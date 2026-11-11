/**
 * Pure checks used by the server to settle cash-out amounts from the chain
 * (deep-scan finding "Anyone can set the cash-out amount"). The wallet's own
 * numbers are never trusted: before coins move an amount is capped at the
 * sending address's real balance, and once a txid exists the amount is
 * replaced by what that transaction actually moves to our deposit address.
 */
export const TSD_PROPERTY_ID = 39;
const TRANSFER_SELECTOR = "a9059cbb"; // transfer(address,uint256)

/**
 * Confirmations a transfer must have before its amount settles
 * (round-2 audit 3.2): a mined-but-shallow tx can still be reorged out.
 */
export const MIN_EVM_CONFIRMATIONS = 12;
export const MIN_TSD_CONFIRMATIONS = 3;

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
  /** Blocks since the tx was mined; null when the node couldn't say. */
  confirmations: number | null,
): { ok: true; raw: bigint } | { ok: false; reason: string } {
  if (!tx) return { ok: false, reason: "not found" };
  if (receiptStatus === "0x0") return { ok: false, reason: "failed on chain" };
  if ((tx.from ?? "").toLowerCase() !== want.from.toLowerCase()) return { ok: false, reason: "sent from a different address" };
  if ((tx.to ?? "").toLowerCase() !== want.token.toLowerCase()) return { ok: false, reason: "not a transfer of this coin" };
  const call = decodeErc20TransferInput(tx.input ?? "");
  if (!call) return { ok: false, reason: "not a plain token transfer" };
  if (call.to.toLowerCase() !== want.to.toLowerCase()) return { ok: false, reason: "not sent to the cash-out address" };
  // Only a mined, successful and deep-enough transfer counts (round-2 audit
  // 2.1 + 3.2): a pending one could still be dropped or revert, and a shallow
  // one can still be reorged out.
  if (receiptStatus !== "0x1") return { ok: false, reason: "pending" };
  if (confirmations === null || confirmations < MIN_EVM_CONFIRMATIONS) return { ok: false, reason: "pending" };
  return { ok: true, raw: call.amount };
}

/** What our own TEXITcoin node answers for one Omni transaction. */
export interface OmniTxLike {
  valid?: boolean;
  confirmations?: number | string;
  amount?: string | number;
  [key: string]: unknown;
}

function omniField(tx: OmniTxLike, names: string[]): unknown {
  for (const key of Object.keys(tx)) {
    if (names.includes(key.toLowerCase())) return (tx as Record<string, unknown>)[key];
  }
  return undefined;
}

/** "147.85" → 14785000000 (TSD is 1e8 fixed point); 0 for anything odd. */
export function omniAmountToUnits(amount: string | number): bigint {
  const s = typeof amount === "number" ? amount.toFixed(8) : String(amount).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return 0n;
  const [whole, frac = ""] = s.split(".");
  try {
    return BigInt(whole + (frac + "00000000").slice(0, 8));
  } catch {
    return 0n;
  }
}

/**
 * Settle a TSD send from our node's own answer (round-2 audit 3.1). The public
 * explorer only says the tx exists: sender, reference, amount, validity and
 * depth all come from omni_gettransaction, and the send must be judged valid
 * by the TSD ledger and sit deep enough before any of it counts.
 */
export function checkOmniTx(
  tx: OmniTxLike | null,
  want: { from: string; to: string },
): { ok: true; raw: bigint } | { ok: false; reason: string } {
  if (!tx) return { ok: false, reason: "not found" };
  const property = Number(omniField(tx, ["propertyid", "property_id"]));
  if (property !== TSD_PROPERTY_ID) return { ok: false, reason: "not TSD" };
  const sender = String(omniField(tx, ["sendingaddress", "sender"]) ?? "");
  const reference = String(omniField(tx, ["referenceaddress", "reference"]) ?? "");
  if (sender !== want.from) return { ok: false, reason: "sent from a different address" };
  if (reference !== want.to) return { ok: false, reason: "not sent to the cash-out address" };
  if (tx.valid !== true) {
    return tx.valid === false ? { ok: false, reason: "rejected by the TSD ledger" } : { ok: false, reason: "pending" };
  }
  const conf = typeof tx.confirmations === "number" ? tx.confirmations : Number(tx.confirmations);
  if (!Number.isFinite(conf) || conf < MIN_TSD_CONFIRMATIONS) return { ok: false, reason: "pending" };
  const raw = omniAmountToUnits(tx.amount ?? "");
  if (raw <= 0n) return { ok: false, reason: "not a TSD amount" };
  return { ok: true, raw };
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
