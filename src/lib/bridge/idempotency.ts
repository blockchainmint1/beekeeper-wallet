/**
 * Stable Idempotency-Key for starting an ID check (round-4 audit B6): a
 * double tap on "Start ID check" with the same details reuses one Bridge
 * customer instead of creating two. Different details (a typo fixed) get a
 * new key, so the customer can still correct themselves.
 */
export async function kycIdempotencyKey(p: {
  env: string;
  address: string;
  fullName: string;
  email: string;
  type: string;
}): Promise<string> {
  const text = [p.fullName.trim().toLowerCase(), p.email.trim().toLowerCase(), p.type].join("\n");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  const tag = Array.from(digest.slice(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
  return `bk-kyc-${p.env}-${p.address}-${tag}`;
}
