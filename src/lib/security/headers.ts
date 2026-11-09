/**
 * Central definition of the app's security headers, so the SSR server
 * (src/start.ts) and the HTML shell (src/routes/__root.tsx) can't drift.
 *
 * The Content-Security-Policy is the single most important control for a
 * wallet: even if a script is somehow injected (XSS, a compromised
 * dependency, an MITM without cert pinning), a strict `connect-src` prevents
 * it from exfiltrating the seed phrase or password to an attacker-controlled
 * server, and `object-src` / `base-uri` / `form-action` close common
 * escalation vectors.
 *
 * NOTE on `script-src`: this SSR React app relies on framework-generated
 * inline hydration scripts plus two small inline bootstrap scripts in
 * __root.tsx. Locking `script-src` to hashes/nonces requires threading a
 * per-request nonce through TanStack Start and is tracked as a follow-up
 * (see SECURITY-AUDIT.md, H2). Until then we keep `'unsafe-inline'` on
 * `script-src` ONLY. That does not weaken the exfiltration protection, which
 * comes from `connect-src`.
 *
 * Client-side network destinations that must stay in `connect-src`:
 *   - 'self'                          same-origin API proxy + server functions
 *   - https://mempool.texitcoin.org  TXC balance/UTXO/broadcast (client fetch)
 *   - https://mempool.iskandercoin.com  ISK balance/UTXO/broadcast (client fetch)
 * Everything else (Alchemy, CoinMarketCap, LI.FI, Nectar) is called from the
 * server only, so it must NOT be added here.
 */

const CONNECT_SRC = [
  "'self'",
  "https://mempool.texitcoin.org",
  "https://mempool.iskandercoin.com",
  // BeeKeeper's own deployment: the native app's server calls and the
  // release feed. (The old HME hosts were removed in the 2026-11-09 audit.)
  PROD_ORIGIN,
  ...PROD_ALIASES,
].join(" ");

const CSP_DIRECTIVES: Record<string, string> = {
  "default-src": "'self'",
  // See note above: unsafe-inline stays until nonce plumbing lands.
  "script-src": "'self' 'unsafe-inline'",
  // Tailwind + Radix/vaul inject inline styles.
  "style-src": "'self' 'unsafe-inline'",
  // Token/tool logos and QR data URLs. https allowed, cleartext http is not.
  "img-src": "'self' data: https:",
  "font-src": "'self' data:",
  "connect-src": CONNECT_SRC,
  "manifest-src": "'self'",
  "worker-src": "'self' blob:",
  "object-src": "'none'",
  "base-uri": "'none'",
  "form-action": "'self'",
  "frame-src": "'none'",
  "frame-ancestors": "'none'",
  "upgrade-insecure-requests": "",
};

/** Full CSP string suitable for a response header. */
export const CONTENT_SECURITY_POLICY = Object.entries(CSP_DIRECTIVES)
  .map(([k, v]) => (v ? `${k} ${v}` : k))
  .join("; ");

/**
 * CSP for a <meta http-equiv> tag. `frame-ancestors` is ignored inside a
 * meta tag by spec, so we drop it here (it is still sent as a real header by
 * the server) to avoid a console warning.
 */
export const CONTENT_SECURITY_POLICY_META = Object.entries(CSP_DIRECTIVES)
  .filter(([k]) => k !== "frame-ancestors")
  .map(([k, v]) => (v ? `${k} ${v}` : k))
  .join("; ");

/** Non-CSP security headers applied to every server response. */
export const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": CONTENT_SECURITY_POLICY,
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Permissions-Policy": "camera=(self), microphone=(), geolocation=(), payment=(), usb=()",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
};
