import { beforeEach, describe, expect, it } from "vitest";
import { BIP32Factory } from "bip32";
import * as ecc from "@bitcoinerlab/secp256k1";

const mem = new Map<string, string>();
const store = {
  get length() {
    return mem.size;
  },
  key: (i: number) => [...mem.keys()][i] ?? null,
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => void mem.set(k, String(v)),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
};
(globalThis as unknown as { window: unknown }).window = { localStorage: store, dispatchEvent: () => true };
(globalThis as unknown as { localStorage: unknown }).localStorage = store;
(globalThis as unknown as { CustomEvent: unknown }).CustomEvent ??= class {};

const { addWifWallet, listWifWallets, revealWif } = await import("./store");

const bip32 = BIP32Factory(ecc);
const rootA = bip32.fromSeed(new Uint8Array(32).fill(7));
const rootB = bip32.fromSeed(new Uint8Array(32).fill(9));
const WIF = "L1aW4aubDFB7yfras2S1mN3bqg9nwySY8nkoLmJebSLD5BWv3ENZ";
const INPUT = { label: "test", chain: "txc" as const, kind: "p2pkh" as never, address: "TXaddr1", compressed: true, wif: WIF };

function toAB(u: Uint8Array) {
  const out = new ArrayBuffer(u.byteLength);
  new Uint8Array(out).set(u);
  return out;
}

/** Writes an entry the way the app did before the HKDF change (v1). */
async function writeLegacyEntry(root: typeof rootA) {
  const material = await crypto.subtle.digest("SHA-256", toAB(root.privateKey!));
  const key = await crypto.subtle.importKey("raw", material, { name: "AES-GCM" }, false, ["encrypt"]);
  const fpBuf = new Uint8Array(await crypto.subtle.digest("SHA-256", material));
  const fp = Array.from(fpBuf.slice(0, 2), (b) => b.toString(16).padStart(2, "0")).join("");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(WIF)));
  const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
  const entry = { id: "legacy1", label: "old", chain: "txc", kind: "p2pkh", address: "TXold", compressed: true, createdAt: 1, ct: b64(ct), iv: b64(iv), fp };
  mem.set("hme.wif.v1", JSON.stringify([entry]));
}

describe("imported key (WIF) wrapping", () => {
  beforeEach(() => mem.clear());

  it("saves new imported keys with the stronger v2 key and reads them back", async () => {
    const entry = await addWifWallet(INPUT, rootA);
    expect(entry.v).toBe(2);
    expect(await revealWif(entry, rootA)).toBe(WIF);
  });

  it("still opens keys saved the old way, then upgrades them to v2", async () => {
    await writeLegacyEntry(rootA);
    const [legacy] = listWifWallets();
    expect(legacy!.v).toBeUndefined();
    expect(await revealWif(legacy!, rootA)).toBe(WIF);
    const [upgraded] = listWifWallets();
    expect(upgraded!.v).toBe(2);
    expect(await revealWif(upgraded!, rootA)).toBe(WIF);
  });

  it("refuses to open a key with a different seed and leaves it untouched", async () => {
    await writeLegacyEntry(rootA);
    const before = mem.get("hme.wif.v1");
    const [legacy] = listWifWallets();
    await expect(revealWif(legacy!, rootB)).rejects.toThrow(/different seed/);
    expect(mem.get("hme.wif.v1")).toBe(before);
  });

  it("opens a key mislabeled v2 that was really saved the old way", async () => {
    await writeLegacyEntry(rootA);
    const [legacy] = listWifWallets();
    const mislabeled = { ...legacy!, v: 2 as const };
    mem.set("hme.wif.v1", JSON.stringify([mislabeled]));
    expect(await revealWif(mislabeled, rootA)).toBe(WIF);
  });

  it("keeps the v2 key recipe frozen (label + salt are part of the saved data)", async () => {
    const { deriveRootAesKey } = await import("@/lib/security/hkdf");
    const { WIF_HKDF_LABEL } = await import("./store");
    expect(WIF_HKDF_LABEL).toBe("beekeeper/wif-wrap/v2");
    const { key, fp } = await deriveRootAesKey(rootA, WIF_HKDF_LABEL);
    expect(fp).toBe("9437");
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: new Uint8Array(12) }, key, new TextEncoder().encode("pin")));
    expect(btoa(String.fromCharCode(...ct))).toBe("Lm3eKCbJuXpNPayYzAAVcy93zg==");
  });
});
