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
