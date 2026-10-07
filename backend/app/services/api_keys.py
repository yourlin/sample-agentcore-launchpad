"""Scope, expiry, rate limit and usage for `/v1` API keys (T16).

Design notes:

* **Rate limit is in-process.** A sliding 60 s window per key id held in memory:
  the backend is a single process (same assumption as the deploy-worker registry),
  the check must not add a ledger write per *rejected* call, and a restart merely
  forgives one window. It is a guard against runaway integrations, not billing.
* **Usage is in the ledger.** `api_keys.last_used_at`/`use_count` plus one
  `api_key_usage` row per (key, UTC day) so the console can chart it and a restart
  loses nothing. Only *admitted* calls are counted.
"""

import threading
import time
from collections import deque
from datetime import UTC, datetime, timedelta

from sqlalchemy import update
from sqlalchemy.orm import Session

from app.core.errors import AppError
from app.models.ledger import ApiKey, ApiKeyUsage

WINDOW_SECONDS = 60.0
MAX_RATE_PER_MINUTE = 100_000

_hits: dict[str, deque[float]] = {}
_lock = threading.Lock()


def reset_rate_limits() -> None:
    with _lock:
        _hits.clear()


def _aware(value: datetime | None) -> datetime | None:
    # SQLite hands timezone-aware columns back naive; every stored value is UTC.
    if value is not None and value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value


def is_expired(key: ApiKey, now: datetime | None = None) -> bool:
    expires = _aware(key.expires_at)
    return expires is not None and (now or datetime.now(UTC)) >= expires


def allows_agent(key: ApiKey, agent_id: str) -> bool:
    """Empty/NULL scope means every agent in the key's workspace (legacy keys)."""
    return not key.agent_ids or agent_id in key.agent_ids


def check_rate(key: ApiKey, *, now: float | None = None) -> None:
    """Admit or refuse one call; refusal is 429 with `Retry-After` (whole seconds)."""
    limit = key.rate_per_minute
    if not limit:
        return
    moment = time.monotonic() if now is None else now
    with _lock:
        window = _hits.setdefault(key.id, deque())
        while window and moment - window[0] >= WINDOW_SECONDS:
            window.popleft()
        if len(window) >= limit:
            retry = max(1, int(WINDOW_SECONDS - (moment - window[0])) + 1)
            raise AppError(
                "auth.rate_limited",
                f"rate limit of {limit} requests per minute exceeded",
                {"limit_per_minute": limit, "retry_after_seconds": retry},
                status_code=429,
                headers={"Retry-After": str(retry)},
            )
        window.append(moment)


def record_use(db: Session, key: ApiKey) -> None:
    """Stamp the key and bump today's counter, atomically in SQL (no lost updates)."""
    now = datetime.now(UTC)
    day = now.strftime("%Y-%m-%d")
    db.execute(
        update(ApiKey)
        .where(ApiKey.id == key.id)
        .values(last_used_at=now, use_count=ApiKey.use_count + 1)
    )
    bumped = db.execute(
        update(ApiKeyUsage)
        .where(ApiKeyUsage.key_id == key.id, ApiKeyUsage.day == day)
        .values(count=ApiKeyUsage.count + 1)
    ).rowcount
    if not bumped:
        db.add(ApiKeyUsage(workspace_id=key.workspace_id, key_id=key.id, day=day, count=1))
    db.commit()
    db.refresh(key)


def usage_by_day(db: Session, key_id: str, days: int = 14) -> list[dict[str, object]]:
    """Dense per-day counts for the last `days` UTC days, oldest first."""
    today = datetime.now(UTC).date()
    wanted = [(today - timedelta(days=i)).isoformat() for i in range(days - 1, -1, -1)]
    rows = {
        r.day: r.count
        for r in db.query(ApiKeyUsage)
        .filter(ApiKeyUsage.key_id == key_id, ApiKeyUsage.day.in_(wanted))
        .all()
    }
    return [{"day": d, "count": rows.get(d, 0)} for d in wanted]
