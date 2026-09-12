import { useQuery } from "@tanstack/react-query";
import { ArrowDownLeft, ArrowUpRight, RefreshCw } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { useHideBalances, maskAmount } from "@/lib/hide-balances";
import { formatFiat } from "@/lib/txc/units";
import { CHAIN_META } from "@/lib/chain-prefs";
import { getSolBalance, getSolanaHistory, type SolanaTransfer } from "@/lib/solana/api";
import { formatSol, lamportsToSol } from "@/lib/solana/network";

export function useSolanaData(address: string | null, enabled: boolean) {
  const balance = useQuery({
    queryKey: ["solana-balance", address],
    enabled: !!address && enabled,
    queryFn: () => {
      if (!address) throw new Error("Wallet is locked");
      return getSolBalance(address);
    },
    staleTime: 20_000,
    refetchInterval: 30_000,
  });
  const history = useQuery({
    queryKey: ["solana-history", address],
    enabled: !!address && enabled,
    queryFn: () => {
      if (!address) throw new Error("Wallet is locked");
      return getSolanaHistory(address);
    },
    staleTime: 20_000,
  });
  return { balance, history, refetch: () => Promise.all([balance.refetch(), history.refetch()]) };
}

export function SolanaTile({
  address,
  label,
  balanceLamports,
  loading,
  priceUsd,
  refreshing,
  onRefresh,
  onOpenDetails,
}: {
  address: string | null;
  label: string;
  balanceLamports: number;
  loading: boolean;
  priceUsd: number | null;
  refreshing: boolean;
  onRefresh: () => void;
  onOpenDetails: () => void;
}) {
  const [hidden] = useHideBalances();
  const accent = CHAIN_META.solana.accent;
  const solText = loading ? "..." : `${formatSol(balanceLamports)} SOL`;
  const usd = priceUsd != null ? lamportsToSol(balanceLamports) * priceUsd : null;
  const fiat = usd != null ? formatFiat(usd) : "Price unavailable";
  return (
    <button
      type="button"
      onClick={onOpenDetails}
      className="w-full text-left rounded-2xl p-6 text-white shadow-xl active:scale-[0.99] transition-transform"
      style={{ background: `linear-gradient(135deg, ${accent} 0%, ${accent}CC 60%, #111 140%)` }}
    >
      <div className="flex items-center justify-between">
        <p className="text-sm opacity-80 truncate">{label}</p>
        <span
          role="button"
          tabIndex={0}
          onClick={(event) => { event.stopPropagation(); onRefresh(); }}
          className="opacity-80 hover:opacity-100"
          aria-label="Refresh"
        >
          <RefreshCw className={`h-4 w-4 ${refreshing || loading ? "animate-spin" : ""}`} />
        </span>
      </div>
      <p className="mt-4 text-[10px] uppercase tracking-widest opacity-70">Native</p>
      <p className="mt-0.5 text-4xl font-bold tracking-tight">
        {hidden ? maskAmount(solText) : solText}
      </p>
      <p className="text-sm opacity-80">{hidden ? maskAmount(fiat) : fiat}</p>
      <div className="mt-3 pt-3 border-t border-white/15">
        <p className="text-[10px] uppercase tracking-widest opacity-70">Chain total</p>
        <p className="text-lg font-semibold">{hidden ? maskAmount(fiat) : fiat}</p>
      </div>
      {!address && <p className="mt-2 text-xs opacity-70">Unlock your wallet to load Solana.</p>}
    </button>
  );
}

export function SolanaActivity({ address, rows }: { address: string | null; rows: SolanaTransfer[] | null }) {
  const [hidden] = useHideBalances();
  if (!address) return null;
  return (
    <section>
      {!rows ? (
        <div className="space-y-2">{[0, 1, 2].map((i) => <div key={i} className="h-16 rounded-lg bg-muted/40 animate-pulse" />)}</div>
      ) : rows.length === 0 ? (
        <Card><CardContent className="pt-6 text-sm text-muted-foreground">No Solana transactions yet.</CardContent></Card>
      ) : (
        <ul className="space-y-2">
          {rows.map((tx) => {
            const amount = `${formatSol(tx.lamports)} SOL`;
            return <li key={tx.signature}>
              <a href={`https://solscan.io/tx/${encodeURIComponent(tx.signature)}`} target="_blank" rel="noreferrer" className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-card/40 px-4 py-3">
                <div className="flex items-center gap-3 min-w-0">
                  <span className={`rounded-full p-2 ${tx.incoming ? "bg-emerald-500/15 text-emerald-500" : "bg-muted text-muted-foreground"}`}>
                    {tx.incoming ? <ArrowDownLeft className="h-4 w-4" /> : <ArrowUpRight className="h-4 w-4" />}
                  </span>
                  <div className="min-w-0"><p className="text-sm font-medium">{tx.incoming ? "Received SOL" : "Sent SOL"}</p><p className="text-xs text-muted-foreground truncate">{tx.blockTime ? new Date(tx.blockTime * 1000).toLocaleString() : "Confirmed"}</p></div>
                </div>
                <p className={`text-sm font-semibold ${tx.incoming ? "text-emerald-500" : ""}`}>{hidden ? maskAmount(amount) : `${tx.incoming ? "+" : "-"}${amount}`}</p>
              </a>
            </li>;
          })}
        </ul>
      )}
    </section>
  );
}
