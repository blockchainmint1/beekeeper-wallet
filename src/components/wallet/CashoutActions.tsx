/**
 * Cash out to a bank account, in two parts:
 *
 *   Part 1 (here)      total up every stable balance the merchant wants to cash
 *                      out, then send each one to the cash-out deposit address,
 *                      one authorised transfer at a time.
 *   Part 2 (VectorPay) identity verification, bank linking through Plaid and
 *                      the dollar payout.
 *
 * The order is registered with VectorPay *after* the transfers, for the amount
 * that actually went out — a partial run still produces a valid order.
 *
 * NectarPay merchants pay no service fee; everyone else pays 1%.
 *
 * Exchange/off-ramp feature — gated by `useExchangeFeaturesAllowed()` and
 * therefore absent from the iOS build. See AGENTS.md.
 */
import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  ExternalLink,
  Landmark,
  Loader2,
  Send,
  Wallet,
  X,
} from "lucide-react";
import { formatEther, type Address } from "viem";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useExchangeFeaturesAllowed } from "@/lib/native/capabilities";
import { getTxcTokenBalancesForAddresses, getTxcTokenBalancesPerAddress } from "@/lib/txc/tokens.functions";
import { sendOmniToken } from "@/lib/txc/omni-send";
import { explorerTxUrl } from "@/lib/txc/mempool";
import { EVM_CHAINS } from "@/lib/chains/evm";
import { useWallet } from "@/lib/txc/wallet-context";
import { listLinks } from "@/lib/nectar/link";
import {
  ensureGas,
  ROUNDUP_CHAINS,
  scanEvmCashable,
  sendCashRow,
  signEvmProof,
  signTsdProof,
  cashoutCustomerId,
  type EvmCashRow,
  type TransferProof,
} from "@/lib/cashout/roundup";
import {
  CASHOUT_DISCLOSURES,
  MERCHANT_FEE_BPS,
  ORDER_FEE_BPS,
  ORDER_MAX_USD,
  ORDER_MIN_USD,
  quoteCashout,
  saveLocalVectorPayOrder,
  openVectorPayCheckout,
  type CashoutChain,
  type CashoutAsset,
} from "@/lib/vectorpay";
import { getVectorPayConfig, startVectorPayCashout } from "@/lib/vectorpay.functions";
import { QrScanButton } from "@/components/wallet/QrScanButton";
import { recordEcosystemLink } from "@/lib/ecosystem-links";
import {
  getVectorPayLink,
  parseVectorPayLinkInput,
  setVectorPayLink,
  type VectorPayLink,
} from "@/lib/vectorpay-link";
import { redeemVectorPayLink, vectorPayLinkStatus } from "@/lib/vectorpay-link.functions";

type Step = "intro" | "holdings" | "review" | "transfers" | "done";
const STEPS: Step[] = ["intro", "holdings", "review", "transfers", "done"];

interface Holding {
  key: string;
  chain: CashoutChain;
  label: string;
  sub: string;
  asset: CashoutAsset;
  coinAmount: number;
  usd: number;
  /** Omni property id, for TSD. */
  propertyId?: number;
  evm?: EvmCashRow;
  /** Can't send: no coin for the network fee anywhere. */
  blocked?: string;
}

type RowStatus = { state: "sending" | "sent" | "failed" | "skipped"; txid?: string; error?: string };

/** Survives the trip to the TSD send screen and back. */
export const CASHOUT_SESSION_KEY = "beekeeper.cashout.session.v1";
const SESSION_KEY = CASHOUT_SESSION_KEY;
interface CashoutSession {
  reference: string;
  step: Step;
  accepted: string[];
  selected: string[];
  /** Per-row manually lowered cash-out amount ("partial cash-out"). */
  amounts: Record<string, string>;
  result?: { orderId: string; checkoutUrl: string | null; detail: string } | null;
  status: Record<string, RowStatus>;
}

function fmt(value: number, digits = 6) {
  return value.toLocaleString(undefined, { maximumFractionDigits: digits });
}

function newReference() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const suffix = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
  return `BK-${Date.now().toString(36).toUpperCase()}-${suffix}`;
}

/** Row with a manually lowered cash-out amount, or unchanged when blank/full. */
function appliedAmount(row: Holding, amounts: Record<string, string>): Holding {
  const txt = amounts[row.key];
  if (!txt) return row;
  const v = Number(txt);
  if (!Number.isFinite(v) || v <= 0 || v >= row.usd) return row;
  if (row.evm) {
    const raw = BigInt(Math.round(v * 10 ** row.evm.token.decimals));
    if (raw <= 0n || raw >= row.evm.raw) return row;
    const coin = Number(raw) / 10 ** row.evm.token.decimals;
    return { ...row, usd: coin, coinAmount: coin };
  }
  const coin = Math.min(Math.round((v / row.usd) * row.coinAmount * 1e8) / 1e8, row.coinAmount);
  return { ...row, usd: coin, coinAmount: coin };
}

/** Raw token amount for a partial cash-out row (undefined = send the full balance). */
function partialRaw(row: Holding, amounts: Record<string, string>): bigint | undefined {
  if (!row.evm) return undefined;
  const txt = amounts[row.key];
  if (!txt) return undefined;
  const v = Number(txt);
  if (!Number.isFinite(v) || v <= 0) return undefined;
  const raw = BigInt(Math.round(v * 10 ** row.evm.token.decimals));
  return raw > 0n && raw < row.evm.raw ? raw : undefined;
}

export function CashoutActions({
  txcAddresses,
}: {
  txcAddresses: string[];
  evmAddress?: string | null;
}) {
  const allowed = useExchangeFeaturesAllowed();
  const { root, unlocked } = useWallet();
  const configFn = useServerFn(getVectorPayConfig);
  const startCashout = useServerFn(startVectorPayCashout);
  const fetchTsd = useServerFn(getTxcTokenBalancesForAddresses);
  const fetchTsdPerAddr = useServerFn(getTxcTokenBalancesPerAddress);
  const [tsdProgress, setTsdProgress] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const config = useQuery({
    queryKey: ["vectorpay-config"],
    queryFn: () => configFn(),
    staleTime: 60_000,
    enabled: allowed,
  });
  const destinations = config.data?.destinations ?? { txc: null, base: null, eth: null, bsc: null, tron: null };

  const addressKey = txcAddresses.slice().sort().join(",");
  const tsd = useQuery({
    queryKey: ["cashout-tsd", addressKey],
    enabled: allowed && open && txcAddresses.length > 0,
    queryFn: () => fetchTsd({ data: { addresses: txcAddresses, propertyIds: [39] } }),
    staleTime: 15_000,
  });

  const evmChains = ROUNDUP_CHAINS.filter((c) => destinations[c]);
  const evm = useQuery({
    queryKey: ["cashout-evm-roundup", root ? root.neutered().toBase58().slice(0, 24) : null, evmChains.join(",")],
    enabled: allowed && open && !!root && evmChains.length > 0,
    queryFn: () => scanEvmCashable(root!, evmChains),
    staleTime: 15_000,
  });

  const [step, setStep] = useState<Step>("intro");
  const [accepted, setAccepted] = useState<string[]>([]);
  const [selected, setSelected] = useState<string[] | null>(null);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<Record<string, RowStatus>>({});
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ orderId: string; checkoutUrl: string | null; detail: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [reference, setReference] = useState("");

  // Restore an in-progress cash-out (e.g. after sending TSD on its own screen).
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
      if (!raw) {
        setReference(newReference());
        return;
      }
      const saved = JSON.parse(raw) as CashoutSession;
      setReference(saved.reference);
      setStep((saved.step as string) === "details" ? "review" : saved.step);
      setAccepted(saved.accepted);
      setSelected(saved.selected);
      setAmounts(saved.amounts ?? {});
      setStatus(saved.status);
      if (saved.result) setResult(saved.result);
      if (saved.step !== "intro") setOpen(true);
    } catch {
      setReference(newReference());
    }
  }, []);
  useEffect(() => {
    if (!reference || step === "intro" || step === "done") return;
    const session: CashoutSession = { reference, step, accepted, selected: selected ?? [], amounts, status, result };
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    } catch {
      /* noop */
    }
  }, [reference, step, accepted, selected, amounts, status, result]);

  // NectarPay merchants cash out with no service fee.
  const [merchantId, setMerchantId] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setMerchantId(listLinks()[0]?.merchantId ?? null);
  }, [open]);
  const feeBps = merchantId ? MERCHANT_FEE_BPS : ORDER_FEE_BPS;

  // Cash out requires a linked VectorPay account. Check the local record,
  // then confirm with VectorPay (picks up links made on another device).
  const [vpLink, setVpLink] = useState<VectorPayLink | null>(null);
  const [vpChecking, setVpChecking] = useState(false);
  const [vpCode, setVpCode] = useState("");
  const [vpBusy, setVpBusy] = useState(false);
  const [vpError, setVpError] = useState<string | null>(null);
  useEffect(() => {
    if (!open || !root) return;
    setVpLink(getVectorPayLink());
    setVpChecking(true);
    void (async () => {
      try {
        const accountRef = await cashoutCustomerId(root);
        const reply = await vectorPayLinkStatus({ data: { accountRef } });
        if (reply.ok && reply.linked) {
          setVectorPayLink({ firstName: reply.firstName, bank: reply.bank });
          setVpLink(getVectorPayLink());
        }
      } catch {
        /* offline — fall back to the local record */
      } finally {
        setVpChecking(false);
      }
    })();
  }, [open, root]);

  async function onLinkVectorPay(raw: string) {
    if (!root) return;
    const code = parseVectorPayLinkInput(raw);
    if (!code) {
      setVpError("That isn't a VectorPay link code. Copy the code or scan the QR on your VectorPay dashboard.");
      return;
    }
    setVpBusy(true);
    setVpError(null);
    try {
      const accountRef = await cashoutCustomerId(root);
      const reply = await redeemVectorPayLink({ data: { code, accountRef } });
      if (!reply.ok || !reply.linked) {
        setVpError(reply.detail);
        return;
      }
      setVectorPayLink({ firstName: reply.firstName, bank: reply.bank });
      recordEcosystemLink({
        id: "vectorpay",
        app: "VectorPay",
        detail: reply.bank ? `${reply.bank.institution ?? "Bank"} ····${reply.bank.mask}` : "Cash out to your bank",
      });
      setVpLink(getVectorPayLink());
      setVpCode("");
    } catch (e) {
      setVpError(e instanceof Error ? e.message : "Could not link VectorPay.");
    } finally {
      setVpBusy(false);
    }
  }

  /** Everything this wallet holds that a cash-out deposit address can accept. */
  const cashable = useMemo<Holding[]>(() => {
    const list: Holding[] = [];
    const tsdAmount = Number(BigInt(tsd.data?.[39] ?? "0")) / 1e8;
    if (tsdAmount > 0 && destinations.txc) {
      list.push({ key: "t:tsd", chain: "txc", label: "TSD on TEXITcoin", sub: "Sent from the TSD send screen", asset: "TSD", coinAmount: tsdAmount, usd: tsdAmount, propertyId: 39 });
    }
    for (const row of evm.data ?? []) {
      const chain = EVM_CHAINS[row.chain];
      const fee = `~${Number(formatEther(row.gasWei)).toFixed(6)} ${chain.nativeSymbol} fee`;
      list.push({
        key: row.key,
        chain: row.chain,
        label: `${row.asset} on ${chain.name}`,
        sub: `${row.index === 0 ? "Main address" : `Address #${row.index}`} · ${fee}${row.gas === "fund" ? " (topped up from main)" : ""}`,
        asset: row.asset,
        coinAmount: row.amount,
        usd: row.amount,
        evm: row,
        blocked: row.gas === "nogas" ? `Needs a little ${chain.nativeSymbol} for the network fee` : undefined,
      });
    }
    return list.sort((a, b) => b.usd - a.usd);
  }, [tsd.data, evm.data, destinations.txc]);

  const cashableByKey = useMemo(() => new Map(cashable.map((r) => [r.key, r])), [cashable]);
  // Rows with a manually lowered amount ("cash out only part of this balance").
  const cashableEff = useMemo(() => cashable.map((r) => appliedAmount(r, amounts)), [cashable, amounts]);

  // Default: everything sendable, except tiny Ethereum balances the fee would eat.
  useEffect(() => {
    if (selected !== null || step !== "holdings" || tsd.isLoading || evm.isLoading) return;
    setSelected(cashable.filter((r) => !r.blocked && !(r.chain === "eth" && r.usd < 10)).map((r) => r.key));
  }, [selected, step, cashable, tsd.isLoading, evm.isLoading]);

  const picked = selected ?? [];
  const chosen = useMemo(() => cashableEff.filter((row) => picked.includes(row.key)), [cashableEff, picked]);
  const chosenTotal = chosen.reduce((sum, row) => sum + row.usd, 0);
  const sentRows = chosen.filter((row) => status[row.key]?.state === "sent");
  const sentTotal = sentRows.reduce((sum, row) => sum + row.usd, 0);
  const evmPending = chosen.filter((r) => r.evm && status[r.key]?.state !== "sent");
  const allResolved = chosen.every((r) => status[r.key]?.state === "sent" || status[r.key]?.state === "skipped");
  // A checked row with a typed amount that isn't a valid partial amount.
  const invalidAmounts = picked.some((key) => {
    const orig = cashableByKey.get(key);
    if (!orig || orig.blocked) return false;
    const txt = amounts[key];
    if (txt === undefined || txt === "") return false;
    const v = Number(txt);
    return !Number.isFinite(v) || v <= 0 || v > orig.usd;
  });

  const quote = quoteCashout(chosenTotal, feeBps);
  const finalQuote = quoteCashout(Math.min(sentTotal, ORDER_MAX_USD), feeBps);
  const allAccepted = accepted.length === CASHOUT_DISCLOSURES.length;
  const totalError =
    chosenTotal < ORDER_MIN_USD
      ? `Select at least $${ORDER_MIN_USD} to cash out.`
      : chosenTotal > ORDER_MAX_USD
        ? `Orders top out at $${ORDER_MAX_USD}. Uncheck a wallet or two.`
        : null;
  const scanning = tsd.isLoading || evm.isLoading || config.isLoading;

  if (!allowed) return null;

  function reset() {
    setStep("intro");
    setAccepted([]);
    setSelected(null);
    setAmounts({});
    setStatus({});
    setError(null);
    setResult(null);
    setReference(newReference());
    try {
      sessionStorage.removeItem(SESSION_KEY);
    } catch {
      /* noop */
    }
  }

  /** Send one selected EVM balance to its deposit address (tops up gas first if needed). */
  async function sendOne(row: Holding) {
    if (!root || running || !row.evm) return;
    const e = row.evm;
    const to = destinations[e.chain] as Address | null;
    if (!to) return;
    setRunning(true);
    setError(null);
    setStatus((s) => ({ ...s, [row.key]: { state: "sending" } }));
    try {
      const count = evmPending.filter((r) => r.evm!.chain === e.chain && r.evm!.index === e.index).length || 1;
      await ensureGas(root, e.chain, e.index, count);
      const txid = await sendCashRow(root, e, to, partialRaw(row, amounts));
      setStatus((s) => ({ ...s, [row.key]: { state: "sent", txid } }));
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message.split("\n")[0] : "Send failed";
      setStatus((s) => ({ ...s, [row.key]: { state: "failed", error: msg } }));
    } finally {
      setRunning(false);
    }
  }

  /** Send TSD right here — same Omni logic as the Send screen, no page change. */
  async function sendTsdRow(row: Holding) {
    if (!root || !unlocked || running || !row.propertyId) return;
    const to = destinations.txc;
    if (!to) return;
    setRunning(true);
    setError(null);
    setStatus((s) => ({ ...s, [row.key]: { state: "sending" } }));
    try {
      const units = BigInt(Math.round(row.coinAmount * 1e8));
      const txid = await sendOmniToken({
        root,
        kind: unlocked.kind,
        propertyId: row.propertyId,
        amountUnits: units,
        to,
        fetchPerAddress: (addresses, propertyIds) => fetchTsdPerAddr({ data: { addresses, propertyIds } }),
        onProgress: setTsdProgress,
      });
      setStatus((s) => ({ ...s, [row.key]: { state: "sent", txid } }));
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message.split("\n")[0] : "Send failed";
      setStatus((s) => ({ ...s, [row.key]: { state: "failed", error: msg } }));
    } finally {
      setTsdProgress(null);
      setRunning(false);
    }
  }

  /**
   * Called twice with the same reference: first before any coins move (no
   * txids, opens VectorPay), then after sending with fresh proofs that carry
   * the txids — VectorPay looks EVM deposits up by txid and dedupes repeats.
   */
  async function placeOrder(final = false) {
    if (!root || !allAccepted || chosen.length === 0) return;
    if (final && sentRows.length === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      const proofs: Array<TransferProof & { usd: number }> = [];
      // Order first: proofs sign the sending wallet before any coins move, so
      // VectorPay matches deposits that arrive later from these addresses.
      for (const row of final ? sentRows : chosen) {
        const to = destinations[row.chain] ?? "";
        const txids = final && status[row.key]?.txid ? [status[row.key]!.txid!] : [];
        const amount = String(row.coinAmount);
        const proof = row.evm
          ? await signEvmProof(root, { reference, chain: row.evm.chain, asset: row.asset, index: row.evm.index, to, txids, amount })
          : signTsdProof(root, { reference, to, txids, amount });
        proofs.push({ ...proof, usd: Math.round(row.usd * 100) / 100 });
      }
      const response = await startCashout({
        data: {
          reference,
          usd: Math.round(Math.min(final ? sentTotal : chosenTotal, ORDER_MAX_USD) * 100) / 100,
          customerId: await cashoutCustomerId(root),
          acceptedDisclaimers: accepted,
          ...(merchantId ? { merchantId } : {}),
          transfers: proofs.map((p) => ({
            chain: p.chain as CashoutChain,
            asset: p.asset,
            usd: p.usd,
            from: p.from,
            txids: p.txids,
            amount: p.amount,
            message: p.message,
            signature: p.signature,
          })),
        },
      });
      saveLocalVectorPayOrder({
        id: response.orderId,
        side: "sell",
        createdAt: Date.now(),
        status: response.registered ? "ready" : "registration_failed",
        usd: (final ? finalQuote : quote).usd,
        feeUsd: response.feeUsd,
        settlementUsd: (final ? finalQuote : quote).settlementUsd,
        assetAmount: (final ? finalQuote : quote).assetAmount,
        asset: response.asset ?? "TSD",
        chain: response.chain ?? "txc",
        checkoutUrl: response.handoffUrl,
        detail: response.detail,
        transfers: proofs.map((p) => ({ chain: p.chain as CashoutChain, asset: p.asset, usd: p.usd })),
      });
      setResult({ orderId: response.orderId, checkoutUrl: response.handoffUrl, detail: response.detail });
      if (!response.registered || !response.handoffUrl) {
        setError(response.detail || "VectorPay couldn't create the order. Nothing was sent.");
        return;
      }
      if (final) {
        setStep("done");
        try {
          sessionStorage.removeItem(SESSION_KEY);
        } catch {
          /* noop */
        }
        return;
      }
      // Already linked at VectorPay — no checkout bounce; go straight to sending.
      setStep("transfers");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create the order.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="px-4 pt-4">
      <div className="grid grid-cols-2 gap-3">
        <Button variant="outline" size="lg" disabled title="Top up is coming soon">
          <ArrowDownToLine /> Top up
        </Button>
        <Button size="lg" onClick={() => setOpen(true)}>
          <ArrowUpFromLine /> Cash out
        </Button>
      </div>
      <p className="mt-2 text-center text-xs text-muted-foreground">Top up is coming soon.</p>

      <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (!next) reset(); }}>
        <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-md">
          <DialogHeader>
            <p className="text-xs font-semibold uppercase text-primary">
              Cash out · {STEPS.indexOf(step) + 1} of {STEPS.length}
            </p>
            <DialogTitle>{step === "done" ? "Cash-out sent" : "Cash out to your bank"}</DialogTitle>
            <DialogDescription>Turn your USDC, USDT and TSD into dollars in your bank account.</DialogDescription>
          </DialogHeader>

          {step === "intro" && (
            <div className="space-y-4 text-sm text-muted-foreground">
              <p>
                BeeKeeper rounds up every USDC, USDT and TSD you hold — on every chain and your first 20 addresses —
                and sends it to VectorPay, who pays your linked bank.
              </p>
              <div className="rounded-md border border-border/60 bg-muted/40 p-3">
                <p className="font-medium text-foreground">
                  {merchantId ? "No service fee · 1–3 business days" : "1% service fee · 1–3 business days"}
                </p>
                <p className="mt-1">
                  {merchantId
                    ? "NectarPay merchant — you cash out free. Any amount up to $1,000 per order."
                    : "Any amount up to $1,000 per order. NectarPay merchants pay no fee."}
                </p>
              </div>
              {vpLink ? (
                <div className="space-y-3">
                  <p className="rounded-md border border-border/60 bg-muted/40 p-3 text-foreground">
                    {vpLink.bank
                      ? `Pays out to ${vpLink.bank.institution ?? "your bank"} ····${vpLink.bank.mask}`
                      : "VectorPay linked — no bank on file yet. Add one in your VectorPay account first."}
                    {vpLink.firstName ? ` · ${vpLink.firstName}` : ""}
                  </p>
                  <Button className="w-full" disabled={!vpLink.bank} onClick={() => setStep("holdings")}>Get started</Button>
                </div>
              ) : (
                <div className="space-y-3 rounded-md border border-border/60 p-3">
                  <p className="font-medium text-foreground">First, link your VectorPay account</p>
                  <p>
                    VectorPay handles identity, your bank and the payout. Sign in at vector-pay.com, open
                    &quot;Connect your wallet&quot;, then paste the code or scan its QR here.
                  </p>
                  <div className="flex gap-2">
                    <Input
                      value={vpCode}
                      onChange={(e) => setVpCode(e.target.value)}
                      placeholder="Link code (e.g. CVMR-ZFYE)"
                      className="text-xs"
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <QrScanButton
                      onScan={(text) => {
                        setVpCode(text);
                        void onLinkVectorPay(text);
                      }}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      disabled={vpBusy || !vpCode.trim()}
                      onClick={() => void onLinkVectorPay(vpCode)}
                    >
                      {vpBusy ? "Linking…" : "Link"}
                    </Button>
                  </div>
                  {vpChecking && <p className="text-xs">Checking for an existing link…</p>}
                  {vpError && <p className="text-xs text-destructive">{vpError}</p>}
                </div>
              )}
            </div>
          )}

          {step === "holdings" && (
            <div className="space-y-4">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-medium">What you can cash out</p>
                  <p className="text-xs text-muted-foreground">
                    Only USDC, USDT and TSD can be cashed out. Everything is selected by default.
                  </p>
                </div>
                <div className="flex shrink-0 gap-1.5">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 px-2.5 text-xs"
                    onClick={() => setSelected(cashable.filter((r) => !r.blocked).map((r) => r.key))}
                  >
                    All
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 px-2.5 text-xs"
                    onClick={() => setSelected([])}
                  >
                    None
                  </Button>
                </div>
              </div>

              {scanning && (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> Checking every chain and your first 20 addresses…
                </p>
              )}

              {cashable.length === 0 && !scanning && (
                <p className="text-sm text-destructive">No USDC, USDT or TSD balances to cash out yet.</p>
              )}

              <div className="space-y-2">
                {cashableEff.map((row) => {
                  const orig = cashableByKey.get(row.key)!;
                  const checked = picked.includes(row.key);
                  const typed = amounts[row.key] ?? "";
                  return (
                    <div
                      key={row.key}
                      className={`rounded-md border border-border/60 bg-muted/30 p-3 ${row.blocked ? "opacity-60" : ""}`}
                    >
                      <div className="flex items-start gap-3">
                        <Checkbox
                          id={`cashout-${row.key}`}
                          className="mt-0.5"
                          checked={checked}
                          disabled={Boolean(row.blocked)}
                          onCheckedChange={(next) =>
                            setSelected((current) => {
                              const list = current ?? [];
                              return next ? [...list, row.key] : list.filter((value) => value !== row.key);
                            })
                          }
                        />
                        <label htmlFor={`cashout-${row.key}`} className="min-w-0 flex-1 cursor-pointer">
                          <span className="flex items-center justify-between gap-2 text-sm font-medium">
                            <span className="flex items-center gap-1.5">
                              <Wallet className="h-3.5 w-3.5 text-primary" /> {row.label}
                            </span>
                            <span>${fmt(row.usd, 2)}</span>
                          </span>
                          <span className={`mt-0.5 block text-xs ${row.blocked ? "text-destructive" : "text-muted-foreground"}`}>
                            {row.blocked ?? row.sub}
                          </span>
                        </label>
                      </div>
                      {checked && !row.blocked && (
                        <div className="mt-2 flex items-center gap-2 pl-7">
                          <span className="shrink-0 text-xs text-muted-foreground">Cash out</span>
                          <Input
                            inputMode="decimal"
                            value={typed}
                            onChange={(e) =>
                              setAmounts((current) => ({ ...current, [row.key]: e.target.value.replace(/[^0-9.]/g, "") }))
                            }
                            placeholder={fmt(orig.usd, 2)}
                            className="h-7 w-24 text-right text-xs"
                            autoComplete="off"
                          />
                          <span className="text-xs text-muted-foreground">
                            {typed ? `of $${fmt(orig.usd, 2)}` : `— blank for all $${fmt(orig.usd, 2)}`}
                          </span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              <div className="space-y-2 rounded-md border border-border/60 bg-muted/40 p-3 text-sm">
                <Row label="Total to cash out" value={`$${fmt(chosenTotal, 2)}`} strong />
                <Row label={feeBps === 0 ? "Service fee (merchant)" : "Service fee (1%)"} value={`$${quote.feeUsd.toFixed(2)}`} />
                <Row label="Estimated to your bank" value={`$${quote.settlementUsd.toFixed(2)}`} strong />
              </div>

              {invalidAmounts && (
                <p className="text-sm text-destructive">
                  Each amount must be more than $0 and no more than that balance. Leave a line blank to send all of it.
                </p>
              )}

              {totalError && <p className="text-sm text-destructive">{totalError}</p>}

              <div className="flex gap-2">
                <Button variant="outline" onClick={() => setStep("intro")}>Back</Button>
                <Button className="flex-1" disabled={Boolean(totalError) || invalidAmounts} onClick={() => setStep("review")}>
                  Continue
                </Button>
              </div>
            </div>
          )}

          {step === "review" && (
            <div className="space-y-4">
              <div className="space-y-2 rounded-md border border-border/60 bg-muted/40 p-3 text-sm">
                <Row label="You send" value={`$${fmt(chosenTotal, 2)} from ${chosen.length} ${chosen.length === 1 ? "wallet" : "wallets"}`} />
                <Row label={feeBps === 0 ? "Service fee (merchant)" : "Service fee (1%)"} value={`$${quote.feeUsd.toFixed(2)}`} />
                <Row label="Estimated to your bank" value={`$${quote.settlementUsd.toFixed(2)}`} strong />
              </div>
              <div className="space-y-3">
                {CASHOUT_DISCLOSURES.map((item) => (
                  <label key={item.id} className="flex items-start gap-3 text-xs leading-relaxed text-muted-foreground">
                    <Checkbox
                      checked={accepted.includes(item.id)}
                      onCheckedChange={(checked) =>
                        setAccepted((current) => (checked ? [...current, item.id] : current.filter((id) => id !== item.id)))
                      }
                    />
                    <span>
                      {item.text}
                      {item.id === "terms" && (
                        <>
                          {" "}
                          <Link to="/legal/terms" target="_blank" className="text-primary underline">Terms</Link> ·{" "}
                          <Link to="/legal/privacy" target="_blank" className="text-primary underline">Privacy</Link>
                        </>
                      )}
                    </span>
                  </label>
                ))}
              </div>
              {error && <p className="text-sm text-destructive">{error}</p>}
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => setStep("holdings")}>Back</Button>
                <Button className="flex-1" disabled={!allAccepted || submitting} onClick={() => void placeOrder()}>
                  {submitting ? <><Loader2 className="animate-spin" /> Creating order</> : "Create cash-out order with VectorPay"}
                </Button>
              </div>
            </div>
          )}

          {step === "transfers" && (
            <div className="space-y-4">
              <div>
                <p className="text-sm font-medium">Send each one</p>
                <p className="text-xs text-muted-foreground">
                  Your order {reference} is waiting at VectorPay. Tap Send on each line. If one fails, tap it again or
                  skip it — the order only covers what actually went out.
                </p>
              </div>

              <div className="space-y-2">
                {chosen.map((row) => {
                  const st = status[row.key];
                  const to = destinations[row.chain] ?? "";
                  return (
                    <div key={row.key} className="rounded-md border border-border/60 bg-muted/30 p-3">
                      <div className="flex items-center justify-between gap-2 text-sm font-medium">
                        <span className="flex items-center gap-1.5">
                          {st?.state === "sent" ? (
                            <Check className="h-3.5 w-3.5 text-primary" />
                          ) : st?.state === "sending" ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                          ) : st?.state === "failed" ? (
                            <X className="h-3.5 w-3.5 text-destructive" />
                          ) : (
                            <Wallet className="h-3.5 w-3.5 text-primary" />
                          )}
                          {row.label}
                        </span>
                        <span>${fmt(row.usd, 2)}</span>
                      </div>
                      <p className="mt-0.5 text-xs text-muted-foreground">{row.sub}</p>
                      {st?.state === "sent" && st.txid && row.evm && (
                        <a
                          href={EVM_CHAINS[row.evm.chain].explorerTx(st.txid)}
                          target="_blank"
                          rel="noreferrer"
                          className="mt-1 inline-flex items-center gap-1 text-xs text-primary underline"
                        >
                          View transfer <ExternalLink className="h-3 w-3" />
                        </a>
                      )}
                      {st?.state === "failed" && <p className="mt-1 text-xs text-destructive">{st.error}</p>}
                      {row.evm && st?.state !== "sent" && (
                        <div className="mt-2 flex items-center gap-2">
                          <Button
                            type="button"
                            size="sm"
                            className="flex-1"
                            disabled={running || !root || !to}
                            onClick={() => void sendOne(row)}
                          >
                            {st?.state === "sending" ? <><Loader2 className="animate-spin" /> Sending…</> : <><Send /> {st?.state === "failed" ? "Try again" : `Send ${row.asset}`}</>}
                          </Button>
                          {st?.state === "failed" && (
                            <Button type="button" size="sm" variant="outline" disabled={running} onClick={() => setStatus((s) => ({ ...s, [row.key]: { state: "skipped" } }))}>
                              Skip
                            </Button>
                          )}
                        </div>
                      )}
                      {st?.state === "skipped" && <p className="mt-1 text-xs text-muted-foreground">Skipped — not included.</p>}
                      {st?.state === "sent" && st.txid && !row.evm && (
                        <a
                          href={explorerTxUrl(st.txid)}
                          target="_blank"
                          rel="noreferrer"
                          className="mt-1 inline-flex items-center gap-1 text-xs text-primary underline"
                        >
                          View transfer <ExternalLink className="h-3 w-3" />
                        </a>
                      )}
                      {!row.evm && st?.state !== "sent" && st?.state !== "skipped" && (
                        <div className="mt-2 flex items-center gap-2">
                          <Button
                            type="button"
                            size="sm"
                            className="flex-1"
                            disabled={running || !root || !unlocked || !to}
                            onClick={() => void sendTsdRow(row)}
                          >
                            {st?.state === "sending" ? <><Loader2 className="animate-spin" /> {tsdProgress ?? "Sending…"}</> : <><Send /> {st?.state === "failed" ? "Try again" : `Send ${row.asset}`}</>}
                          </Button>
                          {st?.state === "failed" && (
                            <Button type="button" size="sm" variant="outline" disabled={running} onClick={() => setStatus((s) => ({ ...s, [row.key]: { state: "skipped" } }))}>
                              Skip
                            </Button>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              <div className="space-y-2 rounded-md border border-border/60 bg-muted/40 p-3 text-sm">
                <Row label="Sent so far" value={`$${fmt(sentTotal, 2)}`} strong />
                <Row label={feeBps === 0 ? "Service fee (merchant)" : "Service fee (1%)"} value={`$${finalQuote.feeUsd.toFixed(2)}`} />
                <Row label="Estimated to your bank" value={`$${finalQuote.settlementUsd.toFixed(2)}`} strong />
              </div>

              {error && <p className="text-sm text-destructive">{error}</p>}

              <Button
                className="w-full"
                disabled={!allResolved || sentRows.length === 0 || running || submitting}
                onClick={() => void placeOrder(true)}
              >
                {submitting ? <><Loader2 className="animate-spin" /> Confirming</> : "Complete cash-out"}
              </Button>
              {!allResolved && (
                <p className="text-center text-xs text-muted-foreground">Send or skip every line to finish.</p>
              )}
            </div>
          )}

          {step === "done" && result && (
            <div className="space-y-4 text-sm">
              <div className="rounded-md border border-border/60 bg-muted/40 p-4 text-center">
                <Check className="mx-auto mb-2 h-7 w-7 text-primary" />
                <p className="font-semibold">Your cash-out is on its way</p>
                <p className="mt-1 font-mono text-xs text-muted-foreground">{result.orderId}</p>
                <p className="mt-2 text-xs text-muted-foreground">
                  ${fmt(sentTotal, 2)} sent from {sentRows.length} {sentRows.length === 1 ? "wallet" : "wallets"} ·
                  {" "}estimated ${finalQuote.settlementUsd.toFixed(2)} to{" "}
                  {vpLink?.bank ? `${vpLink.bank.institution ?? "your bank"} ····${vpLink.bank.mask}` : "your bank"}
                </p>
              </div>
              <p className="flex items-start gap-2 text-xs text-muted-foreground">
                <Landmark className="mt-0.5 h-4 w-4 shrink-0 text-primary" /> VectorPay checks the coins on the
                blockchain, then pays your linked bank — usually 1–3 business days.
              </p>
              {result.checkoutUrl && (
                <Button className="w-full" onClick={() => void openVectorPayCheckout(result.checkoutUrl ?? "")}>
                  View my cash-out status on VectorPay <ExternalLink />
                </Button>
              )}
              <Button asChild variant="outline" className="w-full">
                <Link to="/wallet/order/$id" params={{ id: result.orderId }} onClick={() => setOpen(false)}>
                  View order in BeeKeeper
                </Link>
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}

/**
 * Opens the ordinary send screen for this wallet, prefilled with the cash-out
 * address — the broadcast path stays the same battle-tested code.
 */
function SendLink({ holding, to, onOpen }: { holding: Holding; to: string; onOpen: () => void }) {
  const label = (
    <>
      <Send /> Send {holding.asset}
    </>
  );
  const amount = holding.propertyId ? String(holding.coinAmount) : undefined;

  if (holding.chain === "txc") {
    return (
      <Button asChild size="sm" className="flex-1">
        <Link
          to="/wallet/send"
          search={{ to, ...(amount ? { amount } : {}), ...(holding.propertyId ? { token: String(holding.propertyId) } : {}), cashout: holding.key }}
          onClick={onOpen}
        >
          {label}
        </Link>
      </Button>
    );
  }

  return (
    <Button asChild size="sm" className="flex-1">
      <Link to="/wallet/evm/$chain/send" params={{ chain: holding.chain }} search={{ to, asset: holding.asset }} onClick={onOpen}>
        {label}
      </Link>
    </Button>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className={strong ? "font-semibold" : ""}>{value}</span>
    </div>
  );
}
