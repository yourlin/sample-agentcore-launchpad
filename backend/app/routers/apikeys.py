"""API key management — keys are stored as sha256 hashes, never plaintext."""

import hashlib
import secrets
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.errors import AppError, NotFoundError
from app.models.ledger import Agent, ApiKey
from app.routers.auth import require_identity
from app.routers.workspaces import WorkspaceScope, require_workspace
from app.services import api_keys as key_limits

router = APIRouter(prefix="/api", tags=["api-keys"])


def hash_key(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


class CreateKeyRequest(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    # T16 — all optional; omitted = the legacy unrestricted key.
    agent_ids: list[str] | None = Field(default=None, max_length=50)
    expires_at: datetime | None = None
    rate_per_minute: int | None = Field(default=None, ge=1, le=key_limits.MAX_RATE_PER_MINUTE)


class UpdateKeyRequest(BaseModel):
    """Only fields present in the body change; an explicit null clears the limit."""

    name: str | None = Field(default=None, min_length=1, max_length=64)
    agent_ids: list[str] | None = Field(default=None, max_length=50)
    expires_at: datetime | None = None
    rate_per_minute: int | None = Field(default=None, ge=1, le=key_limits.MAX_RATE_PER_MINUTE)


def _iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    return (value if value.tzinfo else value.replace(tzinfo=UTC)).isoformat()


def _key_out(key: ApiKey) -> dict[str, Any]:
    return {
        "id": key.id,
        "name": key.name,
        "prefix": key.prefix,
        "enabled": key.enabled,
        "created_at": key.created_at.isoformat() if key.created_at else None,
        "created_by": key.created_by,
        # empty list = every agent in the workspace
        "agent_ids": list(key.agent_ids or []),
        "expires_at": _iso(key.expires_at),
        "expired": key_limits.is_expired(key),
        "rate_per_minute": key.rate_per_minute,
        "last_used_at": _iso(key.last_used_at),
        "use_count": key.use_count or 0,
    }


def _clean_scope(db: Session, ws: WorkspaceScope, agent_ids: list[str] | None) -> list[str] | None:
    """De-duplicated scope, every id a live agent of this workspace (else 422)."""
    if not agent_ids:
        return None
    unique = list(dict.fromkeys(agent_ids))
    live = {
        a.id
        for a in db.query(Agent)
        .filter(Agent.workspace_id == ws.id, Agent.id.in_(unique), Agent.status != "deleted")
        .all()
    }
    unknown = [i for i in unique if i not in live]
    if unknown:
        raise AppError(
            "apikey.unknown_agent",
            "agent_ids must name existing agents of this workspace",
            {"agent_ids": unknown},
            status_code=422,
        )
    return unique


def _clean_expiry(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    aware = value if value.tzinfo else value.replace(tzinfo=UTC)
    if aware <= datetime.now(UTC):
        raise AppError(
            "apikey.expiry_in_past", "expires_at must be in the future", status_code=422
        )
    return aware


def _key_in(db: Session, ws: WorkspaceScope, key_id: str) -> ApiKey:
    key = db.get(ApiKey, key_id)
    if key is None or key.workspace_id != ws.id:
        raise NotFoundError("apikey.not_found", "api key not found")
    return key


@router.get("/apikeys")
def list_keys(
    db: Session = Depends(get_db),
    ws: WorkspaceScope = Depends(require_workspace),
) -> dict[str, Any]:
    keys = (
        db.query(ApiKey)
        .filter(ApiKey.workspace_id == ws.id)
        .order_by(ApiKey.created_at.desc())
        .all()
    )
    return {"keys": [_key_out(k) for k in keys]}


@router.post("/apikeys", status_code=201)
def create_key(
    req: CreateKeyRequest,
    request: Request,
    db: Session = Depends(get_db),
    ws: WorkspaceScope = Depends(require_workspace),
) -> dict[str, Any]:
    raw = f"lp_live_{secrets.token_hex(16)}"
    # The key's workspace is what scopes it on /v1 — a key minted here reaches
    # this environment's agents only.
    key = ApiKey(
        workspace_id=ws.id, name=req.name, prefix=raw[:12] + "…", key_hash=hash_key(raw),
        agent_ids=_clean_scope(db, ws, req.agent_ids),
        expires_at=_clean_expiry(req.expires_at),
        rate_per_minute=req.rate_per_minute,
        created_by=require_identity(request).username,
    )
    db.add(key)
    db.commit()
    # The full key is returned exactly once; only the hash is at rest.
    return {**_key_out(key), "key": raw}


@router.post("/apikeys/{key_id}/disable")
def disable_key(
    key_id: str,
    db: Session = Depends(get_db),
    ws: WorkspaceScope = Depends(require_workspace),
) -> dict[str, Any]:
    key = _key_in(db, ws, key_id)
    key.enabled = False
    db.commit()
    return _key_out(key)


@router.post("/apikeys/{key_id}/enable")
def enable_key(
    key_id: str,
    db: Session = Depends(get_db),
    ws: WorkspaceScope = Depends(require_workspace),
) -> dict[str, Any]:
    key = _key_in(db, ws, key_id)
    key.enabled = True
    db.commit()
    return _key_out(key)


@router.patch("/apikeys/{key_id}")
def update_key(
    key_id: str,
    req: UpdateKeyRequest,
    db: Session = Depends(get_db),
    ws: WorkspaceScope = Depends(require_workspace),
) -> dict[str, Any]:
    key = _key_in(db, ws, key_id)
    sent = req.model_fields_set
    if "name" in sent and req.name is not None:
        key.name = req.name
    if "agent_ids" in sent:
        key.agent_ids = _clean_scope(db, ws, req.agent_ids)
    if "expires_at" in sent:
        key.expires_at = _clean_expiry(req.expires_at)
    if "rate_per_minute" in sent:
        key.rate_per_minute = req.rate_per_minute
    db.commit()
    return _key_out(key)


@router.get("/apikeys/{key_id}/usage")
def key_usage(
    key_id: str,
    days: int = 14,
    db: Session = Depends(get_db),
    ws: WorkspaceScope = Depends(require_workspace),
) -> dict[str, Any]:
    """Admitted `/v1` calls per UTC day, oldest first (dense, zero-filled)."""
    key = _key_in(db, ws, key_id)
    return {
        "key_id": key.id,
        "total": key.use_count or 0,
        "last_used_at": _iso(key.last_used_at),
        "days": key_limits.usage_by_day(db, key.id, max(1, min(days, 90))),
    }
