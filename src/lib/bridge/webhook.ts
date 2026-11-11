/**
 * Bridge webhook signature check (apidocs.bridge.xyz → Webhook event signature
 * verification). Header: `X-Webhook-Signature: t=<ms>,v0=<base64>`. Bridge
 * signs SHA256(SHA256("<t>.<raw body>")) with RSA PKCS#1 v1.5, so we hand
 * WebCrypto the first digest and let it hash once more. Works on workerd.
 */
export const WEBHOOK_MAX_AGE_MS = 10 * 60_000;

export function parseSignatureHeader(header: string | null | undefined): { t: number; sig: string } | null {
  if (!header) return null;
  let t = NaN;
  let sig = "";
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === "t") t = Number(v);
    else if (k === "v0") sig = v;
  }
  if (!Number.isFinite(t) || !sig || !/^[A-Za-z0-9+/]+={0,2}$/.test(sig)) return null;
  return { t, sig };
}

function pemToDer(pem: string): Uint8Array<ArrayBuffer> {
  const b64 = pem.replace(/-----(BEGIN|END) PUBLIC KEY-----/g, "").replace(/\\n/g, "").replace(/\s+/g, "");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/** null when the delivery is genuine and fresh; otherwise a short reason. */
export async function verifyBridgeWebhook(p: {
  publicKeyPem: string;
  header: string | null | undefined;
  rawBody: string;
  now?: number;
}): Promise<string | null> {
  const parsed = parseSignatureHeader(p.header);
  if (!parsed) return "missing signature";
  if (Math.abs((p.now ?? Date.now()) - parsed.t) > WEBHOOK_MAX_AGE_MS) return "stale delivery";
  try {
    const key = await crypto.subtle.importKey(
      "spki",
      pemToDer(p.publicKeyPem),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${parsed.t}.${p.rawBody}`));
    const sig = Uint8Array.from(atob(parsed.sig), (c) => c.charCodeAt(0));
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, sig, digest);
    return ok ? null : "bad signature";
  } catch {
    return "bad signature";
  }
}
