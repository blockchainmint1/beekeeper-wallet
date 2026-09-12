import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useWallet } from "@/lib/txc/wallet-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { unlockWallet } from "@/lib/txc/storage";
import { AlertTriangle, EyeOff, Eye } from "lucide-react";
import { isNative } from "@/lib/native/platform";

export const Route = createFileRoute("/wallet/backup")({
  head: () => ({ meta: [{ title: "Backup — BeeKeeper Wallet" }] }),
  component: BackupPage,
});

function BackupPage() {
  const { unlocked } = useWallet();
  const [password, setPassword] = useState("");
  const [shown, setShown] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reveal, setReveal] = useState(false);

  // Wipe the plaintext seed from React state on unmount so it doesn't linger
  // in the fiber tree / devtools after leaving the page.
  useEffect(() => {
    return () => {
      setShown(null);
      setReveal(false);
      setPassword("");
    };
  }, []);


  // Block screenshots + app-switcher thumbnails whenever the seed is on screen.
  // Android: FLAG_SECURE. iOS: blur overlay in the app switcher (there is no
  // system API to block on-device screenshots on iOS). Best-effort — the
  // plugin no-ops if it's missing from this build.
  useEffect(() => {
    if (!shown || !isNative()) return;
    void (async () => {
      try {
        const { PrivacyScreen } = await import("@capacitor-community/privacy-screen");
        await PrivacyScreen.enable();
      } catch {
        /* plugin unavailable */
      }
    })();
    return () => {
      void (async () => {
        try {
          const { PrivacyScreen } = await import("@capacitor-community/privacy-screen");
          await PrivacyScreen.disable();
        } catch {
          /* noop */
        }
      })();
    };
  }, [shown]);

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const w = await unlockWallet(password);
    if (!w) {
      setError("Wrong password.");
      return;
    }
    setShown(w.mnemonic);
  }

  if (unlocked?.mode === "keyonly") {
    return (
      <main className="mx-auto max-w-xl px-4 py-8">
        <Link to="/wallet" className="text-sm text-muted-foreground hover:text-foreground">
          ← Back
        </Link>
        <h1 className="mt-3 text-2xl font-bold">No seed phrase</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          This is a key-only wallet — it was created from an imported private key, so there is no
          12/24-word phrase to back up. Your backup is the WIF private key itself; keep your own
          copy of it somewhere safe and offline.
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-xl px-4 py-8">

      <Link to="/wallet" className="text-sm text-muted-foreground hover:text-foreground">
        ← Back
      </Link>
      <h1 className="mt-3 text-2xl font-bold">Back up your seed phrase</h1>
      <p className="text-sm text-muted-foreground">
        Showing wallet: <strong>{unlocked?.label}</strong>
      </p>

      <div className="mt-4 flex items-start gap-2 rounded-lg border border-amber-700/40 bg-amber-950/10 p-3 text-sm">
        <AlertTriangle className="h-4 w-4 mt-0.5 text-amber-500" />
        <div className="space-y-2">
          <p>
            <strong>If you lose this phrase, your funds are gone forever.</strong> No one — not
            BeeKeeper, not honest.money, not Apple — can recover it for you.
          </p>
          <p>
            Anyone with these words controls your wallet. Make sure no one is looking over your
            shoulder, no screen recording is on, and you trust this device.
          </p>
          <p className="text-xs text-muted-foreground">
            Crypto assets are volatile and you can lose value. Review the full risk disclosures at{" "}
            <a
              href="https://texitcoin.org/disclosures"
              target="_blank"
              rel="noreferrer noopener"
              className="underline"
            >
              texitcoin.org/disclosures
            </a>
            .
          </p>
        </div>
      </div>

      {!shown ? (
        <Card className="mt-5">
          <CardHeader>
            <CardTitle>Confirm password</CardTitle>
            <CardDescription>To reveal the seed, re-enter the wallet password.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={verify} className="space-y-3">
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoFocus
                autoComplete="current-password"
              />
              {error && <p className="text-sm text-destructive">{error}</p>}
              <Button type="submit" className="w-full" disabled={!password}>
                Reveal seed phrase
              </Button>
            </form>
          </CardContent>
        </Card>
      ) : (
        <Card className="mt-5">
          <CardHeader>
            <CardTitle>Your seed phrase</CardTitle>
            <CardDescription>Write it on paper. Don't take a screenshot.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="relative">
              {reveal ? (
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {shown.split(" ").map((w, i) => (
                    <div
                      key={i}
                      className="flex items-center gap-2 rounded-md border border-border/60 bg-background/60 px-3 py-2 font-mono text-sm"
                    >
                      <span className="text-xs text-muted-foreground w-5 text-right">
                        {i + 1}.
                      </span>
                      <span>{w}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="rounded-md border border-dashed border-border/60 bg-background/40 px-4 py-8 text-center text-sm text-muted-foreground">
                  Seed phrase hidden. Tap Reveal when no one is looking.
                </div>
              )}
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setReveal((r) => !r)}
                className="mt-3"
              >
                {reveal ? (
                  <EyeOff className="h-4 w-4 mr-1.5" />
                ) : (
                  <Eye className="h-4 w-4 mr-1.5" />
                )}
                {reveal ? "Hide" : "Tap to reveal"}
              </Button>
            </div>

          </CardContent>
        </Card>
      )}
    </main>
  );
}
