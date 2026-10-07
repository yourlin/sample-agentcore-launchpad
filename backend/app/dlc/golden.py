"""Golden sets (黄金集): a parent dataset grouping dev / regression / holdout splits (§4.2).

Each split is an ordinary `EvalDataset` (so it syncs to its own AWS Dataset with its
own immutable versions); the parent row only groups them and names the criteria
lineage they serve. Item provenance lives in `metadata.dlc` so it round-trips through
AWS:

    case_tier          known_good | known_bad | ambiguous | adversarial
    criteria_ids       the criteria this item exercises
    origin             manual | session | synthetic | issue | insight | public
    expected_source    annotator | consensus | adjudicated | agent_observed
    retired            true once moved to the regression pool (out of gate denominators)

Admission never writes the holdout split; only curation at creation time does.
"""

from __future__ import annotations

import copy
from collections import Counter, defaultdict
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.errors import AppError, NotFoundError
from app.evaluation.models import EvalDataset

SPLITS = ("dev", "regression", "holdout")
CASE_TIERS = ("known_good", "known_bad", "ambiguous", "adversarial")
ORIGINS = ("manual", "session", "synthetic", "issue", "insight", "public", "review")
EXPECTED_SOURCES = ("annotator", "consensus", "adjudicated", "agent_observed")
SOURCE_BIAS = {
    "session": "only traffic that already happened — long tail and new intents are absent",
    "issue": "all failures — lowers the pass rate; tracked separately",
    "manual": "the writer knows the answer — items read cleaner than real traffic",
    "public": "terminology is not yours — use for cognition generalization only",
    "synthetic": "same family as the agent under test — hides its blind spots",
    "insight": "drawn from a failure cluster — re-label when the fix lands",
    "review": "an SME's correction — strong label, narrow coverage",
}
MAX_ITEMS = 200


def _now() -> datetime:
    return datetime.now(UTC)


def dlc_meta(item: dict[str, Any]) -> dict[str, Any]:
    return ((item.get("metadata") or {}).get("dlc")) or {}


def stamp(item: dict[str, Any], **fields: Any) -> dict[str, Any]:
    out = copy.deepcopy(item)
    meta = dict(out.get("metadata") or {})
    dlc = dict(meta.get("dlc") or {})
    dlc.update({k: v for k, v in fields.items() if v is not None})
    meta["dlc"] = dlc
    out["metadata"] = meta
    return out


def create(
    db: Session,
    workspace_id: str,
    *,
    name: str,
    criteria_lineage_id: str | None,
    actor: str,
    description: str = "",
) -> EvalDataset:
    parent = EvalDataset(
        workspace_id=workspace_id, name=name[:64], kind="predefined", role="golden",
        criteria_set_id=criteria_lineage_id, description=description, items=[],
    )
    db.add(parent)
    db.flush()
    for split in SPLITS:
        db.add(EvalDataset(
            workspace_id=workspace_id, name=f"{name[:52]}·{split}", kind="predefined",
            role="golden", criteria_set_id=criteria_lineage_id, split_of=parent.id,
            split=split, items=[], description=f"{split} split of {name}",
        ))
    db.flush()
    return parent


def get_parent(db: Session, workspace_id: str, dataset_id: str) -> EvalDataset:
    row = db.get(EvalDataset, dataset_id)
    if row is None or row.workspace_id != workspace_id or row.role != "golden":
        raise NotFoundError("golden.not_found", "golden set not found")
    if row.split_of:
        parent = db.get(EvalDataset, row.split_of)
        if parent is not None:
            return parent
    return row


def splits_of(db: Session, parent: EvalDataset) -> dict[str, EvalDataset]:
    rows = db.scalars(
        select(EvalDataset).where(EvalDataset.split_of == parent.id)
    ).all()
    return {r.split: r for r in rows if r.split in SPLITS}


def for_criteria(db: Session, workspace_id: str, lineage_id: str) -> EvalDataset | None:
    return db.scalars(
        select(EvalDataset).where(
            EvalDataset.workspace_id == workspace_id,
            EvalDataset.role == "golden",
            EvalDataset.split_of.is_(None),
            EvalDataset.criteria_set_id == lineage_id,
        ).order_by(EvalDataset.created_at.desc())
    ).first()


def list_parents(db: Session, workspace_id: str) -> list[EvalDataset]:
    return list(db.scalars(
        select(EvalDataset).where(
            EvalDataset.workspace_id == workspace_id,
            EvalDataset.role == "golden",
            EvalDataset.split_of.is_(None),
        ).order_by(EvalDataset.created_at.desc())
    ).all())


def active_items(split: EvalDataset) -> list[dict[str, Any]]:
    """Items that count in a gate run (retired ones moved to the regression pool)."""
    return [i for i in split.items or [] if not dlc_meta(i).get("retired")]


def _version_label(split: EvalDataset) -> str | None:
    versions = (split.cloud or {}).get("versions") or []
    return str(versions[-1]["version"]) if versions else None


def add_items(
    db: Session,
    split: EvalDataset,
    items: list[dict[str, Any]],
    *,
    actor: str,
    origin: str = "manual",
    allow_holdout: bool = False,
) -> list[dict[str, Any]]:
    """Append items with provenance; refuses the holdout split unless curating it."""
    if split.split == "holdout" and not allow_holdout:
        raise AppError("golden.holdout_closed",
                       "the holdout split is never written by admission — it stays out of "
                       "the development loop", status_code=409)
    existing = list(split.items or [])
    ids = {str(i.get("scenario_id")) for i in existing}
    added = []
    for item in items:
        scenario_id = str(item.get("scenario_id") or "")
        if not scenario_id or scenario_id in ids:
            raise AppError("golden.duplicate_scenario",
                           f"scenario '{scenario_id}' is missing or already in this split")
        meta = dlc_meta(item)
        case_tier = meta.get("case_tier") or "known_good"
        if case_tier not in CASE_TIERS:
            raise AppError("golden.bad_case_tier", f"case_tier must be one of {CASE_TIERS}")
        stamped = stamp(
            item,
            case_tier=case_tier,
            origin=meta.get("origin") or origin,
            expected_source=meta.get("expected_source") or "annotator",
            added_by=actor,
            added_at=_now().isoformat(),
            added_in_version=_version_label(split),
        )
        existing.append(stamped)
        ids.add(scenario_id)
        added.append(stamped)
    if len(existing) > MAX_ITEMS:
        raise AppError("golden.full", f"a split holds at most {MAX_ITEMS} items")
    split.items = existing
    db.flush()
    return added


def move_item(
    db: Session, parent: EvalDataset, scenario_id: str, *, to: str, actor: str
) -> None:
    if to == "holdout":
        raise AppError("golden.holdout_closed", "items never move into the holdout split",
                       status_code=409)
    splits = splits_of(db, parent)
    source = next((s for s in splits.values()
                   if any(str(i.get("scenario_id")) == scenario_id for i in s.items or [])), None)
    if source is None:
        raise NotFoundError("golden.item_not_found", "item not found in this golden set")
    if source.split == "holdout":
        raise AppError("golden.holdout_closed", "holdout items stay in the holdout split",
                       status_code=409)
    target = splits.get(to)
    if target is None:
        raise AppError("golden.bad_split", f"split must be one of {SPLITS}")
    item = next(i for i in source.items if str(i.get("scenario_id")) == scenario_id)
    source.items = [i for i in source.items if str(i.get("scenario_id")) != scenario_id]
    target.items = list(target.items or []) + [stamp(item, moved_by=actor, moved_from=source.split)]
    db.flush()


def retire_item(db: Session, split: EvalDataset, scenario_id: str, *, actor: str,
                reason: str) -> None:
    """Out of gate denominators, still replayed as a regression check."""
    found = False
    items = []
    for item in split.items or []:
        if str(item.get("scenario_id")) == scenario_id:
            item = stamp(item, retired=True, retired_by=actor, retired_reason=reason[:500],
                         retired_in_version=_version_label(split))
            found = True
        items.append(item)
    if not found:
        raise NotFoundError("golden.item_not_found", "item not found")
    split.items = items
    db.flush()


def coverage(criteria_keys: list[str], splits: dict[str, EvalDataset]) -> dict[str, Any]:
    """criteria × case-tier counts, plus items that exercise no criterion."""
    matrix: dict[str, Counter] = defaultdict(Counter)
    unmapped = 0
    sources: Counter = Counter()
    agent_observed = 0
    total = 0
    for split in splits.values():
        for item in active_items(split):
            total += 1
            meta = dlc_meta(item)
            sources[meta.get("origin") or "manual"] += 1
            if meta.get("expected_source") == "agent_observed":
                agent_observed += 1
            ids = meta.get("criteria_ids") or []
            if not ids:
                unmapped += 1
            for key in ids:
                matrix[key][meta.get("case_tier") or "known_good"] += 1
    rows = []
    for key in criteria_keys:
        counts = matrix.get(key, Counter())
        rows.append({
            "key": key,
            **{tier: counts.get(tier, 0) for tier in CASE_TIERS},
            "total": sum(counts.values()),
            "thin": sum(counts.values()) < 3,
        })
    return {
        "criteria": rows,
        "items": total,
        "unmapped_items": unmapped,
        "agent_observed_items": agent_observed,
        "sources": [{"origin": k, "count": v, "bias": SOURCE_BIAS.get(k, "")}
                    for k, v in sources.most_common()],
    }


def split_out(split: EvalDataset) -> dict[str, Any]:
    cloud = split.cloud or {}
    return {
        "id": split.id,
        "split": split.split,
        "name": split.name,
        "items": len(split.items or []),
        "active_items": len(active_items(split)),
        "retired_items": len(split.items or []) - len(active_items(split)),
        "cloud_dataset_id": cloud.get("dataset_id"),
        "draft_status": cloud.get("draft_status"),
        "versions": cloud.get("versions") or [],
        "latest_version": _version_label(split),
    }


def parent_out(db: Session, parent: EvalDataset) -> dict[str, Any]:
    splits = splits_of(db, parent)
    return {
        "id": parent.id,
        "name": parent.name,
        "description": parent.description,
        "criteria_lineage_id": parent.criteria_set_id,
        "created_at": parent.created_at.isoformat() if parent.created_at else None,
        "splits": {name: split_out(splits[name]) for name in SPLITS if name in splits},
    }
