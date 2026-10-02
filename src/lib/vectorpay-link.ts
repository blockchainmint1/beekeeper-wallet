/**
 * VectorPay wallet linking — client side.
 *
 * VectorPay shows the customer a one-time 8-character code (QR + typed form,
 * e.g. "CVMR-ZFYE") on their dashboard. The QR encodes
 * `beekeeper://link-vectorpay?code=XXXXXXXX`. The wallet redeems the code
 * through a signed server call (see vectorpay-link.functions.ts); from then on
 * every cash-out order carrying this wallet's private customer ID belongs to
 * that VectorPay account — no identity step in the wallet.
 *
 * This module must stay dependency-free: it is imported by client bundles.
 */

const KEY = "beekeeper.vectorpay.link.v1";

export interface VectorPayLink {
  linkedAt: string;
  firstName?: string | null;
  bank?: { institution: string | null; mask: string; subtype: string | null } | null;
}

/** Their code alphabet excludes 0/O/1/I; 8 chars, dash optional. */
const CODE_RE = /^[A-HJ-NP-Z2-9]{4}-?[A-HJ-NP-Z2-9]{4}$/;

export function normalizeVectorPayCode(raw: string): string | null {
  const c = raw.trim().toUpperCase();
  if (!CODE_RE.test(c)) return null;
  return c.replace(/[^A-Z0-9]/g, "");
}

/**
 * Parse anything the ecosystem link box might receive into a VectorPay code:
 *   beekeeper://link-vectorpay?code=CVMRZFYE
 *   https://vector-pay.com/...?code=CVMRZFYE
 *   CVMR-ZFYE            (typed by hand)
 * Returns the normalized 8-char code, or null when it isn't VectorPay's.
 */
export function parseVectorPayLinkInput(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  if (t.startsWith("beekeeper://")) {
    try {
      const url = new URL(t);
      const action = url.host || url.pathname.replace(/^\/+/, "");
      if (action !== "link-vectorpay") return null;
      const code = url.searchParams.get("code");
      return code ? normalizeVectorPayCode(code) : null;
    } catch {
      return null;
    }
  }
  if (/^https?:\/\//i.test(t)) {
    try {
      const url = new URL(t);
      if (!/(^|\.)vector-pay\.com$/i.test(url.hostname)) return null;
      const code = url.searchParams.get("code");
      return code ? normalizeVectorPayCode(code) : null;
    } catch {
      return null;
    }
  }
  return normalizeVectorPayCode(t);
}

export function getVectorPayLink(): VectorPayLink | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null");
    return v && typeof v.linkedAt === "string" ? (v as VectorPayLink) : null;
  } catch {
    return null;
  }
}

export function setVectorPayLink(link: Omit<VectorPayLink, "linkedAt">) {
  localStorage.setItem(KEY, JSON.stringify({ ...link, linkedAt: new Date().toISOString() }));
}

export function clearVectorPayLink() {
  localStorage.removeItem(KEY);
}

/** Deep-link handoff: the app was opened via beekeeper://link-vectorpay. */
const PENDING_KEY = "beekeeper.vectorpay.pendingCode";

export function stashPendingVectorPayCode(code: string) {
  try {
    sessionStorage.setItem(PENDING_KEY, code);
  } catch {
    /* noop */
  }
}

export function takePendingVectorPayCode(): string | null {
  try {
    const v = sessionStorage.getItem(PENDING_KEY);
    if (v) sessionStorage.removeItem(PENDING_KEY);
    return v;
  } catch {
    return null;
  }
}
