/**
 * Tron tile + activity list. Tron is not a UTXO chain and not JSON-RPC EVM,
 * so it gets its own small set of components instead of reusing BtcForkTile
 * or EvmTile.
 */
import { useExchangeFeaturesAllowed } from "@/lib/native/capabilities";
import { useMemo, useSyncExternalStore } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { ArrowDownLeft, ArrowLeftRight, ArrowUpRight, RefreshCw } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { useHideBalances, maskAmount } from "@/lib/hide-balances";
import { formatFiat } from "@/lib/txc/units";
import { CHAIN_META } from "@/lib/chain-prefs";
import { TRC20_TOKENS, explorerTxUrl } from "@/lib/tron/network";
import { formatTokenAmount, formatTrxCompact, sunToTrx } from "@/lib/tron/units";
import { getTrxBalance, getTrc20Balance, getTronHistory, type TronTransfer } from "@/lib/tron/api";
import { getTronPriceUsd } from "@/lib/tron/price.functions";
import {
  getTronTxLabel,
  subscribeTronTxLabels,
  TRON_TX_LABEL_TEXT,
} from "@/lib/tron/tx-labels";

/** Balance + price queries for the Tron account. */
export function useTronData(address: string | null, enabled: boolean) {
  const fetchPrice = useServerFn(getTronPriceUsd);

  const balance = useQuery({
    queryKey: ["tron-balance", address],
    enabled: !!address && enabled,
    queryFn: () => getTrxBalance(address!),
    staleTime: 30_000,
  });

  const price = useQuery({
    queryKey: ["tron-price"],
    queryFn: () => fetchPrice(),
    staleTime: 10 * 60_000,
    enabled,
  });

  const tokens = useQueries({
    queries: TRC20_TOKENS.map((t) => ({
      queryKey: ["tron-trc20", t.contract, address],
      enabled: !!address && enabled,
      queryFn: () => getTrc20Balance(t, address!),
      staleTime: 30_000,
    })),
  });

  const refetch = async () => {
    await Promise.all([balance.refetch(), ...tokens.map((q) => q.refetch())]);
  };

  return { balance, price, tokens, refetch };
}

export function TronTile({
  address,
  label,
  balanceSun,
  loading,
  priceUsd,
  tokenRows,
  refreshing,
  onRefresh,
  onOpenDetails,
}: {
  address: string | null;
  label: string;
  balanceSun: number;
  loading: boolean;
  priceUsd: number | null;
  tokenRows: { symbol: string; amount: bigint; decimals: number }[];
  refreshing: boolean;
  onRefresh: () => void;
  onOpenDetails: () => void;
}) {
  const [hidden] = useHideBalances();
  const exchangeAllowed = useExchangeFeaturesAllowed();
  const accent = CHAIN_META.tron.accent;
  const balText = loading ? "..." : formatTrxCompact(balanceSun);
  const nativeUsd = priceUsd != null ? sunToTrx(balanceSun) * priceUsd : null;
  // Stablecoins are the point of Tron — count them at $1 for the chain total.
  const stableUsd = tokenRows.reduce((sum, t) => {
    if (t.symbol !== "USDT" && t.symbol !== "USDC") return sum;
    return sum + Number(t.amount) / 10 ** t.decimals;
  }, 0);
  const fiatText = nativeUsd != null ? formatFiat(nativeUsd) : "Price unavailable";
  const totalText =
    nativeUsd != null ? formatFiat(nativeUsd + stableUsd) : formatFiat(stableUsd);

  return (
    <button
      type="button"
      onClick={onOpenDetails}
      className="w-full text-left rounded-2xl p-6 text-white shadow-xl active:scale-[0.99] transition-transform"
      style={{
        background: `linear-gradient(135deg, ${accent} 0%, ${accent}CC 60%, #111 140%)`,
      }}
    >
      <div className="flex items-center justify-between">
        <p className="text-sm opacity-80 truncate">{label}</p>
        <div className="flex items-center gap-2">
          {exchangeAllowed && (
            <Link
              to="/wallet/tron/bridge"
              onClick={(e) => e.stopPropagation()}
              className="inline-flex items-center gap-1 rounded-full bg-white/15 hover:bg-white/25 px-2.5 py-1 text-[11px] font-medium"
              aria-label="Bridge off Tron"
            >
              <ArrowLeftRight className="h-3 w-3" /> Bridge
            </Link>
          )}
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              onRefresh();
            }}
            className="opacity-80 hover:opacity-100"
            aria-label="Refresh"
          >
            <RefreshCw className={`h-4 w-4 ${refreshing || loading ? "animate-spin" : ""}`} />
          </span>
        </div>
      </div>


      <p className="mt-3 text-[10px] uppercase tracking-widest opacity-70">Native</p>
      <p className="mt-0.5 text-4xl font-bold tracking-tight">
        {hidden ? maskAmount(balText) : balText}
        <span className="ml-2 text-2xl font-semibold opacity-90">TRX</span>
      </p>
      <p className="text-sm opacity-80">{hidden ? maskAmount(fiatText) : fiatText}</p>

      {tokenRows.some((t) => t.amount > 0n) && (
        <div className="mt-3 space-y-1">
          {tokenRows
            .filter((t) => t.amount > 0n)
            .map((t) => (
              <div key={t.symbol} className="flex items-center justify-between text-sm">
                <span className="opacity-80">{t.symbol}</span>
                <span className="font-medium">
                  {hidden
                    ? maskAmount("0")
                    : formatTokenAmount(t.amount, t.decimals, 2)}
                </span>
              </div>
            ))}
        </div>
      )}

      <div className="mt-3 pt-3 border-t border-white/15">
        <p className="text-[10px] uppercase tracking-widest opacity-70">Chain total</p>
        <p className="text-lg font-semibold">
          {hidden ? maskAmount(totalText) : totalText}
        </p>
      </div>
      {!address && (
        <p className="mt-2 text-xs opacity-70">Unlock your wallet to load your Tron address.</p>
      )}
    </button>
  );
}

export function TronActivity({ address }: { address: string | null }) {
  const history = useQuery({
    queryKey: ["tron-history", address],
    enabled: !!address,
    queryFn: () => getTronHistory(address!),
    staleTime: 20_000,
  });

  const rows = useMemo(() => history.data ?? null, [history.data]);

  return (
    <section>
      {history.isLoading && !rows ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-16 rounded-lg bg-muted/40 animate-pulse" />
          ))}
        </div>
      ) : history.isError ? (
        <Card>
          <CardContent className="pt-6 text-sm text-muted-foreground">
            Couldn't reach the Tron network right now.
          </CardContent>
        </Card>
      ) : (rows?.length ?? 0) === 0 ? (
        <Card>
          <CardContent className="pt-6 text-sm text-muted-foreground">
            No Tron transactions yet.
          </CardContent>
        </Card>
      ) : (
        <ul className="space-y-2">
          {rows!.slice(0, 50).map((tx) => (
            <TronRow key={`${tx.txid}-${tx.symbol}-${tx.value}`} tx={tx} address={address} />
          ))}
        </ul>
      )}
    </section>
  );
}

function TronRow({ tx, address }: { tx: TronTransfer; address: string | null }) {
  const [hidden] = useHideBalances();
  const label = useSyncExternalStore(
    subscribeTronTxLabels,
    () => getTronTxLabel(tx.txid),
    () => null,
  );
  const incoming = !!address && tx.to === address;
  const amount = formatTokenAmount(tx.value, tx.decimals, 6);
  const when = tx.timestamp ? new Date(tx.timestamp).toLocaleString() : "";
  const title = label
    ? `${TRON_TX_LABEL_TEXT[label]} · ${tx.symbol}`
    : `${incoming ? "Received" : "Sent"} ${tx.symbol}`;
  return (
    <li>
      <a
        href={explorerTxUrl(tx.txid)}
        target="_blank"
        rel="noreferrer"
        className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-card/40 px-4 py-3"
      >
        <div className="flex items-center gap-3 min-w-0">
          <span
            className={`rounded-full p-2 ${
              incoming ? "bg-emerald-500/15 text-emerald-500" : "bg-muted text-muted-foreground"
            }`}
          >
            {incoming ? (
              <ArrowDownLeft className="h-4 w-4" />
            ) : (
              <ArrowUpRight className="h-4 w-4" />
            )}
          </span>
          <div className="min-w-0">
            <p className="text-sm font-medium">{title}</p>
            <p className="text-xs text-muted-foreground truncate">
              {label === "bridge-approval" ? "Permission only — no funds moved · " : ""}
              {when}
            </p>
          </div>
        </div>

        <div className="text-right">
          <p className={`text-sm font-semibold ${incoming ? "text-emerald-500" : ""}`}>
            {hidden ? maskAmount(amount) : `${incoming ? "+" : "-"}${amount}`}
          </p>
          {!tx.confirmed && <p className="text-xs text-amber-500">pending</p>}
        </div>
      </a>
    </li>
  );
}
