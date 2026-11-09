/**
 * Same-origin proxy for TronGrid.
 *
 * Keeps the TRON_API key server-side (the free public endpoint rate-limits
 * hard), satisfies the app's narrow CSP `connect-src`, and lets the Capacitor
 * shell forward /api/* through the server-fn bridge like every other chain.
 *
 * Only read + build/broadcast endpoints are forwarded. Nothing that could
 * make the proxy act as a signing service is allowed (Tron signs locally).
 */
import { createFileRoute } from "@tanstack/react-router";
import { TRUSTED_CALLER_HOSTS } from "@/lib/native/origins";
import { joinUnderBase, safeProxyPath } from "@/lib/security/proxy-path";

const UPSTREAM = "https://api.trongrid.io";

const ALLOWED_EXACT = [
  "wallet/getaccount",
  "wallet/getaccountresource",
  "wallet/getnowblock",
  "wallet/triggerconstantcontract",
  "wallet/triggersmartcontract",
  "wallet/createtransaction",
  "wallet/broadcasttransaction",
  "wallet/gettransactionbyid",
  "wallet/gettransactioninfobyid",
];
const ALLOWED_PREFIXES = ["v1/accounts/", "v1/contracts/"];

function allowedPath(path: string): boolean {
  const p = path.replace(/^\/+/, "");
  if (ALLOWED_EXACT.includes(p)) return true;
  return ALLOWED_PREFIXES.some((prefix) => p.startsWith(prefix));
}

function safeOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function isAllowedCaller(request: Request): boolean {
  const origin = request.headers.get("origin");
  const referer = request.headers.get("referer");
  const host = request.headers.get("host") ?? "";
  const source = origin ?? (referer ? safeOrigin(referer) : null);
  if (!source) return false;
  let sourceHost = "";
  try {
    sourceHost = new URL(source).host;
  } catch {
    return false;
  }
  if (sourceHost && sourceHost === host) return true;
  if (
    source === "capacitor://localhost" ||
    source === "ionic://localhost" ||
    source === "https://localhost"
  ) {
    return true;
  }
  if (TRUSTED_CALLER_HOSTS.has(sourceHost)) return true;
  if (process.env.NODE_ENV !== "production" && sourceHost.endsWith(".lovable.app")) return true;
  return false;
}

async function forward(request: Request, path: string, search: string): Promise<Response> {
  const clean = safeProxyPath(path);
  if (clean === null || !allowedPath(clean)) return new Response("Forbidden path", { status: 403 });
  path = clean;

  const key = process.env.TRON_API ?? process.env.TRON_PRO_API_KEY ?? process.env.TRONGRID_API_KEY;
  const method = request.method === "POST" ? "POST" : "GET";
  const body = method === "POST" ? await request.text() : undefined;

  try {
    const target = joinUnderBase(UPSTREAM, path, search);
    if (!target) return new Response("Forbidden path", { status: 403 });
    const upstream = await fetch(target, {
      method,
      headers: {
        accept: "application/json",
        ...(key ? { "TRON-PRO-API-KEY": key } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body }),
    });
    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: {
        "content-type": upstream.headers.get("content-type") ?? "application/json",
        "cache-control": "no-store",
      },
    });
  } catch (err) {
    return new Response(err instanceof Error ? err.message : "upstream unavailable", {
      status: 502,
      headers: { "cache-control": "no-store" },
    });
  }
}

export const Route = createFileRoute("/api/tron/$")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        if (!isAllowedCaller(request)) return new Response("Forbidden", { status: 403 });
        return forward(request, params._splat ?? "", new URL(request.url).search);
      },
      POST: async ({ request, params }) => {
        if (!isAllowedCaller(request)) return new Response("Forbidden", { status: 403 });
        return forward(request, params._splat ?? "", new URL(request.url).search);
      },
    },
  },
});
