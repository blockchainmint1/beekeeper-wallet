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

/** Largest upstream response the pass-throughs will read (round-2 audit 2.4). */
export const MAX_UPSTREAM_BYTES = 256 * 1024;

/**
 * Fetch a partner URL and hand back ONLY JSON (round-2 audit 2.4):
 *  - redirects are refused outright, never followed;
 *  - the upstream body is read up to MAX_UPSTREAM_BYTES;
 *  - it must parse as JSON and is re-serialised, always served as
 *    application/json — partner HTML can never run on beekeeper.money.
 */
export async function relayJson(target: URL, init: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(target.toString(), { ...init, redirect: "manual", signal: AbortSignal.timeout(15_000) });
  } catch {
    return jsonError(502, "upstream_unreachable");
  }
  if ((res.status >= 300 && res.status < 400) || res.type === "opaqueredirect") {
    return jsonError(502, "upstream_redirect");
  }
  const text = await readCapped(res, MAX_UPSTREAM_BYTES);
  if (text === null) return jsonError(502, "upstream_too_large");
  let parsed: unknown;
  try {
    parsed = text.trim() === "" ? {} : JSON.parse(text);
  } catch {
    return jsonError(502, "upstream_not_json");
  }
  return new Response(JSON.stringify(parsed), {
    status: res.status >= 200 && res.status < 600 ? res.status : 502,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

async function readCapped(res: Response, max: number): Promise<string | null> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > max) return null;
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    all.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NECTAR_LINK_PATH = /^\/api\/public\/v1\/wallet-link(\/status)?$/;

/**
 * The only shapes /api/nectar/link forwards (round-2 audit 2.4): the
 * NectarPay store-link manifest (`/api/public/v1/wallet-link?token=…`) and a
 * website sign-in callback, which always carries `id=<uuid>` (the same check
 * src/lib/nectar/auth.ts does before signing). Anything else is refused.
 */
export function isLinkProxyShape(url: URL): boolean {
  if (NECTAR_LINK_PATH.test(url.pathname)) {
    const token = url.searchParams.get("token");
    return url.pathname.endsWith("/status") || (!!token && /^[A-Za-z0-9._~-]{8,512}$/.test(token));
  }
  return UUID_RE.test(url.searchParams.get("id") ?? "");
}
