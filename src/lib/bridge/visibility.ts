import { PROD_ALIASES, PROD_ORIGIN } from "@/lib/native/origins";

/**
 * Top-ups are still on Bridge's sandbox (fake bank numbers, no real money),
 * so the live site keeps showing "Top up — coming soon". The preview and
 * local dev keep the working test flow. Flip TOPUP_LIVE to true at go-live
 * (see docs/bridge-go-live.md).
 */
export const TOPUP_LIVE = false;

const LIVE_HOSTS = new Set([PROD_ORIGIN, ...PROD_ALIASES].map((o) => new URL(o).host));

export function topupOpenOnHost(host: string): boolean {
  if (TOPUP_LIVE) return true;
  return !LIVE_HOSTS.has(host.toLowerCase());
}

/**
 * Hidden tester unlock for the live site while Bridge is still in sandbox:
 * five quick taps on "Top up · soon" open the test flow for this page visit
 * only (nothing is saved, a reload locks it again). Returns the updated tap
 * history and whether it unlocked.
 */
export const UNLOCK_TAPS = 5;
export const UNLOCK_WINDOW_MS = 2500;

export function registerUnlockTap(taps: number[], now: number): { taps: number[]; unlocked: boolean } {
  const recent = [...taps, now].filter((t) => now - t <= UNLOCK_WINDOW_MS);
  if (recent.length >= UNLOCK_TAPS) return { taps: [], unlocked: true };
  return { taps: recent, unlocked: false };
}
