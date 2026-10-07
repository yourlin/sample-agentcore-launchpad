import { V2_NAV } from "../v2/nav";
import type { V2NavItem } from "../v2/nav";

/** V2 entries V3 has rebuilt natively — the rail shows the V3 page instead. */
const REBUILT = new Set(["/v2", "/v2/chat"]);

/**
 * V2's agent list is rebuilt in V3, but creating an agent is not: that entry
 * becomes "New agent", the wizard hosted in V3.
 */
const RETARGET: Record<string, Pick<V2NavItem, "to" | "labelKey">> = {
  "/v2/agents": { to: "/v2/agents?view=new", labelKey: "v3.nav.create" },
};

export interface V3ModuleGroup {
  key: string;
  labelKey: string;
  items: V2NavItem[];
}

/**
 * Every module page V3 hosts (renders inside its own shell, on its theme) rather
 * than redesigns, in V2's groups. Derived from `V2_NAV` so a page added to V2
 * shows up in V3 too, instead of becoming unreachable from it.
 */
export function hostedGroups(isAdmin: boolean): V3ModuleGroup[] {
  return V2_NAV.map((group) => ({
    key: group.key,
    labelKey: group.labelKey,
    items: group.items
      .filter((item) => !REBUILT.has(item.to) && (!item.admin || isAdmin))
      .map((item) => ({ ...item, ...RETARGET[item.to] })),
  })).filter((group) => group.items.length > 0);
}

/** Same rule as V2's sidebar: a `?view=` entry is active only on that sub-page. */
export function isActive(item: Pick<V2NavItem, "to" | "also">, pathname: string, search: string): boolean {
  const [path, query] = item.to.split("?");
  if (query) {
    if (pathname !== path) return false;
    const have = new URLSearchParams(search);
    return [...new URLSearchParams(query)].every(([k, v]) => have.get(k) === v);
  }
  return [path, ...(item.also ?? [])].some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}
