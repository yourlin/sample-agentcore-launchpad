import { ArrowLeft, ExternalLink, MessagesSquare, Play, Scale, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useSearchParams } from "react-router-dom";

import { api, dlcApi, errorMessage, type AgentInfo, type StageInfo } from "../../lib/api";
import type { ReleaseState } from "../../lib/dlc";
import { useWorkspace } from "../../workspace/workspace-context";
import { agentSignal, gateSignal, releaseSignal } from "../signals";
import { Btn, Chip, Empty, Lamp, Notice, PageHead, Panel, type Signal, Skeleton, Stat } from "../ui";
import { useLoad, useToast } from "../hooks";
import { ago, ms } from "../format";

const STAGE_SIGNAL: Record<StageInfo["status"], Signal> = {
  succeeded: "ok",
  running: "wait",
  failed: "act",
  pending: "off",
  skipped: "off",
};

/**
 * The path a version takes, drawn as one line: built → on candidate → through the
 * gate → serving. Where the line stops is where the agent is; the colour of the
 * last lit node says whether that is fine.
 */
function Lifecycle({ agent, release }: { agent: AgentInfo; release: ReleaseState | null }) {
  const { t } = useTranslation();
  const state = release?.state;
  const pending = release?.pending ?? null;
  const verdict = (pending?.gate_report as { verdict?: "PASS" | "BLOCKED" | "INVALID" } | undefined)?.verdict;
  const gated = state?.endpoint_mode === "live";
  const nodes: { key: string; label: string; detail: string; s: Signal }[] = [
    {
      key: "build",
      label: t("v3.life.build"),
      detail: agent.status === "deploying" ? t("v3.life.building") : `v${agent.version ?? "—"}`,
      s: agent.status === "failed" ? "act" : agent.status === "deploying" ? "wait" : "ok",
    },
    {
      key: "candidate",
      label: t("v3.life.candidate"),
      detail: gated ? (state?.candidate_version ? `v${state.candidate_version}` : "—") : t("v3.life.skipped"),
      s: !gated ? "off" : pending ? "wait" : "ok",
    },
    {
      key: "gate",
      label: t("v3.life.gate"),
      detail: !gated ? t("v3.life.skipped") : verdict ?? (pending ? t("v3.life.notRun") : t("v3.life.clear")),
      s: !gated ? "off" : verdict ? gateSignal(verdict) : pending ? "wait" : "ok",
    },
    {
      key: "live",
      label: t("v3.life.live"),
      detail: gated ? `v${state?.live_version ?? "—"}` : `v${agent.version ?? "—"} · DEFAULT`,
      s: agent.status === "active" ? "ok" : "off",
    },
  ];
  return (
    <div style={{ display: "grid", gridTemplateColumns: `repeat(${nodes.length}, 1fr)`, gap: 0, position: "relative" }}>
      {nodes.map((n, i) => (
        <div key={n.key} style={{ position: "relative", padding: "6px 12px 4px 0" }}>
          {i < nodes.length - 1 && (
            <div
              aria-hidden="true"
              style={{
                position: "absolute", top: 13, left: 20, right: 0, height: 2,
                background: n.s === "ok" ? "linear-gradient(90deg, var(--v3-ok), var(--v3-line-2))" : "var(--v3-line)",
              }}
            />
          )}
          <div style={{ position: "relative", display: "flex", alignItems: "center", gap: 10 }}>
            <Lamp s={n.s} live={n.key === "live" && n.s === "ok"} />
          </div>
          <div className="v3-stat" style={{ marginTop: 12 }}>
            <div className="label">{n.label}</div>
            <div className="mono" style={{ marginTop: 4, color: n.s === "off" ? "var(--v3-text-3)" : "var(--v3-text)" }}>
              {n.detail}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function TryIt({ agent }: { agent: AgentInfo }) {
  const { t } = useTranslation();
  const toast = useToast();
  const [prompt, setPrompt] = useState("");
  const [answer, setAnswer] = useState<{ text: string; latency: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const run = () => {
    if (!prompt.trim()) return;
    setBusy(true);
    api
      .invokeAgent(agent.id, prompt.trim())
      .then((res) => setAnswer({ text: res.text, latency: res.latency_ms }))
      .catch((err: unknown) => toast("act", errorMessage(err)))
      .finally(() => setBusy(false));
  };
  return (
    <Panel title={t("v3.agent.try")} end={answer ? <span className="mono">{ms(answer.latency)}</span> : undefined}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          run();
        }}
        style={{ display: "flex", gap: 8 }}
      >
        <input className="v3-input" value={prompt} onChange={(e) => setPrompt(e.target.value)}
          placeholder={t("v3.agent.tryPlaceholder")} disabled={agent.status !== "active"} />
        <Btn kind="primary" type="submit" disabled={busy || agent.status !== "active" || !prompt.trim()}>
          <Play size={14} /> {t("v3.agent.run")}
        </Btn>
      </form>
      {answer && (
        <pre className="mono" style={{ marginTop: 14, whiteSpace: "pre-wrap", color: "var(--v3-text)", background: "var(--v3-ink-0)",
          border: "1px solid var(--v3-line)", borderRadius: 8, padding: 12, maxHeight: 260, overflow: "auto" }}>
          {answer.text}
        </pre>
      )}
    </Panel>
  );
}

function AgentDetail({ id }: { id: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const agent = useLoad(() => api.getAgent(id), `v3-agent:${id}`);
  const release = useLoad(() => dlcApi.release(id).catch(() => null), `v3-agent-rel:${id}`);
  const versions = useLoad(() => api.agentVersions(id).catch(() => null), `v3-agent-ver:${id}`);
  const a = agent.data;

  if (agent.loading && !a) return <Skeleton rows={6} />;
  if (!a) return <Notice s="act">{agent.error ?? t("v3.agent.notFound")}</Notice>;

  const name = a.display_name || a.name;
  const deploy = a.deployments?.[0] ?? a.deployment;
  const spec = a.spec as { model_id?: string; model?: string; system_prompt?: string; tools?: unknown[] };
  const pending = release.data?.pending ?? null;

  return (
    <div className="v3-reveal" style={{ display: "grid", gap: 16 }}>
      <div>
        <button type="button" className="v3-btn ghost sm" onClick={() => navigate("/v3/agents")}>
          <ArrowLeft size={14} /> {t("v3.agents.title")}
        </button>
      </div>
      <PageHead
        eyebrow={`${a.method} · ${a.id.slice(0, 8)}`}
        title={
          <span style={{ display: "inline-flex", alignItems: "center", gap: 14 }}>
            <Lamp s={agentSignal(a)} live={a.status === "active"} />
            {name}
          </span>
        }
        sub={a.status === "failed" ? a.error ?? t("v3.agent.failed") : spec.system_prompt?.slice(0, 180)}
        end={
          <>
            <Link to={`/v3/chat?agent=${a.id}`} className="v3-btn"><MessagesSquare size={14} /> {t("v3.agent.chat")}</Link>
            <Link to={`/v3/gate?agent=${a.id}`} className="v3-btn"><Scale size={14} /> {t("v3.agent.gate")}</Link>
            <Link to={`/v2/agents?view=detail&id=${a.id}`} className="v3-btn ghost" title={t("v3.nav.inV2Hint")}>
              {t("v3.agent.edit")} <ExternalLink size={13} />
            </Link>
          </>
        }
      />

      <Panel title={t("v3.agent.lifecycle")} signal={agentSignal(a)}>
        <Lifecycle agent={a} release={release.data} />
        {pending && (
          <div style={{ marginTop: 14 }}>
            <Notice s={releaseSignal(pending.decision)}>
              {t("v3.agent.pending", { version: pending.candidate_version ?? "—" })}{" "}
              <Link to={`/v3/gate?agent=${a.id}`} style={{ textDecoration: "underline" }}>{t("v3.agent.openGate")}</Link>
            </Notice>
          </div>
        )}
      </Panel>

      <div className="v3-grid c4">
        <Panel><Stat label={t("v3.agents.version")} value={`v${a.version ?? "—"}`} /></Panel>
        <Panel><Stat label={t("v3.agent.model")} value={<span className="mono" style={{ fontSize: 13, lineHeight: 1.45, wordBreak: "break-all", display: "block" }}>{spec.model_id ?? spec.model ?? "—"}</span>} /></Panel>
        <Panel><Stat label={t("v3.agent.tools")} value={Array.isArray(spec.tools) ? spec.tools.length : 0} /></Panel>
        <Panel><Stat label={t("v3.agents.updated")} value={ago(a.updated_at)} /></Panel>
      </div>

      <div className="v3-grid v3-split">
        <Panel title={t("v3.agent.deploy")} flush>
          {!deploy ? (
            <Empty title={t("v3.agent.noDeploy")} />
          ) : (
            <table className="v3-table">
              <tbody>
                {deploy.stages.map((st) => (
                  <tr key={st.name}>
                    <td style={{ width: 30 }}><Lamp s={STAGE_SIGNAL[st.status]} live={st.status === "running"} /></td>
                    <td className="mono" style={{ width: 120 }}>{st.name}</td>
                    <td style={{ color: "var(--v3-text-2)" }}>{st.detail || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
        <Panel title={t("v3.agent.versions")} flush>
          {!versions.data ? (
            <div style={{ padding: 20 }}>{versions.loading ? <Skeleton rows={3} /> : <Empty title={t("v3.agent.noVersions")} />}</div>
          ) : (
            <table className="v3-table">
              <thead><tr><th>{t("v3.agents.version")}</th><th>{t("v3.agent.endpoints")}</th><th className="num">{t("v3.agents.updated")}</th></tr></thead>
              <tbody>
                {versions.data.versions.slice(0, 8).map((v) => {
                  const serving = versions.data!.endpoints.filter((e) => e.live_version === v.version).map((e) => e.name);
                  return (
                    <tr key={v.version ?? "?"}>
                      <td className="mono">v{v.version}</td>
                      <td style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                        {serving.length ? serving.map((n) => <Chip key={n} s={n === "live" || n === "DEFAULT" ? "ok" : "info"}>{n}</Chip>) : <span style={{ color: "var(--v3-text-3)" }}>—</span>}
                      </td>
                      <td className="num" style={{ color: "var(--v3-text-3)" }}>{ago(v.last_updated_at)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Panel>
      </div>

      <TryIt agent={a} />
    </div>
  );
}

function AgentList() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { current } = useWorkspace();
  const agents = useLoad(() => api.listAgents(), `v3-agents:${current?.id ?? ""}`);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<"all" | Signal>("all");
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (agents.data?.agents ?? [])
      .filter((a) => a.status !== "deleted")
      .filter((a) => filter === "all" || agentSignal(a) === filter)
      .filter((a) => !needle || `${a.name} ${a.display_name ?? ""} ${a.method}`.toLowerCase().includes(needle));
  }, [agents.data, q, filter]);
  const all = agents.data?.agents ?? [];
  const count = (s: Signal) => all.filter((a) => agentSignal(a) === s).length;

  return (
    <div className="v3-reveal" style={{ display: "grid", gap: 16 }}>
      <PageHead
        eyebrow={t("v3.agents.eyebrow")}
        title={t("v3.agents.title")}
        sub={t("v3.agents.sub")}
        end={<Link to="/v2/agents?view=new" className="v3-btn primary">{t("v3.nav.create")}</Link>}
      />
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        {(["all", "ok", "wait", "act", "off"] as const).map((f) => (
          <button key={f} type="button" className={`v3-btn sm${filter === f ? "" : " ghost"}`} onClick={() => setFilter(f)}>
            {f !== "all" && <Lamp s={f} />}
            {t(`v3.agents.filter.${f}`)}
            <span className="mono" style={{ color: "var(--v3-text-3)" }}>{f === "all" ? all.length : count(f)}</span>
          </button>
        ))}
        <div style={{ marginLeft: "auto", position: "relative", width: 280 }}>
          <Search size={14} style={{ position: "absolute", left: 12, top: 11, color: "var(--v3-text-3)" }} aria-hidden="true" />
          <input className="v3-input" style={{ paddingLeft: 34 }} value={q} onChange={(e) => setQ(e.target.value)}
            placeholder={t("v3.agents.search")} aria-label={t("v3.agents.search")} />
        </div>
      </div>
      <Panel flush>
        {agents.loading && !agents.data ? (
          <div style={{ padding: 20 }}><Skeleton rows={6} /></div>
        ) : agents.error ? (
          <div style={{ padding: 20 }}><Notice s="act">{agents.error}</Notice></div>
        ) : rows.length === 0 ? (
          <Empty title={t("v3.agents.none")} />
        ) : (
          <table className="v3-table">
            <thead>
              <tr>
                <th />
                <th>{t("v3.agents.name")}</th>
                <th>{t("v3.agents.method")}</th>
                <th className="num">{t("v3.agents.version")}</th>
                <th>{t("v3.agents.owner")}</th>
                <th className="num">{t("v3.agents.updated")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id} className="click" onClick={() => navigate(`/v3/agents?id=${a.id}`)}>
                  <td style={{ width: 30 }}><Lamp s={agentSignal(a)} live={a.status === "active"} /></td>
                  <td>
                    <div className="v3-name">
                      <div>
                        <b>{a.display_name || a.name}</b>
                        <small>{a.status === "failed" ? (a.error ?? "").slice(0, 80) : a.name}</small>
                      </div>
                    </div>
                  </td>
                  <td><Chip>{a.method}</Chip></td>
                  <td className="num">v{a.version ?? "—"}</td>
                  <td className="mono" style={{ color: "var(--v3-text-2)" }}>{a.owner || "—"}</td>
                  <td className="num" style={{ color: "var(--v3-text-3)" }}>{ago(a.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  );
}

export function V3Agents() {
  const [params] = useSearchParams();
  const id = params.get("id");
  return id ? <AgentDetail key={id} id={id} /> : <AgentList />;
}
