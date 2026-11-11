import { describe, expect, it } from "vitest";
import { bridgeBaseUrl, bridgeEnvForKey, bridgeFeeString, topupQuote, TOPUP_FEE_PERCENT } from "./fees";

describe("top-up fee", () => {
  it("is 3% for everyone", () => {
    expect(TOPUP_FEE_PERCENT).toBe(3);
    expect(bridgeFeeString()).toBe("3.0");
  });
  it("a $50 deposit keeps $48.50 after the $1.50 fee (matches Bridge sandbox)", () => {
    expect(topupQuote(50)).toEqual({ feeUsd: 1.5, netUsd: 48.5, belowMinimum: false });
  });
  it("a $1 deposit is under Bridge's $1 minimum once the fee is taken", () => {
    expect(topupQuote(1).belowMinimum).toBe(true);
    expect(topupQuote(1.04).belowMinimum).toBe(false);
  });
});

describe("Bridge environment", () => {
  it("a sk-test key only ever reaches the sandbox", () => {
    expect(bridgeEnvForKey("sk-test-abc")).toBe("sandbox");
    expect(bridgeBaseUrl(bridgeEnvForKey("sk-test-abc"))).toBe("https://api.sandbox.bridge.xyz/v0");
  });
  it("any other key is live", () => {
    expect(bridgeEnvForKey("sk-live-abc")).toBe("live");
    expect(bridgeBaseUrl("live")).toBe("https://api.bridge.xyz/v0");
  });
});
