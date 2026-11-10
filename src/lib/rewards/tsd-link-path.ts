/**
 * The only TSD Swap paths the /api/tsd/link proxy will forward to
 * (docs/tsd-rewards-xpub.md): the link manifest and its claim endpoint.
 * Anything else on the TSD hosts is refused (audit 2026-11-09 M4).
 */
const LINK_PATH = /^\/api\/public\/v1\/link\/[A-Za-z0-9_-]{1,128}(\/claim)?$/;

export function isTsdLinkPath(pathname: string): boolean {
  return LINK_PATH.test(pathname);
}
