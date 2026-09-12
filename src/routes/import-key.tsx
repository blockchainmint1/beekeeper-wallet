import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { AlertTriangle, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { QrScanButton } from "@/components/wallet/QrScanButton";
import { decodeWif, defaultKindFor, type DecodedWif, type WifAddressKind } from "@/lib/wif/decode";
import { addWifWallet } from "@/lib/wif/store";
import { createKeyOnlyWallet, hasWallet } from "@/lib/txc/storage";
import { useWallet } from "@/lib/txc/wallet-context";
import { assessPassword } from "@/lib/security/password-strength";
import { rootFromSeed } from "@/lib/txc/wallet";
import { toast } from "sonner";

export const Route = createFileRoute("/import-key")({
  head: () => ({
    meta: [
      { title: "Import a private key — BeeKeeper Wallet" },
      {
        name: "description",
        content:
          "Set up an BeeKeeper wallet from a single WIF private key — no seed phrase required. The key is encrypted on your device with your password.",
      },
      { property: "og:title", content: "Import a private key — BeeKeeper Wallet" },
      {
        property: "og:description",
        content: "Set up an BeeKeeper wallet from a WIF private key. No seed phrase required.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: ImportKeyPage,
});

function ImportKeyPage() {
  const navigate = useNavigate();
  const { loadFromMemory } = useWallet();
  const [wif, setWif] = useState("");
  const [kind, setKind] = useState<WifAddressKind | null>(null);
  const [label, setLabel] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const decoded = useMemo<DecodedWif | null>(() => {
    if (!wif.trim()) return null;
    try {
      return decodeWif(wif);
    } catch {
      return null;
    }
  }, [wif]);

  const wifError = useMemo(() => {
    if (!wif.trim()) return null;
    try {
      decodeWif(wif);
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : "Invalid WIF";
    }
  }, [wif]);

  const effectiveKind: WifAddressKind | null = decoded
    ? kind && decoded.addresses[kind]
      ? kind
      : defaultKindFor(decoded)
    : null;

  const verdict = assessPassword(password);
  const overwriting = typeof window !== "undefined" && hasWallet();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!decoded || !effectiveKind) return;
    const address = decoded.addresses[effectiveKind];
    if (!address) {
      setError("Selected address type isn't available for this key.");
      return;
    }
    if (!verdict.ok) {
      setError(verdict.message);
      return;
    }
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const unlocked = await createKeyOnlyWallet(password, label.trim() || "Imported keys");
      // Derive the same anchor root the context will hold, so the WIF is
      // encrypted with the wallet's wrapping key from the very first save.
      const bin = atob(unlocked.anchor ?? "");
      const anchor = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) anchor[i] = bin.charCodeAt(i);
      const root = rootFromSeed(anchor);
      await addWifWallet(
        {
          label: label.trim(),
          chain: decoded.chain,
          kind: effectiveKind,
          address,
          compressed: decoded.compressed,
          wif: wif.trim(),
        },
        root,
      );
      await loadFromMemory(unlocked);
      toast.success("Key-only wallet created");
      await navigate({ to: "/wallet" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto max-w-xl px-4 py-8">
      <Link to="/" className="text-sm text-muted-foreground hover:text-foreground">
        ← Back
      </Link>
      <h1 className="mt-3 text-2xl font-bold">Import a private key</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Set up a wallet from a single WIF private key — no seed phrase needed. The key is
        encrypted on this device with the password you choose.
      </p>

      <div className="mt-4 flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 text-amber-200 p-3 text-xs">
        <ShieldAlert className="h-4 w-4 mt-0.5 shrink-0" />
        <div>
          A key-only wallet is <strong>one address per key</strong>: no address rotation, no
          multi-chain recovery, and nothing to write down but the raw key itself. Keep your own
          backup of the WIF — losing it loses the funds. A seed-phrase wallet is safer if you have
          the choice.
        </div>
      </div>

      {overwriting && (
        <div className="mt-3 flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 text-destructive p-3 text-xs">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          <div>
            There is already a wallet on this device. Continuing replaces it. Back up its seed
            phrase first.
          </div>
        </div>
      )}

      <form onSubmit={submit}>
        <Card className="mt-5">
          <CardHeader>
            <CardTitle>Private key</CardTitle>
            <CardDescription>TEXITcoin, IskanderCoin, Litecoin or Dogecoin WIF</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label htmlFor="wif">WIF</Label>
              <div className="mt-1 flex gap-2">
                <Input
                  id="wif"
                  value={wif}
                  onChange={(e) => setWif(e.target.value)}
                  placeholder="Paste WIF..."
                  className="font-mono flex-1"
                  autoComplete="off"
                  spellCheck={false}
                  type="password"
                />
                <QrScanButton onScan={(raw) => setWif(raw.trim())} />
              </div>
              {wifError && (
                <p className="mt-1 text-xs text-destructive flex items-center gap-1">
                  <AlertTriangle className="h-3 w-3" /> {wifError}
                </p>
              )}
            </div>

            {decoded && (
              <>
                <div>
                  <Label>Detected</Label>
                  <p className="mt-1 text-sm">
                    <span className="font-semibold">{decoded.chain.toUpperCase()}</span>{" "}
                    <span className="text-muted-foreground">
                      ({decoded.compressed ? "compressed" : "uncompressed"})
                    </span>
                  </p>
                </div>

                <div>
                  <Label>Address type</Label>
                  <div className="mt-2 grid gap-2">
                    {(["bip84", "bip49", "bip44"] as const).map((k) => {
                      const addr = decoded.addresses[k];
                      if (!addr) return null;
                      const active = effectiveKind === k;
                      return (
                        <button
                          key={k}
                          type="button"
                          onClick={() => setKind(k)}
                          className={`text-left rounded-md border px-3 py-2 transition-colors ${
                            active ? "border-primary bg-primary/10" : "border-border hover:bg-accent"
                          }`}
                        >
                          <div className="text-xs uppercase tracking-wide text-muted-foreground">
                            {k === "bip84"
                              ? "Native SegWit"
                              : k === "bip49"
                                ? "Wrapped SegWit"
                                : "Legacy"}
                          </div>
                          <div className="font-mono text-xs break-all">{addr}</div>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div>
                  <Label htmlFor="label">Label (optional)</Label>
                  <Input
                    id="label"
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    placeholder={`${decoded.chain.toUpperCase()} · Imported`}
                    className="mt-1"
                    maxLength={40}
                  />
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <Card className="mt-4">
          <CardHeader>
            <CardTitle>Wallet password</CardTitle>
            <CardDescription>
              Encrypts the private key on this device. It cannot be recovered if you forget it.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label htmlFor="pw">Password</Label>
              <Input
                id="pw"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="mt-1"
                autoComplete="new-password"
              />
              {password && !verdict.ok && (
                <p className="mt-1 text-xs text-destructive">{verdict.message}</p>
              )}
              {password && verdict.ok && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Strength: <span className="text-foreground">{verdict.label}</span>
                </p>
              )}
            </div>
            <div>
              <Label htmlFor="pw2">Confirm password</Label>
              <Input
                id="pw2"
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                className="mt-1"
                autoComplete="new-password"
              />
            </div>

            {error && (
              <div className="text-sm text-destructive flex items-center gap-1">
                <AlertTriangle className="h-4 w-4" /> {error}
              </div>
            )}

            <Button
              type="submit"
              className="w-full"
              disabled={busy || !decoded || !effectiveKind || !password || !confirm}
            >
              {busy ? "Creating..." : "Create key-only wallet"}
            </Button>
          </CardContent>
        </Card>
      </form>
    </main>
  );
}
