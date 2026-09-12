/**
 * Biometric unlock for the BeeKeeper Wallet.
 *
 * Design:
 *  - The wallet itself is always encrypted on disk with the user's password
 *    (PBKDF2 + AES-GCM, see src/lib/txc/storage.ts). That never changes.
 *  - When the user opts in to Face ID / fingerprint unlock, we store the
 *    plaintext password AND the "enabled" flag in the platform secure store
 *    (iOS Keychain, Android Keystore) via @aparajita/capacitor-secure-storage.
 *  - To retrieve it we first call BiometricAuth.authenticate() — the user has
 *    to pass Face ID / Touch ID / fingerprint before we read the password
 *    back and feed it into the normal unlock flow.
 *  - The password is always still required as a recovery fallback and for
 *    sensitive actions (revealing the seed phrase, deleting the wallet).
 *
 * The "enabled" flag lives in SecureStorage rather than localStorage so a
 * jailbroken filesystem attacker cannot toggle it on to phish a Keychain
 * read; the value is only trusted after biometric auth succeeds anyway.
 *
 * On the web (Lovable preview, browser) all of this is a no-op:
 * `isBiometricAvailable()` returns false and `enableBiometric()` throws.
 */
import { isNative } from "./platform";

const SECURE_KEY = "txc.wallet.bio.password.v1";
const FLAG_KEY = "txc.wallet.bio.enabled.v1";
const LEGACY_FLAG_KEY = "txc.wallet.bio.enabled";

export interface BiometricStatus {
  available: boolean;
  enabled: boolean;
  reason?: string;
}

async function loadPlugins() {
  if (!isNative()) return null;
  const [{ BiometricAuth }, { SecureStorage }] = await Promise.all([
    import("@aparajita/capacitor-biometric-auth"),
    import("@aparajita/capacitor-secure-storage"),
  ]);
  return { BiometricAuth, SecureStorage };
}

export async function isBiometricAvailable(): Promise<boolean> {
  const plugins = await loadPlugins();
  if (!plugins) return false;
  try {
    const info = await plugins.BiometricAuth.checkBiometry();
    return info.isAvailable === true;
  } catch {
    return false;
  }
}

// In-memory shadow so synchronous callers (e.g. unlockWithBiometric's early
// guard) don't have to await a SecureStorage read every time.
let cachedFlag: boolean | null = null;

async function readFlag(): Promise<boolean> {
  if (cachedFlag !== null) return cachedFlag;
  const plugins = await loadPlugins();
  if (!plugins) {
    cachedFlag = false;
    return false;
  }
  try {
    // Migrate from the old plaintext localStorage flag if present.
    try {
      const legacy = typeof localStorage !== "undefined" && localStorage.getItem(LEGACY_FLAG_KEY);
      if (legacy === "1") {
        await plugins.SecureStorage.set(FLAG_KEY, "1", true, false);
        try {
          localStorage.removeItem(LEGACY_FLAG_KEY);
        } catch {
          /* ignore */
        }
        cachedFlag = true;
        return true;
      }
    } catch {
      /* ignore migration errors */
    }
    const v = await plugins.SecureStorage.get(FLAG_KEY, true, false).catch(() => null);
    cachedFlag = v === "1";
    return cachedFlag;
  } catch {
    cachedFlag = false;
    return false;
  }
}

export function isBiometricEnabled(): boolean {
  // Synchronous consumers get whatever's cached; async paths (getBiometricStatus,
  // unlockWithBiometric) refresh via readFlag first.
  return cachedFlag === true;
}

export async function getBiometricStatus(): Promise<BiometricStatus> {
  const available = await isBiometricAvailable();
  const enabled = available ? await readFlag() : false;
  return { available, enabled };
}

/**
 * Store the wallet password in the OS secure store so the user can unlock
 * with biometrics on the next launch. Requires the caller to already have a
 * verified password (typically right after a successful password unlock).
 */
export async function enableBiometric(password: string): Promise<void> {
  const plugins = await loadPlugins();
  if (!plugins) throw new Error("Biometric unlock is only available on the mobile app.");
  await plugins.BiometricAuth.authenticate({
    reason: "Enable Face ID / fingerprint unlock for your TXC wallet",
    cancelTitle: "Cancel",
    allowDeviceCredential: false,
    iosFallbackTitle: "Use Passcode",
    androidTitle: "Enable biometric unlock",
    androidSubtitle: "Confirm your identity to enable biometric unlock",
  });
  await plugins.SecureStorage.set(SECURE_KEY, password, true, false);
  await plugins.SecureStorage.set(FLAG_KEY, "1", true, false);
  cachedFlag = true;
}

export async function disableBiometric(): Promise<void> {
  const plugins = await loadPlugins();
  if (plugins) {
    try {
      await plugins.SecureStorage.remove(SECURE_KEY);
    } catch {
      /* ignore */
    }
    try {
      await plugins.SecureStorage.remove(FLAG_KEY);
    } catch {
      /* ignore */
    }
  }
  try {
    localStorage.removeItem(LEGACY_FLAG_KEY);
  } catch {
    /* ignore */
  }
  cachedFlag = false;
}

/**
 * Prompt for biometrics and return the stored password on success.
 * Returns null if the user cancels or biometrics is not enabled.
 */
export async function unlockWithBiometric(): Promise<string | null> {
  const plugins = await loadPlugins();
  if (!plugins) return null;
  const enabled = await readFlag();
  if (!enabled) return null;
  try {
    await plugins.BiometricAuth.authenticate({
      reason: "Unlock your TEXITcoin wallet",
      cancelTitle: "Use password",
      allowDeviceCredential: false,
      iosFallbackTitle: "Use Passcode",
      androidTitle: "Unlock wallet",
      androidSubtitle: "Confirm your identity",
    });
    const pw = await plugins.SecureStorage.get(SECURE_KEY, true, false);
    return typeof pw === "string" ? pw : null;
  } catch {
    return null;
  }
}

/**
 * Re-authenticate the user with biometrics before a sensitive action
 * (e.g. broadcasting a payment). Resolves true on success or when
 * biometrics is unavailable / not enabled on this device (the caller is
 * expected to have its own confirmation UI in that case). Resolves false
 * only when biometrics is available + enabled and the user cancels or
 * fails the prompt.
 */
export async function confirmWithBiometric(reason: string): Promise<boolean> {
  const plugins = await loadPlugins();
  if (!plugins) return true;
  const enabled = await readFlag();
  if (!enabled) return true;
  try {
    await plugins.BiometricAuth.authenticate({
      reason,
      cancelTitle: "Cancel",
      allowDeviceCredential: false,
      iosFallbackTitle: "Use Passcode",
      androidTitle: "Confirm payment",
      androidSubtitle: reason,
    });
    return true;
  } catch {
    return false;
  }
}
