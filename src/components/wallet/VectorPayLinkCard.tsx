/**
 * Link this wallet to a VectorPay account. The customer copies or scans the
 * one-time code from their VectorPay dashboard; redeeming it binds this
 * wallet's private customer ID to that account, so cash-out orders skip the
 * identity step and pay out to their saved bank.
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useWallet } from "@/lib/txc/wallet-context";
import { cashoutCustomerId } from "@/lib/cashout/roundup";
import { recordEcosystemLink } from "@/lib/ecosystem-links";
import { setVectorPayLink } from "@/lib/vectorpay-link";
import { redeemVectorPayLink } from "@/lib/vectorpay-link.functions";

export function VectorPayLinkCard({
  initialCode,
  embedded,
  onDone,
}: {
  initialCode: string;
  embedded?: boolean;
  onDone?: () => void;
}) {
  const { unlocked, root } = useWallet();
  const seedless = !unlocked || unlocked.mode === "keyonly" || !root;
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onLink() {
    if (!root) return;
    setBusy(true);
    setError(null);
    try {
      const accountRef = await cashoutCustomerId(root);
      const reply = await redeemVectorPayLink({ data: { code: initialCode, accountRef } });
      if (!reply.ok || !reply.linked) {
        setError(reply.detail);
        return;
      }
      setVectorPayLink({ firstName: reply.firstName, bank: reply.bank });
      recordEcosystemLink({
        id: "vectorpay",
        app: "VectorPay",
        detail: reply.bank
          ? `${reply.bank.institution ?? "Bank"} ····${reply.bank.mask}`
          : "Cash out to your bank",
      });
      setDone(true);
      onDone?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not link VectorPay.");
    } finally {
      setBusy(false);
    }
  }

  if (seedless) {
    return (
      <p className="text-sm text-muted-foreground">
        VectorPay linking needs a seed-based wallet. Key-only wallets can&apos;t link yet.
      </p>
    );
  }

  return (
    <div className="space-y-3 rounded-md border border-border/60 p-3">
      {!embedded && <p className="text-sm font-medium">Link VectorPay</p>}
      <p className="text-xs text-muted-foreground">
        Link this wallet to your VectorPay account with code{" "}
        <span className="font-mono font-medium text-foreground">{initialCode}</span>. Only your
        wallet&apos;s private customer ID is shared — never your seed or keys. Cash-outs then pay out
        to your saved VectorPay bank automatically.
      </p>
      <Button onClick={onLink} disabled={busy || done} size="sm">
        {done ? "Linked" : busy ? "Linking…" : "Link VectorPay"}
      </Button>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {done && (
        <p className="text-sm text-emerald-500">
          Linked. Cash-outs from this wallet now go to your VectorPay account.
        </p>
      )}
    </div>
  );
}
