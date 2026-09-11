/**
 * Website wallet sign-in protocol (NectarPay, streamTXC, and other partners).
 *
 * Login QR codes contain a short-lived challenge and a callback owned by the
 * site. We fetch the exact message from that callback before signing, so the
 * wallet never guesses what it is authorizing. Only the TXC identity address
 * and compact signature leave the device. Callbacks are restricted to
 * TRUSTED_LOGIN_HOSTS (src/lib/web-login-hosts.ts), shared with the proxy.
 */

import { signMessageWithSeed, verifyMessage, type SignedMessage } from "@/lib/txc/message-sign";
import { TRUSTED_LOGIN_HOSTS } from "@/lib/web-login-hosts";

export { TRUSTED_LOGIN_HOSTS };
/** @deprecated Use TRUSTED_LOGIN_HOSTS. */
export const NECTAR_LOGIN_HOSTS = TRUSTED_LOGIN_HOSTS;
const PROXY = "/api/nectar/link";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface NectarLoginRequest {
  challengeId: string;
  nonce: string;
  callbackUrl: string;
  origin: string;
  expiresAt: number;
  chain: "txc";
  message?: string;
}

interface LoginChallengeResponse {
  id?: string;
  nonce?: string;
  domain?: string;
  issued_at?: string;
  expires_at?: string;
  status?: string;
  message?: string;
}

function trustedUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    if (
      url.protocol !== "https:" ||
      !TRUSTED_LOGIN_HOSTS.has(url.hostname) ||
      url.port ||
      url.username ||
      url.password
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

function decodeBase64Url(value: string): string | null {
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    const binary = atob(normalized);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

function numberFrom(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function validateRequest(raw: {
  challengeId?: unknown;
  nonce?: unknown;
  callbackUrl?: unknown;
  origin?: unknown;
  expiresAt?: unknown;
  chain?: unknown;
  message?: unknown;
}): NectarLoginRequest {
  const challengeId = typeof raw.challengeId === "string" ? raw.challengeId : "";
  const nonce = typeof raw.nonce === "string" ? raw.nonce : "";
  const callbackUrl = typeof raw.callbackUrl === "string" ? raw.callbackUrl : "";
  const origin = typeof raw.origin === "string" ? raw.origin : "";
  const expiresAt = numberFrom(raw.expiresAt);
  const callback = trustedUrl(callbackUrl);

  if (!UUID_RE.test(challengeId)) throw new Error("This is not a valid website sign-in QR.");
  if (nonce.length < 16 || nonce.length > 128) throw new Error("The sign-in challenge is malformed.");
  if (!callback) throw new Error("This sign-in QR points to an untrusted server.");
  if (!TRUSTED_LOGIN_HOSTS.has(origin)) throw new Error("This sign-in request is not from a trusted site.");
  if (expiresAt === null || expiresAt <= Date.now()) throw new Error("This sign-in QR has expired.");
  if (callback.searchParams.get("id") !== challengeId) throw new Error("The sign-in challenge does not match its callback.");
  if (callback.hostname !== origin) throw new Error("The sign-in request domain does not match its callback.");
  if (callback.searchParams.get("domain") && callback.searchParams.get("domain") !== origin) {
    throw new Error("The sign-in request domain does not match its callback.");
  }
  if (raw.chain !== undefined && String(raw.chain).toLowerCase() !== "txc") {
    throw new Error("This sign-in request uses an unsupported chain.");
  }

  return {
    challengeId,
    nonce,
    callbackUrl,
    origin,
    expiresAt,
    chain: "txc",
    message: typeof raw.message === "string" && raw.message.length <= 2000 ? raw.message : undefined,
  };
}

/** Parse the JSON envelope or payhme://login URL emitted by a partner site. */
export function parseLoginInput(raw: string): NectarLoginRequest {
  const text = raw.trim();
  if (!text) throw new Error("Scan a website sign-in QR to continue.");

  try {
    const value: unknown = JSON.parse(text);
    if (value && typeof value === "object") {
      const envelope = value as Record<string, unknown>;
      if (envelope.type !== "hm-login") throw new Error("This QR is not a supported sign-in request.");
      return validateRequest({
        challengeId: typeof envelope.callback === "string" ? new URL(envelope.callback).searchParams.get("id") : undefined,
        nonce: envelope.nonce,
        callbackUrl: envelope.callback,
        origin: envelope.origin,
        expiresAt: envelope.expiresAt,
        chain: envelope.chain,
      });
    }
  } catch (error) {
    if (error instanceof Error && error.message !== "Unexpected end of JSON input") throw error;
  }

  try {
    const url = new URL(text);
    if (url.protocol !== "payhme:" || url.hostname !== "login") {
      throw new Error("This QR is not a supported sign-in request.");
    }
    const callbackUrl = url.searchParams.get("cb") ?? "";
    const message = url.searchParams.get("msg");
    return validateRequest({
      challengeId: url.searchParams.get("id"),
      nonce: url.searchParams.get("nonce"),
      callbackUrl,
      origin: url.searchParams.get("from"),
      // Deep links carry the exact message, but the callback remains the source of truth.
      expiresAt: Date.now() + 5 * 60 * 1000,
      chain: "txc",
      message: message ? decodeBase64Url(message) ?? undefined : undefined,
    });
  } catch (error) {
    if (error instanceof Error && error.message !== "This QR is not a supported sign-in request.") throw error;
    throw new Error("This QR is not a supported sign-in request.");
  }
}

/**
 * Cheap pre-check used by the camera scanner: does this QR look like a
 * website sign-in request (hm-login envelope or payhme://login deep link)?
 * Full validation still happens in parseLoginInput.
 */
export function looksLikeLoginQr(raw: string): boolean {
  const text = raw.trim();
  if (/^payhme:\/\/login/i.test(text)) return true;
  if (!text.startsWith("{")) return false;
  try {
    const value: unknown = JSON.parse(text);
    return !!value && typeof value === "object" && (value as Record<string, unknown>).type === "hm-login";
  } catch {
    return false;
  }
}

async function proxyRequest(callbackUrl: string, init?: RequestInit): Promise<Response> {
  return fetch(`${PROXY}?url=${encodeURIComponent(callbackUrl)}`, init);
}

/** Fetch the server-generated message and verify it belongs to this challenge. */
export async function fetchLoginMessage(request: NectarLoginRequest): Promise<NectarLoginRequest & { message: string }> {
  const response = await proxyRequest(request.callbackUrl, { headers: { Accept: "application/json" } });
  const body = (await response.json().catch(() => null)) as LoginChallengeResponse | null;
  if (!response.ok || !body) throw new Error(body?.message ?? "Could not read the sign-in request.");
  if (body.id !== request.challengeId || body.nonce !== request.nonce) {
    throw new Error("The sign-in challenge changed or is invalid.");
  }
  if (body.status && body.status !== "pending") throw new Error("This sign-in request is no longer waiting.");
  const message = body.message;
  const responseDomain = body.domain ?? request.origin;
  const responseIssuedAt = body.issued_at;
  // Every line is checked against a fixed template so a site cannot smuggle
  // extra terms into what the wallet signs. Only the site's own display name
  // on the "authorize a sign-in session for X" line is free-form.
  const lines = message ? message.split("\n") : [];
  const shapeOk =
    !!message &&
    !!responseIssuedAt &&
    lines.length === 6 &&
    lines[0] === `${responseDomain} wants you to sign in with your TXC wallet.` &&
    lines[1] === "" &&
    lines[2] === `Nonce: ${request.nonce}` &&
    lines[3] === `Issued At: ${responseIssuedAt}` &&
    /^By signing, you authorize a sign-in session for [A-Za-z0-9 ._-]{1,40}\.$/.test(lines[4] ?? "") &&
    lines[5] === "This signature does not authorize any payment.";
  if (
    !shapeOk ||
    (request.message !== undefined && request.message !== message) ||
    responseDomain !== request.origin
  ) {
    throw new Error("The site returned an invalid sign-in message.");
  }

  const expiresAt = body.expires_at ? Date.parse(body.expires_at) : request.expiresAt;
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new Error("This sign-in request has expired.");
  return { ...request, expiresAt, message: message as string };
}

export async function signInToNectar(args: {
  request: NectarLoginRequest & { message: string };
  mnemonic: string;
  passphrase?: string;
}): Promise<SignedMessage> {
  const { request, mnemonic, passphrase = "" } = args;
  if (request.expiresAt <= Date.now()) throw new Error("This sign-in request has expired.");

  const signed = await signMessageWithSeed({
    mnemonic,
    passphrase,
    kind: "bip44",
    change: 0,
    index: 0,
    message: request.message,
  });
  if (!verifyMessage(signed.address, request.message, signed.signature)) {
    throw new Error("The wallet could not verify its own sign-in signature.");
  }

  const response = await proxyRequest(request.callbackUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      id: request.challengeId,
      address: signed.address,
      signature: signed.signature,
      message: request.message,
    }),
  });
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  if (!response.ok) throw new Error(body?.error ?? `Sign-in failed (${response.status}).`);
  return signed;
}
