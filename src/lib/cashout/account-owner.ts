/**
 * Which wallet may see a VectorPay customer's bank name and last-4
 * (round-4 audit N2, round-5 §3). The customer ID is a hash of a private key,
 * so the server can't tell from an address alone whether it belongs to that
 * ID. A wallet becomes the ID's owner only by redeeming a one-time code that
 * VectorPay confirms — a plain status check never claims, so someone holding
 * a leaked ID can't lock the real merchant out. The same seed always derives
 * the same holder address, so the real owner is never locked out.
 */
export type OwnerAction = "redeem" | "lookup";
export type OwnerDecision = "claim" | "ok" | "other-wallet" | "unclaimed";

export function ownerDecision(
  existing: string | null | undefined,
  address: string,
  action: OwnerAction,
): OwnerDecision {
  if (!existing) return action === "redeem" ? "claim" : "unclaimed";
  return existing === address ? "ok" : "other-wallet";
}

/** A redeem may claim the ID only once VectorPay has accepted the code. */
export function mayClaimAfterRedeem(decision: OwnerDecision, reply: { ok: boolean; linked: boolean }): boolean {
  return decision === "claim" && reply.ok && reply.linked;
}

export const OTHER_WALLET_DETAIL = "This VectorPay customer ID belongs to a different wallet.";
export const CONFIRM_LINK_DETAIL =
  "Confirm this wallet once: get a fresh link code from your VectorPay dashboard and enter it here.";
