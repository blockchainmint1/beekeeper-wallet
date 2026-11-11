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

describe("a one-tap line that gets cut sends only the cut amount", () => {
  it("TSD: $1,200 held, $1,000 cap → 1,000 TSD go out, not 1,200", async () => {
    const { appliedAmount } = await import("./one-tap");
    const plan = planOneTap([{ key: "t:tsd", chain: "txc", usd: 1200 }], 1000);
    expect(plan.amounts["t:tsd"]).toBe("1000.00");
    const row = appliedAmount({ key: "t:tsd", usd: 1200, coinAmount: 1200 }, plan.amounts);
    expect(row.coinAmount).toBe(1000);
  });

  it("USDC: $300 held behind a $900 TSD line → only $100 of the USDC goes out", async () => {
    const { appliedAmount } = await import("./one-tap");
    const plan = planOneTap([{ key: "t:tsd", chain: "txc", usd: 900 }, { key: "e:usdc", chain: "base", usd: 300 }], 1000);
    const row = appliedAmount({ key: "e:usdc", usd: 300, coinAmount: 300, evm: { raw: 300_000_000n, token: { decimals: 6 } } }, plan.amounts);
    expect(row.coinAmount).toBe(100);
  });
});
