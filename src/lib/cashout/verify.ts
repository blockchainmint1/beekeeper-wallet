/**
 * Pure checks used by the server to settle cash-out amounts from the chain
 * (deep-scan finding "Anyone can set the cash-out amount"). The wallet's own
 * numbers are never trusted: before coins move an amount is capped at the
 * sending address's real balance, and once a txid exists the amount is
 * replaced by what that transaction actually moves to our deposit address.
 */
import type { OmniSend } from "@/lib/txc/omni-decode";

export const TSD_PROPERTY_ID = 39;
const TRANSFER_SELECTOR = "a9059cbb"; // transfer(address,uint256)

/** Decode ERC-20 `transfer(to, amount)` calldata. */
export function decodeErc20TransferInput(input: string): { to: string; amount: bigint } | null {
  const hex = input.toLowerCase().replace(/^0x/, "");
  if (hex.length !== 8 + 64 * 2 || !hex.startsWith(TRANSFER_SELECTOR)) return null;
  const toWord = hex.slice(8, 72);
  if (!/^0{24}/.test(toWord)) return null;
  try {
    return { to: `0x${toWord.slice(24)}`, amount: BigInt(`0x${hex.slice(72, 136)}`) };
  } catch {
    return null;
  }
}

export interface EvmTxLike {
  from?: string | null;
  to?: string | null;
  input?: string | null;
}

/** Raw token units this tx moves from `from` to `to`, or a short reason. */
export function checkEvmTransferTx(
  tx: EvmTxLike | null,
  receiptStatus: string | null,
  want: { from: string; to: string; token: string },
): { ok: true; raw: bigint } | { ok: false; reason: string } {
  if (!tx) return { ok: false, reason: "not found" };
  if (receiptStatus === "0x0") return { ok: false, reason: "failed on chain" };
  if ((tx.from ?? "").toLowerCase() !== want.from.toLowerCase()) return { ok: false, reason: "sent from a different address" };
  if ((tx.to ?? "").toLowerCase() !== want.token.toLowerCase()) return { ok: false, reason: "not a transfer of this coin" };
  const call = decodeErc20TransferInput(tx.input ?? "");
  if (!call) return { ok: false, reason: "not a plain token transfer" };
  if (call.to.toLowerCase() !== want.to.toLowerCase()) return { ok: false, reason: "not sent to the cash-out address" };
  return { ok: true, raw: call.amount };
}

/** TSD units (1e8 fixed point) this Omni send moves from `from` to `to`. */
export function checkTsdSend(
  send: OmniSend | null,
  want: { from: string; to: string },
): { ok: true; raw: bigint } | { ok: false; reason: string } {
  if (!send) return { ok: false, reason: "not a TSD send" };
  if (send.propertyId !== TSD_PROPERTY_ID) return { ok: false, reason: "not TSD" };
  if (send.sender !== want.from) return { ok: false, reason: "sent from a different address" };
  if (send.reference !== want.to) return { ok: false, reason: "not sent to the cash-out address" };
  return { ok: true, raw: send.amount };
}

/** Raw units → whole dollars, rounded DOWN to the cent so we never overstate. */
export function unitsToUsd(raw: bigint, decimals: number): number {
  if (raw <= 0n) return 0;
  const cents = decimals >= 2 ? raw / 10n ** BigInt(decimals - 2) : raw * 10n ** BigInt(2 - decimals);
  return Number(cents) / 100;
}

/** Wallet-claimed amount, capped at what the chain says. */
export function capAtBalance(claimed: number, balanceUsd: number): number {
  const c = Number.isFinite(claimed) && claimed > 0 ? Math.floor(claimed * 100) / 100 : 0;
  return Math.max(0, Math.min(c, balanceUsd));
}
