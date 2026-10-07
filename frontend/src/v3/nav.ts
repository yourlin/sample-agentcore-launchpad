import { V2_NAV } from "../v2/nav";
import type { V2NavItem } from "../v2/nav";

/** V2 entries V3 has rebuilt natively — the rail shows the V3 page instead. */
const REBUILT = new Set(["/v2", "/v2/chat"]);

/**
 * V2's agent list is rebuilt in V3, but creating an agent is not: that entry
 * becomes "New agent", straight into the V2 wizard.
 */
const RETARGET: Record<string, Pick<V2NavItem, "to" | "labelKey">> = {
  "/v2/agents": { to: "/v2/agents?view=new", labelKey: "v3.nav.create" },
};

export interface V3InV2Group {
  key: string;
  labelKey: string;
  items: V2NavItem[];
}

/**
 * Every V2 page V3 has not rebuilt, in V2's own groups. Derived from `V2_NAV`
 * so a page added to V2 shows up here too, instead of becoming unreachable
 * from V3.
 */
export function inV2Groups(isAdmin: boolean): V3InV2Group[] {
  return V2_NAV.map((group) => ({
    key: group.key,
    labelKey: group.labelKey,
    items: group.items
      .filter((item) => !REBUILT.has(item.to) && (!item.admin || isAdmin))
      .map((item) => ({ ...item, ...RETARGET[item.to] })),
  })).filter((group) => group.items.length > 0);
}
