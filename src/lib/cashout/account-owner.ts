/**
 * Which wallet may see a VectorPay customer's bank name and last-4
 * (round-4 audit N2). The customer ID is a hash of a private key, so the
 * server can't tell from an address alone whether it belongs to that ID.
 * Instead the first wallet to link or check an ID (with a valid signature)
 * becomes its owner, and every later link or lookup must come from that
 * same wallet. The same seed always derives the same holder address, so the
 * real owner is never locked out.
 */
export type OwnerDecision = "claim" | "ok" | "other-wallet";

export function ownerDecision(existing: string | null | undefined, address: string): OwnerDecision {
  if (!existing) return "claim";
  return existing === address ? "ok" : "other-wallet";
}

export const OTHER_WALLET_DETAIL = "This VectorPay customer ID belongs to a different wallet.";
