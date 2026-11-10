/**
 * TSD Swap ⇄ wallet account link.
 *
 * TSD Swap issues the same `hm-link-xpubs` manifest as Nectar Pay, so we reuse
 * the shared derivation/signing helpers in `@/lib/nectar/link` and only swap in
 * the TSD trusted hosts and proxy. The wallet hands over watch-only account
 * xpubs (TXC + EVM + the rest), signed by the TXC identity key. No seed, no
 * private keys, no spending authority.
 *
 * The claim response may issue a TSD Swap API key, which we store locally so
 * cash-out lights up automatically.
 */
import { canonicalJson, deriveWalletKeys } from "@/lib/nectar/link";
import { setCashoutApiKey } from "@/lib/cashout/api-key";
import { scopedKey } from "@/lib/profiles";
import { signMessageWithSeed } from "@/lib/txc/message-sign";

const PROXY = "/api/tsd/link";
export const TSD_TRUSTED_HOSTS = ["tsd.honest.money", "app.tsdswap.com"];

export interface TsdLinkManifest {
  v: number;
  type: "hm-link-xpubs";
  challenge_id: string;
  from: string;
  callback_url: string;
  manifest_url: string;
  chains: string[];
  exp: number;
  account_id?: string;
  account_name?: string;
  purpose?: string;
}

function trustedUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return (
      u.protocol === "https:" &&
      TSD_TRUSTED_HOSTS.includes(u.hostname) &&
      u.port === "" &&
      u.username === "" &&
      u.password === ""
    );
  } catch {
    return false;
  }
}

/** Accept a pasted URL or a scanned QR payload (URL, or `tsd:` deep link). */
export function parseTsdLinkInput(text: string): string | null {
  const trimmed = text.trim();
  const candidate = trimmed.replace(/^tsd:(\/\/)?/i, () => "https://");
  if (trustedUrl(trimmed)) return new URL(trimmed).toString();
  if (trustedUrl(candidate)) return new URL(candidate).toString();
  return null;
}

/**
 * TSD Swap may advertise the protocol as `type`, inside a `types[]` array, or
 * simply by `app: "tsd-swap"`. Accept all three rather than one exact string.
 */
function isLinkManifest(raw: Record<string, unknown>): boolean {
  if (raw["type"] === "hm-link-xpubs") return true;
  const types = raw["types"];
  if (Array.isArray(types) && types.includes("hm-link-xpubs")) return true;
  const app = typeof raw["app"] === "string" ? raw["app"].toLowerCase() : "";
  if (app === "tsd-swap" || app === "tsdswap") return true;
  return false;
}

export function validateTsdManifest(raw: Record<string, unknown>): TsdLinkManifest {
  const fail = (m: string): never => {
    throw new Error(m);
  };
  if (!isLinkManifest(raw))
    fail(
      typeof raw["error"] === "string" || typeof raw["message"] === "string"
        ? ((raw["message"] as string) ?? (raw["error"] as string))
        : "That link isn't a TSD Swap account link.",
    );
  if (typeof raw["challenge_id"] !== "string" || !raw["challenge_id"]) fail("Link is malformed.");
  if (typeof raw["callback_url"] !== "string" || !trustedUrl(raw["callback_url"] as string))
    fail("Link points at an untrusted server.");
  if (typeof raw["manifest_url"] === "string" && !trustedUrl(raw["manifest_url"] as string))
    fail("Link points at an untrusted server.");
  const manifestUrl = (raw["manifest_url"] as string) ?? (raw["callback_url"] as string);
  if (new URL(raw["callback_url"] as string).origin !== new URL(manifestUrl).origin)
    fail("Link callback does not match its manifest.");
  const exp = Number(raw["exp"]);
  if (!Number.isFinite(exp) || exp * 1000 <= Date.now()) fail("This link has expired.");
  const chains = Array.isArray(raw["chains"])
    ? (raw["chains"] as unknown[]).filter((c): c is string => typeof c === "string")
    : [];
  return {
    v: Number(raw["v"]) || 1,
    type: "hm-link-xpubs",
    challenge_id: raw["challenge_id"] as string,
    from: (raw["from"] as string) ?? new URL(manifestUrl).hostname,
    callback_url: raw["callback_url"] as string,
    manifest_url: manifestUrl,
    chains,
    exp,
    account_id: (raw["account"] as string) ?? (raw["account_id"] as string) ?? undefined,
    account_name:
      (raw["merchant"] as string) ??
      (raw["account_name"] as string) ??
      (raw["account"] as string) ??
      undefined,
    purpose: (raw["purpose"] as string) ?? undefined,
  };
}

export async function fetchTsdManifest(manifestUrl: string): Promise<TsdLinkManifest> {
  const res = await fetch(`${PROXY}?url=${encodeURIComponent(manifestUrl)}`, {
    headers: { Accept: "application/json" },
  });
  const text = await res.text();
  let body: Record<string, unknown> | null = null;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = null;
  }
  if (!res.ok) {
    // Surface the server's own error text (e.g. 410 "Token expired") so the
    // user knows to regenerate the QR instead of seeing a generic message.
    const serverMsg =
      (body?.["message"] as string) ??
      (body?.["error"] as string) ??
      (!body && text ? text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160) : "");
    throw new Error(serverMsg ? `${serverMsg} (${res.status})` : `Could not read that link (${res.status}).`);
  }
  if (!body) throw new Error("That link returned a page instead of link data.");
  const manifest = validateTsdManifest(body);
  if (new URL(manifest.manifest_url).origin !== new URL(manifestUrl).origin)
    throw new Error("The link manifest does not match its URL.");
  return manifest;
}

export interface TsdLinkResult {
  ok: boolean;
  account_id?: string;
  account_name?: string;
  api_key?: string;
}

export async function submitTsdLink(args: {
  manifest: TsdLinkManifest;
  mnemonic: string;
  passphrase?: string;
}): Promise<TsdLinkResult> {
  const { manifest, mnemonic, passphrase = "" } = args;
  const keys = await deriveWalletKeys(mnemonic, passphrase);

  const payload = {
    v: 1,
    type: "hm-link-xpubs",
    challenge_id: manifest.challenge_id,
    from: manifest.from,
    callback_url: manifest.callback_url,
    chains: Object.keys(keys.xpubs).sort(),
    xpubs: keys.xpubs,
    exp: manifest.exp,
    issued_at: new Date().toISOString(),
  } as const;

  const message = canonicalJson(payload as unknown as Parameters<typeof canonicalJson>[0]);
  const signed = await signMessageWithSeed({
    mnemonic,
    passphrase,
    kind: "bip44",
    change: 0,
    index: 0,
    message,
  });

  const res = await fetch(`${PROXY}?url=${encodeURIComponent(manifest.callback_url)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ payload, signature: signed.signature, address: signed.address }),
  });
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    throw new Error(
      (body?.["message"] as string) ??
        (body?.["hint"] as string) ??
        (body?.["error"] as string) ??
        `Link failed (${res.status})`,
    );
  }
  const apiKey = (body?.["api_key"] as string | undefined) ?? undefined;
  return {
    ok: true,
    account_id: (body?.["account_id"] as string | undefined) ?? undefined,
    account_name: (body?.["account_name"] as string | undefined) ?? undefined,
    api_key: apiKey,
  };
}

/* ------------------------------------------------------------------ */
/* Local record (per vault)                                            */
/* ------------------------------------------------------------------ */

export interface TsdLinkRecord {
  accountId: string;
  accountName: string;
  identity: string;
  linkedAt: string;
}

const STORE_BASE = "hme:tsd-account-link";

export function listTsdLinks(): TsdLinkRecord[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(scopedKey(STORE_BASE));
    const parsed = raw ? (JSON.parse(raw) as TsdLinkRecord[]) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveTsdLink(record: TsdLinkRecord) {
  try {
    const next = [...listTsdLinks().filter((l) => l.accountId !== record.accountId), record];
    window.localStorage.setItem(scopedKey(STORE_BASE), JSON.stringify(next));
  } catch {
    /* noop */
  }
}

export function removeTsdLink(accountId: string) {
  try {
    const next = listTsdLinks().filter((l) => l.accountId !== accountId);
    window.localStorage.setItem(scopedKey(STORE_BASE), JSON.stringify(next));
  } catch {
    /* noop */
  }
}
