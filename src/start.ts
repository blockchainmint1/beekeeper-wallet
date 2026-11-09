import { createStart, createMiddleware } from "@tanstack/react-start";

import { renderErrorPage } from "./lib/error-page";
import { SECURITY_HEADERS } from "./lib/security/headers";
import { NATIVE_WEBVIEW_ORIGIN } from "./lib/native/origins";
import { attachSupabaseAuth } from "@/integrations/supabase/auth-attacher";

const IS_PROD = process.env.NODE_ENV === "production";

// Origins allowed to call server functions / API routes cross-origin: the
// native Capacitor WebView's LOCAL origin (see lib/native/origins.ts) and the
// iOS capacitor scheme. Plain-http localhost is only allowed in development
// (audit 2026-11-09 L4).
const ALLOWED_CORS_ORIGINS = new Set<string>([
  NATIVE_WEBVIEW_ORIGIN,
  "capacitor://localhost",
  "https://localhost",
  ...(IS_PROD ? [] : ["http://localhost"]),
]);

function corsHeadersFor(origin: string | null): Record<string, string> {
  if (!origin || !ALLOWED_CORS_ORIGINS.has(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Vary": "Origin",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, X-Requested-With, Accept, Origin",
    "Access-Control-Max-Age": "86400",
  };
}

/** Best-effort: attach security headers to a Headers object, in place. */
function setSecurityHeaders(headers: Headers, cors: Record<string, string>): void {
  try {
    if (IS_PROD) {
      for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
    }
    for (const [k, v] of Object.entries(cors)) headers.set(k, v);
  } catch {
    /* immutable headers on some runtimes — leave the response untouched */
  }
}

const securityMiddleware = createMiddleware().server(async ({ next, request }) => {
  const origin = request?.headers?.get?.("origin") ?? null;
  const cors = corsHeadersFor(origin);

  // Answer CORS preflight before route handlers run — otherwise TSS server
  // functions reject OPTIONS with 405 and the browser blocks the real call.
  if (request?.method === "OPTIONS" && Object.keys(cors).length > 0) {
    const preflight = new Response(null, { status: 204 });
    setSecurityHeaders(preflight.headers, cors);
    return preflight;
  }

  try {
    const result = await next();
    // Some failure paths resolve without a response object — guard so the
    // header pass never turns an upstream error into an opaque 500.
    if (result?.response?.headers) setSecurityHeaders(result.response.headers, cors);
    return result;
  } catch (error) {
    if (error != null && typeof error === "object" && "statusCode" in error) {
      throw error;
    }
    console.error(error);
    const res = new Response(renderErrorPage(), {
      status: 500,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
    setSecurityHeaders(res.headers, cors);
    return res;
  }
});

export const startInstance = createStart(() => ({
  functionMiddleware: [attachSupabaseAuth],
  requestMiddleware: [securityMiddleware],
}));
