/**
 * Same-origin proxy for Nectar.Pay invoice endpoints.
 *
 * Why proxy instead of calling nectar-pay.com directly from the client:
 *  - One place to change the upstream host (staging vs prod).
 *  - Avoid any CORS surprises from a third party.
 *
 * Only GET and POST are supported, matching the spec. The `?t=<nonce>` query
 * is forwarded. Guards (audit 2026-11-09 M4): invoice ids are restricted to a
 * safe character set, per-IP rate limit, POSTs must come from our own app,
 * bodies capped at 32 KB. Round 2: redirects refused, upstream replies
 * capped and always re-served as JSON.
 */
import { createFileRoute } from "@tanstack/react-router";
import {
  MAX_PROXY_BODY_BYTES,
  isAllowedCaller,
  jsonError,
  makeRateLimiter,
  relayJson,
} from "@/lib/security/proxy-guard";

// nectar-pay.com 308-redirects here; we refuse redirects, so call it directly.
const UPSTREAM = "https://app.nectar-pay.com";
const INVOICE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const limited = makeRateLimiter(60);

function buildUpstreamUrl(invoiceId: string, search: string): string {
  const qs = search && search !== "?" ? search : "";
  return `${UPSTREAM}/api/public/v1/pay/${encodeURIComponent(invoiceId)}${qs}`;
}

async function forward(req: Request, invoiceId: string, init: RequestInit): Promise<Response> {
  if (limited(req)) return jsonError(429, "rate_limited");
  if (!INVOICE_ID.test(invoiceId)) return jsonError(400, "bad_invoice_id");
  const url = new URL(req.url);
  return relayJson(new URL(buildUpstreamUrl(invoiceId, url.search)), init);
}

export const Route = createFileRoute("/api/nectar/pay/$invoiceId")({
  server: {
    handlers: {
      GET: async ({ request, params }) =>
        forward(request, params.invoiceId, {
          method: "GET",
          headers: { Accept: "application/json" },
        }),
      POST: async ({ request, params }) => {
        if (!isAllowedCaller(request)) return jsonError(403, "forbidden_caller");
        const body = await request.text();
        if (body.length > MAX_PROXY_BODY_BYTES) return jsonError(413, "body_too_large");
        return forward(request, params.invoiceId, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body,
        });
      },
    },
  },
});
