/**
 * Domain-separated AES-GCM keys derived from the unlocked wallet root.
 *
 * HKDF-SHA256 over the root private key with a per-purpose label, so a key
 * made for one store (imported WIFs, the TSD Swap API key, …) can never
 * decrypt another store's data. Audit 2026-11-09 L6 asked for this instead of
 * a bare SHA-256 of the root key.
 */
import type { BIP32Interface } from "bip32";

const SALT = new TextEncoder().encode("beekeeper-hkdf-v1");

function toAB(u: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(u.byteLength);
  new Uint8Array(out).set(u);
  return out;
}

export interface DerivedKey {
  key: CryptoKey;
  /** 4 hex chars identifying the key, so a wrong seed fails with a clear message. */
  fp: string;
}

export async function deriveRootAesKey(root: BIP32Interface, label: string): Promise<DerivedKey> {
  if (!root.privateKey) throw new Error("Wallet must be unlocked.");
  const ikm = await crypto.subtle.importKey("raw", toAB(root.privateKey), "HKDF", false, ["deriveBits"]);
  const bits = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: toAB(SALT), info: toAB(new TextEncoder().encode(label)) },
      ikm,
      256,
    ),
  );
  const key = await crypto.subtle.importKey("raw", toAB(bits), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  const fpBuf = new Uint8Array(await crypto.subtle.digest("SHA-256", toAB(bits)));
  const fp = Array.from(fpBuf.slice(0, 2), (b) => b.toString(16).padStart(2, "0")).join("");
  bits.fill(0);
  return { key, fp };
}

export function b64enc(u: Uint8Array): string {
  let s = "";
  for (const b of u) s += String.fromCharCode(b);
  return btoa(s);
}

export function b64dec(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function aesEncrypt(key: CryptoKey, plaintext: string): Promise<{ iv: string; ct: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: toAB(iv) }, key, toAB(new TextEncoder().encode(plaintext))),
  );
  return { iv: b64enc(iv), ct: b64enc(ct) };
}

export async function aesDecrypt(key: CryptoKey, iv: string, ct: string): Promise<string> {
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: toAB(b64dec(iv)) }, key, toAB(b64dec(ct)));
  return new TextDecoder().decode(pt);
}
