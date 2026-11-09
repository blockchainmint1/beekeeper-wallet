/**
 * Single source of truth for the origins the app trusts.
 *
 * - PROD_ORIGIN: the ONE deployed server every build talks to. The native
 *   app forwards all `/_serverFn/*` and `/api/*` calls here, so this host
 *   decides cash-out deposit addresses, swap/bridge calldata and release
 *   info for every phone user. It must be BeeKeeper's own deployment.
 * - NATIVE_WEBVIEW_ORIGIN: the LOCAL origin the Capacitor WebView serves the
 *   bundled app from. Nothing is fetched from this host over the network;
 *   it only exists so localStorage (the encrypted wallet) keeps its keying.
 *   Never forward requests to it.
 *
 * The bridge, CSP, CORS allowlist and API caller checks all import from here
 * so they cannot drift apart (see origins.test.ts).
 */
export const PROD_ORIGIN = "https://beekeeper.money";

/** Other deployments of this same project (published lovable.app URL). */
export const PROD_ALIASES = ["https://beekeeper-wallet.lovable.app"] as const;

export const NATIVE_WEBVIEW_ORIGIN = "https://mobile.honest.money";
export const NATIVE_WEBVIEW_HOST = new URL(NATIVE_WEBVIEW_ORIGIN).host;

/** Hosts whose Origin header identifies our own app as the caller. */
export const TRUSTED_CALLER_HOSTS: ReadonlySet<string> = new Set([
  new URL(PROD_ORIGIN).host,
  ...PROD_ALIASES.map((o) => new URL(o).host),
  NATIVE_WEBVIEW_HOST,
]);
