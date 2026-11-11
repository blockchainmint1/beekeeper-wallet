/**
 * One-tap cash-out: pick what to send without asking the merchant anything.
 *
 * Rules (same defaults the step-by-step picker uses):
 *   - skip balances that can't pay their own network fee ("blocked")
 *   - skip Ethereum balances under $10 — the fee would eat too much of it
 *   - biggest balances first, up to the per-order maximum; the last one is
 *     sent in part when it would push the order over the maximum
 */
import { scopedKey } from "@/lib/profiles";

export interface OneTapCandidate {
  key: string;
  chain: string;
  usd: number;
  blocked?: string;
}

export interface OneTapPlan {
  keys: string[];
  /** Partial amounts (USD, as typed in the picker) — only for the row that was cut. */
  amounts: Record<string, string>;
  total: number;
}

export const SMALL_ETH_USD = 10;

export function planOneTap(rows: OneTapCandidate[], maxUsd: number): OneTapPlan {
  const eligible = rows
    .filter((r) => !r.blocked && r.usd > 0 && !(r.chain === "eth" && r.usd < SMALL_ETH_USD))
    .sort((a, b) => b.usd - a.usd);
  const keys: string[] = [];
  const amounts: Record<string, string> = {};
  let total = 0;
  for (const row of eligible) {
    const room = Math.floor((maxUsd - total) * 100) / 100;
    if (room < 0.01) break;
    if (row.usd <= room) {
      keys.push(row.key);
      total += row.usd;
    } else {
      keys.push(row.key);
      amounts[row.key] = room.toFixed(2);
      total += room;
      break;
    }
  }
  return { keys, amounts, total: Math.round(total * 100) / 100 };
}

/** Shape appliedAmount needs (a cash-out row, TSD or EVM token). */
export interface PartialRow {
  key: string;
  usd: number;
  coinAmount: number;
  evm?: { raw: bigint; token: { decimals: number } };
}

/**
 * A row with its manually lowered / one-tap-cut amount applied, or unchanged
 * when the typed amount is blank or not below the full balance. Used for
 * both TSD and EVM lines, so a cut TSD line sends only the cut amount.
 */
export function appliedAmount<T extends PartialRow>(row: T, amounts: Record<string, string>): T {
  const txt = amounts[row.key];
  if (!txt) return row;
  const v = Number(txt);
  if (!Number.isFinite(v) || v <= 0 || v >= row.usd) return row;
  if (row.evm) {
    const raw = BigInt(Math.round(v * 10 ** row.evm.token.decimals));
    if (raw <= 0n || raw >= row.evm.raw) return row;
    const coin = Number(raw) / 10 ** row.evm.token.decimals;
    return { ...row, usd: coin, coinAmount: coin };
  }
  const coin = Math.min(Math.round((v / row.usd) * row.coinAmount * 1e8) / 1e8, row.coinAmount);
  return { ...row, usd: coin, coinAmount: coin };
}

/* ------------------------------------------------------------------ */
/* "I agree to the cash-out terms" — asked once per wallet             */
/* ------------------------------------------------------------------ */

export const CASHOUT_TERMS_BASE = "beekeeper.cashout.terms.v1";

/** Stored value is the list of term ids agreed to; a new term means asking again. */
export function hasAcceptedCashoutTerms(ids: readonly string[]): boolean {
  try {
    const raw = localStorage.getItem(scopedKey(CASHOUT_TERMS_BASE));
    if (!raw) return false;
    const saved = JSON.parse(raw) as string[];
    return ids.every((id) => saved.includes(id));
  } catch {
    return false;
  }
}

export function rememberCashoutTerms(ids: readonly string[]): void {
  try {
    localStorage.setItem(scopedKey(CASHOUT_TERMS_BASE), JSON.stringify([...ids]));
  } catch {
    /* private mode — they'll just be asked again next time */
  }
}
