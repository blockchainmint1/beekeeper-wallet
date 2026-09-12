import type { BIP32Interface } from "bip32";
import { isLegacyCoinTypeKind, type DerivationKind } from "./network";
import { rootFromSeed, seedFromMnemonic } from "./wallet";
import {
  DEFAULT_PROFILE_ID,
  activeProfileId,
  listProfileIds,
  newProfileId,
  purgeProfileStorage,
  registerProfile,
  scopedKey,
  setActiveProfileId,
  unregisterProfile,
} from "@/lib/profiles";
/**
 * Encrypted wallet storage for the TEXITcoin web wallet.
 *
 * - Wallet secret (BIP39 mnemonic + optional passphrase) is encrypted with a
 *   password-derived key (PBKDF2-SHA256, 600k iterations) using AES-GCM via
 *   the browser WebCrypto API.
 * - The ciphertext + salt + IV are stored in localStorage.
 * - Plaintext seed lives only in memory while the wallet is unlocked.
 *
 * NOTE: browser storage is not the same as a phone's secure enclave.
 * The seed phrase backup written down by the user is always the source of truth.
 */

const STORAGE_KEY = "txc.wallet.v1";

/**
 * Envelope key for a profile ("vault"). The first/default profile keeps the
 * historical unprefixed key, so existing installs are untouched.
 */
function walletKey(profileId: string = activeProfileId()): string {
  return scopedKey(STORAGE_KEY, profileId);
}
// KDF cost for NEW wallets. 600k PBKDF2-SHA256 is the current OWASP
// recommendation and keeps unlock responsive on phones (1M made unlock take
// several seconds). The actual count used to DECRYPT is read from each
// envelope (see `iterations` below) so existing wallets keep unlocking with
// whatever they were saved at. This is what prevents a lockout when the
// default changes.
const PBKDF2_ITERATIONS = 600_000;
// Envelopes written before this field existed were all PBKDF2-SHA256 @ 600k.
const LEGACY_ITERATIONS = 600_000;

/**
 * Envelopes written before the SLIP-0044 fix stored kinds like "bip84" that
 * meant Bitcoin's coin type (m/84'/0'/0'). Those users' funds live on that
 * path, so map them onto the explicit "-legacy" kinds. `pathsV` marks
 * envelopes written after the fix, where the unsuffixed kinds mean 696969'.
 */
function migrateKind(env: StoredWalletEnvelope): DerivationKind {
  if (env.pathsV && env.pathsV >= 2) return env.kind;
  return isLegacyCoinTypeKind(env.kind)
    ? env.kind
    : (`${env.kind}-legacy` as DerivationKind);
}

export interface StoredWalletEnvelope {
  v: 1;
  kind: DerivationKind;
  label: string;
  /** base64 */ salt: string;
  /** base64 */ iv: string;
  /** base64 */ ciphertext: string;
  createdAt: number;
  /** KDF identifier. Absent on legacy envelopes (implies pbkdf2-sha256). */
  kdf?: "pbkdf2-sha256";
  /** PBKDF2 iteration count this envelope was encrypted with. Absent = 600k. */
  iterations?: number;
  /** Derivation-path scheme version. Absent/1 = pre-SLIP-0044 (coin type 0'). */
  pathsV?: 2;
  /**
   * "keyonly" = seed-free wallet. There is no BIP39 mnemonic; the envelope
   * holds a random 32-byte anchor used solely to derive the wrapping key for
   * imported WIF private keys. Absent = normal seed wallet.
   */
  mode?: "keyonly";
}

export interface UnlockedWallet {
  mnemonic: string;
  passphrase: string;
  kind: DerivationKind;
  label: string;
  /** Seed-free wallets carry no mnemonic; see StoredWalletEnvelope.mode. */
  mode?: "seed" | "keyonly";
  /** base64 random anchor — present only for key-only wallets. */
  anchor?: string;
}


function b64encode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

// WebCrypto wants ArrayBufferView<ArrayBuffer>, not the broader ArrayBufferLike
// that Uint8Array carries. Copy into a fresh ArrayBuffer to satisfy the types.
function toAB(u: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(u.byteLength);
  new Uint8Array(out).set(u);
  return out;
}

function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveKey(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: toAB(salt),
      iterations,
      hash: "SHA-256",
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function saveWallet(
  unlocked: UnlockedWallet,
  password: string,
): Promise<StoredWalletEnvelope> {
  if (typeof window === "undefined") throw new Error("saveWallet requires a browser");
  const keyOnly = unlocked.mode === "keyonly";
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt, PBKDF2_ITERATIONS);
  const payload = new TextEncoder().encode(
    keyOnly
      ? JSON.stringify({ mode: "keyonly", a: unlocked.anchor })
      : JSON.stringify({ m: unlocked.mnemonic, p: unlocked.passphrase }),
  );
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: toAB(iv) }, key, toAB(payload)),
  );

  const env: StoredWalletEnvelope = {
    v: 1,
    kind: unlocked.kind,
    label: unlocked.label,
    salt: b64encode(salt),
    iv: b64encode(iv),
    ciphertext: b64encode(ct),
    createdAt: Date.now(),
    kdf: "pbkdf2-sha256",
    iterations: PBKDF2_ITERATIONS,
    pathsV: 2,
    ...(keyOnly ? { mode: "keyonly" as const } : {}),
  };
  registerProfile(activeProfileId());
  localStorage.setItem(walletKey(), JSON.stringify(env));
  return env;
}

/**
 * Create and persist a seed-free ("key-only") wallet. There is no BIP39
 * mnemonic: we store a random 32-byte anchor, encrypted with the user's
 * password, which is used solely to derive the wrapping key for imported WIF
 * private keys. Everything else about the wallet lifecycle stays the same.
 */
export async function createKeyOnlyWallet(
  password: string,
  label = "Imported keys",
): Promise<UnlockedWallet> {
  const anchorBytes = crypto.getRandomValues(new Uint8Array(32));
  const unlocked: UnlockedWallet = {
    mnemonic: "",
    passphrase: "",
    kind: "bip84",
    label,
    mode: "keyonly",
    anchor: b64encode(anchorBytes),
  };
  await saveWallet(unlocked, password);
  return unlocked;
}

/**
 * Upgrade a key-only wallet to a seed-phrase HD wallet.
 *
 * All imported WIFs are decrypted with the old anchor root and re-encrypted
 * with the new seed-derived root, so they stay usable. The new wallet keeps
 * the same password and defaults to the standard TXC legacy (T…) path.
 */
export async function upgradeKeyOnlyToSeed(
  mnemonic: string,
  passphrase: string,
  password: string,
  oldRoot: BIP32Interface,
): Promise<UnlockedWallet> {
  if (typeof window === "undefined") throw new Error("upgradeKeyOnlyToSeed requires a browser");
  const seed = await seedFromMnemonic(mnemonic, passphrase);
  const newRoot = rootFromSeed(seed);

  const { reencryptAllWifs } = await import("@/lib/wif/store");
  await reencryptAllWifs(oldRoot, newRoot);

  const unlocked: UnlockedWallet = {
    mnemonic,
    passphrase,
    kind: "bip44",
    label: "Main wallet",
    mode: "seed",
  };
  await saveWallet(unlocked, password);
  return unlocked;
}

export function loadEnvelope(profileId?: string): StoredWalletEnvelope | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(walletKey(profileId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredWalletEnvelope;
  } catch {
    return null;
  }
}

/** True when the stored wallet has no seed phrase (WIF-only wallet). */
export function isKeyOnlyWallet(): boolean {
  return loadEnvelope()?.mode === "keyonly";
}

export async function unlockWallet(password: string): Promise<UnlockedWallet | null> {
  const env = loadEnvelope();
  if (!env) return null;
  try {
    const iterations = env.iterations ?? LEGACY_ITERATIONS;
    const key = await deriveKey(password, b64decode(env.salt), iterations);
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: toAB(b64decode(env.iv)) },
      key,
      toAB(b64decode(env.ciphertext)),
    );

    const parsed = JSON.parse(new TextDecoder().decode(pt)) as {
      m?: string;
      p?: string;
      mode?: string;
      a?: string;
    };
    const keyOnly = env.mode === "keyonly" || parsed.mode === "keyonly";
    const unlocked: UnlockedWallet = keyOnly
      ? {
          mnemonic: "",
          passphrase: "",
          kind: migrateKind(env),
          label: env.label,
          mode: "keyonly",
          anchor: parsed.a ?? "",
        }
      : {
          mnemonic: parsed.m ?? "",
          passphrase: parsed.p ?? "",
          kind: migrateKind(env),
          label: env.label,
          mode: "seed",
        };

    // Silent KDF upgrade: if this envelope predates the current cost (or has
    // no recorded iteration count), transparently re-encrypt at the stronger
    // setting now that we hold the correct password and plaintext. Best-effort
    // only — a failure here must never block a successful unlock.
    if ((env.iterations ?? LEGACY_ITERATIONS) < PBKDF2_ITERATIONS) {
      try {
        await saveWallet(unlocked, password);
      } catch {
        /* keep the old envelope; user is still unlocked */
      }
    }

    return unlocked;
  } catch {
    return null;
  }
}


export function deleteWallet(): void {
  if (typeof window === "undefined") return;
  const id = activeProfileId();
  localStorage.removeItem(walletKey(id));
  if (id !== DEFAULT_PROFILE_ID) {
    purgeProfileStorage(id);
    unregisterProfile(id);
    setActiveProfileId(DEFAULT_PROFILE_ID);
  }
}

/**
 * Forget a single profile (vault) without touching the others. Used by the
 * settings wallet list to remove a seed that is no longer needed. Funds stay
 * on the blockchain; the seed phrase is the only backup.
 */
export function deleteProfileWallet(profileId: string): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(walletKey(profileId));
  if (profileId !== DEFAULT_PROFILE_ID) {
    purgeProfileStorage(profileId);
    unregisterProfile(profileId);
  }
  // If the active vault was removed, fall back to whichever profile remains.
  if (profileId === activeProfileId()) {
    const remaining = listProfileIds().find((id) => id !== profileId);
    setActiveProfileId(remaining ?? DEFAULT_PROFILE_ID);
  }
}

/**
 * Rename the stored wallet without re-encrypting. The label is metadata
 * only — the encrypted seed material is untouched.
 */
export function renameStoredWallet(
  newLabel: string,
  profileId?: string,
): StoredWalletEnvelope | null {
  const env = loadEnvelope(profileId);
  if (!env) return null;
  const next: StoredWalletEnvelope = { ...env, label: newLabel };
  localStorage.setItem(walletKey(profileId), JSON.stringify(next));
  return next;
}

/**
 * Change which derivation path this wallet treats as primary (the branch new
 * receive addresses and change come from). Metadata only — the encrypted seed
 * is untouched, and every other path stays in the background scan, so funds
 * are never hidden by this switch.
 */
export function setStoredKind(kind: DerivationKind): StoredWalletEnvelope | null {
  const env = loadEnvelope();
  if (!env) return null;
  const next: StoredWalletEnvelope = { ...env, kind, pathsV: 2 };
  localStorage.setItem(walletKey(), JSON.stringify(next));
  return next;
}

export function hasWallet(): boolean {
  return loadEnvelope() !== null;
}

/* -------------------------------------------------------------------------
 * Profiles (multi-seed vaults)
 * ---------------------------------------------------------------------- */

export interface WalletProfileSummary {
  id: string;
  label: string;
  createdAt: number;
  mode: "seed" | "keyonly";
  isActive: boolean;
}

/** Every profile that actually holds an encrypted wallet, oldest first. */
export function listWalletProfiles(): WalletProfileSummary[] {
  if (typeof window === "undefined") return [];
  const active = activeProfileId();
  return listProfileIds()
    .map((id) => {
      const env = loadEnvelope(id);
      if (!env) return null;
      return {
        id,
        label: env.label || "Wallet",
        createdAt: env.createdAt ?? 0,
        mode: env.mode === "keyonly" ? ("keyonly" as const) : ("seed" as const),
        isActive: id === active,
      };
    })
    .filter((p): p is WalletProfileSummary => p !== null);
}

export function getActiveProfileId(): string {
  return activeProfileId();
}

/**
 * Create a brand-new profile and store `unlocked` in it, encrypted with the
 * same password used everywhere else on this device (one password unlocks all
 * profiles). Returns the new profile id, which is left active.
 */
export async function saveWalletToNewProfile(
  unlocked: UnlockedWallet,
  password: string,
): Promise<string> {
  const id = newProfileId();
  registerProfile(id);
  setActiveProfileId(id);
  try {
    await saveWallet(unlocked, password);
  } catch (e) {
    unregisterProfile(id);
    setActiveProfileId(DEFAULT_PROFILE_ID);
    throw e;
  }
  return id;
}

/** Switch profiles and unlock the target with the shared password. */
export async function unlockProfile(
  profileId: string,
  password: string,
): Promise<UnlockedWallet | null> {
  const previous = activeProfileId();
  setActiveProfileId(profileId);
  const w = await unlockWallet(password);
  if (!w) {
    setActiveProfileId(previous);
    return null;
  }
  return w;
}
