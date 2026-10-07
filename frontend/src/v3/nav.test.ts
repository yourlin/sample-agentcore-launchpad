import { describe, expect, it } from "vitest";

import { V2_NAV } from "../v2/nav";
import { inV2Groups } from "./nav";

describe("inV2Groups", () => {
  it("reaches every V2 page V3 has not rebuilt", () => {
    const listed = new Set(inV2Groups(true).flatMap((g) => g.items.map((i) => i.to.split("?")[0])));
    const missing = V2_NAV.flatMap((g) => g.items)
      .map((i) => i.to)
      .filter((to) => to !== "/v2" && to !== "/v2/chat" && !listed.has(to));
    expect(missing).toEqual([]);
  });

  it("does not list a rebuilt page, and creating an agent opens the V2 wizard", () => {
    const items = inV2Groups(true).flatMap((g) => g.items);
    expect(items.map((i) => i.to)).not.toContain("/v2/chat");
    expect(items.find((i) => i.to.startsWith("/v2/agents"))?.to).toBe("/v2/agents?view=new");
  });

  it("hides administrator pages from members", () => {
    const admin = V2_NAV.flatMap((g) => g.items).filter((i) => i.admin).map((i) => i.to);
    const member = inV2Groups(false).flatMap((g) => g.items.map((i) => i.to));
    expect(member.filter((to) => admin.includes(to))).toEqual([]);
  });
});
