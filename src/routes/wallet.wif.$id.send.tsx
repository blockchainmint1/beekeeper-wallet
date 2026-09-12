import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { friendlyBroadcastError } from "@/lib/broadcast-error";
import { useMemo, useState } from "react";
import { z } from "zod";
import { useWallet } from "@/lib/txc/wallet-context";
import { getWifWallet, revealWif } from "@/lib/wif/store";
import { decodeWif } from "@/lib/wif/decode";
import { api } from "@/lib/wif/chain-io";
import { buildAndSignWifTx, estimateWifVsize, type WifUtxoInput } from "@/lib/wif/sign";
import { formatTxc, txcToSats } from "@/lib/txc/units";
import {
  buildSimpleSendPayload,
  formatTokenAmount,
  isOmniCompatibleAddress,
  parseTokenAmount,
  useEnabledTxcTokens,
} from "@/lib/txc/tokens";
import { useTxcTokenProps } from "@/lib/txc/token-props";
import { getTxcTokenBalancesForAddresses } from "@/lib/txc/tokens.functions";
import { TXC_NETWORK } from "@/lib/txc/network";
import { ISK_NETWORK } from "@/lib/isk/network";
import { address as addrLib } from "bitcoinjs-lib";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { AlertTriangle, ExternalLink } from "lucide-react";
import { QrScanButton, parseWalletUri } from "@/components/wallet/QrScanButton";
import { AddressBookButton } from "@/components/wallet/AddressBookButton";
import { hapticSuccess, hapticError } from "@/lib/native/ui";
import { confirmWithBiometric } from "@/lib/native/biometric";

const searchSchema = z.object({
  to: z.string().optional(),
  amount: z.string().optional(),
  /** Omni property id — when present this is a token (e.g. TSD) send. */
  token: z.string().optional(),
});

/** Omni reference output value, matching the HD send flow. */
const OMNI_DUST_SATS = 10_000;
/** Extra vbytes for the OP_RETURN payload output. */
const OP_RETURN_VBYTES = 32;

export const Route = createFileRoute("/wallet/wif/$id/send")({
  head: () => ({ meta: [{ title: "Send — BeeKeeper Wallet" }] }),
  validateSearch: (raw) => searchSchema.parse(raw),
  component: WifSendPage,
});

type Stage =
  | { kind: "form" }
  | { kind: "review"; vsize: number; feeSats: number; selected: number }
  | { kind: "sent"; txid: string };

function WifSendPage() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const { root } = useWallet();
  const search = Route.useSearch();
  const qc = useQueryClient();
  const entry = useMemo(() => getWifWallet(id), [id]);

  const tokenId = search.token ? Number(search.token) : null;
  const localTokens = useEnabledTxcTokens();
  const { resolved: knownTokens } = useTxcTokenProps(localTokens);
  const activeToken =
    tokenId != null ? (knownTokens.find((t) => t.id === tokenId) ?? null) : null;
  const isTokenSend = !!activeToken && entry?.chain === "txc";
  const fetchTokenBalances = useServerFn(getTxcTokenBalancesForAddresses);

  const chainApi = entry ? api(entry.chain) : null;
  const network = entry ? (entry.chain === "txc" ? TXC_NETWORK : ISK_NETWORK) : null;

  const utxosQ = useQuery({
    queryKey: ["wif-utxos", id],
    enabled: !!entry,
    queryFn: async () => {
      if (!chainApi || !entry) return [];
      const list = await chainApi.getAddressUtxos(entry.address);
      // Enrich with the witness script or non-witness raw hex needed for signing.
      return await Promise.all(
        list.map(async (u) => {
          const enriched: WifUtxoInput = { txid: u.txid, vout: u.vout, value: u.value };
          if (entry.kind === "bip44") {
            enriched.nonWitnessUtxoHex = await chainApi.getTxHex(u.txid);
          } else {
            // Reconstruct scriptPubKey from the address (Esplora doesn't
            // return it on /utxo). bitcoinjs's address.toOutputScript does.
            const script = addrLib.toOutputScript(entry.address, network!);
            enriched.witnessScriptHex = Array.from(script, (b) =>
              b.toString(16).padStart(2, "0"),
            ).join("");
          }
          return enriched;
        }),
      );
    },
  });

  const feesQ = useQuery({
    queryKey: ["wif-fees", entry?.chain],
    enabled: !!entry,
    queryFn: () => chainApi!.getFeeEstimates(),
    staleTime: 60_000,
  });

  const tokenBalanceQ = useQuery({
    queryKey: ["wif-token-balance", entry?.address, tokenId],
    enabled: !!entry && isTokenSend,
    queryFn: () =>
      fetchTokenBalances({
        data: { addresses: [entry!.address], propertyIds: [tokenId!] },
      }),
    staleTime: 30_000,
  });

  const [to, setTo] = useState(search.to ?? "");
  const [amount, setAmount] = useState(search.amount ?? "");
  const [sendAll, setSendAll] = useState(false);
  const [feeTier, setFeeTier] = useState<"fastestFee" | "halfHourFee" | "hourFee">("halfHourFee");
  const [stage, setStage] = useState<Stage>({ kind: "form" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!entry) {
    return (
      <main className="mx-auto max-w-xl px-4 py-10">
        <p className="text-sm text-muted-foreground">Wallet not found.</p>
        <Link className="underline text-sm" to="/wallet">← Back</Link>
      </main>
    );
  }

  const utxos = utxosQ.data ?? [];
  const totalAvailable = utxos.reduce((s, u) => s + u.value, 0);
  const amountSats = txcToSats(amount || "0"); // same 8 decimals for ISK
  const feeRate = feesQ.data?.[feeTier] ?? 1;
  const chainLabel = entry.chain.toUpperCase();
  const unitLabel = isTokenSend ? activeToken!.symbol : chainLabel;
  const tokenUnits = BigInt(
    (tokenBalanceQ.data as Record<string, string> | undefined)?.[String(tokenId)] ?? "0",
  );

  function isValidAddress(addr: string): boolean {
    try {
      addrLib.toOutputScript(addr.trim(), network!);
      return true;
    } catch {
      return false;
    }
  }

  function applyUri(raw: string) {
    const { address, amount: amt } = parseWalletUri(raw);
    setTo(address);
    if (amt) {
      setAmount(amt);
      setSendAll(false);
    }
  }

  function review(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const cleanTo = to.trim();
    if (!isValidAddress(cleanTo)) {
      setError(`That's not a valid ${chainLabel} address.`);
      return;
    }
    const sorted = [...utxos].sort((a, b) => b.value - a.value);

    if (isTokenSend && activeToken) {
      if (entry!.kind !== "bip44") {
        setError(
          "Omni tokens can only be sent from a legacy T… address. This imported key uses a segwit address.",
        );
        return;
      }
      if (!isOmniCompatibleAddress(cleanTo)) {
        setError(
          `Omni tokens can't be sent to a txc1… address. Ask for a legacy T… address instead.`,
        );
        return;
      }
      let amountUnits: bigint;
      try {
        amountUnits = parseTokenAmount(amount, activeToken.divisible);
      } catch {
        setError("Enter a valid amount.");
        return;
      }
      if (amountUnits <= 0n) {
        setError("Enter an amount greater than zero.");
        return;
      }
      if (amountUnits > tokenUnits) {
        setError(
          `You only hold ${formatTokenAmount(tokenUnits, activeToken.divisible)} ${activeToken.symbol} on this address.`,
        );
        return;
      }
      const picked: typeof sorted = [];
      let acc = 0;
      let vsize = 0;
      let feeSats = 0;
      for (const u of sorted) {
        picked.push(u);
        acc += u.value;
        vsize = estimateWifVsize(entry!.kind, picked.length, 2) + OP_RETURN_VBYTES;
        feeSats = Math.ceil(vsize * feeRate);
        if (acc >= OMNI_DUST_SATS + feeSats + OMNI_DUST_SATS) break;
      }
      if (acc < OMNI_DUST_SATS + feeSats) {
        setError(
          `Not enough TXC on this address for the transfer. Need about ${formatTxc(OMNI_DUST_SATS + feeSats)}, have ${formatTxc(acc)}.`,
        );
        return;
      }
      setStage({ kind: "review", vsize, feeSats, selected: picked.length });
      return;
    }

    if (sendAll) {
      const nIn = sorted.length;
      if (nIn === 0) {
        setError("No funds available.");
        return;
      }
      const vsize = estimateWifVsize(entry!.kind, nIn, 1);
      const feeSats = Math.ceil(vsize * feeRate);
      const outSats = totalAvailable - feeSats;
      if (outSats <= 546) {
        setError("Not enough to cover the network fee.");
        return;
      }
      setStage({ kind: "review", vsize, feeSats, selected: nIn });
      return;
    }
    if (amountSats <= 546) {
      setError("Amount is below dust limit.");
      return;
    }
    const picked: typeof sorted = [];
    let acc = 0;
    let vsize = 0;
    let feeSats = 0;
    for (const u of sorted) {
      picked.push(u);
      acc += u.value;
      vsize = estimateWifVsize(entry!.kind, picked.length, 2);
      feeSats = Math.ceil(vsize * feeRate);
      if (acc >= amountSats + feeSats) break;
    }
    if (acc < amountSats + feeSats) {
      setError(
        `Not enough funds. Available ${formatTxc(totalAvailable)}, needed ${formatTxc(amountSats + feeSats)}.`,
      );
      return;
    }
    setStage({ kind: "review", vsize, feeSats, selected: picked.length });
  }

  async function send() {
    if (!root || !entry || stage.kind !== "review" || !chainApi || !network) return;
    const ok = await confirmWithBiometric(`Confirm sending ${chainLabel}`);
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      const wifStr = await revealWif(entry, root);
      const decoded = decodeWif(wifStr);
      const sorted = [...utxos].sort((a, b) => b.value - a.value);
      const picked = sorted.slice(0, stage.selected);
      const outValue = isTokenSend
        ? OMNI_DUST_SATS
        : sendAll
          ? totalAvailable - stage.feeSats
          : amountSats;
      const built = buildAndSignWifTx({
        network,
        kind: entry.kind,
        privateKey: decoded.privateKey,
        publicKey: decoded.publicKey,
        inputs: picked,
        outputs: [{ address: to.trim(), valueSats: outValue }],
        changeAddress: entry.address, // change back to same single address
        feeSats: stage.feeSats,
        opReturnData:
          isTokenSend && activeToken
            ? buildSimpleSendPayload(
                activeToken.id,
                parseTokenAmount(amount, activeToken.divisible),
              )
            : undefined,
      });
      const txid = await chainApi.broadcastTx(built.hex);
      hapticSuccess();
      void qc.invalidateQueries({ queryKey: ["wif-utxos", id] });
      void qc.invalidateQueries({ queryKey: ["wif-txs", id] });
      void qc.invalidateQueries({ queryKey: ["wif-token-balance"] });
      void qc.invalidateQueries({ queryKey: ["txc-token-balances"] });
      setStage({ kind: "sent", txid });
    } catch (err) {
      hapticError();
      setError(friendlyBroadcastError(err));
    } finally {
      setBusy(false);
    }
  }

  const reviewedOutSats =
    stage.kind === "review"
      ? isTokenSend
        ? OMNI_DUST_SATS
        : sendAll
          ? totalAvailable - stage.feeSats
          : amountSats
      : 0;

  if (stage.kind === "sent") {
    return (
      <main className="mx-auto max-w-xl px-4 py-10 text-center">
        <div className="w-16 h-16 rounded-full bg-emerald-500/15 text-emerald-400 mx-auto flex items-center justify-center text-2xl">
          ✓
        </div>
        <h1 className="mt-4 text-2xl font-bold">Sent</h1>
        <p className="mt-2 text-muted-foreground">Your transaction was broadcast to the network.</p>
        <a
          href={chainApi!.explorerTxUrl(stage.txid)}
          target="_blank"
          rel="noreferrer"
          className="mt-3 inline-flex items-center gap-1 text-sm underline"
        >
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
      <Link to="/wallet" className="text-sm text-muted-foreground hover:text-foreground">
        ← Back
      </Link>
      <h1 className="mt-3 text-2xl font-bold">Send {unitLabel}</h1>
      <p className="text-sm text-muted-foreground">
        {entry.label} ·{" "}
        {isTokenSend
          ? `${tokenBalanceQ.isLoading ? "…" : formatTokenAmount(tokenUnits, activeToken!.divisible)} ${activeToken!.symbol} · ${formatTxc(totalAvailable)} for fees`
          : `Available: ${utxosQ.isLoading ? "…" : formatTxc(totalAvailable)}`}
      </p>

      {stage.kind === "form" && (
        <Card className="mt-5">
          <CardHeader>
            <CardTitle>Recipient</CardTitle>
            <CardDescription>Sends are irreversible.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={review} className="space-y-4">
              <div>
                <Label htmlFor="to">{chainLabel} address</Label>
                <div className="mt-1 flex gap-2">
                  <Input
                    id="to"
                    value={to}
                    onChange={(e) => setTo(e.target.value)}
                    placeholder={
                      isTokenSend
                        ? "T... (legacy address required)"
                        : entry.chain === "txc"
                          ? "txc1... or T..."
                          : "isk1... or K..."
                    }
                    className="font-mono flex-1"
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <QrScanButton onScan={applyUri} />
                  <AddressBookButton chain={entry.chain} onPick={(a) => setTo(a)} />
                </div>
              </div>
              <div>
                <div className="flex items-center justify-between">
                  <Label htmlFor="amount">Amount ({unitLabel})</Label>
                  {!isTokenSend && (
                    <label className="text-xs text-muted-foreground flex items-center gap-1.5 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={sendAll}
                        onChange={(e) => setSendAll(e.target.checked)}
                        className="h-3.5 w-3.5"
                      />
                      Send all
                    </label>
                  )}
                </div>
                <Input
                  id="amount"
                  type="number"
                  inputMode="decimal"
                  step="0.00000001"
                  min="0"
                  value={sendAll ? "" : amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder={sendAll ? "All available (minus fee)" : "0.0"}
                  className="mt-1"
                  disabled={sendAll}
                />
              </div>
              <div>
                <Label>Fee speed</Label>
                <div className="mt-2 grid grid-cols-3 gap-2 text-sm">
                  {(["hourFee", "halfHourFee", "fastestFee"] as const).map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setFeeTier(t)}
                      className={`rounded-md border px-2 py-2 text-center transition-colors ${
                        feeTier === t
                          ? "border-primary bg-primary/10"
                          : "border-border hover:bg-accent"
                      }`}
                    >
                      <div className="font-medium">
                        {t === "fastestFee" ? "Fast" : t === "halfHourFee" ? "Medium" : "Slow"}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {feesQ.data?.[t] ?? "—"} sat/vB
                      </div>
                    </button>
                  ))}
                </div>
              </div>
              {error && (
                <div className="flex items-start gap-2 text-sm text-destructive">
                  <AlertTriangle className="h-4 w-4 mt-0.5" /> {error}
                </div>
              )}
              <Button
                type="submit"
                className="w-full"
                disabled={!to || (!sendAll && !amount) || utxosQ.isLoading}
              >
                Review
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      {stage.kind === "review" && (
        <Card className="mt-5">
          <CardHeader>
            <CardTitle>Review and send</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <Row label="To"><code className="font-mono break-all">{to.trim()}</code></Row>
            <Row label="Amount">
              {isTokenSend ? (
                `${amount} ${activeToken!.symbol}`
              ) : (
                <>
                  {formatTxc(reviewedOutSats)}
                  {sendAll && <span className="text-muted-foreground text-xs ml-1">(all)</span>}
                </>
              )}
            </Row>
            {isTokenSend && (
              <Row label="Reference output">
                {formatTxc(OMNI_DUST_SATS)}{" "}
                <span className="text-muted-foreground text-xs">(TXC, carries the transfer)</span>
              </Row>
            )}
            <Row label="Network fee">
              {formatTxc(stage.feeSats)}{" "}
              <span className="text-muted-foreground text-xs">
                ({stage.vsize} vB × {feeRate} sat/vB)
              </span>
            </Row>
            <Row label="Total TXC">{formatTxc(reviewedOutSats + stage.feeSats)}</Row>
            {error && (
              <div className="flex items-start gap-2 text-sm text-destructive">
                <AlertTriangle className="h-4 w-4 mt-0.5" /> {error}
              </div>
            )}
            <div className="flex gap-2 pt-2">
              <Button variant="ghost" onClick={() => setStage({ kind: "form" })} disabled={busy}>
                Edit
              </Button>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button className="flex-1" disabled={busy}>
                    {busy ? "Broadcasting..." : `Send ${unitLabel}`}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Confirm transaction</AlertDialogTitle>
                    <AlertDialogDescription asChild>
                      <div className="space-y-2 text-sm">
                        <div>
                          Send{" "}
                          <strong>
                            {isTokenSend
                              ? `${amount} ${activeToken!.symbol}`
                              : formatTxc(reviewedOutSats)}
                          </strong>{" "}
                          to
                        </div>
                        <code className="block font-mono break-all text-xs bg-muted rounded p-2">
                          {to.trim()}
                        </code>
                        <div className="text-muted-foreground">
                          Network fee {formatTxc(stage.feeSats)} · Total{" "}
                          {formatTxc(reviewedOutSats + stage.feeSats)}
                        </div>
                        <div className="text-destructive text-xs pt-1">
                          {chainLabel} transactions are irreversible.
                        </div>
                      </div>
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={send} disabled={busy}>
                      Confirm & send
                    </AlertDialogAction>
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
