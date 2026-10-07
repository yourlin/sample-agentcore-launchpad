// Every status the console shows is mapped onto a Signal exactly once, here — so
// mint always means "running as intended", amber "waiting on someone", coral "it
// needs you", wherever it appears. Pure functions, unit-tested.
import type { AgentInfo } from "../lib/api";
import type { GateVerdict, ReleaseRecord } from "../lib/dlc";
import type { Signal } from "./ui";

export function agentSignal(agent: Pick<AgentInfo, "status">): Signal {
  switch (agent.status) {
    case "active":
      return "ok";
    case "deploying":
      return "wait";
    case "failed":
      return "act";
    default:
      return "off";
  }
}

export function gateSignal(verdict: GateVerdict | null | undefined): Signal {
  if (verdict === "PASS") return "ok";
  if (verdict === "BLOCKED") return "act";
  // INVALID is not a failure but it does need someone to fix the evidence
  if (verdict === "INVALID") return "wait";
  return "off";
}

export function releaseSignal(decision: ReleaseRecord["decision"] | null | undefined): Signal {
  switch (decision) {
    case "released":
      return "ok";
    case "pending":
    case "open":
      return "wait";
    case "blocked":
    case "invalid":
      return "act";
    default:
      return "off";
  }
}

/** One item in the "needs you" queue: what happened, how urgent, where to act. */
export interface Attention {
  key: string;
  signal: Signal;
  /** sorts the queue: lower first */
  rank: number;
  agentId: string;
  agentName: string;
  kind: "deploy_failed" | "release_waiting" | "gate_invalid" | "gate_blocked" | "deploying";
  at: string | null;
}

export function attentionFor(
  agent: Pick<AgentInfo, "id" | "name" | "display_name" | "status" | "updated_at">,
  pending: Pick<ReleaseRecord, "decision" | "gate_report" | "created_at"> | null,
): Attention[] {
  const name = agent.display_name || agent.name;
  const base = { agentId: agent.id, agentName: name };
  const out: Attention[] = [];
  if (agent.status === "failed") {
    out.push({ ...base, key: `${agent.id}:failed`, signal: "act", rank: 0, kind: "deploy_failed", at: agent.updated_at });
  } else if (agent.status === "deploying") {
    out.push({ ...base, key: `${agent.id}:deploying`, signal: "wait", rank: 4, kind: "deploying", at: agent.updated_at });
  }
  if (pending) {
    const verdict = (pending.gate_report as { verdict?: GateVerdict } | undefined)?.verdict;
    if (verdict === "BLOCKED") {
      out.push({ ...base, key: `${agent.id}:blocked`, signal: "act", rank: 1, kind: "gate_blocked", at: pending.created_at });
    } else if (verdict === "INVALID") {
      out.push({ ...base, key: `${agent.id}:invalid`, signal: "wait", rank: 2, kind: "gate_invalid", at: pending.created_at });
    } else if (pending.decision === "pending" || pending.decision === "open") {
      out.push({ ...base, key: `${agent.id}:waiting`, signal: "wait", rank: 3, kind: "release_waiting", at: pending.created_at });
    }
  }
  return out;
}

export function sortAttention(items: Attention[]): Attention[] {
  return [...items].sort((a, b) => a.rank - b.rank || (b.at ?? "").localeCompare(a.at ?? ""));
}
