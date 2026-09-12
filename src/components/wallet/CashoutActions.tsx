import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowDownToLine, ArrowUpFromLine, Check, ExternalLink, Loader2 } from "lucide-react";
import type { Address } from "viem";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useExchangeFeaturesAllowed } from "@/lib/native/capabilities";
import { getTxcTokenBalancesForAddresses } from "@/lib/txc/tokens.functions";
import { readErc20Balance, tokenAmountFromRaw, USDC_BY_CHAIN } from "@/lib/chains/erc20";
import {
  CASHOUT_ASSETS,
  CASHOUT_DISCLOSURES,
  ORDER_MAX_USD,
  ORDER_MIN_USD,
  quoteCashout,
  saveLocalVectorPayOrder,
  type CashoutAsset,
} from "@/lib/vectorpay";
import { getVectorPayConfig, startVectorPayCashout } from "@/lib/vectorpay.functions";

const QUICK_AMOUNTS = [50, 100, 250, 1000];

type Step = "intro" | "amount" | "details" | "review" | "handoff";

export function CashoutActions({ txcAddresses, evmAddress }: { txcAddresses: string[]; evmAddress: string | null }) {
  const allowed = useExchangeFeaturesAllowed();
  const configFn = useServerFn(getVectorPayConfig);
  const startCashout = useServerFn(startVectorPayCashout);
  const fetchTsd = useServerFn(getTxcTokenBalancesForAddresses);
  const config = useQuery({ queryKey: ["vectorpay-config"], queryFn: () => configFn(), staleTime: 60_000, enabled: allowed });
  const tsd = useQuery({
    queryKey: ["cashout-tsd", txcAddresses.slice().sort().join(",")],
    enabled: allowed && txcAddresses.length > 0,
    queryFn: () => fetchTsd({ data: { addresses: txcAddresses, propertyIds: [39] } }),
    staleTime: 15_000,
  });
  const usdc = useQuery({
    queryKey: ["cashout-usdc-base", evmAddress],
    enabled: allowed && Boolean(evmAddress),
    queryFn: () => readErc20Balance("base", USDC_BY_CHAIN.base, evmAddress as Address),
    staleTime: 15_000,
  });
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>("intro");
  const [asset, setAsset] = useState<CashoutAsset>("TSD");
  const [amount, setAmount] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [accepted, setAccepted] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ orderId: string; checkoutUrl: string | null; detail: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const available = asset === "TSD"
    ? Number(BigInt(tsd.data?.[39] ?? "0")) / 1e8
    : Number(tokenAmountFromRaw(usdc.data ?? 0n, USDC_BY_CHAIN.base.decimals));
  const numeric = Number(amount);
  const quote = quoteCashout(Number.isFinite(numeric) ? numeric : 0);
  const allAccepted = accepted.length === CASHOUT_DISCLOSURES.length;
  const detailsValid = name.trim().length >= 2 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const amountError = useMemo(() => {
    if (!Number.isFinite(numeric) || numeric < ORDER_MIN_USD) return `Minimum cash out is $${ORDER_MIN_USD}.`;
    if (numeric > ORDER_MAX_USD) return `Maximum cash out is $${ORDER_MAX_USD}.`;
    if (numeric > available) return `Available balance is ${available.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${asset}.`;
    return null;
  }, [numeric, available, asset]);

  if (!allowed) return null;

  function reset() {
    setStep("intro"); setAmount(""); setName(""); setEmail(""); setAccepted([]); setError(null); setResult(null);
  }

  async function placeOrder() {
    if (amountError || !detailsValid || !allAccepted) return;
    setSubmitting(true); setError(null);
    try {
      const chain = asset === "TSD" ? "txc" : "base";
      const response = await startCashout({ data: {
        usd: numeric,
        asset,
        chain,
        name: name.trim(),
        email: email.trim().toLowerCase(),
        acceptedDisclaimers: accepted,
      } });
      saveLocalVectorPayOrder({
        id: response.orderId,
        side: "sell",
        createdAt: Date.now(),
        status: response.registered ? "ready" : "registration_failed",
        usd: quote.usd,
        feeUsd: response.feeUsd,
        settlementUsd: quote.settlementUsd,
        assetAmount: quote.assetAmount,
        asset,
        chain,
        checkoutUrl: response.handoffUrl,
        detail: response.detail,
      });
      setResult({ orderId: response.orderId, checkoutUrl: response.handoffUrl, detail: response.detail });
      setStep("handoff");
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
            <p className="text-xs font-semibold uppercase text-primary">Cash out · {step === "intro" ? "1" : step === "amount" ? "2" : step === "details" ? "3" : step === "review" ? "4" : "5"} of 5</p>
            <DialogTitle>{step === "handoff" ? "Continue at VectorPay" : "Cash out to your bank"}</DialogTitle>
            <DialogDescription>Sell TSD or Base USDC through VectorPay.</DialogDescription>
          </DialogHeader>

          {step === "intro" && <div className="space-y-4 text-sm text-muted-foreground">
            <p>VectorPay handles identity checks, bank linking, pricing, and settlement. BeeKeeper never sees your bank credentials.</p>
            <div className="rounded-md border border-border/60 bg-muted/40 p-3">
              <p className="font-medium text-foreground">1% service fee · 1–3 business days</p>
              <p className="mt-1">Orders are available from $25 to $1,000.</p>
            </div>
            <Button className="w-full" onClick={() => setStep("amount")}>Get started</Button>
          </div>}

          {step === "amount" && <div className="space-y-4">
            <div className="space-y-2"><Label htmlFor="cashout-asset">Asset</Label>
              <Select value={asset} onValueChange={(value) => setAsset(value as CashoutAsset)}>
                <SelectTrigger id="cashout-asset"><SelectValue /></SelectTrigger>
                <SelectContent>{CASHOUT_ASSETS.map((row) => <SelectItem key={row.asset} value={row.asset}>{row.label}</SelectItem>)}</SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">Available: {available.toLocaleString(undefined, { maximumFractionDigits: 6 })} {asset}</p>
            </div>
            <div className="space-y-2"><Label htmlFor="cashout-amount">Amount</Label>
              <Input id="cashout-amount" type="number" inputMode="decimal" min={ORDER_MIN_USD} max={ORDER_MAX_USD} step="0.01" value={amount} onChange={(event) => setAmount(event.target.value.slice(0, 12))} placeholder="100.00" />
              <div className="grid grid-cols-4 gap-2">{QUICK_AMOUNTS.map((value) => <Button key={value} type="button" size="sm" variant="outline" onClick={() => setAmount(String(value))}>${value}</Button>)}</div>
            </div>
            {numeric > 0 && <QuoteRows amount={quote.usd} fee={quote.feeUsd} payout={quote.settlementUsd} asset={asset} />}
            {amount && amountError && <p className="text-sm text-destructive">{amountError}</p>}
            <div className="flex gap-2"><Button variant="outline" onClick={() => setStep("intro")}>Back</Button><Button className="flex-1" disabled={Boolean(amountError)} onClick={() => setStep("details")}>Continue</Button></div>
          </div>}

          {step === "details" && <div className="space-y-4">
            <div className="space-y-2"><Label htmlFor="cashout-name">Full legal name</Label><Input id="cashout-name" autoComplete="name" maxLength={120} value={name} onChange={(event) => setName(event.target.value)} /></div>
            <div className="space-y-2"><Label htmlFor="cashout-email">Email</Label><Input id="cashout-email" type="email" autoComplete="email" maxLength={200} value={email} onChange={(event) => setEmail(event.target.value)} /></div>
            <p className="text-xs text-muted-foreground">VectorPay uses these details to match your order. BeeKeeper does not store them in your order history.</p>
            <div className="flex gap-2"><Button variant="outline" onClick={() => setStep("amount")}>Back</Button><Button className="flex-1" disabled={!detailsValid} onClick={() => setStep("review")}>Review</Button></div>
          </div>}

          {step === "review" && <div className="space-y-4">
            <QuoteRows amount={quote.usd} fee={quote.feeUsd} payout={quote.settlementUsd} asset={asset} />
            <div className="space-y-3">{CASHOUT_DISCLOSURES.map((item) => <label key={item.id} className="flex items-start gap-3 text-xs leading-relaxed text-muted-foreground">
              <Checkbox checked={accepted.includes(item.id)} onCheckedChange={(checked) => setAccepted((current) => checked ? [...current, item.id] : current.filter((id) => id !== item.id))} />
              <span>{item.text}{item.id === "terms" && <> <Link to="/legal/terms" target="_blank" className="text-primary underline">Terms</Link> · <Link to="/legal/privacy" target="_blank" className="text-primary underline">Privacy</Link></>}</span>
            </label>)}</div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <div className="flex gap-2"><Button variant="outline" onClick={() => setStep("details")}>Back</Button><Button className="flex-1" disabled={!allAccepted || submitting} onClick={() => void placeOrder()}>{submitting ? <><Loader2 className="animate-spin" /> Creating order</> : "Place order"}</Button></div>
          </div>}

          {step === "handoff" && result && <div className="space-y-4 text-sm">
            <div className="rounded-md border border-border/60 bg-muted/40 p-4 text-center"><Check className="mx-auto mb-2 h-7 w-7 text-primary" /><p className="font-semibold">{result.detail}</p><p className="mt-1 font-mono text-xs text-muted-foreground">{result.orderId}</p></div>
            {result.checkoutUrl ? <Button asChild className="w-full"><a href={result.checkoutUrl} rel="noopener noreferrer">Continue at VectorPay <ExternalLink /></a></Button> : <p className="text-destructive">Keep your reference and try again later.</p>}
            <Button asChild variant="outline" className="w-full"><Link to="/wallet/order/$id" params={{ id: result.orderId }} onClick={() => setOpen(false)}>View order</Link></Button>
          </div>}
        </DialogContent>
      </Dialog>
    </section>
  );
}

function QuoteRows({ amount, fee, payout, asset }: { amount: number; fee: number; payout: number; asset: CashoutAsset }) {
  return <div className="space-y-2 rounded-md border border-border/60 bg-muted/40 p-3 text-sm">
    <Row label="You sell" value={`${amount.toFixed(2)} ${asset}`} />
    <Row label="Service fee (1%)" value={`$${fee.toFixed(2)}`} />
    <Row label="Estimated to your bank" value={`$${payout.toFixed(2)}`} strong />
  </div>;
}
function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return <div className="flex items-center justify-between gap-3"><span className="text-muted-foreground">{label}</span><span className={strong ? "font-semibold" : ""}>{value}</span></div>;
}
