import { describe, expect, it } from "vitest";

import { type CostEstimate, compoundRate, gateTone, kappaTone, tierTone, unpricedJudges } from "./dlc";

describe("compoundRate", () => {
  it("multiplies the gates, which is the number nobody types on purpose", () => {
    // the design's worked example: eight 95% gates let 66% of sessions through
    const eight = compoundRate(Array.from({ length: 8 }, () => 0.95));
    expect(eight).not.toBeNull();
    expect(eight as number).toBeCloseTo(0.6634, 4);
  });

  it("is the single threshold when there is only one gate", () => {
    expect(compoundRate([0.9])).toBeCloseTo(0.9, 10);
  });

  it("says nothing rather than 1.0 when no gate has a threshold", () => {
    // a metric gate carries a bound, not a rate: counting it as 1.0 would make a
    // table of metric gates look like a certainty
    expect(compoundRate([])).toBeNull();
    expect(compoundRate([0, 1.5, Number.NaN])).toBeNull();
  });

  it("ignores unusable thresholds instead of poisoning the product", () => {
    expect(compoundRate([0.9, 0, 2])).toBeCloseTo(0.9, 10);
  });
});

describe("kappaTone", () => {
  it("follows the Landis–Koch bands", () => {
    expect(kappaTone(0.85)).toBe("green");
    expect(kappaTone(0.8)).toBe("green");
    expect(kappaTone(0.61)).toBe("blue");
    expect(kappaTone(0.45)).toBe("orange");
    expect(kappaTone(0.1)).toBe("red");
    expect(kappaTone(-0.2)).toBe("red");
  });

  it("is grey when there is no measurement, not green", () => {
    expect(kappaTone(null)).toBe("gray");
  });
});

describe("gateTone", () => {
  it("keeps 'cannot decide' visually apart from 'failed'", () => {
    expect(gateTone("BLOCKED")).toBe("red");
    expect(gateTone("INVALID")).toBe("orange");
    expect(gateTone("PASS")).toBe("green");
    expect(gateTone("WAIVED")).toBe("blue");
    expect(gateTone("OBSERVED")).toBe("gray");
    expect(gateTone(null)).toBe("gray");
  });
});

describe("tierTone", () => {
  it("colours a red line as a red line", () => {
    expect(tierTone("redline")).toBe("red");
    expect(tierTone("gate")).toBe("orange");
    expect(tierTone("observe")).toBe("gray");
  });
});

describe("unpricedJudges", () => {
  const base = { judges: [] } as unknown as CostEstimate;
  it("names the self-billed judges the price map cannot value", () => {
    const est = { ...base, judges: [
      { evaluator_id: "Builtin.Correctness", billed_by: "agentcore_evaluations", usd: null },
      { evaluator_id: "fee-check", billed_by: "your_account", usd: null, note: "judge model is not in the price map" },
      { evaluator_id: "privacy", billed_by: "your_account", usd: 0.12 },
    ] } as CostEstimate;
    // the service-billed builtin is not "unpriced": it is not this account's bill
    expect(unpricedJudges(est).map((j) => j.evaluator_id)).toEqual(["fee-check"]);
  });
  it("is empty without an estimate", () => {
    expect(unpricedJudges(null)).toEqual([]);
    expect(unpricedJudges(base)).toEqual([]);
  });
});
