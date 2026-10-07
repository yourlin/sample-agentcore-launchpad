import { describe, expect, it } from "vitest";

import { V2_NAV } from "../v2/nav";
import { hostedGroups, isActive } from "./nav";

describe("hostedGroups", () => {
  it("reaches every V2 page V3 has not rebuilt", () => {
    const listed = new Set(hostedGroups(true).flatMap((g) => g.items.map((i) => i.to.split("?")[0])));
    const missing = V2_NAV.flatMap((g) => g.items)
      .map((i) => i.to)
      .filter((to) => to !== "/v2" && to !== "/v2/chat" && !listed.has(to));
    expect(missing).toEqual([]);
  });

  it("does not list a rebuilt page, and creating an agent opens the V2 wizard", () => {
    const items = hostedGroups(true).flatMap((g) => g.items);
    expect(items.map((i) => i.to)).not.toContain("/v2/chat");
    expect(items.find((i) => i.to.startsWith("/v2/agents"))?.to).toBe("/v2/agents?view=new");
  });

  it("hides administrator pages from members", () => {
    const admin = V2_NAV.flatMap((g) => g.items).filter((i) => i.admin).map((i) => i.to);
    const member = hostedGroups(false).flatMap((g) => g.items.map((i) => i.to));
    expect(member.filter((to) => admin.includes(to))).toEqual([]);
  });
});

describe("isActive", () => {
  it("matches a sub-page entry only on that sub-page", () => {
    const create = { to: "/v2/agents?view=new" };
    expect(isActive(create, "/v2/agents", "?view=new")).toBe(true);
    expect(isActive(create, "/v2/agents", "?view=detail&id=1")).toBe(false);
  });

  it("matches a path and its children and the classic paths it owns", () => {
    const registry = { to: "/v2/registry", also: ["/registry"] };
    expect(isActive(registry, "/v2/registry", "")).toBe(true);
    expect(isActive(registry, "/registry", "?view=x")).toBe(true);
    expect(isActive(registry, "/v2/registry-x", "")).toBe(false);
  });
});
