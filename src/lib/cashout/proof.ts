/**
 * Cash-out ownership proofs (docs/vectorpay-cashout-proof.md).
 *
 * The wallet signs one message per sending address; the BeeKeeper server now
 * checks every proof itself before it HMAC-signs the order to VectorPay, so
 * the server is no longer an open signing relay (audit 2026-11-09 M4).
 * VectorPay still re-verifies on its side.
 */
import { recoverMessageAddress } from "viem";
import { verifyMessage as verifyTxcMessage } from "@/lib/txc/message-sign";

/** Exact text that gets signed. VectorPay must rebuild it byte-for-byte. */
export function proofMessage(p: { reference: string; chain: string; asset: string; from: string; to: string; txids: string[] }) {
  return [
    "BeeKeeper cash-out proof",
    `order: ${p.reference}`,
    `chain: ${p.chain}`,
    `asset: ${p.asset}`,
    `from: ${p.from}`,
    `to: ${p.to}`,
    `txids: ${p.txids.join(",")}`,
  ].join("\n");
}

const EVM_CHAINS = new Set(["eth", "base", "bsc"]);

export interface ProofInput {
  reference: string;
  chain: string;
  asset: string;
  /** Deposit address the SERVER expects for this chain (not the caller's). */
  to: string;
  from?: string;
  txids?: string[];
  message?: string;
  signature?: string;
}

/**
 * Returns null when the proof is valid, otherwise a short reason.
 * EVM: EIP-191 personal_sign recovered locally (no RPC).
 * TXC (TSD): TEXITcoin BIP-137 signature from the Omni holder address.
 */
export async function checkCashoutProof(p: ProofInput): Promise<string | null> {
  if (!p.from || !p.message || !p.signature) return "missing proof";
  const isEvm = EVM_CHAINS.has(p.chain);
  if (!isEvm && !(p.chain === "txc" && p.asset === "TSD")) return "unsupported chain";

  const norm = (s: string) => (isEvm ? s.toLowerCase() : s);
  const expected = proofMessage({
    reference: p.reference,
    chain: p.chain,
    asset: p.asset,
    from: p.from,
    to: p.to,
    txids: p.txids ?? [],
  });
  // EVM addresses may differ only in checksum casing; everything else exact.
  const lines = p.message.split("\n");
  const want = expected.split("\n");
  if (lines.length !== want.length) return "proof message mismatch";
  for (let i = 0; i < want.length; i++) {
    const a = lines[i]!;
    const b = want[i]!;
    const caseless = isEvm && (b.startsWith("from: ") || b.startsWith("to: ") || b.startsWith("txids: "));
    if (caseless ? norm(a) !== norm(b) : a !== b) return "proof message mismatch";
  }

  try {
    if (isEvm) {
      if (!/^0x[0-9a-fA-F]{130}$/.test(p.signature)) return "bad signature";
      const signer = await recoverMessageAddress({ message: p.message, signature: p.signature as `0x${string}` });
      return signer.toLowerCase() === p.from.toLowerCase() ? null : "signature does not match sender";
    }
    return verifyTxcMessage(p.from, p.message, p.signature) ? null : "signature does not match sender";
  } catch {
    return "bad signature";
  }
}

/**
 * Bank-mask lookups have to prove the wallet behind the customer ID
 * (round-2 audit 2.4). The customer ID is derived from a private key, so
 * whoever holds it can look up that account's bank name and last-4 — but
 * nobody holding a stolen or guessed ID can, because they can't sign this.
 */
export function bankLookupMessage(p: { accountRef: string; address: string; nonce: string; at: number }) {
  return [
    "BeeKeeper bank lookup",
    `account: ${p.accountRef}`,
    `address: ${p.address}`,
    `nonce: ${p.nonce}`,
    `time: ${p.at}`,
  ].join("\n");
}

/** A signed lookup is only good for a few minutes, so it can't be replayed. */
export const LOOKUP_MAX_AGE_MS = 5 * 60_000;

/** null when the lookup is signed by the wallet and fresh; otherwise a short reason. */
export function checkBankLookup(p: {
  accountRef: string;
  address?: string;
  message?: string;
  signature?: string;
  now?: number;
}): string | null {
  if (!p.address || !p.message || !p.signature) return "missing wallet signature";
  const lines = p.message.split("\n");
  if (lines.length !== 5) return "lookup message mismatch";
  const nonce = lines[3]!.startsWith("nonce: ") ? lines[3]!.slice("nonce: ".length).trim() : "";
  const at = lines[4]!.startsWith("time: ") ? Number(lines[4]!.slice("time: ".length)) : NaN;
  if (!nonce || !Number.isFinite(at)) return "lookup message mismatch";
  if (Math.abs((p.now ?? Date.now()) - at) > LOOKUP_MAX_AGE_MS) return "lookup expired — try again";
  const expected = bankLookupMessage({ accountRef: p.accountRef, address: p.address, nonce, at });
  if (p.message !== expected) return "lookup message mismatch";
  return verifyTxcMessage(p.address, p.message, p.signature) ? null : "signature does not match wallet";
}
