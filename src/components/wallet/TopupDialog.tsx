/**
 * Top up with Bridge (bridge.xyz): each customer gets a permanent US bank
 * account in their name. Dollars sent there by ACH or wire are converted and
 * delivered to this wallet — as TSD once the TSD bridge's mint address is
 * connected; in test mode, as USDC on the wallet's Base address.
 *
 *   new        → name + email (passed to Bridge, never stored) → start ID check
 *   verifying  → Bridge's terms + ID pages, then "check again"
 *   ready      → bank details to send to, fee, and the deposit history
 */
import { useCallback, useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Check, Copy, ExternalLink, Landmark, Loader2, RefreshCw, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useWallet } from "@/lib/txc/wallet-context";
import { copyToClipboard } from "@/lib/clipboard";
import { EVM_CHAINS } from "@/lib/chains/evm";
import { BRIDGE_MIN_NET_USD, TOPUP_FEE_PERCENT } from "@/lib/bridge/fees";
import { signTopup } from "@/lib/bridge/sign";
import type { TopupLine } from "@/lib/bridge/history";
import {
  simulateTopupApproval,
  simulateTopupDeposit,
  startTopupKyc,
  topupHistory,
  topupStatus,
  type TopupStatus,
} from "@/lib/bridge/topup.functions";

const STATE_LABEL: Record<TopupLine["state"], string> = {
  received: "Received",
  in_review: "Being checked",
  converting: "Converting",
  delivered: "Delivered",
  refunded: "Refunded",
};

function CopyRow({ label, value }: { label: string; value: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border py-2 last:border-0">
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="break-all font-mono text-sm text-foreground">{value}</p>
      </div>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        aria-label={`Copy ${label}`}
        onClick={async () => {
          if (await copyToClipboard(value, { autoClearMs: 120_000 })) {
            setDone(true);
            setTimeout(() => setDone(false), 1500);
          } else toast.error("Couldn't copy");
        }}
      >
        {done ? <Check /> : <Copy />}
      </Button>
    </div>
  );
}

export function TopupDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { root } = useWallet();
  const statusFn = useServerFn(topupStatus);
  const startFn = useServerFn(startTopupKyc);
  const historyFn = useServerFn(topupHistory);
  const approveFn = useServerFn(simulateTopupApproval);
  const depositFn = useServerFn(simulateTopupDeposit);

  const [status, setStatus] = useState<TopupStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lines, setLines] = useState<TopupLine[]>([]);
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [kind, setKind] = useState<"individual" | "business">("individual");

  const refresh = useCallback(async () => {
    if (!root) return;
    setLoading(true);
    setError(null);
    try {
      const s = await statusFn({ data: signTopup(root, "status") });
      setStatus(s);
      if (!s.ok && s.detail) setError(s.detail);
      if (s.stage === "ready") {
        const h = await historyFn({ data: signTopup(root, "history") });
        if (h.ok) setLines(h.lines);
      }
    } catch {
      setError("Couldn't reach the top-up service — try again.");
    } finally {
      setLoading(false);
    }
  }, [root, statusFn, historyFn]);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  async function onStart(e: React.FormEvent) {
    e.preventDefault();
    if (!root) return;
    setBusy(true);
    setError(null);
    try {
      const s = await startFn({ data: { ...signTopup(root, "start"), fullName, email, type: kind } });
      setStatus(s);
      if (!s.ok) setError(s.detail);
      else {
        setFullName("");
        setEmail("");
      }
    } catch {
      setError("Check your name and email, then try again.");
    } finally {
      setBusy(false);
    }
  }

  async function onApproveTest() {
    if (!root) return;
    setBusy(true);
    try {
      setStatus(await approveFn({ data: signTopup(root, "simulate-approval") }));
    } finally {
      setBusy(false);
    }
  }

  async function onDepositTest() {
    if (!root) return;
    setBusy(true);
    try {
      const r = await depositFn({ data: { ...signTopup(root, "simulate-deposit"), amount: 50 } });
      if (!r.ok) {
        toast.error(r.detail);
        return;
      }
      toast.success("Test deposit of $50 sent");
      for (let i = 0; i < 4; i++) {
        await new Promise((res) => setTimeout(res, 3000));
        const h = await historyFn({ data: signTopup(root, "history") });
        if (h.ok) setLines(h.lines);
      }
    } finally {
      setBusy(false);
    }
  }

  const sandbox = status?.sandbox ?? true;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <p className="text-xs font-semibold uppercase text-primary">Top up{sandbox ? " · test mode" : ""}</p>
          <DialogTitle>Add dollars from your bank</DialogTitle>
          <DialogDescription>
            Send dollars from your bank to your own BeeKeeper deposit account. They arrive in this wallet as TSD.
          </DialogDescription>
        </DialogHeader>

        {sandbox && status?.configured !== false && (
          <p className="rounded-md border border-dashed border-primary/40 bg-primary/5 p-2 text-xs text-muted-foreground">
            Test mode — no real money moves. Test top-ups land as USDC on your Base address; real top-ups will arrive as TSD.
          </p>
        )}

        {loading && !status && (
          <p className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Checking your deposit account…
          </p>
        )}

        {status?.configured === false && <p className="py-4 text-center text-sm text-muted-foreground">Top-ups aren't switched on yet.</p>}

        {status?.configured !== false && status?.stage === "new" && (
          <form className="space-y-4" onSubmit={onStart}>
            <div className="space-y-1 text-sm text-muted-foreground">
              <p className="font-medium text-foreground">Get your personal deposit account</p>
              <p>
                Our partner Bridge gives you a US bank account and routing number in your name. Bridge checks your ID once, then
                you can top up any time.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {(["individual", "business"] as const).map((k) => (
                <Button key={k} type="button" variant={kind === k ? "default" : "outline"} onClick={() => setKind(k)}>
                  {k === "individual" ? "Me personally" : "My business"}
                </Button>
              ))}
            </div>
            <div className="space-y-2">
              <Label htmlFor="topup-name">{kind === "business" ? "Business legal name" : "Full legal name"}</Label>
              <Input id="topup-name" value={fullName} onChange={(e) => setFullName(e.target.value)} autoComplete="name" required minLength={2} maxLength={120} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="topup-email">Email</Label>
              <Input id="topup-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required maxLength={200} />
            </div>
            <p className="flex gap-2 text-xs text-muted-foreground">
              <ShieldCheck className="h-4 w-4 shrink-0 text-primary" />
              BeeKeeper passes your name and email to Bridge to start their ID check. We don't keep them.
            </p>
            <Button type="submit" size="lg" className="w-full" disabled={busy || fullName.trim().length < 2 || !email.includes("@")}>
              {busy ? <Loader2 className="animate-spin" /> : <ShieldCheck />} Start ID check
            </Button>
          </form>
        )}

        {status?.stage === "verifying" && (
          <div className="space-y-3 text-sm">
            <p className="text-muted-foreground">{status.detail}</p>
            <ol className="space-y-2">
              <li className="flex items-center justify-between gap-2 rounded-md border border-border p-3">
                <span>1. Accept Bridge's terms</span>
                {status.tosStatus === "approved" ? (
                  <Check className="h-4 w-4 text-primary" aria-label="Done" />
                ) : status.tosUrl ? (
                  <Button asChild size="sm" variant="outline">
                    <a href={status.tosUrl} target="_blank" rel="noopener noreferrer">
                      Open <ExternalLink />
                    </a>
                  </Button>
                ) : null}
              </li>
              <li className="flex items-center justify-between gap-2 rounded-md border border-border p-3">
                <span>2. Verify your ID</span>
                {status.kycStatus === "approved" ? (
                  <Check className="h-4 w-4 text-primary" aria-label="Done" />
                ) : status.kycUrl ? (
                  <Button asChild size="sm" variant="outline">
                    <a href={status.kycUrl} target="_blank" rel="noopener noreferrer">
                      Open <ExternalLink />
                    </a>
                  </Button>
                ) : null}
              </li>
            </ol>
            <Button className="w-full" variant="secondary" onClick={() => void refresh()} disabled={loading}>
              {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />} I'm done — check again
            </Button>
            {sandbox && status.kycStatus !== "approved" && (
              <Button className="w-full" variant="outline" onClick={() => void onApproveTest()} disabled={busy}>
                {busy ? <Loader2 className="animate-spin" /> : <Check />} Approve me (test)
              </Button>
            )}
          </div>
        )}

        {status?.stage === "blocked" && (
          <p className="text-sm text-destructive">Bridge couldn't approve your ID check, so top-ups aren't available for this wallet.</p>
        )}

        {status?.stage === "ready" && (
          <div className="space-y-4 text-sm">
            {status.deposit ? (
              <div className="rounded-lg border border-primary/30 bg-primary/5 p-3">
                <p className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase text-primary">
                  <Landmark className="h-4 w-4" /> Your BeeKeeper deposit account
                </p>
                <CopyRow label="Bank" value={status.deposit.bankName} />
                <CopyRow label="Routing number" value={status.deposit.routingNumber} />
                <CopyRow label="Account number" value={status.deposit.accountNumber} />
                {status.deposit.beneficiaryName && <CopyRow label="Name on account" value={status.deposit.beneficiaryName} />}
                {status.deposit.bankAddress && <CopyRow label="Bank address" value={status.deposit.bankAddress} />}
              </div>
            ) : (
              <p className="text-muted-foreground">{status.detail}</p>
            )}
            <div className="space-y-1 text-xs text-muted-foreground">
              <p>
                Send dollars from your bank by {status.deposit?.rails.includes("wire") ? "ACH or wire" : "ACH"}. Save it as a payee
                and top up any time — this account number is yours to keep.
              </p>
              <p>
                {TOPUP_FEE_PERCENT}% top-up fee, taken by Bridge before conversion (a $100 deposit arrives as ${(100 - TOPUP_FEE_PERCENT).toFixed(2)}).
                Deposits under about ${(BRIDGE_MIN_NET_USD / (1 - TOPUP_FEE_PERCENT / 100)).toFixed(2)} are too small to deliver.
              </p>
            </div>

            <div>
              <div className="mb-2 flex items-center justify-between">
                <p className="font-medium">Your top-ups</p>
                <Button size="sm" variant="ghost" onClick={() => void refresh()} disabled={loading} aria-label="Refresh top-ups">
                  {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                </Button>
              </div>
              {lines.length === 0 ? (
                <p className="text-xs text-muted-foreground">No top-ups yet.</p>
              ) : (
                <ul className="space-y-2">
                  {lines.map((l) => (
                    <li key={l.depositId} className="flex items-center justify-between gap-2 rounded-md border border-border p-2">
                      <div>
                        <p className="font-medium">${l.amountUsd.toFixed(2)} → ${l.netUsd.toFixed(2)}</p>
                        <p className="text-xs text-muted-foreground">
                          {l.createdAt ? new Date(l.createdAt).toLocaleString() : ""} · fee ${l.feeUsd.toFixed(2)}
                        </p>
                      </div>
                      <div className="text-right text-xs">
                        <p className={l.state === "delivered" ? "font-semibold text-primary" : "text-muted-foreground"}>{STATE_LABEL[l.state]}</p>
                        {l.txHash && /^0x[0-9a-fA-F]{64}$/.test(l.txHash) && (
                          <a className="inline-flex items-center gap-1 underline" href={EVM_CHAINS.base.explorerTx(l.txHash)} target="_blank" rel="noopener noreferrer">
                            View <ExternalLink className="h-3 w-3" />
                          </a>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {sandbox && status.deposit && (
              <Button className="w-full" variant="outline" onClick={() => void onDepositTest()} disabled={busy}>
                {busy ? <Loader2 className="animate-spin" /> : <Landmark />} Simulate a $50 deposit (test)
              </Button>
            )}
          </div>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}
      </DialogContent>
    </Dialog>
  );
}
