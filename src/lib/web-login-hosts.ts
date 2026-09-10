/**
 * Trusted website sign-in hosts for the QR "Sign in to a website" flow.
 *
 * A scanned login QR names a callback URL; the wallet only fetches and posts
 * to hosts in this list (HTTPS, default port, no credentials). Add partner
 * sites here — e.g. NectarPay, streamTXC — and nowhere else. Both the client
 * validator (src/lib/nectar/auth.ts) and the server proxy
 * (src/routes/api/nectar.link.ts) read from this single source.
 *
 * This module must stay dependency-free: it is imported by client bundles.
 */
export const TRUSTED_LOGIN_HOSTS: ReadonlySet<string> = new Set([
  // NectarPay
  "app.nectar-pay.com",
  "pay.honest.money",
  // streamTXC — TODO: add the exact sign-in domain once confirmed.
]);

/** Human-friendly site name for a trusted host, used in the confirm UI. */
export function loginSiteName(hostname: string): string {
  if (hostname === "app.nectar-pay.com" || hostname === "pay.honest.money") return "NectarPay";
  return hostname;
}
