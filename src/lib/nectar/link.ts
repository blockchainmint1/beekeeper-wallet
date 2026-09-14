/**
 * Nectar Pay ⇄ wallet link protocol (v1).
 *
 * Hands a merchant watch-only account xpubs, signed by the wallet's TXC
 * identity key (`m/44'/696969'/0'/0/0`, BIP-137 over canonical JSON with the
 * TEXITcoin message prefix). Nothing secret ever leaves the device.
 *
 * Spec: NECTARPAY-LINK.md. Only the manifest flow is implemented.
 */
import * as ecc from "@bitcoinerlab/secp256k1";
import { sha256 } from "@noble/hashes/sha2.js";
import { BIP32Factory } from "bip32";
import { scopedKey } from "@/lib/profiles";
import { DOGE_NETWORK, DOGE_DERIVATION_PATHS } from "@/lib/doge/network";
import { ISK_NETWORK, ISK_DERIVATION_PATHS } from "@/lib/isk/network";
import { LTC_NETWORK, LTC_DERIVATION_PATHS } from "@/lib/ltc/network";
import { TXC_NETWORK, DERIVATION_PATHS as TXC_PATHS } from "@/lib/txc/network";
import { TRON_COIN_TYPE } from "@/lib/tron/network";
import { deriveSolanaAddress } from "@/lib/solana/derive";
import { seedFromMnemonic, deriveAddress, rootFromSeed } from "@/lib/txc/wallet";
import { signMessageWithSeed } from "@/lib/txc/message-sign";

const bip32 = BIP32Factory(ecc);

export const NECTAR_TRUSTED_HOST = "app.nectar-pay.com";
const PROXY = "/api/nectar/link";

export interface NectarManifest {
  v: number;
  type: "hm-link-xpubs";
  challenge_id: string;
  from: string;
  callback_url: string;
  manifest_url: string;
  chains: string[];
  exp: number;
  allow_new_wallet?: boolean;
  known_addresses_count?: number;
  known_addresses_hash?: string;
  store_id?: string;
  merchant_name?: string;
}

export interface NectarLinkResult {
  ok: boolean;
  store_id?: string;
  merchant_name?: string;
  chains_linked?: string[];
}

/* ------------------------------------------------------------------ */
/* Canonical JSON                                                      */
/* ------------------------------------------------------------------ */

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

export function canonicalJson(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, Json>)[k] as Json)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** sha256(dedupe(trim) → drop empty → sort → join("\n")), hex lowercase. */
export function knownAddressesHash(addresses: string[]): string {
  const set = Array.from(new Set(addresses.map((a) => a.trim()).filter(Boolean))).sort();
  return toHex(sha256(new TextEncoder().encode(set.join("\n"))));
}

/* ------------------------------------------------------------------ */
/* Manifest                                                            */
/* ------------------------------------------------------------------ */

const KNOWN_CHAINS = new Set([
  "BTC",
  "TXC",
  "EVM",
  "ZCU",
  "LTC",
  "BCH",
  "TRX",
  "DOGE",
  "DASH",
  "ISK",
  "SOL",
]);

/** Accept either a bare manifest URL or a QR payload containing one. */
export function parseLinkInput(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  try {
    const url = new URL(text);
    if (url.protocol === "https:" && url.hostname === NECTAR_TRUSTED_HOST) return url.toString();
    return null;
  } catch {
    return null;
  }
}

export async function fetchManifest(manifestUrl: string): Promise<NectarManifest> {
  const res = await fetch(`${PROXY}?url=${encodeURIComponent(manifestUrl)}`, {
    headers: { Accept: "application/json" },
  });
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok || !body) {
    throw new Error(
      (body?.["message"] as string) ?? (body?.["error"] as string) ?? "Could not read the link",
    );
  }
  const manifest = validateManifest(body);
  if (manifest.manifest_url !== manifestUrl) throw new Error("The link manifest does not match its URL.");
  return manifest;
}

function sameHost(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      u.protocol === "https:" &&
      u.hostname === NECTAR_TRUSTED_HOST &&
      u.port === "" &&
      u.username === "" &&
      u.password === ""
    );
  } catch {
    return false;
  }
}

export function validateManifest(raw: Record<string, unknown>): NectarManifest {
  const fail = (m: string): never => {
    throw new Error(m);
  };
  if (raw["type"] !== "hm-link-xpubs") fail("This QR isn't a Nectar Pay wallet link.");
  if (raw["from"] !== NECTAR_TRUSTED_HOST) fail("Link comes from an untrusted server.");
  if (typeof raw["challenge_id"] !== "string" || !raw["challenge_id"]) fail("Link is malformed.");
  if (typeof raw["callback_url"] !== "string" || !sameHost(raw["callback_url"] as string))
    fail("Link points at an untrusted server.");
  if (typeof raw["manifest_url"] !== "string" || !sameHost(raw["manifest_url"] as string))
    fail("Link points at an untrusted server.");
  if (new URL(raw["callback_url"] as string).origin !== new URL(raw["manifest_url"] as string).origin)
    fail("Link callback does not match its manifest.");
  const exp = Number(raw["exp"]);
  if (!Number.isFinite(exp) || exp * 1000 <= Date.now()) fail("This link has expired.");
  const chains = Array.isArray(raw["chains"])
    ? Array.from(
        new Set(
          (raw["chains"] as unknown[])
            .filter((c): c is string => typeof c === "string")
            .map((c) => c.toUpperCase())
            .filter((c) => KNOWN_CHAINS.has(c)),
        ),
      )
    : [];
  if (chains.length === 0) fail("Link requests no supported chains.");
  return {
    v: Number(raw["v"]) || 1,
    type: "hm-link-xpubs",
    challenge_id: raw["challenge_id"] as string,
    from: (raw["from"] as string) ?? NECTAR_TRUSTED_HOST,
    callback_url: raw["callback_url"] as string,
    manifest_url: raw["manifest_url"] as string,
    chains,
    exp,
    allow_new_wallet: Boolean(raw["allow_new_wallet"]),
    known_addresses_count: Number(raw["known_addresses_count"] ?? 0),
    known_addresses_hash: (raw["known_addresses_hash"] as string) ?? undefined,
    store_id: (raw["store_id"] as string) ?? undefined,
    merchant_name: (raw["merchant_name"] as string) ?? undefined,
  };
}

export type ConsentMode = "silent" | "confirm-new-wallet" | "blocked" | "optimistic";

/** Three-way consent branch from the manifest + this wallet's identity. */
export function consentMode(manifest: NectarManifest, identityAddress: string): ConsentMode {
  const count = manifest.known_addresses_count ?? 0;
  if (count === 0) return "silent";
  if (count === 1) {
    if (manifest.known_addresses_hash === knownAddressesHash([identityAddress])) return "silent";
    return manifest.allow_new_wallet ? "confirm-new-wallet" : "blocked";
  }
  return "optimistic";
}

/* ------------------------------------------------------------------ */
/* Key material (watch-only)                                           */
/* ------------------------------------------------------------------ */

/** BIP84 BTC account key is serialized as zpub, not xpub. */
const ZPUB_VERSIONS = { public: 0x04b24746, private: 0x04b2430c };
const XPUB_VERSIONS = { public: 0x0488b21e, private: 0x0488ade4 };

/**
 * bip32 validates the whole network object (wif included), so synthetic
 * serializations must carry mainnet Bitcoin defaults alongside the versions.
 */
function serializationNetwork(bip32Versions: { public: number; private: number }) {
  return {
    messagePrefix: "\x18Bitcoin Signed Message:\n",
    bech32: "bc",
    bip32: bip32Versions,
    pubKeyHash: 0x00,
    scriptHash: 0x05,
    wif: 0x80,
  };
}

function accountXpub(
  seed: Uint8Array,
  path: string,
  net: { bip32: { public: number; private: number } },
): string {
  return bip32.fromSeed(seed, net as never).derivePath(path).neutered().toBase58();
}

/**
 * Bitcoin Cash: BTC-style legacy params, SLIP-44 coin type 145.
 * Standard xpub serialization — BCH never adopted custom version bytes.
 */
const BCH_NETWORK = {
  ...serializationNetwork(XPUB_VERSIONS),
  messagePrefix: "\x18Bitcoin Signed Message:\n",
};
const BCH_PATH = "m/44'/145'/0'";

/**
 * Dash: P2PKH 0x4c (X…), P2SH 0x10, WIF 0xcc, SLIP-44 coin type 5.
 * Standard xpub serialization (drkv/drkp is an Electrum-Dash convention,
 * not what watch-only indexers expect).
 */
const DASH_NETWORK = {
  ...serializationNetwork(XPUB_VERSIONS),
  messagePrefix: "\x19DarkCoin Signed Message:\n",
  pubKeyHash: 0x4c,
  scriptHash: 0x10,
  wif: 0xcc,
};
const DASH_PATH = "m/44'/5'/0'";



export interface WalletKeys {
  /** Stable wallet ID across devices: TXC legacy P2PKH at m/44'/696969'/0'/0/0. */
  identityAddress: string;
  xpubs: Record<string, string>;
}

/** Derive every watch-only account key we can offer. Extra keys are harmless. */
export async function deriveWalletKeys(mnemonic: string, passphrase = ""): Promise<WalletKeys> {
  const seed = await seedFromMnemonic(mnemonic, passphrase);
  const txcRoot = rootFromSeed(seed);
  const identityAddress = deriveAddress(txcRoot, "bip44", 0, 0).address;

  const evm = accountXpub(seed, "m/44'/60'/0'", serializationNetwork(XPUB_VERSIONS));
  const xpubs: Record<string, string> = {
    TXC: accountXpub(seed, TXC_PATHS.bip44, TXC_NETWORK),
    BTC: accountXpub(seed, "m/84'/0'/0'", serializationNetwork(ZPUB_VERSIONS)),
    EVM: evm,
    ZCU: evm,
    LTC: accountXpub(seed, LTC_DERIVATION_PATHS.bip84, LTC_NETWORK),
    DOGE: accountXpub(seed, DOGE_DERIVATION_PATHS.bip44, DOGE_NETWORK),
    BCH: accountXpub(seed, BCH_PATH, BCH_NETWORK),
    DASH: accountXpub(seed, DASH_PATH, DASH_NETWORK),
    ISK: accountXpub(seed, ISK_DERIVATION_PATHS.bip44, ISK_NETWORK),
    TRX: accountXpub(seed, `m/44'/${TRON_COIN_TYPE}'/0'`, serializationNetwork(XPUB_VERSIONS)),
    // Solana is ed25519: no BIP32 xpub exists, so we hand over the single
    // account public key (base58) derived at m/44'/501'/0'/0'.
    SOL: deriveSolanaAddress(seed),
  };
  return { identityAddress, xpubs };
}

/* ------------------------------------------------------------------ */
/* Claim                                                               */
/* ------------------------------------------------------------------ */

export async function submitLink(args: {
  manifest: NectarManifest;
  mnemonic: string;
  passphrase?: string;
}): Promise<NectarLinkResult> {
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

  const message = canonicalJson(payload as unknown as Json);
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
    const msg =
      (body?.["message"] as string) ??
      (body?.["hint"] as string) ??
      (body?.["error"] as string) ??
      `Link failed (${res.status})`;
    throw new Error(msg);
  }
  return {
    ok: true,
    store_id: body?.["store_id"] as string | undefined,
    merchant_name: body?.["merchant_name"] as string | undefined,
    chains_linked: (body?.["chains_linked"] as string[] | undefined) ?? Object.keys(keys.xpubs),
  };
}

/* ------------------------------------------------------------------ */
/* Local records (per vault)                                           */
/* ------------------------------------------------------------------ */

export interface NectarLinkRecord {
  merchantId: string;
  merchantName: string;
  url: string;
  linkedAt: string;
}

const STORE_BASE = "hme:nectar-links";

export function listLinks(): NectarLinkRecord[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(scopedKey(STORE_BASE));
    return raw ? (JSON.parse(raw) as NectarLinkRecord[]) : [];
  } catch {
    return [];
  }
}

export function saveLink(record: NectarLinkRecord) {
  try {
    const next = [record, ...listLinks().filter((l) => l.merchantId !== record.merchantId)];
    window.localStorage.setItem(scopedKey(STORE_BASE), JSON.stringify(next));
  } catch {
    /* noop */
  }
}

export function removeLink(merchantId: string) {
  try {
    window.localStorage.setItem(
      scopedKey(STORE_BASE),
      JSON.stringify(listLinks().filter((l) => l.merchantId !== merchantId)),
    );
  } catch {
    /* noop */
  }
}

/** Forget every linked merchant on this device (does not unlink server-side). */
export function clearLinks() {
  try {
    window.localStorage.removeItem(scopedKey(STORE_BASE));
  } catch {
    /* noop */
  }
}
