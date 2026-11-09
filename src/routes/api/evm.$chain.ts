/**
 * JSON-RPC proxy for EVM networks. The Alchemy API key stays server-side;
 * the client points viem at /api/evm/<chain> instead of the upstream RPC.
 *
 * Allowed chains: eth, bsc, base.
 */
import { createFileRoute } from "@tanstack/react-router";
import { TRUSTED_CALLER_HOSTS } from "@/lib/native/origins";

const UPSTREAM: Record<string, (key: string) => string> = {
  eth: (k) => `https://eth-mainnet.g.alchemy.com/v2/${k}`,
  base: (k) => `https://base-mainnet.g.alchemy.com/v2/${k}`,
  bsc: (k) => `https://bnb-mainnet.g.alchemy.com/v2/${k}`,
  // Zero Chill runs on our own node — no API key involved.
  zcu: () => "https://node-zcu.honest.money",
};

// Public fallbacks if Alchemy doesn't have a given network on the plan.
const FALLBACK: Record<string, string> = {
  bsc: "https://bsc-dataseed.binance.org",
  zcu: "https://node-zcu.honest.money",
};

// Only allow safe read + raw send methods. Blocks `eth_accounts`,
// `eth_sign`, wallet_*, etc. so the proxy can't be abused as a wallet.
const ALLOWED = new Set([
  "eth_chainId",
  "eth_blockNumber",
  "eth_getBalance",
  "eth_getCode",
  "eth_getStorageAt",
  "eth_getTransactionCount",
  "eth_getBlockByNumber",
  "eth_getBlockByHash",
  "eth_getTransactionByHash",
  "eth_getTransactionReceipt",
  "eth_getLogs",
  "eth_call",
  "eth_estimateGas",
  "eth_gasPrice",
  "eth_maxPriorityFeePerGas",
  "eth_feeHistory",
  "eth_sendRawTransaction",
  "net_version",
  // Alchemy helpers used by the token list
  "alchemy_getTokenBalances",
  "alchemy_getTokenMetadata",
]);

type RpcCall = { jsonrpc: "2.0"; id: number | string; method: string; params?: unknown };

/**
 * Returns true if the request originates from our own web app or from the
 * Capacitor-wrapped mobile shell. Blocks anonymous internet callers from
 * draining the Alchemy quota through our key.
 */
function isAllowedCaller(request: Request): boolean {
  const origin = request.headers.get("origin");
  const referer = request.headers.get("referer");
  const host = request.headers.get("host") ?? "";
  const source = origin ?? (referer ? new URL(referer).origin : null);
  // No Origin/Referer at all → not a browser fetch from a real page. Reject.
  if (!source) return false;

  let sourceHost = "";
  try {
    sourceHost = new URL(source).host;
  } catch {
    return false;
  }

  // Same-origin web requests.
  if (sourceHost && sourceHost === host) return true;

  // Capacitor / Ionic native shells use these origins on iOS / Android.
  // capacitor://localhost (iOS), https://localhost (Android), ionic://localhost
  if (source === "capacitor://localhost") return true;
  if (source === "ionic://localhost") return true;
  if (source === "https://localhost") return true;

  // Allowlist our published web origins.
  if (TRUSTED_CALLER_HOSTS.has(sourceHost)) return true;

  // Lovable preview subdomains are DEV-only. In production this wildcard is a
  // broad hole (anyone can host a *.lovable.app page), so gate it out.
  if (process.env.NODE_ENV !== "production" && sourceHost.endsWith(".lovable.app")) {
    return true;
  }

  return false;
}

// -------------------- Coarse per-IP rate limiting --------------------
// This proxy fronts a metered Alchemy key. The origin check above is only
// quota protection (Origin/Referer are spoofable), so add a simple fixed-
// window limiter to cap abuse. It is per-server-instance and best-effort;
// for hard guarantees move this to a shared store (Redis/Durable Object).
// It ALWAYS fails open so a limiter bug can never lock out real users.
const RATE_WINDOW_MS = 60_000;
// Set high on purpose: mobile carriers NAT many real users behind one IP, and
// viem batches calls. This only catches an egregious flood, not normal use.
// Tune down (and move to a shared, per-session store) once you have metrics.
const RATE_MAX = 1200;
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

function clientIp(request: Request): string {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return request.headers.get("x-real-ip") ?? "unknown";
}

function rateLimited(request: Request): boolean {
  try {
    const ip = clientIp(request);
    const now = Date.now();
    const b = rateBuckets.get(ip);
    if (!b || now > b.resetAt) {
      rateBuckets.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
      if (rateBuckets.size > 10_000) {
        // Bound memory: drop expired entries.
        for (const [k, v] of rateBuckets) if (now > v.resetAt) rateBuckets.delete(k);
      }
      return false;
    }
    b.count++;
    return b.count > RATE_MAX;
  } catch {
    return false; // fail open
  }
}

export const Route = createFileRoute("/api/evm/$chain")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        if (!isAllowedCaller(request)) {
          return new Response("Forbidden", { status: 403 });
        }
        if (rateLimited(request)) {
          return new Response("Too Many Requests", {
            status: 429,
            headers: { "retry-after": "60" },
          });
        }

        const chain = params.chain;
        const builder = UPSTREAM[chain];
        if (!builder) return new Response("Unknown chain", { status: 404 });

        // Zero Chill runs on our own node: prefer the private RPC endpoint
        // (with basic auth) when configured, else the public one.
        let url: string | undefined;
        const authHeaders: Record<string, string> = {};
        if (chain === "zcu") {
          url = process.env.ZCU_RPC_URL ?? FALLBACK.zcu;
          if (url && !url.startsWith("http")) url = `https://${url}`;
          const u = process.env.ZCU_RPC_USER;
          const p = process.env.ZCU_RPC_PASS ?? process.env.ZCU_RPC_PASSWORD;
          if (u && p) {
            authHeaders.authorization =
              "Basic " + Buffer.from(`${u}:${p}`).toString("base64");
          }
        } else {
          const key = process.env.ALCHEMY_KEY;
          url = key ? builder(key) : FALLBACK[chain];
        }
        if (!url) return new Response("RPC not configured", { status: 500 });


        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return new Response("Invalid JSON", { status: 400 });
        }

        const calls = Array.isArray(body) ? (body as RpcCall[]) : [body as RpcCall];
        for (const c of calls) {
          if (!c || typeof c.method !== "string" || !ALLOWED.has(c.method)) {
            return new Response(`Method not allowed: ${c?.method ?? "?"}`, { status: 403 });
          }
        }

        const upstream = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", ...authHeaders },
          body: JSON.stringify(body),
        });


        const text = await upstream.text();
        return new Response(text, {
          status: upstream.status,
          headers: { "content-type": "application/json" },
        });
      },
    },
  },
});
