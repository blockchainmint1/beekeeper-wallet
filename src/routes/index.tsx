import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { Fingerprint } from "lucide-react";
import { hasWallet } from "@/lib/txc/storage";
import { useWallet } from "@/lib/txc/wallet-context";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import {
  getBiometricStatus,
  unlockWithBiometric,
} from "@/lib/native/biometric";
import { BeeKeeperOnboarding } from "@/components/wallet/BeeKeeperOnboarding";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "HME Wallet — self-custodial multi-chain" },
      {
        name: "description",
        content:
          "Open an HME wallet in seconds. A self-custodial wallet for TEXITcoin (TXC), Iskander Coin (ISK), Zero Chill Units (ZCU), and EVM Stablecoins. Your keys stay on your device.",
      },
      { property: "og:title", content: "HME Wallet — self-custodial multi-chain" },
      {
        property: "og:description",
        content: "A self-custodial wallet for TEXITcoin (TXC), Iskander Coin (ISK), Zero Chill Units (ZCU), and EVM Stablecoins.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "twitter:title", content: "BeeKeeper Wallet activation" },
      { name: "twitter:description", content: "Activate your self-custodial BeeKeeper Wallet with your Copper Coin." },
    ],
  }),
  component: Home,
});

function Home() {
  const navigate = useNavigate();
  const { unlock, unlocked } = useWallet();
  const [exists, setExists] = useState<boolean | null>(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [bio, setBio] = useState<{ available: boolean; enabled: boolean }>({
    available: false,
    enabled: false,
  });
  const [postUpdate, setPostUpdate] = useState(false);

  useEffect(() => {
    // Set by applyWebUpdate() right before the hard reload: the reload wipes
    // the in-memory session key, so the wallet locks. Tell the user this was
    // an update, not a sign-out.
    try {
      if (window.sessionStorage.getItem("hme.postUpdate")) {
        window.sessionStorage.removeItem("hme.postUpdate");
        setPostUpdate(true);
      }
    } catch {
      /* noop */
    }
    setExists(hasWallet());
    getBiometricStatus().then(setBio).catch(() => undefined);
    // Hide the native launch splash once we've mounted the unlock UI so users
    // never see a flash of unstyled content. No-op on web.
    void import("@/lib/native/ui").then(({ hideSplash }) => hideSplash());
  }, []);

  useEffect(() => {
    if (unlocked) navigate({ to: "/wallet" });
  }, [unlocked, navigate]);

  const tryBiometric = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      const pw = await unlockWithBiometric();
      if (!pw) {
        setBusy(false);
        return;
      }
      const ok = await unlock(pw);
      if (!ok) setError("Stored biometric password no longer matches. Use your password.");
      else navigate({ to: "/wallet" });
    } finally {
      setBusy(false);
    }
  }, [unlock, navigate]);

  // Auto-prompt biometrics once on landing if it's enabled.
  useEffect(() => {
    if (exists && bio.enabled && !unlocked) {
      void tryBiometric();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exists, bio.enabled]);

  async function onUnlock(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const ok = await unlock(password);
    setBusy(false);
    if (!ok) setError("Wrong password.");
    else navigate({ to: "/wallet" });
  }

  // Belt-and-suspenders navigation. Prefer the router once React is hydrated;
  // the native static shell also has a tiny fallback script for pre-hydration
  // taps. Do not bypass the router on Capacitor when React is alive.
  const goImport = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      void navigate({ to: "/import" }).catch(() => window.location.assign("/import"));
    },
    [navigate],
  );
  const goCreate = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      void navigate({ to: "/create" }).catch(() => window.location.assign("/create"));
    },
    [navigate],
  );
  const goImportKey = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      void navigate({ to: "/import-key" }).catch(() => window.location.assign("/import-key"));
    },
    [navigate],
  );


  if (exists === null) return null;

  return (
    !exists ? <BeeKeeperOnboarding /> :
    <main className="mx-auto max-w-3xl px-4 pt-16 pb-12">
      <header className="text-center mb-12">
        <img
          src="/icon-512.webp"
          alt="Honest Money Ecosystem"
          width={64}
          height={64}
          className="mx-auto mb-5 h-16 w-16 rounded-2xl shadow-lg shadow-amber-900/40"
        />

        <h1 className="text-4xl sm:text-5xl font-bold tracking-tight">honest.money</h1>
        <p className="mt-3 text-muted-foreground max-w-xl mx-auto">
          A self-custodial wallet for TEXITcoin (TXC), Iskander Coin (ISK), Zero
          Chill Units (ZCU), and EVM Stablecoins. Your seed phrase stays on your
          device, encrypted with your password.
        </p>
      </header>

      {exists ? (
        <>
        {listLegacyBeeKeeperWallets().length > 0 && (
          <Card className="mb-4 border-primary/30 bg-primary/5">
            <CardContent className="pt-6 text-sm text-muted-foreground">
              We found an old BeeKeeper wallet saved in this browser. Unlock your wallet and
              you&apos;ll get the option to import it — your current wallet won&apos;t be changed.
            </CardContent>
          </Card>
        )}
        <Card className="border-border/60">
          <CardHeader>
            <CardTitle>Unlock your wallet</CardTitle>
            <CardDescription>
              {postUpdate
                ? "Updated to the latest version. For security, updates lock the wallet — unlock to pick up right where you left off."
                : "Enter the password you set when this wallet was created."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={onUnlock} className="space-y-4">
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Wallet password"
                autoFocus
                autoComplete="current-password"
              />
              {error && <p className="text-sm text-destructive">{error}</p>}
              <div className="flex flex-wrap gap-3">
                <Button type="submit" disabled={busy || !password}>
                  {busy ? "Unlocking..." : "Unlock"}
                </Button>
                {bio.enabled && (
                  <Button type="button" variant="secondary" onClick={tryBiometric} disabled={busy}>
                    <Fingerprint className="h-4 w-4 mr-1.5" />
                    Use biometrics
                  </Button>
                )}
                <a href="/import" data-native-route="/import" onClick={goImport} className={buttonVariants({ variant: "ghost" })}>Import a different wallet</a>
              </div>
            </form>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <Card className="border-border/60 hover:border-primary/60 transition-colors">
              <CardHeader>
                <CardTitle>I already have a wallet</CardTitle>
                <CardDescription>
                  Already use the old TXC Wallet app? Open it, write down your 12 / 24-word seed,
                  and import it here.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <a href="/import" data-native-route="/import" onClick={goImport} className={buttonVariants({ className: "w-full" })}>Import seed phrase</a>
              </CardContent>
            </Card>

            <Card className="border-border/60 hover:border-primary/60 transition-colors">
              <CardHeader>
                <CardTitle>Create a new wallet</CardTitle>
                <CardDescription>
                  Generate a fresh 24-word seed phrase. You'll back it up on the next screen.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <a href="/create" data-native-route="/create" onClick={goCreate} className={buttonVariants({ variant: "secondary", className: "w-full" })}>Create new wallet</a>
              </CardContent>
            </Card>
          </div>

          <Card className="mt-4 border-border/60 hover:border-primary/60 transition-colors">
            <CardHeader>
              <CardTitle>I only have a private key</CardTitle>
              <CardDescription>
                Import a single WIF key (TXC, ISK, LTC or DOGE) — no seed phrase. One key, one
                address, and you keep your own backup of the key.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <a
                href="/import-key"
                data-native-route="/import-key"
                onClick={goImportKey}
                className={buttonVariants({ variant: "outline", className: "w-full" })}
              >
                Import private key
              </a>
            </CardContent>
          </Card>
        </>
      )}


      <section className="mt-12 rounded-xl border border-border/60 bg-card/40 p-5 text-sm text-muted-foreground">
        <h2 className="font-semibold text-foreground mb-2">Moving from the old TXC Wallet app?</h2>
        <p>
          This is a brand-new app. It <strong>cannot</strong> read the old app's storage, so
          installing it will <strong>not</strong> overwrite or change anything in your existing
          wallet. To move funds: open the old app, back up your seed phrase, then choose
          <em> Import seed phrase</em> here. Better yet, setup a fresh wallet here and transfer your digital assets. You can bring the old wallet over later.
        </p>
      </section>
    </main>
  );
}
