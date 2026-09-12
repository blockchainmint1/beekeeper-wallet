/**
 * Post-unlock prompt shown on the wallet home when old BeeKeeper wallet
 * data is found in this browser's storage (e.g. after beekeeper.money moved
 * to this app). Imports each legacy seed as its own profile, encrypted with
 * the CURRENT wallet password — the existing wallet is never touched and the
 * old encrypted records are left in place.
 */
import { useEffect, useState } from "react";
import { WalletCards, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  listLegacyBeeKeeperWallets,
  unlockLegacyBeeKeeperWallet,
  type LegacyBeeKeeperWallet,
} from "@/lib/legacy-beekeeper";
import { saveWalletToNewProfile } from "@/lib/txc/storage";
import { getSessionPassword } from "@/lib/txc/session-cache";
import { setActiveProfileId, DEFAULT_PROFILE_ID, activeProfileId } from "@/lib/profiles";
import { useWallet } from "@/lib/txc/wallet-context";
import { toast } from "sonner";

const DISMISS_KEY = "hme.legacy-beekeeper-dismissed.v1";

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
    setDismissed(isDismissed());
    if (unlocked) setWallets(listLegacyBeeKeeperWallets());
  }, [unlocked]);

  if (!unlocked || dismissed || wallets.length === 0) return null;

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

  if (!open) {
    return (
      <div className="rounded-md border border-primary/30 bg-primary/5 p-4">
        <div className="flex items-start gap-3">
          <WalletCards className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
          <div className="min-w-0 flex-1">
            <h3 className="font-semibold">Old BeeKeeper wallet found on this device</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              We found {wallets.length} encrypted wallet{wallets.length === 1 ? "" : "s"} from the
              previous BeeKeeper app. Import {wallets.length === 1 ? "it" : "them"} as{" "}
              {wallets.length === 1 ? "a new profile" : "new profiles"} — your current wallet stays
              exactly as it is.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" onClick={() => setOpen(true)}>
                Import old BeeKeeper wallet{wallets.length === 1 ? "" : "s"}
              </Button>
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
      {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
      <Button type="submit" className="mt-4 w-full" disabled={busy}>
        {busy ? "Importing…" : `Import ${wallets.length} wallet${wallets.length === 1 ? "" : "s"}`}
      </Button>
    </form>
  );
}
