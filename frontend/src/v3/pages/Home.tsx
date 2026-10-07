import { ArrowRight, CheckCircle2 } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router-dom";

import { api, dlcApi, type AgentInfo } from "../../lib/api";
import type { ReleaseState } from "../../lib/dlc";
import { useWorkspace } from "../../workspace/workspace-context";
import { type Attention, agentSignal, attentionFor, sortAttention } from "../signals";
import { Chip, Empty, Lamp, PageHead, Panel, Skeleton, Spark, Stat } from "../ui";
import { useLoad } from "../hooks";
import { ago, ms, pct } from "../format";

const ATTENTION_TO: Record<Attention["kind"], (id: string) => string> = {
  deploy_failed: (id) => `/v3/agents?id=${id}`,
  deploying: (id) => `/v3/agents?id=${id}`,
  release_waiting: (id) => `/v3/gate?agent=${id}`,
  gate_invalid: (id) => `/v3/gate?agent=${id}`,
  gate_blocked: (id) => `/v3/gate?agent=${id}`,
};

/** Release state for the active agents — capped, because it is one request each. */
async function releases(agents: AgentInfo[]): Promise<Record<string, ReleaseState | null>> {
  const active = agents.filter((a) => a.status === "active").slice(0, 24);
  const settled = await Promise.allSettled(active.map((a) => dlcApi.release(a.id)));
  return Object.fromEntries(
    active.map((a, i) => [a.id, settled[i].status === "fulfilled" ? settled[i].value : null]),
  );
}

/**
 * The workbench. Its first question is not "how is everything" but "what needs me":
 * failed deploys, releases waiting for a signature, gates that blocked or could not
 * decide — ranked, each one a click from where it gets handled. The fleet and the
 * traffic sit underneath, because quiet is the normal state and should read as such.
 */
export function V3Home() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { current } = useWorkspace();
  const ws = current?.id ?? "";
  const agents = useLoad(() => api.listAgents(), `v3-home-agents:${ws}`);
  const list = useMemo(() => agents.data?.agents ?? [], [agents.data]);
  const rel = useLoad<Record<string, ReleaseState | null>>(
    () => (list.length ? releases(list) : Promise.resolve({})), `v3-home-rel:${ws}:${list.length}`);
  const dash = useLoad(() => api.obsDashboard("24h"), `v3-home-dash:${ws}`);

  const queue = useMemo(() => {
    const items = list.flatMap((a) => attentionFor(a, rel.data?.[a.id]?.pending ?? null));
    return sortAttention(items);
  }, [list, rel.data]);

  const live = list.filter((a) => a.status === "active").length;
  const needsYou = queue.filter((q) => q.signal === "act").length;
  const waiting = queue.filter((q) => q.signal === "wait").length;
  const tiles = dash.data?.tiles;
  const hasTraffic = Boolean(tiles && tiles.traces.total > 0);
  const series = dash.data?.series ?? [];

  const headline =
    agents.loading && !agents.data
      ? t("v3.home.loading")
      : needsYou + waiting === 0
        ? t("v3.home.quiet")
        : t("v3.home.needs", { count: needsYou + waiting });

  return (
    <div className="v3-reveal" style={{ display: "grid", gap: 18 }}>
      <PageHead
        eyebrow={t("v3.home.eyebrow", { ws: current ? `${current.name} · ${current.region}` : "—" })}
        title={headline}
        sub={t("v3.home.sub")}
      />

      <div className="v3-grid c4">
        <Panel signal="ok">
          <Stat
            label={t("v3.home.live")}
            value={agents.data ? live : "—"}
            signal={live ? "ok" : undefined}
            foot={t("v3.home.ofTotal", { count: list.length })}
          />
        </Panel>
        <Panel signal={waiting ? "wait" : undefined}>
          <Stat label={t("v3.home.waiting")} value={rel.data ? waiting : "—"} signal={waiting ? "wait" : undefined}
            foot={t("v3.home.waitingFoot")} />
        </Panel>
        <Panel signal={needsYou ? "act" : undefined}>
          <Stat label={t("v3.home.needsYou")} value={rel.data ? needsYou : "—"} signal={needsYou ? "act" : undefined}
            foot={t("v3.home.needsYouFoot")} />
        </Panel>
        <Panel>
          <Stat
            label={t("v3.home.p95")}
            // no traces is "no measurement", not a 0ms latency
            value={tiles && hasTraffic ? ms(tiles.latency.p95_ms) : "—"}
            foot={tiles && hasTraffic ? t("v3.home.errorRate", { rate: pct(tiles.error_rate, 1) }) : t("v3.home.noTraffic")}
            signal={tiles && hasTraffic && tiles.error_rate > 0.05 ? "act" : undefined}
          />
        </Panel>
      </div>

      <div className="v3-grid v3-split">
        <Panel title={t("v3.home.queue")} end={<span className="mono">{queue.length}</span>} flush>
          {rel.loading && !rel.data ? (
            <div style={{ padding: 20 }}><Skeleton rows={4} /></div>
          ) : queue.length === 0 ? (
            <div className="v3-empty">
              <CheckCircle2 size={30} style={{ color: "var(--v3-ok)" }} aria-hidden="true" />
              <strong>{t("v3.home.queueEmpty")}</strong>
              <span>{t("v3.home.queueEmptySub")}</span>
            </div>
          ) : (
            <table className="v3-table">
              <tbody>
                {queue.map((item) => (
                  <tr key={item.key}>
                    <td style={{ width: 30 }}><Lamp s={item.signal} live={item.kind === "deploying"} /></td>
                    <td>
                      <div style={{ fontWeight: 600 }}>{t(`v3.attention.${item.kind}`)}</div>
                      <div className="mono" style={{ color: "var(--v3-text-3)", fontSize: 12 }}>{item.agentName}</div>
                    </td>
                    <td className="num" style={{ color: "var(--v3-text-3)", width: 70 }}>{ago(item.at)}</td>
                    <td style={{ width: 120, textAlign: "right" }}>
                      <Link to={ATTENTION_TO[item.kind](item.agentId)} className="v3-btn sm">
                        {t(`v3.attention.${item.kind}Act`)} <ArrowRight size={13} />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        <Panel title={t("v3.home.traffic")} end={<span className="mono">24h</span>}>
          {dash.loading && !dash.data ? (
            <Skeleton rows={3} />
          ) : !tiles || !hasTraffic || series.length < 2 ? (
            <Empty title={t("v3.home.noTraffic")}>{t("v3.home.noTrafficSub")}</Empty>
          ) : (
            <div style={{ display: "grid", gap: 16 }}>
              <Spark values={series.map((b) => b.traces)} />
              <div className="v3-grid c3" style={{ gap: 10 }}>
                <Stat label={t("v3.home.traces")} value={tiles.traces.total.toLocaleString()} />
                <Stat label={t("v3.home.sessions")} value={tiles.sessions.total.toLocaleString()} />
                <Stat
                  label={t("v3.home.spend")}
                  value={tiles.tokens.est_cost_usd === null ? "—" : `$${tiles.tokens.est_cost_usd.toFixed(2)}`}
                />
              </div>
              {series.some((b) => b.errors > 0) && (
                <div>
                  <div className="v3-stat"><div className="label">{t("v3.home.errors")}</div></div>
                  <Spark values={series.map((b) => b.errors)} s="act" />
                </div>
              )}
            </div>
          )}
        </Panel>
      </div>

      <Panel
        title={t("v3.home.fleet")}
        end={<Link to="/v3/agents" className="v3-btn ghost sm">{t("v3.home.allAgents")} <ArrowRight size={13} /></Link>}
        flush
      >
        {agents.loading && !agents.data ? (
          <div style={{ padding: 20 }}><Skeleton rows={5} /></div>
        ) : list.length === 0 ? (
          <Empty title={t("v3.home.noAgents")}>
            <Link to="/v2/agents?view=new" className="v3-btn primary">{t("v3.nav.create")}</Link>
          </Empty>
        ) : (
          <table className="v3-table">
            <thead>
              <tr>
                <th />
                <th>{t("v3.agents.name")}</th>
                <th>{t("v3.agents.method")}</th>
                <th className="num">{t("v3.agents.version")}</th>
                <th>{t("v3.agents.release")}</th>
                <th className="num">{t("v3.agents.updated")}</th>
              </tr>
            </thead>
            <tbody>
              {list.slice(0, 8).map((a) => {
                const state = rel.data?.[a.id]?.state;
                return (
                  <tr key={a.id} className="click" onClick={() => navigate(`/v3/agents?id=${a.id}`)}>
                    <td style={{ width: 30 }}><Lamp s={agentSignal(a)} live={a.status === "active"} /></td>
                    <td>
                      <div className="v3-name"><div><b>{a.display_name || a.name}</b><small>{a.name}</small></div></div>
                    </td>
                    <td><Chip>{a.method}</Chip></td>
                    <td className="num">v{a.version ?? "—"}</td>
                    <td>
                      {state?.endpoint_mode === "live" ? (
                        <Chip s="ok">live {state.live_version ?? "—"}
                          {state.candidate_version && state.candidate_version !== state.live_version
                            ? ` · cand ${state.candidate_version}` : ""}</Chip>
                      ) : (
                        <Chip>{t("v3.agents.ungated")}</Chip>
                      )}
                    </td>
                    <td className="num" style={{ color: "var(--v3-text-3)" }}>{ago(a.updated_at)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  );
}
