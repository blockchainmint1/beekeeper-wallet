/**
 * Post-unlock prompt shown on the wallet home when old BeeKeeper wallet
 * data is found in this browser's storage (e.g. after beekeeper.money moved
 * to this app). Imports each legacy seed as its own profile, encrypted with
 * the CURRENT wallet password — the existing wallet is never touched and the
 * old encrypted records are left in place.
 */
import { useEffect, useState } from "react";
import { Upload, WalletCards, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  isSupportedLegacyBackupFile,
  listLegacyBeeKeeperWallets,
  parseLegacyBeeKeeperBackup,
  unlockLegacyBeeKeeperWallet,
  type LegacyBeeKeeperWallet,
} from "@/lib/legacy-beekeeper";
import { saveWalletToNewProfile } from "@/lib/txc/storage";
import { getSessionPassword } from "@/lib/txc/session-cache";
import { setActiveProfileId, DEFAULT_PROFILE_ID, activeProfileId } from "@/lib/profiles";
import { useWallet } from "@/lib/txc/wallet-context";
import { toast } from "sonner";

const DISMISS_KEY = "hme.legacy-beekeeper-dismissed.v2";

function isDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

export function LegacyBeeKeeperImportCard() {
  const { unlocked, refreshProfiles } = useWallet();
  const [wallets, setWallets] = useState<LegacyBeeKeeperWallet[]>([]);
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState(true);
  const [passwords, setPasswords] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const detected = unlocked ? listLegacyBeeKeeperWallets() : [];
    setWallets(detected);
    // A newly detected legacy wallet must override an earlier "Not now".
    setDismissed(detected.length === 0 && isDismissed());
  }, [unlocked]);

  if (!unlocked || dismissed) return null;

  function dismiss() {
    try {
      localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* noop */
    }
    setDismissed(true);
  }

  async function importAll() {
    setError(null);
    const sessionPassword = getSessionPassword();
    if (!sessionPassword) {
      setError("Lock and unlock your wallet with your password first, then try the import again.");
      return;
    }
    const missing = wallets.find((w) => !passwords[w.id]);
    if (missing) {
      setError(`Enter the old password for “${missing.label}”.`);
      return;
    }
    setBusy(true);
    const previousProfile = activeProfileId();
    try {
      const unlockedWallets = await Promise.all(
        wallets.map(async (legacy) => ({
          legacy,
          mnemonic: await unlockLegacyBeeKeeperWallet(legacy, passwords[legacy.id] ?? ""),
        })),
      );
      for (const item of unlockedWallets) {
        await saveWalletToNewProfile(
          {
            mnemonic: item.mnemonic,
            passphrase: "",
            kind: "bip44",
            label: item.legacy.label,
            mode: "seed",
          },
          sessionPassword,
        );
      }
      // saveWalletToNewProfile activates each new profile — put the user back
      // on the wallet they were using. Their current wallet is untouched.
      setActiveProfileId(previousProfile || DEFAULT_PROFILE_ID);
      refreshProfiles();
      setPasswords({});
      dismiss();
      toast.success(
        `${unlockedWallets.length} old BeeKeeper wallet${unlockedWallets.length === 1 ? "" : "s"} imported as ${unlockedWallets.length === 1 ? "a profile" : "profiles"}. Switch between them from the wallet menu.`,
      );
    } catch (cause) {
      setActiveProfileId(previousProfile || DEFAULT_PROFILE_ID);
      setError(cause instanceof Error ? cause.message : "Could not import the old BeeKeeper wallet.");
    } finally {
      setBusy(false);
    }
  }

  async function loadLegacyBackup(file: File | undefined) {
    setError(null);
    if (!file) return;
    if (!isSupportedLegacyBackupFile(file)) {
      setError("Choose the encrypted JSON backup downloaded from the old BeeKeeper wallet.");
      return;
    }
    try {
      const imported = parseLegacyBeeKeeperBackup(await file.text(), file.name);
      setWallets(imported);
      setPasswords({});
      setOpen(true);
      toast.success(`${imported.length} encrypted BeeKeeper wallet${imported.length === 1 ? "" : "s"} found in the backup.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not read that BeeKeeper backup.");
      setOpen(true);
    }
  }

  if (!open) {
    return (
      <div className="rounded-md border border-primary/30 bg-primary/5 p-4">
        <div className="flex items-start gap-3">
          <WalletCards className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
          <div className="min-w-0 flex-1">
            <h3 className="font-semibold">Import an old BeeKeeper wallet</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {wallets.length > 0
                ? `We found ${wallets.length} encrypted wallet${wallets.length === 1 ? "" : "s"} from the previous BeeKeeper app.`
                : "Choose an encrypted backup from the previous BeeKeeper app."} Your current wallet stays exactly as it is.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {wallets.length > 0 ? (
                <Button size="sm" onClick={() => setOpen(true)}>Import old BeeKeeper wallet{wallets.length === 1 ? "" : "s"}</Button>
              ) : (
                <Label htmlFor="legacy-home-backup" className="inline-flex h-8 cursor-pointer items-center justify-center gap-2 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90">
                  <Upload className="h-3.5 w-3.5" /> Choose encrypted backup
                </Label>
              )}
              <Input id="legacy-home-backup" type="file" accept=".json,application/json,text/plain" className="sr-only" onChange={(event) => void loadLegacyBackup(event.target.files?.[0])} />
              <Button size="sm" variant="ghost" onClick={dismiss}>
                Not now
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <form
      className="rounded-md border border-border p-4"
      onSubmit={(event) => {
        event.preventDefault();
        void importAll();
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold">Import old BeeKeeper wallets</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Unlock each old wallet with the password it had in the previous app. Each one becomes a
            separate profile, protected by your current wallet password. The old encrypted data is
            left untouched.
          </p>
        </div>
        <Button type="button" variant="ghost" size="icon" onClick={() => setOpen(false)} disabled={busy} aria-label="Close import">
          <X className="h-4 w-4" />
        </Button>
      </div>
      <div className="mt-4 space-y-3">
        {wallets.map((wallet) => (
          <div key={wallet.id}>
            <Label htmlFor={`legacy-import-${wallet.id}`}>{wallet.label} — old password</Label>
            <Input
              id={`legacy-import-${wallet.id}`}
              className="mt-1"
              type="password"
              autoComplete="off"
              value={passwords[wallet.id] ?? ""}
              onChange={(event) =>
                setPasswords((current) => ({ ...current, [wallet.id]: event.target.value }))
              }
              disabled={busy}
            />
          </div>
        ))}
      </div>
      {wallets.length === 0 && (
        <div className="mt-4 rounded-md border border-border p-4">
          <p className="text-sm text-muted-foreground">This page cannot see an old saved wallet from another browser, app, or website address.</p>
          <Label htmlFor="legacy-open-backup" className="mt-3 inline-flex cursor-pointer items-center justify-center gap-2 rounded-md border border-input bg-background px-4 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground">
            <Upload className="h-4 w-4" /> Choose encrypted backup
          </Label>
          <Input id="legacy-open-backup" type="file" accept=".json,application/json,text/plain" className="sr-only" onChange={(event) => void loadLegacyBackup(event.target.files?.[0])} />
        </div>
      )}
      {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
      <Button type="submit" className="mt-4 w-full" disabled={busy || wallets.length === 0}>
        {busy ? "Importing…" : `Import ${wallets.length} wallet${wallets.length === 1 ? "" : "s"}`}
      </Button>
    </form>
  );
}
