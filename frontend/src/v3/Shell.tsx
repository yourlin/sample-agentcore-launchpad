import "@fontsource-variable/archivo/wdth.css";
import "./v3.css";

import { ArrowLeftRight, Bot, ChevronRight, LayoutDashboard, LogOut, MessagesSquare, Scale, Search } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, NavLink, Outlet, useNavigate } from "react-router-dom";

import { useAuth } from "../auth/auth-context";
import { RouteChunk } from "../layout/RouteChunk";
import { api } from "../lib/api";
import { setUiVersion } from "../lib/ui-version";
import { useWorkspace } from "../workspace/workspace-context";
import { type Command, CommandPalette } from "./CommandPalette";
import { ToastProvider } from "./ui";
import { useLoad } from "./hooks";
import { inV2Groups } from "./nav";

const RAIL_KEY = "launchpad_v3_rail_open";

function readOpen(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(RAIL_KEY) ?? "{}") as Record<string, boolean>;
  } catch {
    return {};
  }
}

interface RailItem {
  to: string;
  labelKey: string;
  icon: ReactNode;
  end?: boolean;
}

const NATIVE: RailItem[] = [
  { to: "/v3", labelKey: "v3.nav.home", icon: <LayoutDashboard size={16} />, end: true },
  { to: "/v3/agents", labelKey: "v3.nav.agents", icon: <Bot size={16} /> },
  { to: "/v3/chat", labelKey: "v3.nav.chat", icon: <MessagesSquare size={16} /> },
  { to: "/v3/gate", labelKey: "v3.nav.gate", icon: <Scale size={16} /> },
];

function WorkspaceSwitch() {
  const { t } = useTranslation();
  const { workspaces, current, select } = useWorkspace();
  if (workspaces.length === 0) return null;
  return (
    <label className="v3-ws" data-tier={current?.tier ?? "dev"} title={t("v3.top.workspace")}>
      <span style={{ color: "var(--v3-text-3)" }}>ws</span>
      <select value={current?.id ?? ""} onChange={(e) => select(e.target.value)} aria-label={t("v3.top.workspace")}>
        {workspaces.map((ws) => (
          <option key={ws.id} value={ws.id}>
            {ws.name} · {ws.region}
            {ws.tier && ws.tier !== "dev" ? ` · ${ws.tier}` : ""}
          </option>
        ))}
      </select>
    </label>
  );
}

function Lang() {
  const { i18n } = useTranslation();
  const zh = (i18n.resolvedLanguage ?? "en").startsWith("zh");
  return (
    <button
      type="button"
      className="v3-btn ghost sm mono"
      onClick={() => void i18n.changeLanguage(zh ? "en" : "zh-CN")}
      aria-label={zh ? "English" : "中文"}
    >
      {zh ? "EN" : "中"}
    </button>
  );
}

/**
 * Console V3 — the command center. A fixed top bar (brand, ⌘K, workspace,
 * language, V2 switch, account) over a rail and the page. Pages V3 has not
 * rebuilt are still in the rail, marked, and open in V2 rather than being
 * wrapped in a shell whose look they do not share.
 */
export function V3Shell() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { isAdmin, authRequired, username, logout } = useAuth();
  const { current } = useWorkspace();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const agents = useLoad(() => api.listAgents(), `v3-shell-agents:${current?.id ?? ""}`);

  // Opening a /v3 page is choosing V3 — reloads and "/" land back here.
  useEffect(() => {
    setUiVersion("v3");
    document.body.classList.add("v3-body");
    return () => document.body.classList.remove("v3-body");
  }, []);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const typing = /input|textarea|select/i.test((e.target as HTMLElement)?.tagName ?? "");
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((open) => !open);
      } else if (e.key === "/" && !typing) {
        e.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const backToV2 = () => {
    setUiVersion("v2");
    navigate("/v2");
  };

  const inV2 = useMemo(() => inV2Groups(isAdmin), [isAdmin]);
  // V2's groups start folded: the rail leads with what V3 does natively
  const [open, setOpen] = useState<Record<string, boolean>>(readOpen);
  const toggle = (key: string) =>
    setOpen((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      try {
        localStorage.setItem(RAIL_KEY, JSON.stringify(next));
      } catch {
        // per-browser convenience only
      }
      return next;
    });

  const pages = useMemo<Command[]>(() => {
    const group = t("v3.cmdk.pages");
    const all = [
      ...NATIVE.map((item) => ({ to: item.to, labelKey: item.labelKey, icon: item.icon, v2: false })),
      ...inV2.flatMap((g) =>
        g.items.map(({ to, labelKey, icon: Icon }) => ({ to, labelKey, icon: <Icon size={16} />, v2: true })),
      ),
    ];
    return all.map((item) => ({
      id: `p:${item.to}`,
      group,
      label: t(item.labelKey),
      hint: item.v2 ? "V2" : undefined,
      icon: item.icon,
      // the English name and the route, so "chat" finds 对话 under zh-CN
      keywords: `${t(item.labelKey, { lng: "en" })} ${item.to.replace(/[/?=&]/g, " ")}`,
      run: () => navigate(item.to),
    }));
  }, [inV2, navigate, t]);

  const closePalette = useCallback(() => setPaletteOpen(false), []);
  const displayName = authRequired ? (username ?? "—") : "operator";
  const failing = (agents.data?.agents ?? []).filter((a) => a.status === "failed").length;

  return (
    <div className="v3" data-testid="v3-shell">
      <div className="v3-atmos" aria-hidden="true" />
      <ToastProvider>
        <header className="v3-top">
          <Link to="/v3" className="v3-brand">
            <span className="v3-brand-mark" aria-hidden="true" />
            Launchpad
            <sup>V3</sup>
          </Link>
          <button type="button" className="v3-cmdk-trigger" onClick={() => setPaletteOpen(true)}>
            <Search size={15} aria-hidden="true" />
            {t("v3.top.search")}
            <kbd>⌘K</kbd>
          </button>
          <div className="v3-top-right">
            <WorkspaceSwitch />
            <Lang />
            <button type="button" className="v3-btn sm" onClick={backToV2} data-testid="v3-switch-v2">
              <ArrowLeftRight size={13} aria-hidden="true" />
              {t("v3.switch.back")}
            </button>
            <span className="v3-chip" title={displayName}>
              {displayName}
            </span>
            {authRequired && (
              <button type="button" className="v3-btn ghost sm" onClick={() => void logout()} aria-label={t("auth.logout")}>
                <LogOut size={14} />
              </button>
            )}
          </div>
        </header>

        <nav className="v3-rail" aria-label={t("v3.nav.label")}>
          {NATIVE.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.end} className={({ isActive }) => (isActive ? "on" : "")}>
              {item.icon}
              {t(item.labelKey)}
              {item.to === "/v3/agents" && failing > 0 && <span className="count">{failing}</span>}
            </NavLink>
          ))}
          <div className="v3-rail-label" title={t("v3.nav.inV2Hint")}>{t("v3.nav.inV2")}</div>
          {inV2.map((group) => {
            const isOpen = open[group.key] === true;
            return (
              <div key={group.key} className="v3-rail-group">
                <button
                  type="button"
                  className="v3-rail-item v3-rail-group-head"
                  aria-expanded={isOpen}
                  onClick={() => toggle(group.key)}
                  data-testid={`v3-rail-group-${group.key}`}
                >
                  <ChevronRight size={14} className="chev" aria-hidden="true" />
                  {t(group.labelKey)}
                  <span className="ext">{group.items.length}</span>
                </button>
                {isOpen &&
                  group.items.map((item) => {
                    const Icon = item.icon;
                    return (
                      <Link key={item.to} to={item.to} title={t("v3.nav.inV2Hint")} className="v3-rail-sub">
                        <Icon size={15} aria-hidden="true" />
                        {t(item.labelKey)}
                        <span className="ext">V2</span>
                      </Link>
                    );
                  })}
              </div>
            );
          })}
          <div className="v3-rail-foot">
            <span className="mono" style={{ color: "var(--v3-text-3)", fontSize: 11 }}>
              {current ? `${current.region}` : ""}
            </span>
          </div>
        </nav>

        <main className="v3-main">
          <RouteChunk>
            <Outlet />
          </RouteChunk>
        </main>

        <CommandPalette open={paletteOpen} onClose={closePalette} agents={agents.data?.agents ?? []} pages={pages} />
      </ToastProvider>
    </div>
  );
}
