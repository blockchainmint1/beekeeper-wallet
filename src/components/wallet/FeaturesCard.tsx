import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useFeature } from "@/lib/feature-prefs";
import { useHideBalances } from "@/lib/hide-balances";
import { useExchangeFeaturesAllowed } from "@/lib/native/capabilities";
import { unlockWallet } from "@/lib/txc/storage";
import { disableBiometric, enableBiometric, getBiometricStatus } from "@/lib/native/biometric";

export function FeaturesCard({ compact }: { compact?: boolean }) {
  const [evmSwap, setEvmSwap] = useFeature("evmSwap");
  const [utxoSwap, setUtxoSwap] = useFeature("utxoSwap");
  const [confirmLast4, setConfirmLast4] = useFeature("confirmLast4");
  const [hideSpam, setHideSpam] = useFeature("hideSpamTokens");
  const [hiddenBalances, setHiddenBalances] = useHideBalances();
  const exchangeAllowed = useExchangeFeaturesAllowed();

  const [bio, setBio] = useState({ available: false, enabled: false });
  const [bioBusy, setBioBusy] = useState(false);
  const [bioError, setBioError] = useState<string | null>(null);
  const [bioPassword, setBioPassword] = useState("");
  const [showBioPassword, setShowBioPassword] = useState(false);

  useEffect(() => {
    getBiometricStatus()
      .then(setBio)
      .catch(() => undefined);
  }, []);

  async function onToggleBiometric(next: boolean) {
    setBioError(null);
    if (!next) {
      setBioBusy(true);
      await disableBiometric();
      setBio((s) => ({ ...s, enabled: false }));
      setBioBusy(false);
      return;
    }
    setShowBioPassword(true);
  }

  async function confirmEnableBiometric(e: React.FormEvent) {
    e.preventDefault();
    setBioError(null);
    setBioBusy(true);
    try {
      const w = await unlockWallet(bioPassword);
      if (!w) {
        setBioError("Wrong password.");
        return;
      }
      await enableBiometric(bioPassword);
      setBio((s) => ({ ...s, enabled: true }));
      setShowBioPassword(false);
      setBioPassword("");
    } catch (err) {
      setBioError(err instanceof Error ? err.message : "Could not enable biometrics.");
    } finally {
      setBioBusy(false);
    }
  }

  return (
    <Card className={compact ? "rounded-none border-0 bg-transparent shadow-none" : undefined}>
      {!compact && (
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5" /> Extra features
          </CardTitle>
          <CardDescription>
            Opt-in features and safety checks. Toggle to fit how you use the wallet.
          </CardDescription>
        </CardHeader>
      )}
      <CardContent className={compact ? "space-y-4 p-0" : "space-y-4"}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <Label htmlFor="feat-confirm-last4" className="text-sm font-medium">
              Confirm last 4 of address
            </Label>
            <p className="text-xs text-muted-foreground mt-0.5">
              Before sending on Ethereum, Base, or BSC, re-type the last 4 characters
              of the recipient address. Helps catch clipboard-swap malware. On by default.
            </p>
          </div>
          <Switch
            id="feat-confirm-last4"
            checked={confirmLast4}
            onCheckedChange={setConfirmLast4}
          />
        </div>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <Label htmlFor="feat-hide-spam" className="text-sm font-medium">
              Hide worthless / spam tokens
            </Label>
            <p className="text-xs text-muted-foreground mt-0.5">
              Filters imposter tokens from the Ethereum, Base, and BSC activity list —
              airdropped coins that mimic USDC/USDT, phishing symbols with URLs, and
              unknown contracts you never sent to. On by default.
            </p>
          </div>
          <Switch
            id="feat-hide-spam"
            checked={hideSpam}
            onCheckedChange={setHideSpam}
          />
        </div>

        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <Label htmlFor="feat-hide-balances" className="text-sm font-medium">
              Hide balances
            </Label>
            <p className="text-xs text-muted-foreground mt-0.5">
              Mask amounts everywhere in the app.
            </p>
          </div>
          <Switch
            id="feat-hide-balances"
            checked={hiddenBalances}
            onCheckedChange={setHiddenBalances}
          />
        </div>

        <div className="space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <Label htmlFor="bio-toggle" className="text-sm font-medium">
                Biometric unlock
              </Label>
              <p className="text-xs text-muted-foreground mt-0.5">
                {bio.available
                  ? "Unlock with Face ID / fingerprint."
                  : "Only available in the installed iOS or Android app."}
              </p>
            </div>
            <Switch
              id="bio-toggle"
              checked={bio.enabled}
              disabled={!bio.available || bioBusy}
              onCheckedChange={onToggleBiometric}
            />
          </div>
          {showBioPassword && (
            <form
              onSubmit={confirmEnableBiometric}
              className="space-y-2 pt-2 border-t border-border/40"
            >
              <Label htmlFor="bio-pw" className="text-sm">
                Confirm your wallet password
              </Label>
              <Input
                id="bio-pw"
                type="password"
                value={bioPassword}
                autoFocus
                onChange={(e) => setBioPassword(e.target.value)}
                placeholder="Wallet password"
              />
              {bioError && <p className="text-sm text-destructive">{bioError}</p>}
              <div className="flex gap-2">
                <Button type="submit" disabled={bioBusy || !bioPassword}>
                  {bioBusy ? "Verifying..." : "Enable"}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setShowBioPassword(false);
                    setBioPassword("");
                    setBioError(null);
                  }}
                >
                  Cancel
                </Button>
              </div>
            </form>
          )}
        </div>

        {exchangeAllowed && (
          <>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <Label htmlFor="feat-evm-swap" className="text-sm font-medium">
                  In-app Swap
                </Label>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Adds a Swap button on Ethereum, Base, and BSC tiles. Quotes and routing
                  are powered by LI.FI; transactions are signed on this device and
                  broadcast through BeeKeeper Wallet — no external wallet connect required.
                </p>
              </div>
              <Switch
                id="feat-evm-swap"
                checked={evmSwap}
                onCheckedChange={setEvmSwap}
              />
            </div>

            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <Label htmlFor="feat-utxo-swap" className="text-sm font-medium">
                  Swap LTC / DOGE to stablecoins
                </Label>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Adds a Swap button on the Litecoin and Dogecoin tiles. Swaps run natively
                  over THORChain — your coins are signed on this device and the stablecoin is
                  paid out to this wallet's EVM address. No bridge, no custodian.
                </p>
              </div>
              <Switch
                id="feat-utxo-swap"
                checked={utxoSwap}
                onCheckedChange={setUtxoSwap}
              />
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
