import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { api as chainApi } from "@/lib/wif/chain-io";
import { useWallet } from "@/lib/txc/wallet-context";
import { decodeWif, defaultKindFor, type DecodedWif, type WifAddressKind } from "@/lib/wif/decode";
import { addWifWallet } from "@/lib/wif/store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { AlertTriangle, ShieldAlert } from "lucide-react";
import { QrScanButton } from "@/components/wallet/QrScanButton";
import { toast } from "sonner";

export const Route = createFileRoute("/wallet/wif-add")({
  head: () => ({ meta: [{ title: "Import Private Key — HME Wallet" }] }),
  component: WifAddPage,
});

function WifAddPage() {
  const { root, unlocked } = useWallet();
  const navigate = useNavigate();
  const [wif, setWif] = useState("");
  const [label, setLabel] = useState("");
  const [kind, setKind] = useState<WifAddressKind | null>(null);
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

  const errorMsg = useMemo(() => {
    if (!wif.trim()) return null;
    try {
      decodeWif(wif);
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : "Invalid WIF";
    }
  }, [wif]);

  // Probe every candidate address so we can preselect the one that actually
  // holds coins. A key imported as native segwit shows a zero balance when the
  // funds sit on the legacy address for the very same key.
  const [balances, setBalances] = useState<Record<string, number | null>>({});
  const [probing, setProbing] = useState(false);
  const [autoKind, setAutoKind] = useState<WifAddressKind | null>(null);

  const candidateKey = decoded
    ? `${decoded.chain}:${Object.values(decoded.addresses).join("|")}`
    : "";

  useEffect(() => {
    if (!decoded) {
      setBalances({});
      setAutoKind(null);
      return;
    }
    let cancelled = false;
    const chain = decoded.chain;
    const entries = (["bip84", "bip49", "bip44"] as const)
      .map((k) => [k, decoded.addresses[k]] as const)
      .filter((e): e is readonly [WifAddressKind, string] => !!e[1]);
    setProbing(true);
    setBalances({});
    setAutoKind(null);
    (async () => {
      const found: Record<string, number | null> = {};
      const winners: { kind: WifAddressKind; sats: number }[] = [];
      await Promise.all(
        entries.map(async ([k, addr]) => {
          try {
            const s = await chainApi(chain).getAddressStats(addr);
            const sats =
              s.chain_stats.funded_txo_sum -
              s.chain_stats.spent_txo_sum +
              s.mempool_stats.funded_txo_sum -
              s.mempool_stats.spent_txo_sum;
            found[addr] = sats;
            if (sats > 0 && (!best || sats > best.sats)) best = { kind: k, sats };
          } catch {
            found[addr] = null;
          }
        }),
      );
      if (cancelled) return;
      setBalances(found);
      setAutoKind(best ? best.kind : null);
      setProbing(false);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidateKey]);

  const effectiveKind: WifAddressKind | null = decoded
    ? kind && decoded.addresses[kind]
      ? kind
      : (autoKind ?? defaultKindFor(decoded))
    : null;

  function formatSats(sats: number, chain: string): string {
    return `${(sats / 1e8).toLocaleString(undefined, { maximumFractionDigits: 8 })} ${chain.toUpperCase()}`;
  }

  async function submit() {
    if (!decoded || !effectiveKind || !root) return;
    const address = decoded.addresses[effectiveKind];
    if (!address) {
      setError("Selected address type isn't available for this key.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const entry = await addWifWallet(
        {
          label,
          chain: decoded.chain,
          kind: effectiveKind,
          address,
          compressed: decoded.compressed,
          wif: wif.trim(),
        },
        root,
      );
      toast.success("Private key imported");
      navigate({ to: "/wallet" });
      void entry;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Import failed");
    } finally {
      setBusy(false);
    }
  }

  if (!unlocked) {
    return (
      <main className="mx-auto max-w-xl px-4 py-10">
        <p className="text-sm text-muted-foreground">Unlock your wallet first.</p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-xl px-4 py-8">
      <Link to="/wallet" className="text-sm text-muted-foreground hover:text-foreground">
        ← Back
      </Link>
      <h1 className="mt-3 text-2xl font-bold">Import private key</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Paste a WIF (Wallet Import Format) private key. We detect the network — TXC or ISK — and
        add it as its own tile. The key is encrypted with your seed and only readable while your
        wallet is unlocked.
      </p>

      <div className="mt-4 flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 text-amber-200 p-3 text-xs">
        <ShieldAlert className="h-4 w-4 mt-0.5 shrink-0" />
        <div>
          A WIF is one address. It is <strong>not</strong> a seed phrase. Back it up separately —
          this app doesn't display it after import unless you export it explicitly.
        </div>
      </div>

      <Card className="mt-5">
        <CardHeader>
          <CardTitle>Private key</CardTitle>
          <CardDescription>Starts with K/L/5 for TXC · K/L/5 for ISK</CardDescription>
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
            {errorMsg && (
              <p className="mt-1 text-xs text-destructive flex items-center gap-1">
                <AlertTriangle className="h-3 w-3" /> {errorMsg}
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
                <p className="mt-1 text-xs text-muted-foreground">
                  {probing
                    ? "Checking which address holds coins…"
                    : autoKind
                      ? "We selected the address that holds your coins."
                      : "No coins found on any address for this key."}
                </p>
                <div className="mt-2 grid gap-2">
                  {(["bip84", "bip49", "bip44"] as const).map((k) => {
                    const addr = decoded.addresses[k];
                    if (!addr) return null;
                    const active = effectiveKind === k;
                    const sats = balances[addr];
                    return (
                      <button
                        key={k}
                        type="button"
                        onClick={() => setKind(k)}
                        className={`text-left rounded-md border px-3 py-2 transition-colors ${
                          active ? "border-primary bg-primary/10" : "border-border hover:bg-accent"
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="text-xs uppercase tracking-wide text-muted-foreground">
                            {k === "bip84"
                              ? "Native SegWit"
                              : k === "bip49"
                                ? "Wrapped SegWit"
                                : "Legacy"}
                          </div>
                          <div
                            className={`text-xs ${
                              sats && sats > 0 ? "font-semibold text-primary" : "text-muted-foreground"
                            }`}
                          >
                            {probing && sats === undefined
                              ? "checking…"
                              : sats === null || sats === undefined
                                ? "—"
                                : formatSats(sats, decoded.chain)}
                          </div>
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

              {error && (
                <div className="text-sm text-destructive flex items-center gap-1">
                  <AlertTriangle className="h-4 w-4" /> {error}
                </div>
              )}
              <Button className="w-full" onClick={submit} disabled={busy || !effectiveKind}>
                {busy ? "Importing..." : "Import as its own tile"}
              </Button>
            </>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
