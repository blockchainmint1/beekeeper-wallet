import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { generateMnemonic, generateMnemonicFromUserEntropy } from "@/lib/txc/wallet";
import { saveWallet, saveWalletToNewProfile } from "@/lib/txc/storage";
import { getSessionPassword } from "@/lib/txc/session-cache";
import { useWallet } from "@/lib/txc/wallet-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { AlertTriangle, Check, Copy, Lock, RotateCcw, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { copyToClipboard } from "@/lib/clipboard";
import { ScribblePad } from "@/components/wallet/ScribblePad";
import { assessPassword } from "@/lib/security/password-strength";

// Hold the draft mnemonic in an in-memory module variable instead of
// sessionStorage. sessionStorage is readable by any script on the origin
// (extensions, XSS, devtools) — the seed phrase must never live there.
// Trade-off: a hard refresh during creation discards the draft and the user
// generates a fresh one. That is the correct security posture.
let draftMnemonic: string | null = null;

function getOrCreateDraftMnemonic() {
  if (draftMnemonic) return draftMnemonic;
  draftMnemonic = generateMnemonic(256);
  return draftMnemonic;
}

function clearDraftMnemonic() {
  draftMnemonic = null;
}

export const Route = createFileRoute("/create")({
  // ?add=true creates an ADDITIONAL wallet profile (vault) instead of
  // replacing the wallet on this device.
  validateSearch: (search: Record<string, unknown>): { add?: boolean } => ({
    add: search.add === true || search.add === "true" || search.add === "1" ? true : undefined,
  }),
  head: () => ({
    meta: [
      { title: "Create wallet — BeeKeeper Wallet" },
      { name: "description", content: "Generate a new wallet and back up the seed phrase." },
    ],
  }),
  component: CreatePage,
});

function CreatePage() {
  const navigate = useNavigate();
  const { add } = Route.useSearch();
  const { loadFromMemory, unlocked, profiles } = useWallet();
  // Adding a vault only skips the password step while a session is alive —
  // the new envelope is encrypted with the same password as the others.
  const [sessionPw] = useState<string | null>(() => getSessionPassword());
  const addingProfile = !!add && !!unlocked && !!sessionPw;
  const [mnemonic, setMnemonic] = useState("");
  const words = mnemonic ? mnemonic.split(" ") : [];
  const [confirmedBackup, setConfirmedBackup] = useState(false);
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scribbleProgress, setScribbleProgress] = useState(0);
  const [locked, setLocked] = useState(false);
  const scribbleBytesRef = useRef<Uint8Array | null>(null);

  // Pre-generate a draft so we have something to mix into when the user
  // first taps the pad — but we won't show it until they lock in.
  useEffect(() => {
    if (!mnemonic) {
      try {
        setMnemonic(getOrCreateDraftMnemonic());
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to generate seed phrase");
      }
    }
  }, [mnemonic]);

  // Drop the in-memory draft when leaving the screen without finishing.
  useEffect(() => () => clearDraftMnemonic(), []);


  function revealSeed(useScribbleEntropy: boolean) {
    setError(null);
    try {
      if (useScribbleEntropy && scribbleBytesRef.current?.length) {
        draftMnemonic = generateMnemonicFromUserEntropy(scribbleBytesRef.current, 256);
      } else {
        draftMnemonic = generateMnemonic(256);
      }
      setMnemonic(draftMnemonic);
      setConfirmedBackup(false);
      setLocked(true);
    } catch (e) {
      const message = e instanceof Error ? e.message : "Could not reveal seed";
      setError(message);
      toast.error(message);
    }
  }

  async function finalize(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!addingProfile) {
      const strength = assessPassword(password);
      if (!strength.ok) {
        setError(strength.message);
        return;
      }
      if (password !== password2) {
        setError("Passwords don't match.");
        return;
      }
    }
    if (!locked) {
      setError("Reveal and back up your seed phrase first.");
      return;
    }
    if (!confirmedBackup) {
      setError("Please confirm you wrote down the seed phrase.");
      return;
    }
    if (!mnemonic) {
      setError("Seed phrase is still generating. Try again in a moment.");
      return;
    }
    setBusy(true);
    try {
      const u = { mnemonic, passphrase: "", // SLIP-0044 legacy path (m/44'/696969'/0') — matches the TXC Web Wallet
      // and wTXC bridge, so seeds move between them cleanly.
      kind: "bip44" as const, label: name.trim() || (addingProfile ? `Wallet ${profiles.length + 1}` : "Main wallet") };
      if (addingProfile) {
        await saveWalletToNewProfile(u, sessionPw!);
      } else {
        await saveWallet(u, password);
      }
      await loadFromMemory(u);
      clearDraftMnemonic();
      navigate({ to: "/dashboard" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save wallet");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <Link to="/" className="text-sm text-muted-foreground hover:text-foreground">
        ← Back
      </Link>
      <h1 className="mt-4 text-3xl font-bold">Back up your seed phrase</h1>
      <p className="mt-2 text-muted-foreground">
        These 24 words are the only way to recover your wallet. Write them down on paper and store
        them somewhere safe. Never share them. Never type them into a website you don't trust.
      </p>

      {!locked ? (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Sparkles className="h-4 w-4 text-primary" /> Add your own randomness
            </CardTitle>
            <CardDescription>
              Scribble in the pad to mix your own entropy into the seed. Your words stay hidden
              until you lock it in — that way you can't accidentally write down a phrase that's
              about to change. You can also skip this and use secure device randomness only.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ScribblePad
              onStart={() => {
                try {
                  draftMnemonic = generateMnemonic(256);
                  setMnemonic(draftMnemonic);
                  setConfirmedBackup(false);
                  scribbleBytesRef.current = null;
                } catch (e) {
                  toast.error(e instanceof Error ? e.message : "Could not regenerate seed");
                }
              }}
              onEntropy={(bytes) => {
                scribbleBytesRef.current = bytes.length > 0 ? bytes : null;
              }}
              onProgress={setScribbleProgress}
            />
            <Button
              type="button"
              onClick={() => revealSeed(true)}
              disabled={!mnemonic || scribbleProgress <= 0}
              className="mt-4 w-full gap-2"
            >
              <Lock className="h-4 w-4" />
              {scribbleProgress <= 0
                ? "Scribble first, or skip below"
                : "Lock in & reveal seed phrase"}
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => revealSeed(false)}
              disabled={!mnemonic}
              className="mt-2 w-full"
            >
              Skip scribble and reveal seed phrase
            </Button>
            <p className="mt-2 text-xs text-muted-foreground text-center">
              Your randomness is always combined with secure device randomness — scribbling can only
              make the seed stronger, never weaker.
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card className="mt-6">
          <CardContent className="flex items-center justify-between gap-3 py-4">
            <div className="flex items-center gap-2 text-sm">
              <Check className="h-4 w-4 text-primary" />
              <span className="font-medium">Randomness locked in</span>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                try {
                  draftMnemonic = generateMnemonic(256);
                  setMnemonic(draftMnemonic);
                  setConfirmedBackup(false);
                  setScribbleProgress(0);
                  scribbleBytesRef.current = null;
                  setLocked(false);
                } catch (e) {
                  toast.error(e instanceof Error ? e.message : "Could not regenerate seed");
                }
              }}
              className="gap-1.5"
            >
              <RotateCcw className="h-3.5 w-3.5" /> Redo
            </Button>
          </CardContent>
        </Card>
      )}

      <Card className="mt-6 border-amber-700/40 bg-amber-950/10">
        <CardContent className="pt-6">
          {!locked ? (
            <div className="rounded-md border border-dashed border-border/60 bg-background/40 px-3 py-10 text-center text-sm text-muted-foreground">
              <Lock className="mx-auto mb-2 h-5 w-5 opacity-60" />
              Your seed phrase will appear here once you lock in or skip the scribble above.
            </div>
          ) : mnemonic ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {words.map((w, i) => (
                <div
                  key={i}
                  className="flex items-center gap-2 rounded-md border border-border/60 bg-background/60 px-3 py-2 font-mono text-sm"
                >
                  <span className="text-xs text-muted-foreground w-5 text-right">{i + 1}.</span>
                  <span>{w}</span>
                </div>
              ))}
            </div>
          ) : error ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-8 text-center text-sm text-destructive">
              {error}
            </div>
          ) : (
            <div className="rounded-md border border-border/60 bg-background/60 px-3 py-8 text-center text-sm text-muted-foreground">
              Generating seed phrase…
            </div>
          )}
          {locked && (
            <button
              type="button"
              disabled={!mnemonic}
              onClick={async () => {
                const ok = await copyToClipboard(mnemonic);
                if (ok) {
                  toast.success(
                    "Seed copied. Paste into a paper-only backup, then clear clipboard.",
                  );
                } else {
                  toast.error(
                    "Could not copy. Long-press a word to select, or write it down by hand.",
                  );
                }
              }}
              className="mt-4 inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
            >
              <Copy className="h-3.5 w-3.5" /> Copy to clipboard
            </button>
          )}
        </CardContent>
      </Card>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>{addingProfile ? "Add this wallet" : "Set a wallet password"}</CardTitle>
          <CardDescription>
            Encrypts your seed inside this browser. You'll enter it each time you open the wallet.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={finalize} className="space-y-4">
            <div>
              <Label htmlFor="wallet-name">Wallet name (optional)</Label>
              <Input
                id="wallet-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={addingProfile ? `Wallet ${profiles.length + 1}` : "Main wallet"}
                maxLength={40}
                className="mt-1"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Shown in your vault list so you can tell seeds apart.
              </p>
            </div>
            {addingProfile ? (
              <p className="rounded-md border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
                This wallet will be encrypted with the same password you already use on this
                device — one password unlocks all of your wallets.
              </p>
            ) : (
              <>
              <div>
                <Label htmlFor="pw1">Password</Label>
                <Input
                  id="pw1"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
                  className="mt-1"
                />
                {password.length > 0 &&
                  (() => {
                    const s = assessPassword(password);
                    const colors = [
                      "bg-destructive",
                      "bg-destructive",
                      "bg-amber-500",
                      "bg-emerald-500",
                      "bg-emerald-500",
                    ];
                    return (
                      <div className="mt-2">
                        <div className="flex gap-1" aria-hidden>
                          {[0, 1, 2, 3].map((i) => (
                            <div
                              key={i}
                              className={`h-1.5 flex-1 rounded-full ${
                                i < s.score ? colors[s.score] : "bg-border/60"
                              }`}
                            />
                          ))}
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">
                          Strength: <span className="font-medium">{s.label}</span>
                          {!s.ok && s.message ? `. ${s.message}` : ""}
                        </p>
                      </div>
                    );
                  })()}
              </div>
              <div>
                <Label htmlFor="pw2">Confirm password</Label>
                <Input
                  id="pw2"
                  type="password"
                  value={password2}
                  onChange={(e) => setPassword2(e.target.value)}
                  autoComplete="new-password"
                  className="mt-1"
                />
              </div>
              </>
            )}
            <div className="flex items-start gap-3 text-sm">
              <input
                id="backup-confirmed"
                type="checkbox"
                checked={confirmedBackup}
                onChange={(e) => setConfirmedBackup(e.currentTarget.checked)}
                className="mt-0.5 h-5 w-5 shrink-0 cursor-pointer rounded-md border border-input bg-background accent-primary"
              />
              <Label htmlFor="backup-confirmed" className="flex-1 leading-relaxed">
                I wrote down all 24 words in order. I understand that losing them means losing my
                coins, and that the password alone cannot recover them.
              </Label>
            </div>

            {error && (
              <div className="flex items-start gap-2 text-sm text-destructive">
                <AlertTriangle className="h-4 w-4 mt-0.5" /> {error}
              </div>
            )}

            <Button type="submit" disabled={busy || !mnemonic || !locked} className="w-full">
              {busy ? "Saving..." : !locked ? "Reveal seed phrase first" : "Open my wallet"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
