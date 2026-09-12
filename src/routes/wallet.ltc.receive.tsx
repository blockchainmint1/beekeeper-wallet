import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useWallet } from "@/lib/txc/wallet-context";
import { scanLtcAccount } from "@/lib/ltc/scan";
import { deriveAddress } from "@/lib/ltc/wallet";
import { LTC_DERIVATION_PATHS, LTC_DEFAULT_KIND } from "@/lib/ltc/network";
import { QrCode } from "@/components/wallet/QrCode";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Check, Copy, Plus, Share2 } from "lucide-react";
import { toast } from "sonner";
import { shareText } from "@/lib/native/ui";
import { copyToClipboard } from "@/lib/clipboard";
import { useCopyFeedback } from "@/hooks/use-copy-feedback";

export const Route = createFileRoute("/wallet/ltc/receive")({
  head: () => ({ meta: [{ title: "Receive LTC — BeeKeeper Wallet" }] }),
  component: ReceiveLtcPage,
});

function ReceiveLtcPage() {
  const { root, unlocked } = useWallet();
  const accountId = useMemo(
    () => (root ? root.neutered().toBase58().slice(0, 24) : ""),
    [root],
  );
  const account = useQuery({
    queryKey: ["ltc-account", LTC_DEFAULT_KIND, accountId],
    enabled: !!root && !!unlocked && !!accountId,
    queryFn: () => scanLtcAccount(root!, LTC_DEFAULT_KIND),
    staleTime: 30_000,
  });

  const [manualBump, setManualBump] = useState(0);
  const { copied, copy } = useCopyFeedback();
  const firstUnused = account.data?.nextReceiveIndex ?? 0;

  const shown = useMemo(() => {
    if (!root || !unlocked) return null;
    const idx = Math.max(firstUnused, manualBump);
    const derived = deriveAddress(root, LTC_DEFAULT_KIND, 0, idx);
    return { index: idx, address: derived.address, path: derived.path };
  }, [root, unlocked, firstUnused, manualBump]);

  const address = shown?.address ?? "";

  return (
    <main className="mx-auto max-w-xl px-4 py-8">
      <Link to="/wallet" className="text-sm text-muted-foreground hover:text-foreground">← Back</Link>
      <h1 className="mt-3 text-2xl font-bold">Receive LTC</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Share this address with the sender. Old addresses always keep working.
      </p>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Your deposit address</CardTitle>
          <CardDescription>{unlocked?.label}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col items-center gap-4">
          {account.isLoading || !shown ? (
            <div className="w-60 h-60 rounded-lg bg-muted animate-pulse" />
          ) : address ? (
            <>
              <QrCode value={`litecoin:${address}`} size={240} />
              <code className="font-mono text-sm text-center break-all px-2">{address}</code>
              <div className="text-xs text-muted-foreground text-center">
                Address #{shown.index} · <span className="font-mono">{shown.path}</span>
              </div>
              <div className="flex flex-col sm:flex-row gap-2 w-full sm:w-auto">
                <Button
                  variant={copied ? "default" : "secondary"}
                  onClick={async () => {
                    const ok = await copy(address);
                    if (ok) toast.success("Address copied");
                    else toast.error("Could not copy. Long-press the address to select it.");
                  }}
                  aria-live="polite"
                >
                  {copied ? (
                    <Check className="h-4 w-4 mr-2" />
                  ) : (
                    <Copy className="h-4 w-4 mr-2" />
                  )}
                  {copied ? "Copied!" : "Copy"}
                </Button>
                <Button variant="secondary" onClick={async () => {
                  const ok = await shareText({ title: "My LTC address", text: address, dialogTitle: "Share LTC address" });
                  if (!ok) { const c = await copyToClipboard(address); if (c) toast.success("Address copied"); }
                }}>
                  <Share2 className="h-4 w-4 mr-2" /> Share
                </Button>
                <Button variant="outline" onClick={() => {
                  setManualBump(Math.max(shown.index + 1, firstUnused));
                  toast.success("Fresh address generated");
                }}>
                  <Plus className="h-4 w-4 mr-2" /> New
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground text-center max-w-xs">
                All addresses under{" "}
                <span className="font-mono">{LTC_DERIVATION_PATHS[LTC_DEFAULT_KIND]}/0/i</span>{" "}
                belong to this wallet.
              </p>
            </>
          ) : (
            <p className="text-sm text-destructive">Couldn't load an address. Try again.</p>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
