/**
 * Ephemeral unlocked-wallet cache — MEMORY ONLY. Nothing (plaintext or
 * ciphertext) is written to sessionStorage / localStorage / IndexedDB; a
 * reload or process kill always means password/biometric unlock again.
 * The sliding 5-minute auto-lock is enforced via `lastActiveAt`.
 */
import type { UnlockedWallet } from "./storage";

const KEY = "txc.wallet.session.v2";
export const AUTO_LOCK_MS = 5 * 60 * 1000; // 5 minutes

interface CachedPlain {
  wallet: UnlockedWallet;
  /**
   * The wallet password, kept ONLY in this in-memory session. One password unlocks every profile,
   * so switching vaults must not re-prompt while the session is alive.
   */
  password?: string;
  lastActiveAt: number;
}

let memPayload: CachedPlain | null = null;

function safeSession(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.sessionStorage;
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
