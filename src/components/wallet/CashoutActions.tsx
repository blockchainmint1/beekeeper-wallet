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
import { useQueries, useQuery } from "@tanstack/react-query";
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
} from "lucide-react";
import type { Address } from "viem";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useExchangeFeaturesAllowed } from "@/lib/native/capabilities";
import { getTxcTokenBalancesForAddresses } from "@/lib/txc/tokens.functions";
import { readErc20Balance, tokenAmountFromRaw, USDC_BY_CHAIN, USDT_BY_CHAIN } from "@/lib/chains/erc20";
import { EVM_CHAINS, type StableEvmChainId } from "@/lib/chains/evm";
import { listLinks } from "@/lib/nectar/link";
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

const STABLE_EVM_CHAINS: StableEvmChainId[] = ["eth", "base", "bsc"];

const STABLE_TOKEN_CATALOG: { asset: CashoutAsset; byChain: Record<StableEvmChainId, { symbol: CashoutAsset; address: Address; decimals: number }> }[] = [
  { asset: "USDC", byChain: USDC_BY_CHAIN },
  { asset: "USDT", byChain: USDT_BY_CHAIN },
];

type Step = "intro" | "holdings" | "details" | "review" | "transfers" | "done";
const STEPS: Step[] = ["intro", "holdings", "details", "review", "transfers", "done"];

interface Holding {
  key: string;
  /** Wallet's own chain id. */
  chain: CashoutChain;
  /** Which cash-out deposit address receives it. */
  depositChain: CashoutChain;
  label: string;
  asset: CashoutAsset;
  coinAmount: number;
  usd: number;
  /** Omni property id, for TSD. */
  propertyId?: number;
}

function fmt(value: number, digits = 6) {
  return value.toLocaleString(undefined, { maximumFractionDigits: digits });
}

export function CashoutActions({
  txcAddresses,
  evmAddress,
}: {
  txcAddresses: string[];
  evmAddress: string | null;
}) {
  const allowed = useExchangeFeaturesAllowed();
  const configFn = useServerFn(getVectorPayConfig);
  const startCashout = useServerFn(startVectorPayCashout);
  const fetchTsd = useServerFn(getTxcTokenBalancesForAddresses);
  const config = useQuery({
    queryKey: ["vectorpay-config"],
    queryFn: () => configFn(),
    staleTime: 60_000,
    enabled: allowed,
  });
  const addressKey = txcAddresses.slice().sort().join(",");
  const tsd = useQuery({
    queryKey: ["cashout-tsd", addressKey],
    enabled: allowed && txcAddresses.length > 0,
    queryFn: () => fetchTsd({ data: { addresses: txcAddresses, propertyIds: [39] } }),
    staleTime: 15_000,
  });

  const stableQueries = STABLE_EVM_CHAINS.flatMap((chain) =>
    STABLE_TOKEN_CATALOG.map((entry) => ({
      queryKey: ["cashout-stable", chain, entry.asset, evmAddress],
      enabled: allowed && Boolean(evmAddress),
      queryFn: () => readErc20Balance(chain, entry.byChain[chain], evmAddress as Address),
      staleTime: 15_000,
    })),
  );
  const stableBalances = useQueries({ queries: stableQueries });

  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>("intro");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [accepted, setAccepted] = useState<string[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [sent, setSent] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ orderId: string; checkoutUrl: string | null; detail: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [reference, setReference] = useState("");

  // NectarPay merchants cash out with no service fee.
  const [merchantId, setMerchantId] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setMerchantId(listLinks()[0]?.merchantId ?? null);
  }, [open]);
  const feeBps = merchantId ? MERCHANT_FEE_BPS : ORDER_FEE_BPS;

  const destinations = config.data?.destinations ?? { txc: null, base: null, eth: null, bsc: null, tron: null };

  /** Everything the merchant holds that a cash-out deposit address can accept. */
  const cashable = useMemo<Holding[]>(() => {
    const list: Holding[] = [];

    const tsdAmount = Number(BigInt(tsd.data?.[39] ?? "0")) / 1e8;
    if (tsdAmount > 0 && destinations.txc) {
      list.push({
        key: "t:tsd",
        chain: "txc",
        depositChain: "txc",
        label: "TSD on TEXITcoin",
        asset: "TSD",
        coinAmount: tsdAmount,
        usd: tsdAmount,
        propertyId: 39,
      });
    }

    let idx = 0;
    for (const chain of STABLE_EVM_CHAINS) {
      for (const entry of STABLE_TOKEN_CATALOG) {
        const raw = stableBalances[idx]?.data ?? 0n;
        idx++;
        if (raw <= 0n) continue;
        const amt = Number(tokenAmountFromRaw(raw, entry.byChain[chain].decimals));
        if (amt <= 0 || !destinations[chain]) continue;
        list.push({
          key: `e:${chain}:${entry.asset}`,
          chain,
          depositChain: chain,
          label: `${entry.asset} on ${EVM_CHAINS[chain].name}`,
          asset: entry.asset,
          coinAmount: amt,
          usd: amt,
        });
      }
    }

    list.sort((a, b) => b.usd - a.usd);
    return list;
  }, [tsd.data, stableBalances, destinations]);

  const chosen = useMemo(() => cashable.filter((row) => selected.includes(row.key)), [cashable, selected]);
  const chosenTotal = chosen.reduce((sum, row) => sum + row.usd, 0);
  const sentRows = chosen.filter((row) => sent.includes(row.key));
  const sentTotal = sentRows.reduce((sum, row) => sum + row.usd, 0);

  const quote = quoteCashout(chosenTotal, feeBps);
  const finalQuote = quoteCashout(Math.min(sentTotal, ORDER_MAX_USD), feeBps);
  const allAccepted = accepted.length === CASHOUT_DISCLOSURES.length;
  const detailsValid =
    /^[\p{L}\p{M}.' -]{2,120}$/u.test(name.trim()) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const totalError =
    chosenTotal < ORDER_MIN_USD
      ? `Select at least $${ORDER_MIN_USD} to cash out.`
      : chosenTotal > ORDER_MAX_USD
        ? `Orders top out at $${ORDER_MAX_USD}. Uncheck a wallet or two.`
        : null;

  // Default to everything that can be cashed out — merchants usually sweep the lot.
  useEffect(() => {
    if (step !== "holdings" || cashable.length === 0) return;
    setSelected((current) => (current.length > 0 ? current : cashable.map((row) => row.key)));
  }, [step, cashable]);

  if (!allowed) return null;

  function reset() {
    setStep("intro");
    setName("");
    setEmail("");
    setAccepted([]);
    setSelected([]);
    setSent([]);
    setError(null);
    setResult(null);
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    const suffix = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
    setReference(`BK-${Date.now().toString(36).toUpperCase()}-${suffix}`);
  }

  async function placeOrder() {
    if (!detailsValid || !allAccepted || sentRows.length === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      const response = await startCashout({
        data: {
          reference,
          usd: Math.round(Math.min(sentTotal, ORDER_MAX_USD) * 100) / 100,
          name: name.trim(),
          email: email.trim().toLowerCase(),
          acceptedDisclaimers: accepted,
          ...(merchantId ? { merchantId } : {}),
          transfers: sentRows.map((row) => ({
            chain: row.depositChain,
            asset: row.asset,
            usd: Math.round(row.usd * 100) / 100,
          })),
        },
      });
      saveLocalVectorPayOrder({
        id: response.orderId,
        side: "sell",
        createdAt: Date.now(),
        status: response.registered ? "ready" : "registration_failed",
        usd: finalQuote.usd,
        feeUsd: response.feeUsd,
        settlementUsd: finalQuote.settlementUsd,
        assetAmount: finalQuote.assetAmount,
        asset: response.asset ?? "TSD",
        chain: response.chain ?? "txc",
        checkoutUrl: response.handoffUrl,
        detail: response.detail,
        transfers: response.transfers,
      });
      setResult({ orderId: response.orderId, checkoutUrl: response.handoffUrl, detail: response.detail });
      setStep("done");
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
        <Button size="lg" onClick={() => { reset(); setOpen(true); }} disabled={!config.data?.configured}>
          <ArrowUpFromLine /> Cash out
        </Button>
      </div>
      {!config.isLoading && !config.data?.configured && (
        <p className="mt-2 text-center text-xs text-muted-foreground">Cash out is being connected to VectorPay.</p>
      )}

      <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (!next) reset(); }}>
        <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-md">
          <DialogHeader>
            <p className="text-xs font-semibold uppercase text-primary">
              Cash out · {STEPS.indexOf(step) + 1} of {STEPS.length}
            </p>
            <DialogTitle>{step === "done" ? "Link your bank and get paid" : "Cash out to your bank"}</DialogTitle>
            <DialogDescription>Turn your USDC, USDT and TSD into dollars in your bank account.</DialogDescription>
          </DialogHeader>

          {step === "intro" && (
            <div className="space-y-4 text-sm text-muted-foreground">
              <p>
                First BeeKeeper adds up the stablecoins you hold and you approve a transfer out of each wallet. Then
                VectorPay verifies your identity, links your bank and sends the dollars.
              </p>
              <div className="rounded-md border border-border/60 bg-muted/40 p-3">
                <p className="font-medium text-foreground">
                  {merchantId ? "No service fee · 1–3 business days" : "1% service fee · 1–3 business days"}
                </p>
                <p className="mt-1">
                  {merchantId
                    ? "NectarPay merchants cash out free. Any amount up to $1,000 per order."
                    : "Any amount up to $1,000 per order. NectarPay merchants pay no fee."}
                </p>
              </div>
              <Button className="w-full" onClick={() => setStep("holdings")}>Get started</Button>
            </div>
          )}

          {step === "holdings" && (
            <div className="space-y-4">
              <div>
                <p className="text-sm font-medium">What you can cash out</p>
                <p className="text-xs text-muted-foreground">
                  Only USDC, USDT and TSD can be cashed out. Everything is selected by default.
                </p>
              </div>

              {(tsd.isLoading || stableBalances.some((q) => q.isLoading)) && (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> Checking your wallets…
                </p>
              )}

              {cashable.length === 0 && !tsd.isLoading && !stableBalances.some((q) => q.isLoading) && (
                <p className="text-sm text-destructive">No USDC, USDT or TSD balances to cash out yet.</p>
              )}

              <div className="space-y-2">
                {cashable.map((row) => {
                  const checked = selected.includes(row.key);
                  return (
                    <label
                      key={row.key}
                      className="flex items-start gap-3 rounded-md border border-border/60 bg-muted/30 p-3"
                    >
                      <Checkbox
                        className="mt-0.5"
                        checked={checked}
                        onCheckedChange={(next) =>
                          setSelected((current) =>
                            next ? [...current, row.key] : current.filter((value) => value !== row.key),
                          )
                        }
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center justify-between gap-2 text-sm font-medium">
                          <span className="flex items-center gap-1.5">
                            <Wallet className="h-3.5 w-3.5 text-primary" /> {row.label}
                          </span>
                          <span>${fmt(row.usd, 2)}</span>
                        </span>
                        <span className="mt-0.5 block text-xs text-muted-foreground">
                          {fmt(row.coinAmount)} {row.asset}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>

              <div className="space-y-2 rounded-md border border-border/60 bg-muted/40 p-3 text-sm">
                <Row label="Total to cash out" value={`$${fmt(chosenTotal, 2)}`} strong />
                <Row label={feeBps === 0 ? "Service fee (merchant)" : "Service fee (1%)"} value={`$${quote.feeUsd.toFixed(2)}`} />
                <Row label="Estimated to your bank" value={`$${quote.settlementUsd.toFixed(2)}`} strong />
              </div>

              {totalError && <p className="text-sm text-destructive">{totalError}</p>}

              <div className="flex gap-2">
                <Button variant="outline" onClick={() => setStep("intro")}>Back</Button>
                <Button className="flex-1" disabled={Boolean(totalError)} onClick={() => setStep("details")}>
                  Continue
                </Button>
              </div>
            </div>
          )}

          {step === "details" && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="cashout-name">Full legal name</Label>
                <Input id="cashout-name" autoComplete="name" maxLength={120} value={name} onChange={(event) => setName(event.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="cashout-email">Email</Label>
                <Input id="cashout-email" type="email" autoComplete="email" maxLength={200} value={email} onChange={(event) => setEmail(event.target.value)} />
              </div>
              <p className="text-xs text-muted-foreground">
                VectorPay emails you the bank-linking step and uses these details to match your order. BeeKeeper does
                not store them in your order history.
              </p>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => setStep("holdings")}>Back</Button>
                <Button className="flex-1" disabled={!detailsValid} onClick={() => setStep("review")}>Review</Button>
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
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => setStep("details")}>Back</Button>
                <Button className="flex-1" disabled={!allAccepted} onClick={() => setStep("transfers")}>
                  Start transfers
                </Button>
              </div>
            </div>
          )}

          {step === "transfers" && (
            <div className="space-y-4">
              <div>
                <p className="text-sm font-medium">Send each wallet</p>
                <p className="text-xs text-muted-foreground">
                  Approve them one at a time. Each opens the normal send screen with the cash-out address already
                  filled in. Tick one off once it's broadcast.
                </p>
              </div>

              <div className="space-y-2">
                {chosen.map((row) => {
                  const done = sent.includes(row.key);
                  const to = destinations[row.depositChain] ?? "";
                  return (
                    <div key={row.key} className="rounded-md border border-border/60 bg-muted/30 p-3">
                      <div className="flex items-center justify-between gap-2 text-sm font-medium">
                        <span className="flex items-center gap-1.5">
                          {done ? <Check className="h-3.5 w-3.5 text-primary" /> : <Wallet className="h-3.5 w-3.5 text-primary" />}
                          {row.label}
                        </span>
                        <span>{fmt(row.coinAmount)} {row.asset}</span>
                      </div>
                      <div className="mt-2 flex items-center gap-2">
                        {to ? (
                          <SendLink holding={row} to={to} onOpen={() => setOpen(false)} />
                        ) : (
                          <span className="text-xs text-destructive">Cash-out address unavailable.</span>
                        )}
                        <Button
                          type="button"
                          size="sm"
                          variant={done ? "default" : "outline"}
                          onClick={() =>
                            setSent((current) =>
                              done ? current.filter((value) => value !== row.key) : [...current, row.key],
                            )
                          }
                        >
                          {done ? "Sent" : "Mark sent"}
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="space-y-2 rounded-md border border-border/60 bg-muted/40 p-3 text-sm">
                <Row label="Sent so far" value={`$${fmt(sentTotal, 2)}`} strong />
                <Row label={feeBps === 0 ? "Service fee (merchant)" : "Service fee (1%)"} value={`$${finalQuote.feeUsd.toFixed(2)}`} />
                <Row label="Estimated to your bank" value={`$${finalQuote.settlementUsd.toFixed(2)}`} strong />
              </div>
              <p className="text-xs text-muted-foreground">
                If one transfer fails, keep going — the order is created for what actually went out.
              </p>

              {error && <p className="text-sm text-destructive">{error}</p>}

              <div className="flex gap-2">
                <Button variant="outline" onClick={() => setStep("review")}>Back</Button>
                <Button className="flex-1" disabled={sentRows.length === 0 || submitting} onClick={() => void placeOrder()}>
                  {submitting ? <><Loader2 className="animate-spin" /> Creating order</> : "Finish and get my link"}
                </Button>
              </div>
            </div>
          )}

          {step === "done" && result && (
            <div className="space-y-4 text-sm">
              <div className="rounded-md border border-border/60 bg-muted/40 p-4 text-center">
                <Check className="mx-auto mb-2 h-7 w-7 text-primary" />
                <p className="font-semibold">{result.detail}</p>
                <p className="mt-1 font-mono text-xs text-muted-foreground">{result.orderId}</p>
                <p className="mt-2 text-xs text-muted-foreground">
                  ${fmt(sentTotal, 2)} sent from {sentRows.length} {sentRows.length === 1 ? "wallet" : "wallets"} ·
                  {" "}estimated ${finalQuote.settlementUsd.toFixed(2)} to your bank
                </p>
              </div>
              <p className="flex items-start gap-2 text-xs text-muted-foreground">
                <Landmark className="mt-0.5 h-4 w-4 shrink-0 text-primary" /> Next, VectorPay verifies your identity and
                links your bank account, by email or on their secure pages. BeeKeeper never sees your bank login.
              </p>
              {result.checkoutUrl ? (
                <Button className="w-full" onClick={() => void openVectorPayCheckout(result.checkoutUrl ?? "")}>
                  Link my bank at VectorPay <ExternalLink />
                </Button>
              ) : (
                <p className="text-destructive">Keep your reference and try again later.</p>
              )}
              <Button asChild variant="outline" className="w-full">
                <Link to="/wallet/order/$id" params={{ id: result.orderId }} onClick={() => setOpen(false)}>
                  View order
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
          search={{ to, ...(amount ? { amount } : {}), ...(holding.propertyId ? { token: String(holding.propertyId) } : {}) }}
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
