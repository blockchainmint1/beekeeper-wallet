/**
 * Same-origin proxy for the UTXO-chain explorer backends (LTC, DOGE).
 *
 * Why this exists:
 *  - The app's CSP `connect-src` is deliberately narrow, so the client can't
 *    talk to third-party explorers directly.
 *  - Dogecoin's previous backend (doge1.trezor.io) now answers 403 to
 *    non-residential traffic, and the alternative public Blockbook instances
 *    send no CORS headers — unusable from a browser.
 *
 * Proxying through our own worker fixes both, and lets us fail over between
 * several upstream instances. Native (Capacitor) builds route `/api/*`
 * through the server-fn bridge, so relative URLs work there too.
 */
import { createFileRoute } from "@tanstack/react-router";
import { TRUSTED_CALLER_HOSTS } from "@/lib/native/origins";
import { safeProxyPath } from "@/lib/security/proxy-path";

// Ordered upstream lists — first responder wins, the rest are failover.
// NowNodes is a keyed, rate-limit-free Blockbook; it goes first where we
// speak Blockbook (BTC, DOGE). Public instances stay as failover.
type Upstream = { base: string; key?: boolean };

const UPSTREAMS: Record<string, Upstream[]> = {
  ltc: [{ base: "https://litecoinspace.org/api" }],
  btc: [
    { base: "https://btcbook.nownodes.io/api/v2", key: true },
    { base: "https://btc1.trezor.io/api/v2" },
  ],
  doge: [
    { base: "https://dogebook.nownodes.io/api/v2", key: true },
    { base: "https://dogecoin.atomicwallet.io/api/v2" },
    { base: "https://blockbook.doge.zelcore.io/api/v2" },
  ],
};



// Only explorer read paths + raw broadcast. Nothing else is forwarded.
// NOTE: bare "tx" is the Esplora broadcast endpoint (POST /api/tx) — it must
// be allowed on its own, not just as the "tx/<txid>" read prefix.
const ALLOWED_EXACT = ["tx", "sendtx", "blocks", "fee-estimates"];
const ALLOWED_PREFIXES = ["address/", "utxo/", "tx/", "estimatefee/", "sendtx", "v1/fees", "blocks", "fee-estimates"];

function allowedPath(path: string): boolean {
  if (ALLOWED_EXACT.includes(path)) return true;
  return ALLOWED_PREFIXES.some((p) => path === p || path.startsWith(p));
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
  if (source === "capacitor://localhost" || source === "ionic://localhost" || source === "https://localhost") {
    return true;
  }
  if (TRUSTED_CALLER_HOSTS.has(sourceHost)) return true;
  if (process.env.NODE_ENV !== "production" && sourceHost.endsWith(".lovable.app")) return true;
  return false;
}

function safeOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

async function forward(request: Request, coin: string, path: string, search: string): Promise<Response> {
  const bases = UPSTREAMS[coin];
  if (!bases) return new Response("Unknown chain", { status: 404 });
  if (!allowedPath(path)) return new Response("Forbidden path", { status: 403 });

  const method = request.method === "POST" ? "POST" : "GET";
  const body = method === "POST" ? await request.text() : undefined;

  let lastStatus = 502;
  let lastBody = "upstream unavailable";
  const nowNodesKey = process.env["NOWNODES_API_KEY"];
  for (const { base, key } of bases) {
    if (key && !nowNodesKey) continue;
    try {
      const upstream = await fetch(`${base}/${path}${search}`, {
        method,
        headers: {
          accept: "application/json, text/plain, */*",
          ...(key && nowNodesKey ? { "api-key": nowNodesKey } : {}),
          ...(body === undefined ? {} : { "content-type": request.headers.get("content-type") ?? "text/plain" }),
        },
        ...(body === undefined ? {} : { body }),
      });
      const text = await upstream.text();
      if (!upstream.ok) {
        lastStatus = upstream.status;
        lastBody = text;
        // A 400/422 is the node itself rejecting the payload (e.g. an invalid
        // or non-standard tx). Surface it immediately instead of masking it
        // with the next upstream's infrastructure error.
        if (upstream.status === 400 || upstream.status === 422) break;
        continue;
      }

      return new Response(text, {
        status: 200,
        headers: {
          "content-type": upstream.headers.get("content-type") ?? "application/json",
          "cache-control": "no-store",
        },
      });
    } catch (err) {
      lastStatus = 502;
      lastBody = err instanceof Error ? err.message : "fetch failed";
    }
  }
  return new Response(lastBody, { status: lastStatus, headers: { "cache-control": "no-store" } });
}

export const Route = createFileRoute("/api/utxo/$coin/$")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        if (!isAllowedCaller(request)) return new Response("Forbidden", { status: 403 });
        const search = new URL(request.url).search;
        return forward(request, params.coin, params._splat ?? "", search);
      },
      POST: async ({ request, params }) => {
        if (!isAllowedCaller(request)) return new Response("Forbidden", { status: 403 });
        const search = new URL(request.url).search;
        return forward(request, params.coin, params._splat ?? "", search);
      },
    },
  },
});
