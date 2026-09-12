/**
 * Tron receive — shows the derived T… address as text + QR.
 */
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo } from "react";
import { ArrowLeft, Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { QrCode } from "@/components/wallet/QrCode";
import { useWallet } from "@/lib/txc/wallet-context";
import { deriveTronAccount } from "@/lib/tron/address";
import { useCopyFeedback } from "@/hooks/use-copy-feedback";
import { toast } from "sonner";

export const Route = createFileRoute("/wallet/tron/receive")({
  head: () => ({
    meta: [
      { title: "Receive TRX & USDT — BeeKeeper Wallet" },
      {
        name: "description",
        content: "Show your Tron address to receive TRX or USDT-TRC20 into your wallet.",
      },
      { property: "og:title", content: "Receive TRX & USDT — BeeKeeper Wallet" },
      {
        property: "og:description",
        content: "Show your Tron address to receive TRX or USDT-TRC20 into your wallet.",
      },
    ],
  }),
  component: TronReceive,
});

function TronReceive() {
  const { root } = useWallet();
  const address = useMemo(() => (root ? deriveTronAccount(root).address : null), [root]);
  const { copied, copy } = useCopyFeedback();

  return (
    <main className="mx-auto max-w-3xl px-4 py-6">
      <Link
        to="/wallet"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-4"
      >
        <ArrowLeft className="h-4 w-4" /> Back
      </Link>
      <h1 className="text-2xl font-semibold mb-1">Receive on Tron</h1>
      <p className="text-sm text-muted-foreground mb-6">TRX and TRC-20 tokens (USDT, USDC)</p>

      <Card>
        <CardContent className="pt-6 flex flex-col items-center gap-4">
          {address && (
            <div className="bg-white p-3 rounded-lg">
              <QrCode value={address} size={220} />
            </div>
          )}
          <p className="font-mono text-xs break-all text-center">{address ?? "..."}</p>
          <Button
            variant={copied ? "default" : "secondary"}
            onClick={async () => {
              if (!address) return;
              const ok = await copy(address);
              if (ok) toast.success("Address copied");
            }}
            disabled={!address}
            aria-live="polite"
          >
            {copied ? (
              <Check className="h-4 w-4 mr-2" />
            ) : (
              <Copy className="h-4 w-4 mr-2" />
            )}
            {copied ? "Copied!" : "Copy address"}
          </Button>
          <p className="text-xs text-muted-foreground text-center">
            Only send assets on the <strong>Tron (TRC-20)</strong> network to this address.
            USDT sent on Ethereum or BNB Chain will not arrive here.
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
