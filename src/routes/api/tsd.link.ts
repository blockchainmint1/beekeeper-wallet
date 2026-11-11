/**
 * Same-origin proxy for the TSD Swap account-link protocol.
 *
 * The wallet never talks to the TSD Swap host directly: the strict CSP
 * `connect-src` only allows same-origin + our own chain endpoints. Same
 * shape as /api/nectar/link.
 *
 * Usage: /api/tsd/link?url=<url-encoded absolute https URL on a trusted
 * host>. GET reads the link manifest, POST submits the signed keys.
 *
 * Guards (audit 2026-11-09 M4): trusted host, only the documented link
 * paths, per-IP rate limit, POSTs must come from our own app, 32 KB bodies.
 * Round 2: redirects refused, upstream replies capped, always served as JSON.
 */
import { createFileRoute } from "@tanstack/react-router";
import { isTsdLinkPath } from "@/lib/rewards/tsd-link-path";
import {
  MAX_PROXY_BODY_BYTES,
  isAllowedCaller,
  jsonError,
  makeRateLimiter,
  relayJson,
  safePartnerUrl,
} from "@/lib/security/proxy-guard";

const TRUSTED_HOSTS: ReadonlySet<string> = new Set(["tsd.honest.money", "app.tsdswap.com"]);
const limited = makeRateLimiter(30);

async function forward(request: Request, init: RequestInit): Promise<Response> {
  if (limited(request)) return jsonError(429, "rate_limited");
  const target = safePartnerUrl(new URL(request.url).searchParams.get("url"), TRUSTED_HOSTS);
  if (!target || !isTsdLinkPath(target.pathname)) return jsonError(400, "untrusted_url");
  return relayJson(target, init);
}

export const Route = createFileRoute("/api/tsd/link")({
  server: {
    handlers: {
      GET: async ({ request }) =>
        forward(request, { method: "GET", headers: { Accept: "application/json" } }),
      POST: async ({ request }) => {
        if (!isAllowedCaller(request)) return jsonError(403, "forbidden_caller");
        const body = await request.text();
        if (body.length > MAX_PROXY_BODY_BYTES) return jsonError(413, "body_too_large");
        return forward(request, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body,
        });
      },
    },
  },
});
