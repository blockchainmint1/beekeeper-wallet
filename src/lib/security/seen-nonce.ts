/**
 * Single-use signed requests (round-4 audit B5). A signed top-up or bank
 * lookup is valid for a few minutes; remembering its nonce until it expires
 * means a copied request can't be replayed to read deposit or bank details.
 *
 * Kept in memory per edge worker on purpose (the auditor's accepted bar):
 * the wallet signs a fresh nonce for every call, so honest use never repeats.
 */
export function makeNonceGuard(ttlMs: number, maxEntries = 20_000) {
  const seen = new Map<string, number>();
  /** true when this key was already used (refuse it); otherwise records it. */
  return function replayed(key: string): boolean {
    const now = Date.now();
    const until = seen.get(key);
    if (until !== undefined && until > now) return true;
    seen.set(key, now + ttlMs);
    if (seen.size > maxEntries) for (const [k, v] of seen) if (v <= now) seen.delete(k);
    return false;
  };
}
