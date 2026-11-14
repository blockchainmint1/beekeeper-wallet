import { describe, expect, it } from "vitest";
import { kycIdempotencyKey } from "./idempotency";

const base = { env: "sandbox", address: "TWallet1", fullName: "Ana Diaz", email: "ana@example.com", type: "individual" };

describe("one ID check per wallet on a double submit (round-4 audit B6)", () => {
  it("gives the same key for the same wallet and details", async () => {
    expect(await kycIdempotencyKey(base)).toBe(await kycIdempotencyKey({ ...base, email: " ANA@example.com " }));
  });
  it("gives a new key when the customer corrects their details", async () => {
    expect(await kycIdempotencyKey(base)).not.toBe(await kycIdempotencyKey({ ...base, email: "ana.diaz@example.com" }));
  });
  it("never shares a key between wallets or test/live", async () => {
    const k = await kycIdempotencyKey(base);
    expect(await kycIdempotencyKey({ ...base, address: "TWallet2" })).not.toBe(k);
    expect(await kycIdempotencyKey({ ...base, env: "live" })).not.toBe(k);
  });
});
