import { describe, expect, it } from "vitest";
import {
  MIN_EVM_CONFIRMATIONS,
  MIN_TSD_CONFIRMATIONS,
  capAtBalance,
  checkEvmTransferTx,
  checkOmniTx,
  decodeErc20TransferInput,
  omniAmountToUnits,
  unitsToUsd,
} from "./verify";
import { confirmationsFrom } from "./verify.server";

const FROM = "0x1111111111111111111111111111111111111111";
const DEPOSIT = "0x2222222222222222222222222222222222222222";
const OTHER = "0x3333333333333333333333333333333333333333";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

function transferInput(to: string, raw: bigint) {
  return "0xa9059cbb" + to.slice(2).toLowerCase().padStart(64, "0") + raw.toString(16).padStart(64, "0");
}

const want = { from: FROM, to: DEPOSIT, token: USDC_BASE };
const mined = { from: FROM, to: USDC_BASE, input: transferInput(DEPOSIT, 10_000_000n) }; // 10 USDC, 6 decimals

describe("cash-out amounts come from the blockchain, not the wallet", () => {
  it("a $10 USDC send counts as $10 even if the wallet claims $1,000", () => {
    const r = checkEvmTransferTx(mined, "0x1", want, MIN_EVM_CONFIRMATIONS);
    expect(r).toEqual({ ok: true, raw: 10_000_000n });
    expect(unitsToUsd(10_000_000n, 6)).toBe(10);
  });

  it("a send to someone else's address counts for nothing", () => {
    const tx = { from: FROM, to: USDC_BASE, input: transferInput(OTHER, 10_000_000n) };
    expect(checkEvmTransferTx(tx, null, want, MIN_EVM_CONFIRMATIONS).ok).toBe(false);
  });

  it("a send that failed on chain counts for nothing", () => {
    expect(checkEvmTransferTx(mined, "0x0", want, MIN_EVM_CONFIRMATIONS)).toEqual({ ok: false, reason: "failed on chain" });
  });

  it("someone else's txid can't be claimed", () => {
    const tx = { from: OTHER, to: USDC_BASE, input: transferInput(DEPOSIT, 10_000_000n) };
    expect(checkEvmTransferTx(tx, "0x1", want, MIN_EVM_CONFIRMATIONS).ok).toBe(false);
  });

  it("BSC 18-decimal amounts round down to the cent", () => {
    expect(unitsToUsd(12_345_678_900_000_000_000n, 18)).toBe(12.34);
  });

  it("before sending, a $1,000 claim is cut to the $10 the address really holds", () => {
    expect(capAtBalance(1000, 10)).toBe(10);
    expect(capAtBalance(5, 10)).toBe(5);
  });

  it("rejects calldata that isn't a plain transfer", () => {
    expect(decodeErc20TransferInput("0x095ea7b3" + "0".repeat(128))).toBeNull();
  });
});

describe("only confirmed transfers count (round-2 audit 2.1)", () => {
  it("a transfer that hasn't been mined yet isn't counted until it confirms", () => {
    expect(checkEvmTransferTx(mined, null, want, MIN_EVM_CONFIRMATIONS)).toEqual({ ok: false, reason: "pending" });
  });

  it("a look-alike token sent to the deposit address counts for nothing", () => {
    const FAKE = "0x4444444444444444444444444444444444444444";
    const tx = { from: FROM, to: FAKE, input: transferInput(DEPOSIT, 1_000_000_000n) };
    expect(checkEvmTransferTx(tx, "0x1", want, MIN_EVM_CONFIRMATIONS)).toEqual({ ok: false, reason: "not a transfer of this coin" });
  });
});

describe("a mined transfer must sit deep enough to settle (round-2 audit 3.2)", () => {
  it("2 confirmations isn't counted yet", () => {
    expect(checkEvmTransferTx(mined, "0x1", want, 2)).toEqual({ ok: false, reason: "pending" });
  });

  it("exactly the minimum depth is counted", () => {
    expect(checkEvmTransferTx(mined, "0x1", want, MIN_EVM_CONFIRMATIONS)).toEqual({ ok: true, raw: 10_000_000n });
  });

  it("a node that can't tell us the depth counts for nothing", () => {
    expect(checkEvmTransferTx(mined, "0x1", want, null)).toEqual({ ok: false, reason: "pending" });
  });

  it("depth is blocks between the tx and the chain head", () => {
    expect(confirmationsFrom("0x65", "0x5e")).toBe(8); // head 101, mined 94
    expect(confirmationsFrom("0x5e", "0x5e")).toBe(1);
    expect(confirmationsFrom("0x5e", "0x65")).toBeNull(); // head behind the tx
    expect(confirmationsFrom(null, "0x5e")).toBeNull();
    expect(confirmationsFrom("0x5e", null)).toBeNull();
  });
});

describe("TSD settles from our own node, not the explorer (round-2 audit 3.1)", () => {
  const omni = {
    txid: "aa".repeat(32),
    valid: true,
    confirmations: 6,
    amount: "25.00000000",
    propertyid: 39,
    sendingaddress: "Tholder",
    referenceaddress: "Tdeposit",
  };

  it("a valid, deep send from the holder to our deposit address counts its real amount", () => {
    expect(checkOmniTx(omni, { from: "Tholder", to: "Tdeposit" })).toEqual({ ok: true, raw: 2_500_000_000n });
    expect(unitsToUsd(2_500_000_000n, 8)).toBe(25);
  });

  it("a send the TSD ledger hasn't judged yet counts for nothing", () => {
    expect(checkOmniTx({ ...omni, valid: undefined }, { from: "Tholder", to: "Tdeposit" })).toEqual({
      ok: false,
      reason: "pending",
    });
  });

  it("a send the ledger rejected counts for nothing", () => {
    expect(checkOmniTx({ ...omni, valid: false }, { from: "Tholder", to: "Tdeposit" })).toEqual({
      ok: false,
      reason: "rejected by the TSD ledger",
    });
  });

  it(`a send with fewer than ${MIN_TSD_CONFIRMATIONS} confirmations isn't counted yet`, () => {
    expect(checkOmniTx({ ...omni, confirmations: 1 }, { from: "Tholder", to: "Tdeposit" })).toEqual({
      ok: false,
      reason: "pending",
    });
    expect(checkOmniTx({ ...omni, confirmations: undefined }, { from: "Tholder", to: "Tdeposit" })).toEqual({
      ok: false,
      reason: "pending",
    });
  });

  it("a send of someone else's TSD counts for nothing", () => {
    expect(checkOmniTx({ ...omni, sendingaddress: "Tattacker" }, { from: "Tholder", to: "Tdeposit" })).toEqual({
      ok: false,
      reason: "sent from a different address",
    });
  });

  it("a send to someone else's address counts for nothing", () => {
    expect(checkOmniTx({ ...omni, referenceaddress: "Tother" }, { from: "Tholder", to: "Tdeposit" })).toEqual({
      ok: false,
      reason: "not sent to the cash-out address",
    });
  });

  it("a send of another coin counts for nothing", () => {
    expect(checkOmniTx({ ...omni, propertyid: 3 }, { from: "Tholder", to: "Tdeposit" })).toEqual({
      ok: false,
      reason: "not TSD",
    });
  });

  it("camelCase node fields are read the same way", () => {
    expect(
      checkOmniTx(
        { valid: true, confirmations: 6, amount: "1.5", propertyId: 39, sender: "Tholder", reference: "Tdeposit" },
        { from: "Tholder", to: "Tdeposit" },
      ),
    ).toEqual({ ok: true, raw: 150_000_000n });
  });

  it("decimal amounts become 1e8 fixed-point units", () => {
    expect(omniAmountToUnits("147.85")).toBe(14_785_000_000n);
    expect(unitsToUsd(omniAmountToUnits("147.85"), 8)).toBe(147.85);
    expect(omniAmountToUnits("0.00000001")).toBe(1n);
    expect(omniAmountToUnits("nonsense")).toBe(0n);
    expect(omniAmountToUnits("")).toBe(0n);
  });

  it("an amount we can't read counts for nothing", () => {
    expect(checkOmniTx({ ...omni, amount: "nonsense" }, { from: "Tholder", to: "Tdeposit" })).toEqual({
      ok: false,
      reason: "not a TSD amount",
    });
  });
});
