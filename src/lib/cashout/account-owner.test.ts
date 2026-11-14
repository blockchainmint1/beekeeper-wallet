import { describe, expect, it } from "vitest";
import { ownerDecision } from "./account-owner";

describe("bank details stay with the wallet that first claimed the customer ID (round-4 audit N2)", () => {
  it("lets the first signed wallet claim an unowned customer ID", () => {
    expect(ownerDecision(null, "TOwner")).toBe("claim");
  });
  it("lets the same wallet back in every time", () => {
    expect(ownerDecision("TOwner", "TOwner")).toBe("ok");
  });
  it("refuses a different wallet asking about someone else's customer ID", () => {
    expect(ownerDecision("TOwner", "TSomeoneElse")).toBe("other-wallet");
  });
});
