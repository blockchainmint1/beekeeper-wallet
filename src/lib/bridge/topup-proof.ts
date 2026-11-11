/**
 * Every top-up request is signed by the wallet's TEXITcoin holder address
 * (m/44'/696969'/0'/0/0, a legacy T… address — the same one that receives
 * TSD). The server keys the customer's Bridge record by that address, so only
 * the wallet holding its private key can start, read or use the account.
 * Browser-safe: the wallet builds the message, the server checks it.
 */
import { verifyMessage as verifyTxcMessage } from "@/lib/txc/message-sign";

export const TOPUP_ACTIONS = ["status", "start", "history", "simulate-approval", "simulate-deposit"] as const;
export type TopupAction = (typeof TOPUP_ACTIONS)[number];

export interface TopupProofFields {
  action: TopupAction;
  /** TEXITcoin holder address (signer, and where TSD is delivered). */
  address: string;
  /** The wallet's main Base address (sandbox delivery address). */
  base: string;
  nonce: string;
  at: number;
}

export function topupMessage(p: TopupProofFields): string {
  return [
    "BeeKeeper top-up",
    `action: ${p.action}`,
    `address: ${p.address}`,
    `base: ${p.base}`,
    `nonce: ${p.nonce}`,
    `time: ${p.at}`,
  ].join("\n");
}

/** A signed request is only good for a few minutes. */
export const TOPUP_PROOF_MAX_AGE_MS = 5 * 60_000;

/** null when the request is signed by `address` for `action` and still fresh; otherwise a short reason. */
export function checkTopupProof(p: {
  action: TopupAction;
  address?: string;
  base?: string;
  message?: string;
  signature?: string;
  now?: number;
}): string | null {
  if (!p.address || !p.base || !p.message || !p.signature) return "missing wallet signature";
  if (!/^T[1-9A-HJ-NP-Za-km-z]{25,40}$/.test(p.address)) return "not a legacy TEXITcoin address";
  if (!/^0x[0-9a-fA-F]{40}$/.test(p.base)) return "not a Base address";
  const lines = p.message.split("\n");
  if (lines.length !== 6) return "message mismatch";
  const nonce = lines[4]!.startsWith("nonce: ") ? lines[4]!.slice(7).trim() : "";
  const at = lines[5]!.startsWith("time: ") ? Number(lines[5]!.slice(6)) : NaN;
  if (!/^[0-9a-f]{16,64}$/.test(nonce) || !Number.isFinite(at)) return "message mismatch";
  if (Math.abs((p.now ?? Date.now()) - at) > TOPUP_PROOF_MAX_AGE_MS) return "request expired — try again";
  const expected = topupMessage({ action: p.action, address: p.address, base: p.base, nonce, at });
  if (p.message !== expected) return "message mismatch";
  try {
    return verifyTxcMessage(p.address, p.message, p.signature) ? null : "signature does not match wallet";
  } catch {
    return "bad signature";
  }
}
