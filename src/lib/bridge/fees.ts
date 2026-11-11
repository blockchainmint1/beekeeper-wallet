/**
 * Top-up pricing and Bridge environment helpers. Browser-safe.
 *
 * The fee is set on each customer's Bridge deposit account as Bridge's
 * `developer_fee_percent`, so Bridge takes it from every deposit before it
 * converts the rest. Bridge's own minimum applies after the fee.
 */
export const TOPUP_FEE_PERCENT = 3;

/** Bridge's smallest delivery for USDC on Base, counted after our fee. */
export const BRIDGE_MIN_NET_USD = 1;

/** Bridge wants the fee as a decimal string, e.g. "3.0". */
export function bridgeFeeString(percent = TOPUP_FEE_PERCENT): string {
  return percent.toFixed(1);
}

/** What a deposit of `usd` turns into after the top-up fee (cents, rounded down for the customer). */
export function topupQuote(usd: number, percent = TOPUP_FEE_PERCENT) {
  if (!Number.isFinite(usd) || usd <= 0) return { feeUsd: 0, netUsd: 0, belowMinimum: true };
  const cents = Math.round(usd * 100);
  const feeCents = Math.round((cents * percent) / 100);
  const netCents = cents - feeCents;
  return { feeUsd: feeCents / 100, netUsd: netCents / 100, belowMinimum: netCents < BRIDGE_MIN_NET_USD * 100 };
}

export type BridgeEnv = "sandbox" | "live";

/** Sandbox keys start with `sk-test`; anything else is a live key. */
export function bridgeEnvForKey(key: string): BridgeEnv {
  return key.trim().startsWith("sk-test") ? "sandbox" : "live";
}

export function bridgeBaseUrl(env: BridgeEnv): string {
  return env === "sandbox" ? "https://api.sandbox.bridge.xyz/v0" : "https://api.bridge.xyz/v0";
}
