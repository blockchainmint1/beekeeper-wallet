/**
 * In-worker counter for server functions (round-2 audit 3.3).
 *
 * Best effort on purpose: every edge worker keeps its own buckets, which is
 * enough to stop one customer ID or wallet hammering an expensive path (the
 * cash-out settlement path can otherwise ask the blockchains for ~1,000
 * transactions per request).
 */
export function makeKeyedLimiter(max: number, windowMs = 60_000) {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  return function limited(key: string): boolean {
    try {
      const now = Date.now();
      const b = buckets.get(key);
      if (!b || now > b.resetAt) {
        buckets.set(key, { count: 1, resetAt: now + windowMs });
        if (buckets.size > 10_000) for (const [k, v] of buckets) if (now > v.resetAt) buckets.delete(k);
        return false;
      }
      b.count++;
      return b.count > max;
    } catch {
      return false;
    }
  };
}
