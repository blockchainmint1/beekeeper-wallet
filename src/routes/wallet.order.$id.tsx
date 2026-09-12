import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ArrowLeft, ExternalLink, Landmark } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ExchangeUnavailable } from "@/components/wallet/ExchangeUnavailable";
import { useExchangeFeaturesAllowed } from "@/lib/native/capabilities";
import { getLocalVectorPayOrder, openVectorPayCheckout, type LocalVectorPayOrder } from "@/lib/vectorpay";

export const Route = createFileRoute("/wallet/order/$id")({
  head: () => ({ meta: [
    { title: "Cash-out order — BeeKeeper Wallet" },
    { name: "description", content: "Review a BeeKeeper cash-out handoff to VectorPay." },
    { property: "og:title", content: "Cash-out order — BeeKeeper Wallet" },
    { property: "og:description", content: "Review a BeeKeeper cash-out handoff to VectorPay." },
    { property: "og:type", content: "website" },
    { name: "twitter:card", content: "summary" },
  ] }),
  component: CashoutOrderRoute,
});

function CashoutOrderRoute() {
  const allowed = useExchangeFeaturesAllowed();
  const { id } = Route.useParams();
  const [order, setOrder] = useState<LocalVectorPayOrder | null | undefined>(undefined);
  useEffect(() => setOrder(getLocalVectorPayOrder(id)), [id]);
  if (!allowed) return <ExchangeUnavailable title="Cash out" />;
  if (order === undefined) return null;

  return <main className="mx-auto w-full max-w-xl px-4 py-6">
    <Link to="/dashboard" className="mb-5 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" /> Dashboard</Link>
    <h1 className="text-2xl font-semibold">Cash-out order</h1>
    <p className="mt-1 text-sm text-muted-foreground">VectorPay handles bank verification and settlement.</p>
    {!order ? <Card className="mt-6"><CardContent className="space-y-4 pt-6"><p className="font-medium">This order is not stored on this device.</p><p className="text-sm text-muted-foreground">You may have returned in another browser. Use the order reference from VectorPay for support.</p><Button asChild className="w-full"><Link to="/dashboard">Back to dashboard</Link></Button></CardContent></Card>
      : <Card className="mt-6"><CardContent className="space-y-5 pt-6">
        <div className="flex items-center gap-3"><div className="grid h-10 w-10 place-items-center rounded-md bg-primary/15 text-primary"><Landmark /></div><div><p className="font-semibold">{order.asset} on {order.chain === "txc" ? "TEXITcoin" : "Base"}</p><p className="font-mono text-xs text-muted-foreground">{order.id}</p></div></div>
        <div className="space-y-2 border-y border-border/60 py-4 text-sm"><Row label="You sell" value={`${order.assetAmount.toFixed(2)} ${order.asset}`} /><Row label="Service fee" value={`$${order.feeUsd.toFixed(2)}`} /><Row label="Estimated bank payout" value={`$${order.settlementUsd.toFixed(2)}`} strong /></div>
        <p className="text-sm text-muted-foreground">{order.detail} Settlement usually takes 1–3 business days after funds clear.</p>
        {order.checkoutUrl && <Button className="w-full" onClick={() => void openVectorPayCheckout(order.checkoutUrl ?? "")}>Continue at VectorPay <ExternalLink /></Button>}
        <Button asChild variant="outline" className="w-full"><Link to="/dashboard">Back to dashboard</Link></Button>
      </CardContent></Card>}
  </main>;
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return <div className="flex justify-between gap-4"><span className="text-muted-foreground">{label}</span><span className={strong ? "font-semibold" : ""}>{value}</span></div>;
}
