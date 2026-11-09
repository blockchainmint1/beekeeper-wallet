/**
 * In the native Capacitor app the WebView serves the bundled web assets from
 * the configured local hostname (NATIVE_WEBVIEW_ORIGIN). Any relative fetch — including
 * TanStack Start's `/_serverFn/*` RPCs and `/api/*` server routes — is
 * intercepted by Capacitor's local web server and 404s because those endpoints
 * only exist on the deployed origin.
 *
 * Patch window.fetch once at startup to forward those requests to the real
 * production origin so prices, history, and other server functions work
 * inside the APK/IPA.
 */
import { CapacitorHttp } from "@capacitor/core";

import { isNative } from "./platform";
import { PROD_ALIASES, PROD_ORIGIN } from "./origins";

// SECURITY (audit 2026-11-09 H1): forwards go to BeeKeeper's own deployment.
// They previously went to mobile.honest.money — the separate HME Wallet
// deployment — which handed phone users HME's cash-out addresses and feed.
const FORWARD_PREFIXES = ["/_serverFn/", "/api/"];

let patched = false;

export function installNativeServerFnBridge() {
  if (patched || typeof window === "undefined") return;
  if (!isNative()) return;
  patched = true;

  const originalFetch = window.fetch.bind(window);
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    try {
      const path = serverBackedPath(input);
      if (path) {
        return nativeRequest(PROD_ORIGIN + path, input, init, originalFetch);
      }
    } catch {
      /* fall through to original fetch */
    }
    return originalFetch(input as RequestInfo, init);
  }) as typeof window.fetch;
}

function serverBackedPath(input: RequestInfo | URL): string | null {
  let raw: string | null = null;
  if (typeof input === "string") raw = input;
  else if (input instanceof URL) raw = input.toString();
  else if (input instanceof Request) raw = input.url;
  if (!raw) return null;

  try {
    const parsed = raw.startsWith("/") ? new URL(raw, window.location.href) : new URL(raw);
    const isLocalWebview = parsed.origin === window.location.origin;
    const isPublishedApp =
      parsed.origin === PROD_ORIGIN || (PROD_ALIASES as readonly string[]).includes(parsed.origin);
    if (!isLocalWebview && !isPublishedApp) return null;

    const path = parsed.pathname + parsed.search;
    return FORWARD_PREFIXES.some((prefix) => path.startsWith(prefix)) ? path : null;
  } catch {
    return null;
  }
}

async function nativeRequest(
  url: string,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  fallbackFetch: typeof window.fetch,
): Promise<Response> {
  try {
    const request = input instanceof Request ? input : null;
    const method = init?.method ?? request?.method ?? "GET";
    const headers = headersToObject(request?.headers, init?.headers);
    const body = await requestBody(request, init);

    headers.origin ??= window.location.origin;
    headers.referer ??= window.location.href;
    headers.accept ??= "application/json, text/plain, */*";

    const res = await CapacitorHttp.request({
      url,
      method,
      headers,
      data: body,
      responseType: "text",
      connectTimeout: 15_000,
      readTimeout: 30_000,
    });

    const responseBody = res.status === 204 || res.status === 304 ? null : responseDataToBody(res.data);
    return new Response(responseBody, {
      status: res.status,
      headers: res.headers,
    });
  } catch {
    if (input instanceof Request) return fallbackFetch(new Request(url, input));
    return fallbackFetch(url, init);
  }
}

function headersToObject(...headersList: Array<HeadersInit | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const headers of headersList) {
    if (!headers) continue;
    new Headers(headers).forEach((value, key) => {
      out[key.toLowerCase()] = value;
    });
  }
  return out;
}

async function requestBody(request: Request | null, init: RequestInit | undefined): Promise<string | undefined> {
  const body = init?.body;
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body == null && request && !["GET", "HEAD"].includes(request.method.toUpperCase())) {
    return request.clone().text();
  }
  return undefined;
}

function responseDataToBody(data: unknown): BodyInit | null {
  if (data == null) return null;
  if (typeof data === "string") return data;
  return JSON.stringify(data);
}
