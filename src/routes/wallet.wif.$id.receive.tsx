import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo } from "react";
import { QrCode } from "@/components/wallet/QrCode";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Check, Copy, Share2 } from "lucide-react";
import { toast } from "sonner";
import { shareText } from "@/lib/native/ui";
import { copyToClipboard } from "@/lib/clipboard";
import { useCopyFeedback } from "@/hooks/use-copy-feedback";
import { getWifWallet } from "@/lib/wif/store";

export const Route = createFileRoute("/wallet/wif/$id/receive")({
  head: () => ({ meta: [{ title: "Receive — BeeKeeper Wallet" }] }),
  component: WifReceivePage,
});

function WifReceivePage() {
  const { id } = Route.useParams();
  const entry = useMemo(() => getWifWallet(id), [id]);

  if (!entry) {
    return (
      <main className="mx-auto max-w-xl px-4 py-10">
        <p className="text-sm text-muted-foreground">Wallet not found.</p>
        <Link className="underline text-sm" to="/wallet">← Back</Link>
      </main>
    );
  }

  const uriScheme = entry.chain === "txc" ? "texitcoin" : "iskandercoin";
  const address = entry.address;
  const chainLabel = entry.chain.toUpperCase();
  const { copied, copy } = useCopyFeedback();

  return (
    <main className="mx-auto max-w-xl px-4 py-8">
      <Link to="/wallet" className="text-sm text-muted-foreground hover:text-foreground">
        ← Back
      </Link>
      <h1 className="mt-3 text-2xl font-bold">Receive {chainLabel}</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Imported single-key wallet. All payments to this address are yours.
      </p>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>{entry.label}</CardTitle>
          <CardDescription>
            {entry.kind === "bip84"
              ? "Native SegWit"
              : entry.kind === "bip49"
                ? "Wrapped SegWit"
                : "Legacy"}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col items-center gap-4">
          <QrCode value={`${uriScheme}:${address}`} size={240} />
          <code className="font-mono text-sm text-center break-all px-2">{address}</code>
          <div className="flex flex-col sm:flex-row gap-2 w-full sm:w-auto">
            <Button
              variant={copied ? "default" : "secondary"}
              onClick={async () => {
                const ok = await copy(address);
                if (ok) toast.success("Address copied");
                else toast.error("Could not copy.");
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
            <Button
              variant="secondary"
              onClick={async () => {
                const ok = await shareText({
                  title: `My ${chainLabel} address`,
                  text: address,
                  dialogTitle: `Share ${chainLabel} address`,
                });
                if (!ok) {
                  const copied = await copyToClipboard(address);
                  if (copied) toast.success("Address copied");
                }
              }}
            >
              <Share2 className="h-4 w-4 mr-2" /> Share
            </Button>
          </div>
        </CardContent>
      </Card>
    </main>
  );
}
