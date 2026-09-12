import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo } from "react";
import { ArrowLeft, Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { QrCode } from "@/components/wallet/QrCode";
import { useWallet } from "@/lib/txc/wallet-context";
import { deriveSolanaAccount } from "@/lib/solana/network";
import { useCopyFeedback } from "@/hooks/use-copy-feedback";
import { toast } from "sonner";

export const Route = createFileRoute("/wallet/solana/receive")({
  head: () => ({ meta: [
    { title: "Receive SOL — BeeKeeper Wallet" },
    { name: "description", content: "Receive native SOL into your self-custodial honest.money wallet." },
    { property: "og:title", content: "Receive SOL — BeeKeeper Wallet" },
    { property: "og:description", content: "Receive native SOL into your self-custodial honest.money wallet." },
    { property: "og:type", content: "website" },
    { name: "twitter:card", content: "summary" },
  ] }),
  component: SolanaReceive,
});

function SolanaReceive() {
  const { seed } = useWallet();
  const address = useMemo(() => seed ? deriveSolanaAccount(seed).address : null, [seed]);
  const { copied, copy } = useCopyFeedback();
  return <main className="mx-auto max-w-3xl px-4 py-6">
    <Link to="/wallet" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-4"><ArrowLeft className="h-4 w-4" /> Back</Link>
    <h1 className="text-2xl font-semibold mb-1">Receive SOL</h1>
    <p className="text-sm text-muted-foreground mb-6">on Solana</p>
    <Card><CardContent className="pt-6 flex flex-col items-center gap-4">
      {address && <div className="bg-white p-3 rounded-lg"><QrCode value={address} size={220} /></div>}
      <p className="font-mono text-xs break-all text-center">{address ?? "..."}</p>
      <Button variant={copied ? "default" : "secondary"} onClick={async () => { if (address && await copy(address)) toast.success("Address copied"); }} disabled={!address} aria-live="polite">
        {copied ? <Check className="h-4 w-4 mr-2" /> : <Copy className="h-4 w-4 mr-2" />}{copied ? "Copied!" : "Copy address"}
      </Button>
      <p className="text-xs text-muted-foreground text-center">Only send native SOL on the Solana network to this address.</p>
    </CardContent></Card>
  </main>;
}
