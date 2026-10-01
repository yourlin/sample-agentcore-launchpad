"""Platform ledger — every agent, deployment and background job lives here.

The ledger is the source of truth for what the platform created; AWS-side
resources are always reachable from a row (arn / resource id).
"""

import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import (
    JSON,
    DateTime,
    Float,
    ForeignKey,
    Index,
    String,
    Text,
    UniqueConstraint,
    event,
    inspect,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base


def _id() -> str:
    return uuid.uuid4().hex


def _now() -> datetime:
    return datetime.now(UTC)


class Workspace(Base):
    """One (account, region) environment with its own AgentCore resource map.

    The row — not ``Settings`` — is authoritative for where work lands. The
    ``default`` row is seeded from settings at startup (see
    ``app.core.db._seed_default_workspace``) and its id is reserved.
    """

    __tablename__ = "workspaces"
    # One workspace per (account, region): every region-scoped resource name
    # Launchpad provisions (launchpad-gw, launchpad_memory, ...) stays
    # collision-free without a per-workspace name discriminator.
    __table_args__ = (
        UniqueConstraint("account_id", "region", name="uq_workspaces_account_region"),
    )

    id: Mapped[str] = mapped_column(String(32), primary_key=True)  # slug
    name: Mapped[str] = mapped_column(String(64))
    account_id: Mapped[str] = mapped_column(String(16))
    region: Mapped[str] = mapped_column(String(32))
    # NULL means the hub's own ambient credentials (same-account workspace).
    role_arn: Mapped[str | None] = mapped_column(String(256), default=None)
    external_id: Mapped[str | None] = mapped_column(String(128), default=None)
    bootstrap_status: Mapped[str] = mapped_column(String(16), default="registered")
    # registered | bootstrapping | ready | failed
    # dev | staging | prod (T05). Ledger-authoritative for every row, `default`
    # included: the startup mirror never writes it. `prod` refuses member agent
    # mutations (route_policy.PROD_PROTECTED); server_default keeps the raw-SQL
    # seed of `default` (which does not name the column) on `dev`.
    tier: Mapped[str] = mapped_column(String(16), default="dev", server_default="dev")
    # T26: admin-configured release policy for promotions INTO this workspace (eval
    # threshold, ENFORCE requirement, deploy window, freezes). Empty = tier defaults.
    # Nullable: the raw-SQL seed of `default` does not name the column.
    release_policy: Mapped[dict[str, Any] | None] = mapped_column(JSON, default=None)
    resources: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now
    )


class UserWorkspace(Base):
    """Binary grant: a member may operate in this workspace.

    Admins bypass grants entirely — the built-in admin is config-driven and has
    no ``users`` row, so it can never own one of these.
    """

    __tablename__ = "user_workspaces"

    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), primary_key=True)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id"), primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class Agent(Base):
    __tablename__ = "agents"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    workspace_id: Mapped[str | None] = mapped_column(String(32), index=True, default=None)
    # uniqueness among non-deleted rows is enforced in the API layer, so a
    # deleted agent's name can be reused
    name: Mapped[str] = mapped_column(String(64), index=True)
    method: Mapped[str] = mapped_column(String(24))  # harness|zip_runtime|container|studio|byoc
    status: Mapped[str] = mapped_column(String(24), default="draft")
    # draft | deploying | active | failed | deleted
    spec: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    resource_id: Mapped[str | None] = mapped_column(String(128), default=None)
    arn: Mapped[str | None] = mapped_column(String(256), default=None)
    registry_record_id: Mapped[str | None] = mapped_column(String(64), default=None)
    version: Mapped[str | None] = mapped_column(String(16), default=None)
    # Server-owned: the runtime version whose packaged entrypoint acknowledges
    # native attachments. Never copied from AgentSpec or an import descriptor.
    attachment_version: Mapped[str | None] = mapped_column(String(16), default=None)
    owner: Mapped[str] = mapped_column(String(64), default="river")
    error: Mapped[str | None] = mapped_column(Text, default=None)
    # Server-owned system identity. NULL for every ordinary agent; a preset key
    # (``app.system_agents.presets``) for a platform-managed preset the console
    # installed on an administrator's explicit request. Never read from a client
    # payload — ``AgentSpec`` has no such field — and never editable through the
    # ordinary lifecycle routes, which refuse rows that carry it.
    system_key: Mapped[str | None] = mapped_column(String(64), index=True, default=None)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now
    )

    __table_args__ = (
        # One live preset per (workspace, key). Partial so a deleted (uninstalled)
        # preset does not block a later reinstall, and so ordinary rows (NULL key)
        # are never compared. Two concurrent installs race into this index; the
        # loser's INSERT fails and the install handler re-reads the winner.
        Index(
            "uq_agents_workspace_system_key",
            "workspace_id",
            "system_key",
            unique=True,
            sqlite_where=text("system_key IS NOT NULL AND status != 'deleted'"),
        ),
    )


class SystemSkillRecord(Base):
    """Server-owned association between a system preset's published Skill bundle and
    the Agent Registry record that describes it (SE-043).

    One row per (workspace, preset) — the mapping outlives the preset agent (an
    uninstall keeps the record and the S3 release for other consumers) and a reinstall
    reuses it, so it is deliberately **not** ``Agent.registry_record_id`` (that column
    is the agent's own A2A record). Nothing here is derived from a client payload:
    the row is written only by the registration service, and a registry record is
    system-protected exactly when a row in the caller's workspace names its id.
    ``client_token`` is the durable CreateRegistryRecord intent: it is persisted
    before the AWS call so a crash between the call and the commit is recovered by
    repeating the same idempotent request, never by adopting a same-name record.
    AWS keeps the record's payload and approval status; the ledger holds identifiers
    and the release identity it registered.
    """

    __tablename__ = "system_skill_records"
    __table_args__ = (
        # One mapping per (workspace, preset); two racing first registrations hit this
        # index and the loser re-reads the winner's row. An index rather than a table
        # constraint so the pre-workspace migration rehearsal can drop the column.
        Index(
            "uq_system_skill_records_workspace_preset",
            "workspace_id",
            "preset_key",
            unique=True,
        ),
    )

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    workspace_id: Mapped[str] = mapped_column(String(32), index=True)
    preset_key: Mapped[str] = mapped_column(String(64), index=True)
    skill_name: Mapped[str] = mapped_column(String(64))
    # the registry the record lives in — a workspace whose registry was rebuilt must
    # not be matched against a record id from the old one
    registry_id: Mapped[str] = mapped_column(String(128))
    # the VERIFIED record (read back and matched against the request that wrote it)
    record_id: Mapped[str | None] = mapped_column(String(64), index=True, default=None)
    record_arn: Mapped[str | None] = mapped_column(String(512), default=None)
    # the record id AWS returned for OUR create whose read-back has not verified yet;
    # protected like a verified one (it is ours), never projected as registered
    pending_record_id: Mapped[str | None] = mapped_column(String(64), default=None)
    client_token: Mapped[str] = mapped_column(String(256))
    # the COMPLETE CreateRegistryRecord kwargs persisted before the call: a retry
    # after a lost response replays exactly these bytes with the same token — the
    # only thing that proves a same-name record was created by this platform
    create_request: Mapped[dict[str, Any] | None] = mapped_column(JSON, default=None)
    # creating | accepted | registered — ledger-side lifecycle only; approval is AWS's
    status: Mapped[str] = mapped_column(String(16), default="creating")
    # the verified release (what the record is known to describe)
    release_version: Mapped[str | None] = mapped_column(String(32), default=None)
    release_digest: Mapped[str | None] = mapped_column(String(64), default=None)
    s3_uri: Mapped[str | None] = mapped_column(String(512), default=None)
    content_digest: Mapped[str | None] = mapped_column(String(64), default=None)
    # high-water mark: the release the last create/update INTENDED to write, committed
    # before the AWS call, so an accepted-but-lost update can never be downgraded by a
    # worker that still holds the previous release
    intent_version: Mapped[str | None] = mapped_column(String(32), default=None)
    intent_digest: Mapped[str | None] = mapped_column(String(64), default=None)
    intent_content_digest: Mapped[str | None] = mapped_column(String(64), default=None)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now
    )


class User(Base):
    """A console account created by self-service registration (or by an admin).

    The built-in admin is **not** stored here — it stays config-driven
    (`auth_username`/`auth_password`) so a bad row can never lock the console.
    Registered accounts are time-boxed: `expires_at` is checked on every guarded
    request, so expiry/disable takes effect without waiting for the session
    cookie to lapse.
    """

    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    username: Mapped[str] = mapped_column(String(64))  # as typed, for display
    # lowercase mirror; carries the uniqueness constraint so logins and
    # registration are case-insensitive on both username and email
    username_key: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    email: Mapped[str] = mapped_column(String(160), unique=True, index=True)  # lowercased
    password_hash: Mapped[str] = mapped_column(String(256))
    role: Mapped[str] = mapped_column(String(16), default="member")  # member | admin
    # Per-user agent-management permission overrides ({key: bool}). None and any
    # missing key mean GRANTED — only explicit denials are stored, so new
    # permission keys are default-on for every existing account. Inert for
    # admins (role short-circuits in auth). Keys: auth.AGENT_PERMISSIONS.
    permissions: Mapped[dict[str, bool] | None] = mapped_column(JSON, default=None)
    # pending accounts await admin approval and cannot hold a session; the
    # validity window below only starts once they are approved
    status: Mapped[str] = mapped_column(String(16), default="active")
    # pending | active | disabled
    expires_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), default=None
    )  # None = never expires (admin-granted)
    created_by: Mapped[str] = mapped_column(String(64), default="self")
    last_login_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), default=None
    )
    login_count: Mapped[int] = mapped_column(default=0)
    # Stamped once, on the first successful login (TTFA's start clock). NULL for
    # accounts that never logged in or that logged in before the column existed —
    # TTFA falls back to `created_at` for those.
    first_login_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), default=None
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now
    )


class Deployment(Base):
    __tablename__ = "deployments"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    workspace_id: Mapped[str | None] = mapped_column(String(32), index=True, default=None)
    agent_id: Mapped[str] = mapped_column(ForeignKey("agents.id"), index=True)
    job_id: Mapped[str | None] = mapped_column(String(32), default=None)
    status: Mapped[str] = mapped_column(String(24), default="running")
    # running | succeeded | failed
    stages: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    # [{name, status: pending|running|succeeded|skipped|failed, detail, started_at, ended_at}]
    # Immutable ECR digest of the container image this deployment runs. Recorded so
    # the console can say exactly what is deployed and a resumed job re-uses the
    # same image rather than whatever the mutable tag points at by then. None for
    # zip/harness methods and for container deployments predating digest pinning.
    image_digest: Mapped[str | None] = mapped_column(String(80), default=None)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)


class ChatSession(Base):
    __tablename__ = "chat_sessions"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    workspace_id: Mapped[str | None] = mapped_column(String(32), index=True, default=None)
    agent_id: Mapped[str] = mapped_column(ForeignKey("agents.id"), index=True)
    session_id: Mapped[str] = mapped_column(String(80), index=True)
    actor_id: Mapped[str] = mapped_column(String(64), default="river")
    turns: Mapped[int] = mapped_column(default=0)
    runtime_version: Mapped[str | None] = mapped_column(String(16), default=None)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    last_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now
    )
    # Set when the console explicitly ended the AgentCore Runtime session
    # (StopRuntimeSession). The row stays so the transcript remains replayable;
    # only new turns must go to a fresh session id.
    ended_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, default=None
    )


class ChatMessage(Base):
    """One rendered thread item of a console chat session (user turn, agent
    answer, tool call, error) — the Chat playground's reload-safe history.
    Integer autoincrement pk doubles as the replay order."""

    __tablename__ = "chat_messages"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    # carried on the row itself, not only via the agent: two queries match on a
    # bare session_id (routers/chat.py, services/observability.py)
    workspace_id: Mapped[str | None] = mapped_column(String(32), index=True, default=None)
    agent_id: Mapped[str] = mapped_column(ForeignKey("agents.id"), index=True)
    session_id: Mapped[str] = mapped_column(String(80), index=True)
    role: Mapped[str] = mapped_column(String(16))  # user | agent | tool | error
    text: Mapped[str] = mapped_column(Text, default="")
    name: Mapped[str | None] = mapped_column(String(80), default=None)  # tool name
    attachments: Mapped[list[dict[str, Any]] | None] = mapped_column(JSON, default=None)
    # T35: `rule:<rule id>` when a curated answer (not the model) produced this row
    answered_by: Mapped[str | None] = mapped_column(String(48), default=None)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class ApiKey(Base):
    __tablename__ = "api_keys"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    workspace_id: Mapped[str | None] = mapped_column(String(32), index=True, default=None)
    name: Mapped[str] = mapped_column(String(64))
    prefix: Mapped[str] = mapped_column(String(16))  # display only, e.g. lp_live_ab12
    key_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)  # sha256
    enabled: Mapped[bool] = mapped_column(default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    # T16 scope + limits. NULL/empty `agent_ids` = every agent in the workspace (the
    # behaviour of every key minted before scoping); NULL `expires_at` never expires;
    # NULL `rate_per_minute` is unlimited.
    agent_ids: Mapped[list[str] | None] = mapped_column(JSON, default=None)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    rate_per_minute: Mapped[int | None] = mapped_column(default=None)
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    use_count: Mapped[int] = mapped_column(default=0, server_default="0")
    created_by: Mapped[str | None] = mapped_column(String(64), default=None)


class ApiKeyUsage(Base):
    """Admitted `/v1` calls per key per UTC day (T16) — the aggregable usage shape."""

    __tablename__ = "api_key_usage"
    __table_args__ = (UniqueConstraint("key_id", "day", name="uq_api_key_usage_key_day"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    workspace_id: Mapped[str | None] = mapped_column(String(32), index=True, default=None)
    key_id: Mapped[str] = mapped_column(String(32), index=True)
    day: Mapped[str] = mapped_column(String(10))  # YYYY-MM-DD, UTC
    count: Mapped[int] = mapped_column(default=0)


class SpecSnapshot(Base):
    """The full agent spec as of one publish (T18): one row per create/redeploy.

    Rollback re-publishes a stored spec as a NEW snapshot; rows are never edited
    except to fill `aws_version` once the deploy stage learns it.
    """

    __tablename__ = "spec_snapshots"
    __table_args__ = (UniqueConstraint("agent_id", "seq", name="uq_spec_snapshots_agent_seq"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    workspace_id: Mapped[str | None] = mapped_column(String(32), index=True, default=None)
    agent_id: Mapped[str] = mapped_column(ForeignKey("agents.id"), index=True)
    seq: Mapped[int]
    spec: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    aws_version: Mapped[str | None] = mapped_column(String(16), default=None)
    deployment_id: Mapped[str | None] = mapped_column(String(32), index=True, default=None)
    created_by: Mapped[str | None] = mapped_column(String(64), default=None)
    note: Mapped[str | None] = mapped_column(Text, default=None)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class ShareLink(Base):
    """A signed, revocable, account-free way for an outsider to reach exactly one
    thing (T13). The raw token is shown once at creation; only its sha256 is at
    rest, exactly like `ApiKey`. The row — not any request header — decides which
    workspace a visitor lands in."""

    __tablename__ = "share_links"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    workspace_id: Mapped[str | None] = mapped_column(String(32), index=True, default=None)
    kind: Mapped[str] = mapped_column(String(16), default="chat")  # chat (extensible)
    target_id: Mapped[str] = mapped_column(String(32), index=True)  # the agent id for `chat`
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)  # sha256
    prefix: Mapped[str] = mapped_column(String(16), default="")  # display only, e.g. shr_ab12
    label: Mapped[str] = mapped_column(String(64), default="")
    created_by: Mapped[str] = mapped_column(String(64), default="")
    enabled: Mapped[bool] = mapped_column(default=True)
    expires_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, default=None
    )
    revoked_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, default=None
    )
    last_used_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, default=None
    )
    use_count: Mapped[int] = mapped_column(default=0)
    # Channel links (T30) only: `kind` is the platform (slack|feishu). `channel_config`
    # is what the console may show back (e.g. Feishu domain); `channel_secrets` is what
    # the adapter must be able to use (signing secret, bot token) and is NEVER
    # serialized by any route - the API reports only which keys are set.
    channel_config: Mapped[dict[str, Any] | None] = mapped_column(JSON, default=None)
    channel_secrets: Mapped[dict[str, Any] | None] = mapped_column(JSON, default=None)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class ChatFeedback(Base):
    """A thumbs verdict on one agent answer (T15), from the console or a share page.

    A table rather than columns on `ChatMessage`: one message can be rated by
    several actors, a verdict can change or be withdrawn, and it carries a comment
    and an origin — none of which belong on the transcript row. One verdict per
    (message, actor); re-voting updates it.
    """

    __tablename__ = "chat_feedback"
    __table_args__ = (UniqueConstraint("message_id", "actor", name="uq_chat_feedback_actor"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    workspace_id: Mapped[str | None] = mapped_column(String(32), index=True, default=None)
    agent_id: Mapped[str] = mapped_column(String(32), index=True)
    session_id: Mapped[str] = mapped_column(String(80), index=True)
    message_id: Mapped[int] = mapped_column(index=True)  # chat_messages.id (an agent answer)
    verdict: Mapped[str] = mapped_column(String(8), index=True)  # up | down
    comment: Mapped[str | None] = mapped_column(Text, default=None)
    # T34: the answer a reviewer says it should have been (feeds a curated answer)
    correction: Mapped[str | None] = mapped_column(Text, default=None)
    actor: Mapped[str] = mapped_column(String(96))  # console username, or share:<link id>
    source: Mapped[str] = mapped_column(String(16), default="console")  # console|share|review
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now
    )


class SharedTemplate(Base):
    """An agent published as a reusable starting point (roadmap T38).

    Hub-global on purpose: the whole point is that *another* workspace can start from it, so
    unlike every per-environment table this one is not workspace-scoped. The provenance
    column is deliberately NOT named `workspace_id`: in this ledger that name *means* "scoped
    to", and `test_workspaces` enforces exactly that — `source_workspace_id` records where it
    came from, for attribution and for deciding who may unpublish it.

    What the row carries is pruned by `services/marketplace.publishable_spec` — no
    environment-specific ids and nothing secret-shaped; those become `requirements` telling
    a consumer what to supply instead.
    """

    __tablename__ = "shared_templates"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    # the publishing environment, NOT a scope — reads are deliberately cross-workspace
    source_workspace_id: Mapped[str] = mapped_column(String(32), index=True)
    agent_id: Mapped[str] = mapped_column(String(32), index=True)
    source_agent_name: Mapped[str] = mapped_column(String(64), default="")
    title: Mapped[str] = mapped_column(String(80), default="")
    summary: Mapped[str] = mapped_column(Text, default="")
    method: Mapped[str] = mapped_column(String(24), default="harness")
    spec: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    requirements: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    published_by: Mapped[str | None] = mapped_column(String(64), default=None)
    uses: Mapped[int] = mapped_column(default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now
    )


class AlertRule(Base):
    """One threshold the platform watches, and what it last saw (roadmap T29).

    Deliberately a *rule*, not a subscription: the value is computed from data the
    platform already collects (spans for error rate and latency, online-evaluation
    results for quality, the price map for spend), so a rule adds a threshold and a
    destination rather than a new telemetry path.

    `state` and `last_value` are the evaluation's own memory. They exist so a firing rule
    notifies **once** on the transition rather than on every tick, and so the inbox can
    show what is wrong without re-running a billed Logs Insights scan.
    """

    __tablename__ = "alert_rules"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    workspace_id: Mapped[str | None] = mapped_column(String(32), index=True, default=None)
    # error_rate | latency_p95_ms | online_quality | cost_mtd_usd
    kind: Mapped[str] = mapped_column(String(32), index=True)
    name: Mapped[str] = mapped_column(String(64), default="")
    # "above" | "below" — quality fires when it drops, the others when they rise
    comparison: Mapped[str] = mapped_column(String(8), default="above")
    threshold: Mapped[float] = mapped_column(Float)
    # the observability range key the value is measured over ("1h" … "30d")
    window: Mapped[str] = mapped_column(String(8), default="24h")
    enabled: Mapped[bool] = mapped_column(default=True)
    # Optional outbound destination. A generic JSON webhook, which is what a Slack or
    # Feishu incoming hook already is — so one mechanism covers both without the platform
    # holding channel credentials.
    webhook_url: Mapped[str | None] = mapped_column(String(512), default=None)
    # ok | firing | unknown (unknown = the last evaluation could not read the value)
    state: Mapped[str] = mapped_column(String(16), default="unknown", index=True)
    last_value: Mapped[float | None] = mapped_column(default=None)
    last_detail: Mapped[str | None] = mapped_column(Text, default=None)
    last_checked_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), default=None
    )
    last_fired_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), default=None
    )
    last_notified_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), default=None
    )
    created_by: Mapped[str | None] = mapped_column(String(64), default=None)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now
    )


class ReleaseBundle(Base):
    """An immutable, verifiable record of exactly what was tested (T20).

    The unit of promotion: a frozen copy of one `SpecSnapshot`, the artifact
    coordinates that snapshot deployed (image digest / staged upload / requirements
    lock), the evaluation evidence pinned to it, and the policy posture at the time —
    reduced to one `digest`. Promotion deploys the bundle rather than re-generating
    from the spec, which is what makes "build once, deploy many" checkable: the same
    inputs always produce the same digest, and a digest mismatch means something other
    than the tested thing is about to ship.

    Rows are append-only. `workspace_id` is the environment the bundle was BUILT in
    (the source); where it may go is the promotion's business.
    """

    __tablename__ = "release_bundles"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    workspace_id: Mapped[str | None] = mapped_column(String(32), index=True, default=None)
    agent_id: Mapped[str] = mapped_column(ForeignKey("agents.id"), index=True)
    # the snapshot this bundle froze; null only if the snapshot was purged
    snapshot_id: Mapped[str | None] = mapped_column(String(32), index=True, default=None)
    snapshot_seq: Mapped[int | None] = mapped_column(default=None)
    agent_name: Mapped[str] = mapped_column(String(64))
    method: Mapped[str] = mapped_column(String(24))
    spec: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    # {image_digest, image_uri, upload_id, requirements_sha, source_arn, aws_version}
    artifact: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    # {run_id, dataset, dataset_version, pass_rate, evaluators, finished_at} or {}
    evaluation: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    # {guardrail, gateways, policy_engine_mode, registry_record_id}
    policy: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    # sha256 over the canonical (spec, artifact, agent_name, method) — the identity
    digest: Mapped[str] = mapped_column(String(64), index=True)
    created_by: Mapped[str | None] = mapped_column(String(64), default=None)
    note: Mapped[str | None] = mapped_column(Text, default=None)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class Promotion(Base):
    """One request to release a bundle into another environment (T21).

    The hand-off between the member who built an agent and the operator who runs it:
    a request carries the change note and the rollback plan, an approval records who
    accepted it and which gates passed at that moment, and execution (P3) attaches the
    job. `workspace_id` is the SOURCE environment, so the row is scoped like every
    other; `target_workspace_id` is where it is going.
    """

    __tablename__ = "promotions"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    workspace_id: Mapped[str | None] = mapped_column(String(32), index=True, default=None)
    bundle_id: Mapped[str] = mapped_column(ForeignKey("release_bundles.id"), index=True)
    target_workspace_id: Mapped[str] = mapped_column(String(32), index=True)
    # pending | approved | rejected | executing | succeeded | failed | rolled_back
    status: Mapped[str] = mapped_column(String(16), default="pending", index=True)
    requested_by: Mapped[str | None] = mapped_column(String(64), default=None)
    change_note: Mapped[str] = mapped_column(Text, default="")
    rollback_note: Mapped[str] = mapped_column(Text, default="")
    reviewed_by: Mapped[str | None] = mapped_column(String(64), default=None)
    review_note: Mapped[str | None] = mapped_column(Text, default=None)
    reviewed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), default=None
    )
    # the gate results as evaluated at approval time — evidence, not a live read
    gates: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    job_id: Mapped[str | None] = mapped_column(String(32), default=None)
    error: Mapped[str | None] = mapped_column(Text, default=None)
    # T27 execution state. `stages` is the per-stage progress the console renders as one
    # card each; `execution` holds the resumable scratch (target agent, inner deploy job,
    # canary id, observation deadline) so a restarted worker continues instead of redoing.
    stages: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    execution: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    # the bundle the target ran before this release: what a rollback re-deploys
    previous_bundle_id: Mapped[str | None] = mapped_column(String(32), default=None)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now
    )


class PolicyDecision(Base):
    __tablename__ = "policy_decisions"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    workspace_id: Mapped[str | None] = mapped_column(String(32), index=True, default=None)
    principal: Mapped[str] = mapped_column(String(96))  # e.g. demo@hr-analyst
    tool: Mapped[str] = mapped_column(String(128))
    outcome: Mapped[str] = mapped_column(String(8))  # ALLOW | DENY
    reason: Mapped[str | None] = mapped_column(Text, default=None)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class PolicyChange(Base):
    """Immutable request/snapshot fields plus mutable AWS operation outcome."""

    __tablename__ = "policy_changes"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    # deliberately NOT in _POLICY_CHANGE_IMMUTABLE: the startup backfill must
    # stay legal on rows whose audit snapshot is otherwise frozen
    workspace_id: Mapped[str | None] = mapped_column(String(32), index=True, default=None)
    gateway_id: Mapped[str] = mapped_column(String(128), index=True)
    gateway_arn: Mapped[str] = mapped_column(String(512))
    gateway_name: Mapped[str] = mapped_column(String(100))
    engine_id: Mapped[str | None] = mapped_column(String(128), default=None)
    engine_arn: Mapped[str | None] = mapped_column(String(512), default=None)
    policy_id: Mapped[str | None] = mapped_column(String(128), default=None)
    policy_name: Mapped[str | None] = mapped_column(String(100), default=None)
    candidate_policy_id: Mapped[str | None] = mapped_column(String(128), default=None)
    operation: Mapped[str] = mapped_column(String(48))
    operator: Mapped[str] = mapped_column(String(64))
    status: Mapped[str] = mapped_column(String(16), default="pending", index=True)
    before: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    requested: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    after: Mapped[dict[str, Any] | None] = mapped_column(JSON, default=None)
    expected_updated_at: Mapped[str | None] = mapped_column(String(64), default=None)
    override_reason: Mapped[str | None] = mapped_column(Text, default=None)
    error: Mapped[str | None] = mapped_column(Text, default=None)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), default=None)
    completed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), default=None
    )


_POLICY_CHANGE_IMMUTABLE = {
    "gateway_id",
    "gateway_arn",
    "gateway_name",
    "engine_id",
    "engine_arn",
    "policy_id",
    "policy_name",
    "operation",
    "operator",
    "before",
    "requested",
    "expected_updated_at",
    "override_reason",
    "created_at",
}


@event.listens_for(PolicyChange, "before_update")
def _prevent_policy_change_snapshot_mutation(_: Any, __: Any, target: PolicyChange) -> None:
    state = inspect(target)
    changed = [
        name for name in _POLICY_CHANGE_IMMUTABLE if state.attrs[name].history.has_changes()
    ]
    if changed:
        raise ValueError(f"immutable policy audit fields changed: {', '.join(sorted(changed))}")


class AuditEvent(Base):
    """One journaled privileged action (T05): an administrator's break-glass agent
    mutation on a `prod` workspace, or a workspace tier change.

    Written at admission (before the handler runs), so a row records that the
    action was attempted by that actor, not that it succeeded — the Job log /
    Deployment row carries the outcome. Append-only by convention; nothing in the
    app updates or deletes a row except a workspace purge.
    """

    __tablename__ = "audit_events"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    workspace_id: Mapped[str | None] = mapped_column(String(32), index=True, default=None)
    actor: Mapped[str] = mapped_column(String(64))
    # e.g. "POST /api/agents/{agent_id}/redeploy" or "workspace.tier_change"
    action: Mapped[str] = mapped_column(String(160))
    # the concrete path, or "dev->prod" for a tier change
    target: Mapped[str] = mapped_column(String(256), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class Job(Base):
    __tablename__ = "jobs"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    # the environment a resumed job re-runs against; never re-derived from settings
    workspace_id: Mapped[str | None] = mapped_column(String(32), index=True, default=None)
    type: Mapped[str] = mapped_column(String(32))  # deploy_agent | delete_agent | ...
    status: Mapped[str] = mapped_column(String(16), default="queued")
    # queued | running | succeeded | failed
    payload: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    log: Mapped[str] = mapped_column(Text, default="")  # JSONL, one event per line
    error: Mapped[str | None] = mapped_column(Text, default=None)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now
    )
