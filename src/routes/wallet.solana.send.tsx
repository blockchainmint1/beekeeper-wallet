import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Loader2, Send as SendIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { QrScanButton } from "@/components/wallet/QrScanButton";
import { AddressBookButton } from "@/components/wallet/AddressBookButton";
import { useWallet } from "@/lib/txc/wallet-context";
import { deriveSolanaAccount, formatSol, isValidSolanaAddress, solToLamports, explorerTxUrl, SOLANA_FEE_RESERVE_LAMPORTS } from "@/lib/solana/network";
import { getSolBalance, sendSol } from "@/lib/solana/api";

export const Route = createFileRoute("/wallet/solana/send")({
  head: () => ({ meta: [
    { title: "Send SOL — BeeKeeper Wallet" },
    { name: "description", content: "Send native SOL from your self-custodial BeeKeeper wallet." },
    { property: "og:title", content: "Send SOL — BeeKeeper Wallet" },
    { property: "og:description", content: "Send native SOL from your self-custodial BeeKeeper wallet." },
    { property: "og:type", content: "website" },
    { name: "twitter:card", content: "summary" },
  ] }),
  component: SolanaSend,
});

function SolanaSend() {
  const { seed } = useWallet();
  const navigate = useNavigate();
  const account = useMemo(() => seed ? deriveSolanaAccount(seed) : null, [seed]);
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [sending, setSending] = useState(false);
  const [signature, setSignature] = useState<string | null>(null);
  const balance = useQuery({
    queryKey: ["solana-balance", account?.address],
    enabled: !!account,
    queryFn: () => {
      if (!account) throw new Error("Wallet is locked");
      return getSolBalance(account.address);
    },
  });
  const validTo = isValidSolanaAddress(to);
  let lamports = 0n;
  try { lamports = solToLamports(amount); } catch { lamports = 0n; }
  const overBalance = lamports + BigInt(SOLANA_FEE_RESERVE_LAMPORTS) > BigInt(balance.data ?? 0);
  const hasAmount = lamports > 0n;

  async function submit() {
    if (!account || !validTo || !hasAmount || overBalance || sending) return;
    setSending(true);
    try {
      const tx = await sendSol(account, to, lamports);
      setSignature(tx);
      toast.success(`Sent ${amount} SOL`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Send failed");
    } finally { setSending(false); }
  }

  if (signature) return <main className="mx-auto max-w-3xl px-4 py-6"><h1 className="text-2xl font-semibold mb-4">Sent</h1><Card><CardContent className="pt-6 space-y-3"><p className="text-sm">{amount} SOL was sent on Solana.</p><p className="font-mono text-xs break-all">{signature}</p><div className="flex gap-2"><Button asChild variant="secondary" className="flex-1"><a href={explorerTxUrl(signature)} target="_blank" rel="noreferrer">View on Solscan</a></Button><Button className="flex-1" onClick={() => navigate({ to: "/wallet" })}>Done</Button></div></CardContent></Card></main>;

  return <main className="mx-auto max-w-3xl px-4 py-6">
    <Link to="/wallet" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-4"><ArrowLeft className="h-4 w-4" /> Back</Link>
    <h1 className="text-2xl font-semibold mb-6">Send SOL</h1>
    <Card><CardContent className="pt-6 space-y-4">
      <p className="text-sm text-muted-foreground">Available: {balance.data == null ? "…" : `${formatSol(balance.data)} SOL`}</p>
      <div className="space-y-2"><Label htmlFor="solana-to">Recipient address</Label><div className="flex gap-2"><Input id="solana-to" value={to} onChange={(e) => setTo(e.target.value.trim())} placeholder="Solana address" className="font-mono text-sm" autoCapitalize="none" autoCorrect="off" spellCheck={false} /><QrScanButton onScan={(raw) => setTo(raw.trim())} /><AddressBookButton chain="solana" onPick={setTo} /></div>{to && !validTo && <p className="text-xs text-destructive">That isn&apos;t a valid Solana address.</p>}</div>
      <div className="space-y-2"><Label htmlFor="solana-amount">Amount</Label><Input id="solana-amount" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} inputMode="decimal" placeholder="0.00" />{overBalance && <p className="text-xs text-destructive">More than your balance, before network fee.</p>}</div>
      <p className="text-xs text-muted-foreground">Keep a little SOL in this wallet for the network fee.</p>
      <Button className="w-full" size="lg" disabled={!account || !validTo || !hasAmount || overBalance || sending} onClick={submit}>{sending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <SendIcon className="h-4 w-4 mr-2" />}Send SOL</Button>
    </CardContent></Card>
  </main>;
}
