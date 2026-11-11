/**
 * Same-origin proxy for the wallet-link and website sign-in protocols
 * (NectarPay, streamTXC, and other trusted partner sites).
 *
 * The wallet never talks to partner hosts directly: the strict CSP
 * `connect-src` only allows same-origin + our own chain endpoints, and this
 * keeps one place to pin the trusted relying parties.
 *
 * Usage: /api/nectar/link?url=<url-encoded absolute https URL on a
 * trusted host>. GET reads the manifest/challenge, POST claims it.
 *
 * Guards (audit 2026-11-09 M4): trusted host + no path tricks, per-IP rate
 * limit, POSTs must come from our own app, bodies capped at 32 KB.
 * Round 2: only the documented link/sign-in URL shapes, redirects refused,
 * upstream replies capped and always re-served as JSON.
 */
import { createFileRoute } from "@tanstack/react-router";
import { TRUSTED_LOGIN_HOSTS } from "@/lib/web-login-hosts";
import {
  MAX_PROXY_BODY_BYTES,
  isAllowedCaller,
  jsonError,
  makeRateLimiter,
  relayJson,
  safePartnerUrl,
  isLinkProxyShape,
} from "@/lib/security/proxy-guard";

const limited = makeRateLimiter(60);

async function forward(request: Request, init: RequestInit): Promise<Response> {
  if (limited(request)) return jsonError(429, "rate_limited");
  const target = safePartnerUrl(new URL(request.url).searchParams.get("url"), TRUSTED_LOGIN_HOSTS);
  if (!target || !isLinkProxyShape(target)) return jsonError(400, "untrusted_url");
  return relayJson(target, init);
}

export const Route = createFileRoute("/api/nectar/link")({
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
