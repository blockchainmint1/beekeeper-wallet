import { describe, expect, it } from "vitest";
import { capAtBalance, checkEvmTransferTx, checkTsdSend, decodeErc20TransferInput, unitsToUsd } from "./verify";

const FROM = "0x1111111111111111111111111111111111111111";
const DEPOSIT = "0x2222222222222222222222222222222222222222";
const OTHER = "0x3333333333333333333333333333333333333333";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

function transferInput(to: string, raw: bigint) {
  return "0xa9059cbb" + to.slice(2).toLowerCase().padStart(64, "0") + raw.toString(16).padStart(64, "0");
}

describe("cash-out amounts come from the blockchain, not the wallet", () => {
  it("a $10 USDC send counts as $10 even if the wallet claims $1,000", () => {
    const tx = { from: FROM, to: USDC_BASE, input: transferInput(DEPOSIT, 10_000_000n) }; // 10 USDC, 6 decimals
    const r = checkEvmTransferTx(tx, "0x1", { from: FROM, to: DEPOSIT, token: USDC_BASE });
    expect(r).toEqual({ ok: true, raw: 10_000_000n });
    expect(unitsToUsd(10_000_000n, 6)).toBe(10);
  });

  it("a send to someone else's address counts for nothing", () => {
    const tx = { from: FROM, to: USDC_BASE, input: transferInput(OTHER, 10_000_000n) };
    expect(checkEvmTransferTx(tx, null, { from: FROM, to: DEPOSIT, token: USDC_BASE }).ok).toBe(false);
  });

  it("a send that failed on chain counts for nothing", () => {
    const tx = { from: FROM, to: USDC_BASE, input: transferInput(DEPOSIT, 10_000_000n) };
    expect(checkEvmTransferTx(tx, "0x0", { from: FROM, to: DEPOSIT, token: USDC_BASE })).toEqual({ ok: false, reason: "failed on chain" });
  });

  it("someone else's txid can't be claimed", () => {
    const tx = { from: OTHER, to: USDC_BASE, input: transferInput(DEPOSIT, 10_000_000n) };
    expect(checkEvmTransferTx(tx, "0x1", { from: FROM, to: DEPOSIT, token: USDC_BASE }).ok).toBe(false);
  });

  it("BSC 18-decimal amounts round down to the cent", () => {
    expect(unitsToUsd(12_345_678_900_000_000_000n, 18)).toBe(12.34);
  });

  it("before sending, a $1,000 claim is cut to the $10 the address really holds", () => {
    expect(capAtBalance(1000, 10)).toBe(10);
    expect(capAtBalance(5, 10)).toBe(5);
  });

  it("TSD sends count only when they go from the holder to our deposit address", () => {
    const send = { propertyId: 39, amount: 2_500_000_000n, sender: "Tholder", reference: "Tdeposit" };
    expect(checkTsdSend(send, { from: "Tholder", to: "Tdeposit" })).toEqual({ ok: true, raw: 2_500_000_000n });
    expect(unitsToUsd(2_500_000_000n, 8)).toBe(25);
    expect(checkTsdSend({ ...send, reference: "Tother" }, { from: "Tholder", to: "Tdeposit" }).ok).toBe(false);
    expect(checkTsdSend({ ...send, propertyId: 3 }, { from: "Tholder", to: "Tdeposit" }).ok).toBe(false);
  });

  it("rejects calldata that isn't a plain transfer", () => {
    expect(decodeErc20TransferInput("0x095ea7b3" + "0".repeat(128))).toBeNull();
  });
});

describe("only confirmed transfers count (round-2 audit 2.1)", () => {
  it("a transfer that hasn't been mined yet isn't counted until it confirms", () => {
    const tx = { from: FROM, to: USDC_BASE, input: transferInput(DEPOSIT, 10_000_000n) };
    expect(checkEvmTransferTx(tx, null, { from: FROM, to: DEPOSIT, token: USDC_BASE })).toEqual({ ok: false, reason: "pending" });
  });

  it("a look-alike token sent to the deposit address counts for nothing", () => {
    const FAKE = "0x4444444444444444444444444444444444444444";
    const tx = { from: FROM, to: FAKE, input: transferInput(DEPOSIT, 1_000_000_000n) };
    expect(checkEvmTransferTx(tx, "0x1", { from: FROM, to: DEPOSIT, token: USDC_BASE })).toEqual({ ok: false, reason: "not a transfer of this coin" });
  });
});
