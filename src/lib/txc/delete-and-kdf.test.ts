import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

class MemStorage {
  private m = new Map<string, string>();
  get length() {
    return this.m.size;
  }
  key(i: number) {
    return [...this.m.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v));
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  clear() {
    this.m.clear();
  }
  keys() {
    return [...this.m.keys()].sort();
  }
}

const store = new MemStorage();
(globalThis as unknown as { window: unknown }).window = {
  localStorage: store,
  dispatchEvent: () => true,
};
(globalThis as unknown as { localStorage: unknown }).localStorage = store;
(globalThis as unknown as { CustomEvent: unknown }).CustomEvent ??= class {};

const { deleteWallet, needsKdfUpgrade } = await import("./storage");
const { PROFILE_SCOPED_BASES } = await import("@/lib/profiles");

describe("KDF re-encryption is upgrade-only (audit M1)", () => {
  it("upgrades an envelope below the default cost", () => {
    expect(needsKdfUpgrade(100_000)).toBe(true);
  });
  it("never downgrades a 1,000,000-iteration envelope", () => {
    expect(needsKdfUpgrade(1_000_000)).toBe(false);
  });
  it("leaves an envelope at the default 600,000 alone", () => {
    expect(needsKdfUpgrade(600_000)).toBe(false);
  });
});

describe("Delete wallet and all data (audit M5)", () => {
  beforeEach(() => store.clear());

  it("removes the TSD Swap API key, VectorPay link, address book and links when the last wallet goes", () => {
    store.setItem("txc.wallet.v1", "{}");
    store.setItem("hme:tsd-cashout-key", "secret-api-key");
    store.setItem("beekeeper.vectorpay.link.v1", "{}");
    store.setItem("hme:address-book:v1", "[]");
    store.setItem("beekeeper.ecosystem.links.v1", "[]");
    store.setItem("hme:nectar-links", "[]");
    store.setItem("hme.wif.v1", "[]");
    store.setItem("hme.txc.txhex.abc", "00");
    deleteWallet();
    expect(store.keys()).toEqual([]);
  });

  it("keeps the old BeeKeeper wallet data and the theme", () => {
    store.setItem("txc.wallet.v1", "{}");
    store.setItem("lovable-multi-wallet-vault-v1", "legacy");
    store.setItem("beekeeper-seed-accounts-v1", "legacy");
    store.setItem("txc.theme", "dark");
    deleteWallet();
    expect(store.keys()).toEqual(["beekeeper-seed-accounts-v1", "lovable-multi-wallet-vault-v1", "txc.theme"]);
  });

  it("does not touch another vault's data when other wallets remain", () => {
    store.setItem("hme.profiles.v1", JSON.stringify([{ id: "pr_other", createdAt: 1 }]));
    store.setItem("txc.wallet.v1", "{}");
    store.setItem("hme.wif.v1", "[]");
    store.setItem("p:pr_other:txc.wallet.v1", "{}");
    store.setItem("p:pr_other:hme.wif.v1", "[]");
    deleteWallet();
    expect(store.getItem("txc.wallet.v1")).toBeNull();
    expect(store.getItem("hme.wif.v1")).toBeNull();
    expect(store.getItem("p:pr_other:txc.wallet.v1")).toBe("{}");
    expect(store.getItem("p:pr_other:hme.wif.v1")).toBe("[]");
  });
});

describe("per-vault key registry", () => {
  it("lists every base key the code stores per vault", () => {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(n) && !n.includes(".test.")) files.push(p);
      }
    };
    walk("src/lib");
    walk("src/components");
    walk("src/routes");
    const bases = new Set<string>();
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      if (!src.includes("scopedKey(")) continue;
      for (const m of src.matchAll(/const (\w+)\s*=\s*"([^"]+)";/g)) {
        if (new RegExp(`scopedKey\\(${m[1]}\\b`).test(src)) bases.add(m[2]);
      }
    }
    for (const b of bases) expect(PROFILE_SCOPED_BASES).toContain(b);
  });
});
