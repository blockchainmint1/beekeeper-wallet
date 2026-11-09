/**
 * Normalize and validate a path splat before an API proxy appends it to an
 * upstream base URL that carries a paid API key (audit 2026-11-09 L1).
 *
 * Returns the cleaned relative path, or null when the path tries to escape
 * the allowed prefix: `.`/`..` segments, encoded separators or dots,
 * backslashes, empty segments, or anything that isn't plain URL-path text.
 */
export function safeProxyPath(raw: string): string | null {
  const path = raw.replace(/^\/+/, "");
  if (!path) return "";
  // Encoded dot / slash / backslash / percent let a later decode re-introduce
  // traversal; raw backslashes are normalized to "/" by WHATWG URL parsing.
  if (/%(2e|2f|5c|25)/i.test(path) || path.includes("\\")) return null;
  if (!/^[A-Za-z0-9._~\-/:@!$&'()*+,;=%]*$/.test(path)) return null;
  const segments = path.split("/");
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    if (s === "." || s === "..") return null;
    // Allow a single trailing slash, never "//" in the middle.
    if (s === "" && i !== segments.length - 1) return null;
  }
  return path;
}

/**
 * Build the final upstream URL and confirm it is still under `base`
 * (belt-and-braces after safeProxyPath).
 */
export function joinUnderBase(base: string, path: string, search: string): string | null {
  const baseUrl = new URL(base.endsWith("/") ? base : `${base}/`);
  const url = new URL(path + search, baseUrl);
  if (url.origin !== baseUrl.origin) return null;
  if (!url.pathname.startsWith(baseUrl.pathname)) return null;
  return url.toString();
}
