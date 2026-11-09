/** Same-origin JSON-RPC proxy for Solana mainnet. */
import { createFileRoute } from "@tanstack/react-router";
import { TRUSTED_CALLER_HOSTS } from "@/lib/native/origins";

const UPSTREAM = "https://api.mainnet-beta.solana.com";
const ALLOWED = new Set([
  "getBalance",
  "getBlockHeight",
  "getLatestBlockhash",
  "getSignaturesForAddress",
  "getTransaction",
  "getParsedTransaction",
  "sendTransaction",
  "getFeeForMessage",
  "getAccountInfo",
  "getMultipleAccounts",
]);

function isAllowedCaller(request: Request): boolean {
  const origin = request.headers.get("origin");
  const referer = request.headers.get("referer");
  const host = request.headers.get("host") ?? "";
  const source = origin ?? (referer ? (() => { try { return new URL(referer).origin; } catch { return null; } })() : null);
  if (!source) return false;
  let sourceHost = "";
  try { sourceHost = new URL(source).host; } catch { return false; }
  if (sourceHost === host) return true;
  if (["capacitor://localhost", "ionic://localhost", "https://localhost"].includes(source)) return true;
  if (TRUSTED_CALLER_HOSTS.has(sourceHost)) return true;
  return process.env.NODE_ENV !== "production" && sourceHost.endsWith(".lovable.app");
}

export const Route = createFileRoute("/api/solana")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!isAllowedCaller(request)) return new Response("Forbidden", { status: 403 });
        const contentLength = Number(request.headers.get("content-length") ?? 0);
        if (contentLength > 128_000) return new Response("Request too large", { status: 413 });
        let rawBody: string;
        try { rawBody = await request.text(); } catch { return new Response("Invalid request", { status: 400 }); }
        if (rawBody.length > 128_000) return new Response("Request too large", { status: 413 });
        let body: unknown;
        try { body = JSON.parse(rawBody); } catch { return new Response("Invalid JSON", { status: 400 }); }
        const calls = Array.isArray(body) ? body : [body];
        for (const call of calls) {
          const method = (call as { method?: unknown })?.method;
          if (typeof method !== "string" || !ALLOWED.has(method)) {
            return new Response(`Method not allowed: ${String(method ?? "?")}`, { status: 403 });
          }
        }
        try {
          const upstream = await fetch(UPSTREAM, {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json" },
            body: rawBody,
          });
          return new Response(await upstream.text(), {
            status: upstream.status,
            headers: { "content-type": "application/json", "cache-control": "no-store" },
          });
        } catch {
          return new Response("Solana network unavailable", { status: 502 });
        }
      },
    },
  },
});
