import { describe, expect, it } from "vitest";
import { mayClaimAfterRedeem, ownerDecision } from "./account-owner";

describe("who owns a VectorPay customer ID (round-4 N2, round-5 §3)", () => {
  it("a link code can claim an unowned customer ID", () => {
    expect(ownerDecision(null, "TOwner", "redeem")).toBe("claim");
  });
  it("a plain status check never claims an unowned customer ID", () => {
    expect(ownerDecision(null, "TAnyone", "lookup")).toBe("unclaimed");
  });
  it("lets the owning wallet back in on link and on status", () => {
    expect(ownerDecision("TOwner", "TOwner", "redeem")).toBe("ok");
    expect(ownerDecision("TOwner", "TOwner", "lookup")).toBe("ok");
  });
  it("refuses a different wallet on link and on status", () => {
    expect(ownerDecision("TOwner", "TSomeoneElse", "redeem")).toBe("other-wallet");
    expect(ownerDecision("TOwner", "TSomeoneElse", "lookup")).toBe("other-wallet");
  });
  it("claims only after VectorPay accepts the code", () => {
    expect(mayClaimAfterRedeem("claim", { ok: true, linked: true })).toBe(true);
    expect(mayClaimAfterRedeem("claim", { ok: false, linked: false })).toBe(false);
    expect(mayClaimAfterRedeem("claim", { ok: true, linked: false })).toBe(false);
    expect(mayClaimAfterRedeem("ok", { ok: true, linked: true })).toBe(false);
  });
});

describe("placing a cash-out order uses the same owner rule (round-7 sign-off §2)", () => {
  it("an order for an unclaimed customer ID is sent to confirm with a code, not placed", () => {
    expect(ownerDecision(null, "TAnyone", "lookup")).toBe("unclaimed");
  });
  it("an order from a different wallet than the recorded owner is refused", () => {
    expect(ownerDecision("TOwner", "TSomeoneElse", "lookup")).toBe("other-wallet");
  });
});
