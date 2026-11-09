/**
 * Ephemeral unlocked-wallet cache. The plaintext mnemonic is NEVER written to
 * disk (sessionStorage / localStorage / IndexedDB) in cleartext.
 *
 * How it works:
 *  - On first save, we generate a random AES-GCM key kept only in module-local
 *    memory. The mnemonic + metadata are encrypted with this key and the
 *    ciphertext is stored in sessionStorage so an intra-tab reload can rehydrate.
 *  - When the JS runtime is torn down (tab close, process kill, hard reload
 *    that replaces the module graph), the in-memory key vanishes and any
 *    surviving ciphertext becomes unrecoverable — forcing password/biometric
 *    unlock. This is the desired security posture.
 *  - The sliding 5-minute auto-lock timer is enforced separately in
 *    wallet-context.tsx; this module only stores what's needed to rehydrate.
 */
import type { UnlockedWallet } from "./storage";

const KEY = "txc.wallet.session.v2";
export const AUTO_LOCK_MS = 5 * 60 * 1000; // 5 minutes

interface CachedPlain {
  wallet: UnlockedWallet;
  /**
   * The wallet password, kept ONLY inside this ephemeral envelope (encrypted
   * with a per-process in-memory AES key). One password unlocks every profile,
   * so switching vaults must not re-prompt while the session is alive.
   */
  password?: string;
  lastActiveAt: number;
}

interface CachedWire {
  v: 2;
  iv: string; // base64
  ct: string; // base64
  lastActiveAt: number;
}

let memKey: CryptoKey | null = null;
// In-memory shadow so we still work if sessionStorage is blocked (some
// WebViews with privacy modes) or if crypto.subtle throws.
let memPayload: CachedPlain | null = null;

function safeSession(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function b64(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s);
}
function unb64(s: string): Uint8Array {
  const raw = atob(s);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

async function ensureKey(): Promise<CryptoKey | null> {
  if (memKey) return memKey;
  try {
    if (typeof crypto === "undefined" || !crypto.subtle) return null;
    memKey = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
    return memKey;
  } catch {
    return null;
  }
}

export async function saveSession(wallet: UnlockedWallet, password?: string): Promise<void> {
  memPayload = {
    wallet,
    password: password ?? memPayload?.password,
    lastActiveAt: Date.now(),
  };
  // Memory only (audit 2026-11-09 M7). The old encrypted sessionStorage copy
  // could never be decrypted after a reload (its key lived in memory too), so
  // it only left ciphertext of the seed + password behind. Drop any leftover.
  dropStoredSession();
}

export function touchSession(): void {
  if (memPayload) memPayload.lastActiveAt = Date.now();
}

/** The session password, when the session is still alive. */
export function getSessionPassword(): string | null {
  if (!memPayload) return null;
  if (Date.now() - memPayload.lastActiveAt > AUTO_LOCK_MS) return null;
  return memPayload.password ?? null;
}

export async function loadSession(): Promise<UnlockedWallet | null> {
  if (!memPayload) return null;
  if (Date.now() - memPayload.lastActiveAt > AUTO_LOCK_MS) {
    clearSession();
    return null;
  }
  return memPayload.wallet;
}

function dropStoredSession(): void {
  const s = safeSession();
  if (!s) return;
  try {
    s.removeItem(KEY);
    s.removeItem("txc.wallet.session.v1");
  } catch {
    /* noop */
  }
}

export function clearSession(): void {
  memPayload = null;
  dropStoredSession();
}
