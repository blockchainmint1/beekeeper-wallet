/**
 * Tron → EVM stablecoin bridge.
 *
 * Quotes come from Relay Protocol (server-side), the resulting Tron
 * contract calls are signed on this device with the wallet's Tron key, and
 * we poll Relay until the stablecoin lands on the destination chain.
 *
 * Untron was the original plan, but it publishes no hosted API — its
 * backend is reference code each liquidity provider self-hosts. Relay is a
 * public intents API with native Tron support and comparable pricing.
 */
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowLeft, ArrowRight, Loader2, RefreshCw, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useWallet } from "@/lib/txc/wallet-context";
import { deriveTronAccount } from "@/lib/tron/address";
import { explorerTxUrl } from "@/lib/tron/network";
import { formatTokenAmount, formatTrx, parseTokenAmount } from "@/lib/tron/units";
import {
  getAccountResources,
  getTrc20Allowance,
  getTrc20Balance,
  getTrxBalance,
  sendRawContractCall,
  waitForTronTx,
} from "@/lib/tron/api";
import { setTronTxLabel } from "@/lib/tron/tx-labels";
import { deriveEvmAccount, EVM_CHAINS } from "@/lib/chains/evm";
import {
  BRIDGE_DESTINATIONS,
  BRIDGE_SOURCES,
  formatUnitsStr,
  type BridgeQuote,
} from "@/lib/bridge/relay";
import { getBridgeQuote, getBridgeStatus } from "@/lib/bridge/relay.functions";
import { hapticError, hapticSuccess } from "@/lib/native/ui";
import { useExchangeFeaturesAllowed } from "@/lib/native/capabilities";
import { ExchangeUnavailable } from "@/components/wallet/ExchangeUnavailable";

export const Route = createFileRoute("/wallet/tron/bridge")({
  head: () => ({
    meta: [
      { title: "Bridge Tron USDT to Base, Ethereum & BNB — BeeKeeper Wallet" },
      {
        name: "description",
        content:
          "Move USDT or USDC off Tron to USDC on Base, Ethereum or BNB Chain. Non-custodial, signed on your device.",
      },
      { property: "og:title", content: "Bridge Tron USDT to Base, Ethereum & BNB — BeeKeeper Wallet" },
      {
        property: "og:description",
        content:
          "Move USDT or USDC off Tron to stablecoins on Base, Ethereum or BNB Chain from your self-custodial wallet.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: TronBridgeGate,
});

/** Pull the spender out of an `approve(address,uint256)` calldata blob. */
function approveSpender(data: string): string | null {
  const hex = data.startsWith("0x") ? data.slice(2) : data;
  if (!hex.startsWith("095ea7b3") || hex.length < 8 + 64) return null;
  return `41${hex.slice(8 + 24, 8 + 64)}`;
}

function TronBridgeGate() {
  const exchangeAllowed = useExchangeFeaturesAllowed();
  if (!exchangeAllowed) return <ExchangeUnavailable title="Bridge" />;
  return <TronBridge />;
}

function TronBridge() {
  const { root } = useWallet();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const fetchQuote = useServerFn(getBridgeQuote);
  const fetchStatus = useServerFn(getBridgeStatus);

  const tron = useMemo(() => (root ? deriveTronAccount(root) : null), [root]);
  const evm = useMemo(() => (root ? deriveEvmAccount(root) : null), [root]);

  const [sourceSymbol, setSourceSymbol] = useState(BRIDGE_SOURCES[0]!.symbol);
  const [destId, setDestId] = useState(BRIDGE_DESTINATIONS[0]!.id);
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [originTxid, setOriginTxid] = useState<string | null>(null);

  const source = BRIDGE_SOURCES.find((s) => s.symbol === sourceSymbol)!;
  const dest = BRIDGE_DESTINATIONS.find((d) => d.id === destId)!;

  const balance = useQuery({
    queryKey: ["tron-trc20", source.contract, tron?.address],
    enabled: !!tron,
    queryFn: () => getTrc20Balance(source, tron!.address),
  });
  const trx = useQuery({
    queryKey: ["tron-balance", tron?.address],
    enabled: !!tron,
    queryFn: () => getTrxBalance(tron!.address),
  });
  const resources = useQuery({
    queryKey: ["tron-resources", tron?.address],
    enabled: !!tron,
    queryFn: () => getAccountResources(tron!.address),
    staleTime: 60_000,
  });

  const raw = parseTokenAmount(amount, source.decimals);
  const overBalance = raw > (balance.data ?? 0n);
  const hasAmount = raw > 0n;

  const quote = useQuery<BridgeQuote>({
    queryKey: ["tron-bridge-quote", tron?.address, source.contract, dest.id, raw.toString()],
    enabled: !!tron && !!evm && hasAmount && !overBalance && !requestId,
    queryFn: () =>
      fetchQuote({
        data: {
          fromAddress: tron!.address,
          fromContract: source.contract,
          toChainId: dest.chainId,
          toCurrency: dest.address,
          amount: raw.toString(),
          recipient: evm!.address,
        },
      }),
    staleTime: 20_000,
    retry: 0,
  });

  const status = useQuery({
    queryKey: ["tron-bridge-status", requestId],
    enabled: !!requestId,
    queryFn: () => fetchStatus({ data: { requestId: requestId! } }),
    refetchInterval: (q) =>
      q.state.data?.status === "success" || q.state.data?.status === "failure" ? false : 5000,
  });

  useEffect(() => {
    if (status.data?.status === "success") {
      hapticSuccess();
      void qc.invalidateQueries({ queryKey: ["tron-trc20", source.contract, tron?.address] });
    }
  }, [status.data?.status, qc, source.contract, tron?.address]);

  const needsEnergy = (resources.data?.energyAvailable ?? 0) < 130_000;
  const lowTrx = needsEnergy && (trx.data ?? 0) < 40_000_000;

  async function run() {
    const q = quote.data;
    if (!tron || !q) return;
    try {
      // Defense in depth: never sign an identical Relay contract call twice,
      // even if a stale/native client receives a malformed duplicate quote.
      const sentCalls = new Set<string>();
      for (const step of q.steps) {
        const callKey = `${step.contractHex.toLowerCase()}:${step.data.toLowerCase()}:${step.callValue}`;
        if (sentCalls.has(callKey)) continue;
        sentCalls.add(callKey);
        if (step.id === "approve") {
          const spender = approveSpender(step.data);
          if (spender) {
            const allowance = await getTrc20Allowance(source.contract, tron.address, spender);
            if (allowance >= raw) continue;
          }
          setBusy("Approving the bridge to move your tokens…");
        } else {
          setBusy("Depositing to the bridge…");
        }
        const txid = await sendRawContractCall(
          tron.privateKey,
          tron.address,
          step.contractHex,
          step.data,
          { feeLimitSun: 150_000_000, callValue: step.callValue },
        );
        setTronTxLabel(txid, step.id === "approve" ? "bridge-approval" : "bridge-deposit");
        setBusy("Waiting for Tron to confirm…");
        await waitForTronTx(txid);
        if (step.id !== "approve") setOriginTxid(txid);
      }
      setRequestId(q.requestId);
      toast.success("Deposit confirmed — waiting for the other side.");
    } catch (err) {
      hapticError();
      toast.error(err instanceof Error ? err.message : "Bridge failed");
    } finally {
      setBusy(null);
    }
  }

  // ---- Tracking view -------------------------------------------------
  if (requestId) {
    const s = status.data?.status ?? "pending";
    const done = s === "success";
    const failed = s === "failure" || s === "refund";
    const destTx = status.data?.destinationTxHash;
    const destMeta = EVM_CHAINS[dest.chainKey];
    return (
      <main className="mx-auto max-w-3xl px-4 py-6">
        <h1 className="text-2xl font-semibold mb-1">
          {done ? "Bridge complete" : failed ? "Bridge problem" : "Bridging…"}
        </h1>
        <p className="text-sm text-muted-foreground mb-4">
          {source.symbol} on Tron → {dest.label}
        </p>
        <Card>
          <CardContent className="pt-6 space-y-3 text-sm">
            {!done && !failed && (
              <p className="inline-flex items-center gap-2 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Usually lands in under a minute.
              </p>
            )}
            {failed && (
              <p className="text-destructive">
                {status.data?.details ??
                  "The bridge reported a problem. If your deposit confirmed, the relayer will refund it."}
              </p>
            )}
            {done && <p>Your {dest.symbol} has arrived on {destMeta.name}.</p>}
            {originTxid && (
              <a
                className="block underline break-all text-xs"
                href={explorerTxUrl(originTxid)}
                target="_blank"
                rel="noreferrer"
              >
                Tron deposit transaction
              </a>
            )}
            {destTx && (
              <a
                className="block underline break-all text-xs"
                href={destMeta.explorerTx(destTx)}
                target="_blank"
                rel="noreferrer"
              >
                Arrival on {destMeta.name}
              </a>
            )}
            <Button className="w-full" size="lg" onClick={() => navigate({ to: "/wallet" })}>
              Back to wallet
            </Button>
          </CardContent>
        </Card>
      </main>
    );
  }

  // ---- Quote / form view ---------------------------------------------
  return (
    <main className="mx-auto max-w-3xl px-4 py-6">
      <Link
        to="/wallet"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-4"
      >
        <ArrowLeft className="h-4 w-4" /> Back
      </Link>
      <h1 className="text-2xl font-semibold mb-1">Bridge off Tron</h1>
      <p className="text-sm text-muted-foreground mb-6">
        Move Tron stablecoins to Base, Ethereum or BNB Chain — signed on this device.
      </p>

      <Card>
        <CardContent className="pt-6 space-y-4">
          <div className="space-y-2">
            <Label>From (Tron)</Label>
            <div className="grid grid-cols-[1fr_auto] gap-2">
              <Input
                value={amount}
                onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
                inputMode="decimal"
                placeholder="0.00"
              />
              <Select value={sourceSymbol} onValueChange={setSourceSymbol}>
                <SelectTrigger className="w-28">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {BRIDGE_SOURCES.map((s) => (
                    <SelectItem key={s.symbol} value={s.symbol}>
                      {s.symbol}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <button
              type="button"
              className="text-xs text-muted-foreground underline"
              onClick={() =>
                balance.data != null &&
                setAmount(formatTokenAmount(balance.data, source.decimals, source.decimals))
              }
            >
              Available: {formatTokenAmount(balance.data ?? 0n, source.decimals, 2)}{" "}
              {source.symbol}
            </button>
            {overBalance && <p className="text-xs text-destructive">More than your balance.</p>}
          </div>

          <div className="space-y-2">
            <Label>To</Label>
            <Select value={destId} onValueChange={setDestId}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {BRIDGE_DESTINATIONS.map((d) => (
                  <SelectItem key={d.id} value={d.id}>
                    {d.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground break-all">
              Arrives in your own wallet: {evm?.address ?? "unlock to see"}
            </p>
          </div>

          {quote.isFetching && (
            <p className="inline-flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" /> Getting a quote…
            </p>
          )}
          {quote.error && (
            <p className="text-xs text-destructive">{(quote.error as Error).message}</p>
          )}

          {quote.data && (
            <div className="rounded-lg border border-border/60 bg-card/40 px-3 py-2 text-xs text-muted-foreground space-y-1">
              <div className="flex justify-between">
                <span>You receive</span>
                <span className="text-foreground font-medium">
                  {formatUnitsStr(quote.data.amountOut, dest.decimals, 4)} {dest.symbol}
                </span>
              </div>
              <div className="flex justify-between">
                <span>Bridge fee</span>
                <span className="text-foreground">
                  {formatUnitsStr(quote.data.relayerFee, source.decimals, 4)} {source.symbol}
                </span>
              </div>
              <div className="flex justify-between">
                <span>Tron network fee (est.)</span>
                <span className="text-foreground">
                  {formatTrx(Number(quote.data.tronGasSun))}
                </span>
              </div>
              {quote.data.etaSeconds != null && (
                <div className="flex justify-between">
                  <span>Estimated time</span>
                  <span className="text-foreground">~{quote.data.etaSeconds}s</span>
                </div>
              )}
              <button
                type="button"
                onClick={() => void quote.refetch()}
                className="mt-1 inline-flex items-center gap-1 underline hover:text-foreground"
              >
                <RefreshCw className="h-3 w-3" /> Refresh quote
              </button>
            </div>
          )}

          {lowTrx && (
            <p className="text-xs text-amber-500">
              You may not have enough TRX for Tron's energy fee. Keep about 40 TRX in this
              wallet. Current balance: {formatTrx(trx.data ?? 0)}.
            </p>
          )}

          <Button
            className="w-full"
            size="lg"
            disabled={!tron || !evm || !quote.data || !hasAmount || overBalance || !!busy}
            onClick={() => void run()}
          >
            {busy ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <ArrowRight className="h-4 w-4 mr-2" />
            )}
            {busy ?? `Bridge to ${dest.symbol}`}
          </Button>

          <p className="inline-flex items-start gap-1.5 text-[10px] text-muted-foreground">
            <ShieldCheck className="h-3 w-3 mt-0.5 shrink-0" />
            Routing by Relay Protocol. Funds go straight to your own address on the
            destination chain — BeeKeeper never holds them.
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
