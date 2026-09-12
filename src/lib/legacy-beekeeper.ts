import { normalizeMnemonic, validateMnemonic } from "@/lib/txc/wallet";

const LEGACY_VAULT_KEY = "lovable-multi-wallet-vault-v1";
const LEGACY_REGISTRY_KEY = "beekeeper-seed-accounts-v1";
const MIN_ITERATIONS = 250_000;
const MAX_ITERATIONS = 5_000_000;

const LEGACY_BACKUP_TYPES = ["application/json", "text/json", "text/plain"];

interface LegacyEncryptedBlob {
  v: 1 | 2 | 3;
  salt: string;
  iv: string;
  ct: string;
  it?: number;
}

interface LegacyRegistryEntry {
  id?: unknown;
  label?: unknown;
  blob?: unknown;
  createdAt?: unknown;
}

export interface LegacyBeeKeeperWallet {
  id: string;
  label: string;
  blob: LegacyEncryptedBlob;
}

function isBase64(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length < 100_000 && /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

function parseBlob(value: unknown): LegacyEncryptedBlob | null {
  if (!value || typeof value !== "object") return null;
  const blob = value as Partial<LegacyEncryptedBlob>;
  if (blob.v !== 1 && blob.v !== 2 && blob.v !== 3) return null;
  if (!isBase64(blob.salt) || !isBase64(blob.iv) || !isBase64(blob.ct)) return null;
  if (blob.it !== undefined && (!Number.isInteger(blob.it) || blob.it < MIN_ITERATIONS || blob.it > MAX_ITERATIONS)) return null;
  return blob as LegacyEncryptedBlob;
}

function parseRegistry(value: unknown, sourceLabel = "BeeKeeper backup"): LegacyBeeKeeperWallet[] {
  if (!value || typeof value !== "object") return [];
  const registry = value as { accounts?: unknown };
  if (!Array.isArray(registry.accounts)) return [];
  return registry.accounts.flatMap((raw, index) => {
    if (!raw || typeof raw !== "object") return [];
    const entry = raw as LegacyRegistryEntry;
    const blob = parseBlob(entry.blob);
    if (!blob) return [];
    return [{
      id: typeof entry.id === "string" && entry.id ? entry.id : `backup-${index + 1}`,
      label: typeof entry.label === "string" && entry.label.trim()
        ? entry.label.trim().slice(0, 40)
        : `${sourceLabel} ${index + 1}`,
      blob,
    }];
  });
}

function readJson(key: string): unknown {
  try {
    const raw = typeof window === "undefined" ? null : localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function listLegacyBeeKeeperWallets(): LegacyBeeKeeperWallet[] {
  const wallets = parseRegistry(readJson(LEGACY_REGISTRY_KEY), "BeeKeeper wallet");
  if (wallets.length) return wallets;

  const vault = parseBlob(readJson(LEGACY_VAULT_KEY));
  return vault ? [{ id: "legacy-vault", label: "BeeKeeper wallet", blob: vault }] : [];
}

/**
 * Reads either kind of encrypted export produced by the retired BeeKeeper:
 * a single vault blob or the complete multi-wallet registry. Nothing is saved
 * until every selected wallet has been unlocked and the user confirms import.
 */
export function parseLegacyBeeKeeperBackup(text: string, fileName = "BeeKeeper backup"): LegacyBeeKeeperWallet[] {
  if (text.length > 5_000_000) throw new Error("That backup file is too large.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("That is not a valid BeeKeeper backup file.");
  }

  const registryWallets = parseRegistry(parsed, fileName.replace(/\.json$/i, ""));
  if (registryWallets.length) return registryWallets;

  const wrapped = parsed && typeof parsed === "object"
    ? parseBlob((parsed as { blob?: unknown; vault?: unknown }).blob)
      ?? parseBlob((parsed as { blob?: unknown; vault?: unknown }).vault)
    : null;
  const vault = parseBlob(parsed) ?? wrapped;
  if (!vault) throw new Error("That file does not contain an encrypted BeeKeeper wallet.");
  return [{ id: `backup-${Date.now()}`, label: fileName.replace(/\.json$/i, "") || "BeeKeeper wallet", blob: vault }];
}

export function isSupportedLegacyBackupFile(file: File): boolean {
  return file.size <= 5_000_000 && (!file.type || LEGACY_BACKUP_TYPES.includes(file.type) || file.name.toLowerCase().endsWith(".json"));
}

function decodeBase64(value: string): Uint8Array {
  const raw = atob(value);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return bytes;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
}

export async function unlockLegacyBeeKeeperWallet(wallet: LegacyBeeKeeperWallet, password: string): Promise<string> {
  const iterations = wallet.blob.it ?? (wallet.blob.v >= 2 ? 600_000 : 250_000);
  if (iterations < MIN_ITERATIONS || iterations > MAX_ITERATIONS) throw new Error("This old wallet has unsafe encryption settings.");
  try {
    const baseKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
    const key = await crypto.subtle.deriveKey(
      { name: "PBKDF2", salt: toArrayBuffer(decodeBase64(wallet.blob.salt)), iterations, hash: "SHA-256" },
      baseKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["decrypt"],
    );
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: toArrayBuffer(decodeBase64(wallet.blob.iv)) },
      key,
      toArrayBuffer(decodeBase64(wallet.blob.ct)),
    );
    const payload = JSON.parse(new TextDecoder().decode(plaintext)) as { mnemonic?: unknown };
    if (typeof payload.mnemonic !== "string") throw new Error("Missing recovery phrase");
    const mnemonic = normalizeMnemonic(payload.mnemonic);
    if (!validateMnemonic(mnemonic)) throw new Error("Invalid recovery phrase");
    return mnemonic;
  } catch {
    throw new Error(`The password for “${wallet.label}” is incorrect.`);
  }
}