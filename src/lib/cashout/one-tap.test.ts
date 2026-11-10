import { describe, expect, it } from "vitest";
import { planOneTap } from "./one-tap";

describe("one-tap cash-out plan", () => {
  it("takes every sendable balance when the total is under the $1,000 order cap", () => {
    const plan = planOneTap(
      [
        { key: "tsd", chain: "txc", usd: 147.85 },
        { key: "base-usdc", chain: "base", usd: 40 },
      ],
      1000,
    );
    expect(plan.keys).toEqual(["tsd", "base-usdc"]);
    expect(plan.amounts).toEqual({});
    expect(plan.total).toBe(187.85);
  });

  it("stops at $1,000 and sends only part of the last balance", () => {
    const plan = planOneTap(
      [
        { key: "a", chain: "base", usd: 700 },
        { key: "b", chain: "bsc", usd: 500 },
        { key: "c", chain: "txc", usd: 50 },
      ],
      1000,
    );
    expect(plan.keys).toEqual(["a", "b"]);
    expect(plan.amounts).toEqual({ b: "300.00" });
    expect(plan.total).toBe(1000);
  });

  it("skips balances that can't pay their network fee", () => {
    const plan = planOneTap([{ key: "x", chain: "base", usd: 25, blocked: "Needs a little ETH" }], 1000);
    expect(plan.keys).toEqual([]);
    expect(plan.total).toBe(0);
  });

  it("skips Ethereum balances under $10 (the fee would eat them)", () => {
    const plan = planOneTap(
      [
        { key: "eth-small", chain: "eth", usd: 9.5 },
        { key: "eth-big", chain: "eth", usd: 10 },
      ],
      1000,
    );
    expect(plan.keys).toEqual(["eth-big"]);
  });
});
