/**
 * Same-origin proxy for the TSD Swap account-link protocol.
 *
 * The wallet never talks to the TSD Swap host directly: the strict CSP
 * `connect-src` only allows same-origin + our own chain endpoints. Same
 * shape as /api/nectar/link.
 *
 * Usage: /api/tsd/link?url=<url-encoded absolute https URL on a trusted
 * host>. GET reads the link manifest, POST submits the signed keys.
 */
import { createFileRoute } from "@tanstack/react-router";
import { isTsdLinkPath } from "@/lib/rewards/tsd-link-path";

const TRUSTED_HOSTS = new Set(["tsd.honest.money", "app.tsdswap.com"]);

function targetFrom(request: Request): URL | null {
  const raw = new URL(request.url).searchParams.get("url");
  if (!raw) return null;
  try {
    const target = new URL(raw);
    if (target.protocol !== "https:") return null;
    if (!TRUSTED_HOSTS.has(target.hostname) || target.port || target.username || target.password)
      return null;
    if (!isTsdLinkPath(target.pathname)) return null;
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

export const Route = createFileRoute("/api/tsd/link")({
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
