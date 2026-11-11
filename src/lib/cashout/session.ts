/**
 * In-progress cash-out, saved per wallet in localStorage (round-2 audit 2.2).
 *
 * Each send's txid is written the moment it returns, so a reload, a closed
 * tab or a crash between "coins sent" and "order confirmed" never loses the
 * txids — reopening Cash out picks up on the send list with the same order
 * reference and a "Complete cash-out" button.
 */
import { scopedKey } from "@/lib/profiles";

export const CASHOUT_SESSION_BASE = "beekeeper.cashout.session.v1";

export function readCashoutSession<T = unknown>(): T | null {
  try {
    const raw = localStorage.getItem(scopedKey(CASHOUT_SESSION_BASE));
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function writeCashoutSession(session: unknown): void {
  try {
    localStorage.setItem(scopedKey(CASHOUT_SESSION_BASE), JSON.stringify(session));
  } catch {
    /* private mode — falls back to in-memory state only */
  }
}

export function clearCashoutSession(): void {
  try {
    localStorage.removeItem(scopedKey(CASHOUT_SESSION_BASE));
    // Older builds kept it in sessionStorage.
    sessionStorage.removeItem(CASHOUT_SESSION_BASE);
  } catch {
    /* noop */
  }
}

/** Record one line's result immediately (called right after each send). */
export function recordCashoutLine(key: string, status: { state: string; txid?: string; error?: string }): void {
  const s = readCashoutSession<{ status?: Record<string, unknown> }>();
  if (!s) return;
  s.status = { ...(s.status ?? {}), [key]: status };
  writeCashoutSession(s);
}
