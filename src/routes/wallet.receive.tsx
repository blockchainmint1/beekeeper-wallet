import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { z } from "zod";
import { useWallet } from "@/lib/txc/wallet-context";
import { scanAccount } from "@/lib/txc/scan";
import { deriveAddress } from "@/lib/txc/wallet";
import { DERIVATION_PATHS } from "@/lib/txc/network";
import { getOmniDepositAddress } from "@/lib/txc/tokens";
import { QrCode } from "@/components/wallet/QrCode";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Check, Copy, Plus, Share2 } from "lucide-react";
import { toast } from "sonner";
import { shareText } from "@/lib/native/ui";
import { copyToClipboard } from "@/lib/clipboard";
import { useCopyFeedback } from "@/hooks/use-copy-feedback";
import {
  getDisplayIndex,
  getRotationPolicy,
  resolveDisplayIndex,
  setDisplayIndex,
} from "@/lib/address-prefs";

const searchSchema = z.object({ asset: z.enum(["txc", "tsd"]).optional() });

export const Route = createFileRoute("/wallet/receive")({
  validateSearch: (s) => searchSchema.parse(s),
  head: () => ({ meta: [{ title: "Receive — BeeKeeper Wallet" }] }),
  component: ReceivePage,
});

function ReceivePage() {
  const { root, unlocked, setKind } = useWallet();
  const { asset } = Route.useSearch();

  // Receiving is deliberately pinned to the standards-correct legacy branch.
  // Imported wallets may still remember the old app's m/44'/0'/0' branch as
  // their primary kind; following that metadata here would keep handing out
  // fresh *old-path* addresses after a migration. Every historical branch is
  // still scanned and spendable, but all new deposits and future change should
  // start from m/44'/696969'/0'.
  const receiveKind = "bip44" as const;

  // TXC receiving rotates addresses for privacy. Omni tokens (TSD, POP, …)
  // don't: a token balance stays on whichever address received it, and a token
  // send must come from a single address — so token deposits are pinned to one
  // canonical address to keep the balance pooled and spendable in one send.
  const [mode, setMode] = useState<"txc" | "tsd">(asset === "tsd" ? "tsd" : "txc");
  const omniDeposit = useMemo(() => (root ? getOmniDepositAddress(root) : null), [root]);

  const accountId = useMemo(
    () => (root ? root.neutered().toBase58().slice(0, 24) : ""),
    [root],
  );

  const account = useQuery({
    queryKey: ["account", receiveKind, accountId],
    enabled: !!root && !!unlocked && !!accountId && mode === "txc",
    queryFn: () => scanAccount(root!, receiveKind),
    staleTime: 30_000,
  });

  useEffect(() => {
    if (unlocked && unlocked.kind !== receiveKind) setKind(receiveKind);
  }, [unlocked, setKind]);

  // `manualBump` lets the "New address" button advance past the on-chain
  // firstUnusedIndex without waiting for a payment to come in.
  const [manualBump, setManualBump] = useState(0);

  // One canonical T… address works for both native TXC and Omni tokens.
  const activeKind = receiveKind;
  const { copied, copy } = useCopyFeedback();

  const firstUnused = account.data?.nextReceiveIndex ?? 0;

  const shown = useMemo(() => {
    if (!root || !unlocked || !accountId) return null;
    const policy = getRotationPolicy();
    const stored = getDisplayIndex(accountId, activeKind);
    const base = resolveDisplayIndex(policy, stored, firstUnused);
    const idx = Math.max(base, manualBump);
    // Persist advances so a reload doesn't rewind the displayed address.
    if (idx !== stored) setDisplayIndex(accountId, activeKind, idx);
    const derived = deriveAddress(root, activeKind, 0, idx);
    return { index: idx, address: derived.address, path: derived.path };
  }, [root, unlocked, accountId, firstUnused, manualBump, activeKind]);

  // Reset any manual bump if the account changes underneath us.
  useEffect(() => {
    setManualBump(0);
  }, [accountId]);

  const address = shown?.address ?? "";
  const tsdAddress = omniDeposit?.address ?? "";

  async function onCopy(value: string) {
    const ok = await copy(value);
    if (ok) toast.success("Address copied");
    else toast.error("Could not copy. Long-press the address to select it.");
  }

  async function onShare(value: string, title: string) {
    const ok = await shareText({ title, text: value, dialogTitle: title });
    if (!ok) {
      const copiedAddr = await copyToClipboard(value);
      if (copiedAddr) toast.success("Address copied");
    }
  }

  return (
    <main className="mx-auto max-w-xl px-4 py-8">
      <Link to="/wallet" className="text-sm text-muted-foreground hover:text-foreground">
        ← Back
      </Link>
      <h1 className="mt-3 text-2xl font-bold">
        Receive {mode === "tsd" ? "TSD" : "TXC"}
      </h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Share this address with the sender. Old addresses always keep working — anything sent to
        them still lands in your wallet.
      </p>

      <div className="mt-4 inline-flex rounded-lg border border-border/60 bg-muted/40 p-0.5 text-sm">
        {(
          [
            { id: "txc", label: "TXC" },
            { id: "tsd", label: "TSD (token)" },
          ] as const
        ).map((opt) => (
          <button
            key={opt.id}
            type="button"
            onClick={() => setMode(opt.id)}
            className={`rounded-md px-3 py-1.5 transition-colors ${
              mode === opt.id
                ? "bg-background font-medium shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle>
            {mode === "tsd" ? "Your TSD deposit address" : "Your deposit address"}
          </CardTitle>
          <CardDescription>{unlocked?.label}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col items-center gap-4">
          {mode === "tsd" ? (
            !omniDeposit ? (
              <div className="w-60 h-60 rounded-lg bg-muted animate-pulse" />
            ) : (
              <>
                <QrCode value={`texitcoin:${tsdAddress}`} size={240} />
                <code className="font-mono text-sm text-center break-all px-2">{tsdAddress}</code>
                <div className="text-xs text-muted-foreground text-center">
                  Pinned token address · <span className="font-mono">{omniDeposit.path}</span>
                </div>
                <div className="text-xs text-muted-foreground text-center px-2">
                  Omni tokens stay on the address they were sent to, and a token send must come
                  from a single address — so TSD deposits always use this one address to keep your
                  balance pooled and spendable in a single send. TSD sent to any of your other
                  addresses is still found and counted automatically.
                </div>
                <div className="flex flex-col sm:flex-row gap-2 w-full sm:w-auto">
                  <Button
                    variant={copied ? "default" : "secondary"}
                    onClick={() => onCopy(tsdAddress)}
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
                    onClick={() => onShare(tsdAddress, "My TSD deposit address")}
                  >
                    <Share2 className="h-4 w-4 mr-2" /> Share
                  </Button>
                </div>
              </>
            )
          ) : account.isLoading || !shown ? (
            <div className="w-60 h-60 rounded-lg bg-muted animate-pulse" />
          ) : address ? (
            <>
              <QrCode value={`texitcoin:${address}`} size={240} />
              <code className="font-mono text-sm text-center break-all px-2">{address}</code>
              <div className="text-xs text-muted-foreground text-center">
                Address #{shown.index} · <span className="font-mono">{shown.path}</span>
              </div>
              <div className="text-xs text-muted-foreground text-center px-2">
                Receiving TSD or another Omni token? Use the pinned{" "}
                <button
                  type="button"
                  onClick={() => setMode("tsd")}
                  className="underline underline-offset-4 hover:text-foreground"
                >
                  TSD deposit address
                </button>{" "}
                instead — this rotating address is best for plain TXC.
              </div>


              <div className="flex flex-col sm:flex-row gap-2 w-full sm:w-auto">
                <Button
                  variant={copied ? "default" : "secondary"}
                  onClick={() => onCopy(address)}
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
                  onClick={() => onShare(address, "My TXC address")}
                >
                  <Share2 className="h-4 w-4 mr-2" /> Share
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    // Advance past current display and past the on-chain frontier.
                    setManualBump(Math.max(shown.index + 1, firstUnused));
                    toast.success("Fresh address generated");
                  }}
                >
                  <Plus className="h-4 w-4 mr-2" /> New
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground text-center max-w-xs">
                Rotation policy is in Settings. All addresses under{" "}
                <span className="font-mono">{DERIVATION_PATHS[activeKind]}/0/i</span> belong to
                this wallet.
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
