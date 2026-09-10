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
 */
import { createFileRoute } from "@tanstack/react-router";
import { TRUSTED_LOGIN_HOSTS } from "@/lib/web-login-hosts";

/** Exact hosts trusted for the merchant-link and wallet-login protocols. */
const TRUSTED_HOSTS = TRUSTED_LOGIN_HOSTS;

function targetFrom(request: Request): URL | null {
  const raw = new URL(request.url).searchParams.get("url");
  if (!raw) return null;
  try {
    const target = new URL(raw);
    if (target.protocol !== "https:") return null;
    if (!TRUSTED_HOSTS.has(target.hostname) || target.port || target.username || target.password) return null;
    return target;
  } catch {
    return null;
  }
}

async function forward(request: Request, init: RequestInit): Promise<Response> {
  const target = targetFrom(request);
  if (!target) {
    return new Response(JSON.stringify({ error: "untrusted_url" }), {
      status: 400,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }
  const res = await fetch(target.toString(), init);
  const body = await res.text();
  return new Response(body, {
    status: res.status,
    headers: {
      "Content-Type": res.headers.get("content-type") ?? "application/json",
      "Cache-Control": "no-store",
    },
  });
}

export const Route = createFileRoute("/api/nectar/link")({
  server: {
    handlers: {
      GET: async ({ request }) =>
        forward(request, { method: "GET", headers: { Accept: "application/json" } }),
      POST: async ({ request }) => {
        const body = await request.text();
        return forward(request, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body,
        });
      },
    },
  },
});
