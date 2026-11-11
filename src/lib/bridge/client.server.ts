/**
 * Server-only Bridge API access. Reads BRIDGE_API_KEY (live) first, then the
 * sandbox key BRIDGE_API_TEST. The environment follows the key's prefix, so a
 * sandbox key can never reach the live API by accident.
 */
import { bridgeBaseUrl, bridgeEnvForKey, type BridgeEnv } from "./fees";

export function bridgeConfig(): { key: string; env: BridgeEnv } | null {
  const key = (process.env["BRIDGE_API_KEY"] || process.env["BRIDGE_API_TEST"] || "").trim();
  if (!key) return null;
  return { key, env: bridgeEnvForKey(key) };
}

export interface BridgeReply<T = Record<string, unknown>> {
  ok: boolean;
  status: number;
  json: T | null;
}

/**
 * One Bridge call. POSTs carry an Idempotency-Key (Bridge requires it); pass a
 * stable one when a retry must not create a second resource.
 */
export async function bridgeFetch<T = Record<string, unknown>>(
  cfg: { key: string; env: BridgeEnv },
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  idempotencyKey?: string,
): Promise<BridgeReply<T>> {
  const headers: Record<string, string> = { "Api-Key": cfg.key, accept: "application/json" };
  if (method === "POST") {
    headers["content-type"] = "application/json";
    headers["Idempotency-Key"] = idempotencyKey ?? crypto.randomUUID();
  }
  try {
    const res = await fetch(`${bridgeBaseUrl(cfg.env)}${path}`, {
      method,
      headers,
      body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    let json: T | null = null;
    if (text.length < 512_000) {
      try {
        json = JSON.parse(text) as T;
      } catch {
        json = null;
      }
    }
    return { ok: res.ok, status: res.status, json };
  } catch {
    return { ok: false, status: 0, json: null };
  }
}
