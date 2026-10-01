/**
 * Lets a key-only (WIF-only) wallet owner add a seed phrase later.
 *
 * The imported WIFs are decrypted with the old anchor root and re-encrypted
 * with the new seed-derived root, so nothing is lost. After the upgrade the
 * wallet behaves like a normal HD wallet: multi-chain tiles, address rotation,
 * and a recoverable seed phrase.
 */
import { useMemo, useState } from "react";
import { Copy, KeyRound, Loader2, RefreshCw, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useWallet } from "@/lib/txc/wallet-context";
import { upgradeKeyOnlyToSeed } from "@/lib/txc/storage";
import { generateMnemonic, normalizeMnemonic, validateMnemonic } from "@/lib/txc/wallet";
import { assessPassword } from "@/lib/security/password-strength";
import { copyToClipboard } from "@/lib/clipboard";
import { toast } from "sonner";

type Mode = "generate" | "import";
type WordCount = 12 | 24;

export function AddSeedCard({ compact }: { compact?: boolean }) {
  const { root, loadFromMemory } = useWallet();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("generate");
  const [wordCount, setWordCount] = useState<WordCount>(24);
  const [mnemonic, setMnemonic] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [confirmedBackup, setConfirmedBackup] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const words = useMemo(() => (mnemonic ? mnemonic.split(" ") : []), [mnemonic]);

  function reset() {
    setMode("generate");
    setWordCount(24);
    setMnemonic("");
    setPassphrase("");
    setPassword("");
    setConfirm("");
    setConfirmedBackup(false);
    setError(null);
    setBusy(false);
  }

  function generate(count: WordCount = wordCount) {
    setError(null);
    try {
      setMnemonic(generateMnemonic(count === 12 ? 128 : 256));
      setConfirmedBackup(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not generate seed");
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!root) {
      setError("Wallet must be unlocked.");
      return;
    }
    const normalized = normalizeMnemonic(mnemonic);
    if (!validateMnemonic(normalized)) {
      setError("That doesn't look like a valid 12 or 24-word seed phrase.");
      return;
    }
    if (mode === "generate" && !confirmedBackup) {
      setError("Confirm you wrote down the seed phrase before continuing.");
      return;
    }
    const strength = assessPassword(password);
    if (!strength.ok) {
      setError(strength.message);
      return;
    }
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }

    setBusy(true);
    try {
      const upgraded = await upgradeKeyOnlyToSeed(normalized, passphrase, password, root);
      await loadFromMemory(upgraded);
      toast.success("Seed phrase added. Your imported keys are still here.");
      setOpen(false);
      reset();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upgrade failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      className={
        compact ? "rounded-none border-0 bg-transparent shadow-none" : "mt-5 border-primary/40"
      }
    >
      {!compact && (
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="h-5 w-5" /> Add a seed phrase
          </CardTitle>
          <CardDescription>
            Upgrade this key-only wallet to a full HD wallet. Your imported private keys stay usable;
            you just gain a seed phrase for recovery and multi-chain support.
          </CardDescription>
        </CardHeader>
      )}
      <CardContent className={compact ? "p-0" : undefined}>
        <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) reset(); }}>
          <DialogTrigger asChild>
            <Button>Add seed phrase</Button>
          </DialogTrigger>
          <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Add a seed phrase</DialogTitle>
              <DialogDescription>
                Choose whether to generate a fresh seed or import one you already have.
              </DialogDescription>
            </DialogHeader>

            <div className="grid grid-cols-2 gap-2 rounded-lg border border-border p-1">
              <button
                type="button"
                onClick={() => { setMode("generate"); if (!mnemonic) generate(); }}
                className={`rounded-md px-3 py-2 text-sm font-medium ${
                  mode === "generate" ? "bg-primary text-primary-foreground" : "hover:bg-muted"
                }`}
              >
                Generate new
              </button>
              <button
                type="button"
                onClick={() => setMode("import")}
                className={`rounded-md px-3 py-2 text-sm font-medium ${
                  mode === "import" ? "bg-primary text-primary-foreground" : "hover:bg-muted"
                }`}
              >
                Import existing
              </button>
            </div>

            <form onSubmit={submit} className="space-y-4">
              {mode === "generate" ? (
                <div className="space-y-3">
                  {!mnemonic ? (
                    <Button type="button" onClick={generate} className="w-full">
                      <RefreshCw className="h-4 w-4 mr-2" /> Generate 24-word seed
                    </Button>
                  ) : (
                    <>
                      <div className="rounded-lg border border-border/60 bg-muted/30 p-4">
                        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                          {words.map((w, i) => (
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
                        <button
                          type="button"
                          onClick={async () => {
                            const ok = await copyToClipboard(mnemonic);
                            if (ok) toast.success("Copied. Clear clipboard after backing up.");
                            else toast.error("Could not copy.");
                          }}
                          className="mt-3 inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
                        >
                          <Copy className="h-3.5 w-3.5" /> Copy to clipboard
                        </button>
                      </div>
                      <div className="flex items-start gap-3 text-sm">
                        <input
                          id="backup-confirmed"
                          type="checkbox"
                          checked={confirmedBackup}
                          onChange={(e) => setConfirmedBackup(e.currentTarget.checked)}
                          className="mt-0.5 h-5 w-5 shrink-0 cursor-pointer rounded-md border border-input bg-background accent-primary"
                        />
                        <Label htmlFor="backup-confirmed" className="flex-1 leading-relaxed">
                          I wrote down all {words.length} words in order. I understand that losing
                          them means losing my coins.
                        </Label>
                      </div>
                    </>
                  )}
                </div>
              ) : (
                <div className="space-y-3">
                  <div>
                    <Label htmlFor="seed-phrase">Seed phrase</Label>
                    <Textarea
                      id="seed-phrase"
                      value={mnemonic}
                      onChange={(e) => setMnemonic(e.target.value)}
                      rows={4}
                      placeholder="abandon ability able about above ..."
                      autoComplete="off"
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      className="font-mono mt-1"
                    />
                  </div>
                  <div>
                    <Label htmlFor="bip39pp">BIP39 passphrase (25th word)</Label>
                    <Input
                      id="bip39pp"
                      type="password"
                      value={passphrase}
                      onChange={(e) => setPassphrase(e.target.value)}
                      placeholder="Leave blank if you didn't set one"
                      autoComplete="off"
                      className="mt-1"
                    />
                  </div>
                </div>
              )}

              <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-200 flex items-start gap-2">
                <ShieldAlert className="h-4 w-4 mt-0.5 shrink-0" />
                <div>
                  Your current password is needed to re-encrypt your imported private keys with
                  the new seed. After this, the wallet works like a normal HD wallet.
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <Label htmlFor="upgrade-pw">Wallet password</Label>
                  <Input
                    id="upgrade-pw"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="current-password"
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label htmlFor="upgrade-pw2">Confirm password</Label>
                  <Input
                    id="upgrade-pw2"
                    type="password"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    autoComplete="current-password"
                    className="mt-1"
                  />
                </div>
              </div>

              {error && (
                <p className="text-sm text-destructive">{error}</p>
              )}

              <DialogFooter>
                <Button
                  type="submit"
                  disabled={
                    busy ||
                    !mnemonic ||
                    (mode === "generate" && !confirmedBackup) ||
                    !password ||
                    !confirm
                  }
                >
                  {busy && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                  {mode === "generate" ? "Create seed wallet" : "Import seed wallet"}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}
