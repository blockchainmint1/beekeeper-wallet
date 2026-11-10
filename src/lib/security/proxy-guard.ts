/**
 * Shared guards for same-origin pass-through routes (partner link/sign-in
 * protocols, tap-to-pay invoice lookups). Audit 2026-11-09 M4 flagged these
 * as open relays: anyone could use BeeKeeper's server to hit partner hosts.
 *
 * - isAllowedCaller: browser calls from our own app only (Origin/Referer).
 * - makeRateLimiter: coarse per-IP fixed window, best-effort per isolate,
 *   always fails open so a limiter bug can't lock real users out.
 * - safePartnerUrl: https, trusted host, default port, no credentials, no
 *   dot-segments or encoded separators in the path.
 */
import { TRUSTED_CALLER_HOSTS } from "@/lib/native/origins";

export function isAllowedCaller(request: Request): boolean {
  const origin = request.headers.get("origin");
  const referer = request.headers.get("referer");
  let source: string | null = origin;
  if (!source && referer) {
    try {
      source = new URL(referer).origin;
    } catch {
      return false;
    }
  }
  if (!source) return false;
  let sourceHost = "";
  try {
    sourceHost = new URL(source).host;
  } catch {
    return false;
  }
  const host = request.headers.get("host") ?? "";
  if (sourceHost && sourceHost === host) return true;
  // Existing Android installs (frozen) use these shell origins.
  if (source === "capacitor://localhost" || source === "https://localhost") return true;
  if (TRUSTED_CALLER_HOSTS.has(sourceHost)) return true;
  if (process.env.NODE_ENV !== "production" && sourceHost.endsWith(".lovable.app")) return true;
  return false;
}

export function makeRateLimiter(max: number, windowMs = 60_000) {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  return function limited(request: Request): boolean {
    try {
      const xff = request.headers.get("x-forwarded-for");
      const ip = (xff ? xff.split(",")[0]!.trim() : request.headers.get("x-real-ip")) || "unknown";
      const now = Date.now();
      const b = buckets.get(ip);
      if (!b || now > b.resetAt) {
        buckets.set(ip, { count: 1, resetAt: now + windowMs });
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

export function safePartnerUrl(raw: string | null, hosts: ReadonlySet<string>): URL | null {
  if (!raw) return null;
  try {
    // Reject encoded separators / dot-segments before URL normalises them away.
    if (/%2e|%2f|%5c/i.test(raw)) return null;
    const target = new URL(raw);
    if (target.protocol !== "https:") return null;
    if (!hosts.has(target.hostname) || target.port || target.username || target.password) return null;
    if (target.pathname.split("/").some((seg) => seg === "." || seg === "..")) return null;
    if (target.hash) return null;
    return target;
  } catch {
    return null;
  }
}

/** Largest request body the pass-throughs forward (link claims are small JSON). */
export const MAX_PROXY_BODY_BYTES = 32 * 1024;

export function jsonError(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
