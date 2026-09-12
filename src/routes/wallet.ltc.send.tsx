import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { friendlyBroadcastError } from "@/lib/broadcast-error";
import { useMemo, useState } from "react";
import { z } from "zod";
import { useWallet } from "@/lib/txc/wallet-context";
import { scanLtcAccount } from "@/lib/ltc/scan";
import { buildAndSignTx } from "@/lib/ltc/wallet";
import { broadcastTx, explorerTxUrl, getFeeEstimates, type FeeEstimates } from "@/lib/ltc/mempool";
import { formatLtc, ltcToSats } from "@/lib/ltc/units";
import { LTC_NETWORK, LTC_DEFAULT_KIND } from "@/lib/ltc/network";
import { address as addrLib } from "bitcoinjs-lib";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { AlertTriangle, ExternalLink } from "lucide-react";
import { QrScanButton, parseWalletUri } from "@/components/wallet/QrScanButton";
import { AddressBookButton } from "@/components/wallet/AddressBookButton";
import { hapticSuccess, hapticError } from "@/lib/native/ui";
import { confirmWithBiometric } from "@/lib/native/biometric";
import { rootFingerprintHex } from "@/lib/txc/fingerprint";

const searchSchema = z.object({ to: z.string().optional(), amount: z.string().optional() });

export const Route = createFileRoute("/wallet/ltc/send")({
  head: () => ({ meta: [{ title: "Send LTC — BeeKeeper Wallet" }] }),
  validateSearch: (raw) => searchSchema.parse(raw),
  component: SendLtcPage,
});

function isValidLtcAddress(addr: string): boolean {
  try { addrLib.toOutputScript(addr.trim(), LTC_NETWORK); return true; } catch { return false; }
}

const VBYTES = {
  bip84: { input: 68, output: 31, overhead: 11 },
  bip49: { input: 91, output: 32, overhead: 11 },
  bip44: { input: 148, output: 34, overhead: 10 },
} as const;

function estimateVsize(kind: keyof typeof VBYTES, nIn: number, nOut: number): number {
  const v = VBYTES[kind];
  return v.overhead + v.input * nIn + v.output * nOut;
}

type Stage =
  | { kind: "form" }
  | { kind: "review"; vsize: number; feeSats: number; selected: number }
  | { kind: "sent"; txid: string };

function SendLtcPage() {
  const navigate = useNavigate();
  const { root, unlocked } = useWallet();
  const qc = useQueryClient();
  const account = useQuery({
    queryKey: ["ltc-account", LTC_DEFAULT_KIND, root ? rootFingerprintHex(root) : null],
    enabled: !!root && !!unlocked,
    queryFn: () => scanLtcAccount(root!, LTC_DEFAULT_KIND),
    staleTime: 30_000,
  });

  const fees = useQuery<FeeEstimates>({
    queryKey: ["ltc-fees"],
    queryFn: getFeeEstimates,
    staleTime: 60_000,
  });

  const search = Route.useSearch();
  const [to, setTo] = useState(search.to ?? "");
  const [amount, setAmount] = useState(search.amount ?? "");
  const [sendAll, setSendAll] = useState(false);
  const [feeTier, setFeeTier] = useState<"fastestFee" | "halfHourFee" | "hourFee">("halfHourFee");
  const [stage, setStage] = useState<Stage>({ kind: "form" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function applyUri(raw: string) {
    const { address, amount: amt } = parseWalletUri(raw);
    setTo(address);
    if (amt) { setAmount(amt); setSendAll(false); }
  }

  const utxos = account.data?.utxos ?? [];
  const totalAvailable = utxos.reduce((s, u) => s + u.value, 0);
  const amountSats = useMemo(() => ltcToSats(amount || "0"), [amount]);
  const feeRate = Math.max(100, fees.data?.[feeTier] ?? 100);

  function review(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const cleanTo = to.trim();
    if (!isValidLtcAddress(cleanTo)) { setError("That's not a valid Litecoin address."); return; }
    if (!unlocked) return;

    const sorted = [...utxos].sort((a, b) => b.value - a.value);

    if (sendAll) {
      const nIn = sorted.length;
      if (nIn === 0) { setError("No funds available."); return; }
      const vsize = estimateVsize(LTC_DEFAULT_KIND, nIn, 1);
      const feeSats = Math.ceil(vsize * feeRate);
      const outSats = totalAvailable - feeSats;
      if (outSats <= 546) { setError("Not enough to cover the network fee."); return; }
      setStage({ kind: "review", vsize, feeSats, selected: nIn });
      return;
    }

    if (amountSats <= 546) { setError("Amount is below dust limit."); return; }

    const picked: typeof sorted = [];
    let acc = 0, vsize = 0, feeSats = 0;
    for (const u of sorted) {
      picked.push(u); acc += u.value;
      vsize = estimateVsize(LTC_DEFAULT_KIND, picked.length, 2);
      feeSats = Math.ceil(vsize * feeRate);
      if (acc >= amountSats + feeSats) break;
    }
    if (acc < amountSats + feeSats) {
      setError(`Not enough funds. Available ${formatLtc(totalAvailable)}, needed ${formatLtc(amountSats + feeSats)}.`);
      return;
    }
    setStage({ kind: "review", vsize, feeSats, selected: picked.length });
  }

  async function send() {
    if (!root || !unlocked || !account.data) return;
    if (stage.kind !== "review") return;
    const ok = await confirmWithBiometric("Confirm sending LTC");
    if (!ok) return;
    setBusy(true); setError(null);
    try {
      const sorted = [...utxos].sort((a, b) => b.value - a.value);
      const picked = sorted.slice(0, stage.selected);
      const outValue = sendAll ? totalAvailable - stage.feeSats : amountSats;
      const built = buildAndSignTx({
        root, kind: LTC_DEFAULT_KIND, inputs: picked,
        outputs: [{ address: to.trim(), valueSats: outValue }],
        changeAddress: account.data.nextChangeAddress,
        changeIndex: account.data.nextChangeIndex,
        feeSats: stage.feeSats,
      });
      const txid = await broadcastTx(built.hex);
      hapticSuccess();
      void qc.invalidateQueries({ queryKey: ["ltc-account"] });
      void qc.invalidateQueries({ queryKey: ["ltc-txs"] });
      setStage({ kind: "sent", txid });
    } catch (err) {
      hapticError();
      setError(friendlyBroadcastError(err));
    } finally { setBusy(false); }
  }

  const reviewedOutSats = stage.kind === "review" ? (sendAll ? totalAvailable - stage.feeSats : amountSats) : 0;

  if (stage.kind === "sent") {
    return (
      <main className="mx-auto max-w-xl px-4 py-10 text-center">
        <div className="w-16 h-16 rounded-full bg-emerald-500/15 text-emerald-400 mx-auto flex items-center justify-center text-2xl">✓</div>
        <h1 className="mt-4 text-2xl font-bold">Sent</h1>
        <p className="mt-2 text-muted-foreground">Your LTC transaction was broadcast to the network.</p>
        <a href={explorerTxUrl(stage.txid)} target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-1 text-sm underline">
          View on explorer <ExternalLink className="h-3.5 w-3.5" />
        </a>
        <div className="mt-8 flex justify-center gap-2">
          <Button onClick={() => navigate({ to: "/wallet" })}>Back to wallet</Button>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-xl px-4 py-8">
      <Link to="/wallet" className="text-sm text-muted-foreground hover:text-foreground">← Back</Link>
      <h1 className="mt-3 text-2xl font-bold">Send LTC</h1>
      <p className="text-sm text-muted-foreground">
        Available: {account.isLoading ? "…" : formatLtc(totalAvailable)}
      </p>

      {stage.kind === "form" && (
        <Card className="mt-5">
          <CardHeader>
            <CardTitle>Recipient</CardTitle>
            <CardDescription>Double-check the address — LTC sends are irreversible.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={review} className="space-y-4">
              <div>
                <Label htmlFor="to">Litecoin address</Label>
                <div className="mt-1 flex gap-2">
                  <Input id="to" value={to} onChange={(e) => setTo(e.target.value)}
                    placeholder="ltc1q… or L… / M…"
                    className="font-mono flex-1" autoComplete="off" spellCheck={false} />
                  <QrScanButton onScan={applyUri} />
                  <AddressBookButton chain="ltc" onPick={(a) => setTo(a)} />
                </div>
              </div>
              <div>
                <div className="flex items-center justify-between">
                  <Label htmlFor="amount">Amount (LTC)</Label>
                  <label className="text-xs text-muted-foreground flex items-center gap-1.5 cursor-pointer">
                    <input type="checkbox" checked={sendAll} onChange={(e) => setSendAll(e.target.checked)} className="h-3.5 w-3.5" />
                    Send all
                  </label>
                </div>
                <Input id="amount" type="number" inputMode="decimal" step="0.00000001" min="0"
                  value={sendAll ? "" : amount} onChange={(e) => setAmount(e.target.value)}
                  placeholder={sendAll ? "All available (minus fee)" : "0.0"}
                  className="mt-1" disabled={sendAll} />
              </div>
              <div>
                <Label>Fee speed</Label>
                <div className="mt-2 grid grid-cols-3 gap-2 text-sm">
                  {(["hourFee", "halfHourFee", "fastestFee"] as const).map((t) => (
                    <button key={t} type="button" onClick={() => setFeeTier(t)}
                      className={`rounded-md border px-2 py-2 text-center transition-colors ${
                        feeTier === t ? "border-primary bg-primary/10" : "border-border hover:bg-accent"
                      }`}>
                      <div className="font-medium">{t === "fastestFee" ? "Fast" : t === "halfHourFee" ? "Medium" : "Slow"}</div>
                      <div className="text-xs text-muted-foreground">{fees.data?.[t] ?? "—"} sat/vB</div>
                    </button>
                  ))}
                </div>
              </div>
              {error && (
                <div className="flex items-start gap-2 text-sm text-destructive">
                  <AlertTriangle className="h-4 w-4 mt-0.5" /> {error}
                </div>
              )}
              <Button type="submit" className="w-full" disabled={!to || (!sendAll && !amount) || account.isLoading}>Review</Button>
            </form>
          </CardContent>
        </Card>
      )}

      {stage.kind === "review" && (
        <Card className="mt-5">
          <CardHeader><CardTitle>Review and send</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            <Row label="To"><code className="font-mono break-all">{to.trim()}</code></Row>
            <Row label="Amount">
              {formatLtc(reviewedOutSats)}
              {sendAll && <span className="text-muted-foreground text-xs ml-1">(all)</span>}
            </Row>
            <Row label="Network fee">
              {formatLtc(stage.feeSats)}{" "}
              <span className="text-muted-foreground text-xs">({stage.vsize} vB × {feeRate} sat/vB)</span>
            </Row>
            <Row label="Total">{formatLtc(reviewedOutSats + stage.feeSats)}</Row>
            {error && (
              <div className="flex items-start gap-2 text-sm text-destructive">
                <AlertTriangle className="h-4 w-4 mt-0.5" /> {error}
              </div>
            )}
            <div className="flex gap-2 pt-2">
              <Button variant="ghost" onClick={() => setStage({ kind: "form" })} disabled={busy}>Edit</Button>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button className="flex-1" disabled={busy}>{busy ? "Broadcasting..." : "Send LTC"}</Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Confirm transaction</AlertDialogTitle>
                    <AlertDialogDescription asChild>
                      <div className="space-y-2 text-sm">
                        <div>Send <strong>{formatLtc(reviewedOutSats)}</strong> to</div>
                        <code className="block font-mono break-all text-xs bg-muted rounded p-2">{to.trim()}</code>
                        <div className="text-muted-foreground">
                          Network fee {formatLtc(stage.feeSats)} · Total {formatLtc(reviewedOutSats + stage.feeSats)}
                        </div>
                        <div className="text-destructive text-xs pt-1">LTC transactions are irreversible.</div>
                      </div>
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={send} disabled={busy}>Confirm & send</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </CardContent>
        </Card>
      )}
    </main>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3 border-b border-border/40 pb-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right">{children}</span>
    </div>
  );
}
