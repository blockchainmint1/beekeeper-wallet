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
