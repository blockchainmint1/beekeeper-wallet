/**
 * Portfolio summary shown at the top of the wallet home screen.
 *
 * This is the "dashboard" the earlier BeeKeeper wallet showed right after
 * unlocking: one big total in fiat plus an expandable per-wallet breakdown.
 *
 * Every query here reuses the exact query keys the home tiles already use, so
 * React Query serves it from the same cache — the summary adds no extra
 * network traffic.
 */
import { useEffect, useMemo, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ChevronDown, Loader2 } from "lucide-react";
import { useWallet } from "@/lib/txc/wallet-context";
import { getEnabledChains, CHAIN_META, type ChainId } from "@/lib/chain-prefs";
import { getChainLabel, CHAIN_LABEL_EVENT } from "@/lib/chain-labels";
import { EVM_CHAINS, deriveEvmAccount, evmClient, type EvmChainId } from "@/lib/chains/evm";
import { getAllPricesUsd } from "@/lib/chains/prices.functions";
import { scanAccount } from "@/lib/txc/scan";
import { getTxcPriceUsd } from "@/lib/txc/price.functions";
import { formatFiat, satsToTxc, formatTxcCompact } from "@/lib/txc/units";
import { scanIskAccount } from "@/lib/isk/scan";
import { ISK_DEFAULT_KIND } from "@/lib/isk/network";
import { getIskPriceUsd } from "@/lib/isk/price.functions";
import { satsToIsk, formatIskCompact } from "@/lib/isk/units";
import { scanBtcAccount } from "@/lib/btc/scan";
import { BTC_DEFAULT_KIND } from "@/lib/btc/network";
import { getBtcPriceUsd } from "@/lib/btc/price.functions";
import { satsToBtc, formatBtcCompact } from "@/lib/btc/units";
import { scanLtcAccount } from "@/lib/ltc/scan";
import { LTC_DEFAULT_KIND } from "@/lib/ltc/network";
import { getLtcPriceUsd } from "@/lib/ltc/price.functions";
import { satsToLtc, formatLtcCompact } from "@/lib/ltc/units";
import { scanDogeAccount } from "@/lib/doge/scan";
import { DOGE_DEFAULT_KIND } from "@/lib/doge/network";
import { getDogePriceUsd } from "@/lib/doge/price.functions";
import { satsToDoge, formatDogeCompact } from "@/lib/doge/units";
import { deriveTronAccount } from "@/lib/tron/address";
import { useTronData } from "@/components/wallet/TronTile";
import { sunToTrx } from "@/lib/tron/units";
import { deriveSolanaAccount, lamportsToSol } from "@/lib/solana/network";
import { useSolanaData } from "@/components/wallet/SolanaTile";
import { useHideBalances, maskAmount } from "@/lib/hide-balances";
import {
  listWatchWallets,
  watchChangedEvent,
  type WatchWallet,
} from "@/lib/watch-only";
import { WATCH_CHAIN_META, watchApi } from "@/lib/watch/chain-io";
import { listWifWallets, WIF_CHANGED_EVENT, type WifWalletEntry } from "@/lib/wif/store";
import { api as wifApi } from "@/lib/wif/chain-io";

type Row = {
  key: string;
  label: string;
  accent: string;
  ticker: string;
  /** Native amount, already formatted (compact). */
  amountText: string;
  usd: number | null;
  loading: boolean;
};

type AddressStats = {
  chain_stats: { funded_txo_sum: number; spent_txo_sum: number };
  mempool_stats: { funded_txo_sum: number; spent_txo_sum: number };
};

function statsSats(s: AddressStats | undefined): number | null {
  if (!s) return null;
  return (
    s.chain_stats.funded_txo_sum -
    s.chain_stats.spent_txo_sum +
    s.mempool_stats.funded_txo_sum -
    s.mempool_stats.spent_txo_sum
  );
}

export function PortfolioSummary() {
  const { root, unlocked, seed } = useWallet();
  const [hidden] = useHideBalances();
  const [expanded, setExpanded] = useState(false);

  const [enabled, setEnabled] = useState<ChainId[]>(() => getEnabledChains());
  useEffect(() => {
    const h = () => setEnabled(getEnabledChains());
    window.addEventListener("hme:chains-changed", h);
    return () => window.removeEventListener("hme:chains-changed", h);
  }, []);

  const [, bumpLabels] = useState(0);
  useEffect(() => {
    const h = () => bumpLabels((n) => n + 1);
    window.addEventListener(CHAIN_LABEL_EVENT, h);
    return () => window.removeEventListener(CHAIN_LABEL_EVENT, h);
  }, []);

  const [watchList, setWatchList] = useState<WatchWallet[]>(() => listWatchWallets());
  useEffect(() => {
    const h = () => setWatchList(listWatchWallets());
    window.addEventListener(watchChangedEvent(), h);
    return () => window.removeEventListener(watchChangedEvent(), h);
  }, []);
  const [wifList, setWifList] = useState<WifWalletEntry[]>(() => listWifWallets());
  useEffect(() => {
    const h = () => setWifList(listWifWallets());
    window.addEventListener(WIF_CHANGED_EVENT, h);
    return () => window.removeEventListener(WIF_CHANGED_EVENT, h);
  }, []);

  const rootKey = root?.neutered().toBase58().slice(0, 24);

  // ---- prices (same keys as the tiles) ----
  const fetchTxcPrice = useServerFn(getTxcPriceUsd);
  const fetchIskPrice = useServerFn(getIskPriceUsd);
  const fetchBtcPrice = useServerFn(getBtcPriceUsd);
  const fetchLtcPrice = useServerFn(getLtcPriceUsd);
  const fetchDogePrice = useServerFn(getDogePriceUsd);
  const fetchAllPrices = useServerFn(getAllPricesUsd);

  const price = useQuery({ queryKey: ["txc-price"], queryFn: () => fetchTxcPrice(), staleTime: 10 * 60_000 });
  const iskPrice = useQuery({
    queryKey: ["isk-price"],
    queryFn: () => fetchIskPrice(),
    staleTime: 10 * 60_000,
    enabled: enabled.includes("isk"),
  });
  const btcPrice = useQuery({
    queryKey: ["btc-price"],
    queryFn: () => fetchBtcPrice(),
    staleTime: 10 * 60_000,
    enabled: enabled.includes("btc"),
  });
  const ltcPrice = useQuery({
    queryKey: ["ltc-price"],
    queryFn: () => fetchLtcPrice(),
    staleTime: 10 * 60_000,
    enabled: enabled.includes("ltc"),
  });
  const dogePrice = useQuery({
    queryKey: ["doge-price"],
    queryFn: () => fetchDogePrice(),
    staleTime: 10 * 60_000,
    enabled: enabled.includes("doge"),
  });

  const evmEnabled = enabled.filter((c) => c in EVM_CHAINS) as EvmChainId[];
  const solanaEnabled = enabled.includes("solana");
  const allPrices = useQuery({
    queryKey: ["all-prices"],
    queryFn: () => fetchAllPrices(),
    staleTime: 10 * 60_000,
    enabled: evmEnabled.length > 0 || solanaEnabled,
  });

  // ---- balances (same keys as the tiles) ----
  const account = useQuery({
    queryKey: ["account", unlocked?.kind, rootKey],
    enabled: !!root && !!unlocked,
    queryFn: () => scanAccount(root!, unlocked!.kind),
  });
  const iskAccount = useQuery({
    queryKey: ["isk-account", ISK_DEFAULT_KIND, rootKey],
    enabled: !!root && !!unlocked && enabled.includes("isk"),
    queryFn: () => scanIskAccount(root!, ISK_DEFAULT_KIND),
  });
  const btcAccount = useQuery({
    queryKey: ["btc-account", BTC_DEFAULT_KIND, rootKey],
    enabled: !!root && !!unlocked && enabled.includes("btc"),
    queryFn: () => scanBtcAccount(root!, BTC_DEFAULT_KIND),
  });
  const ltcAccount = useQuery({
    queryKey: ["ltc-account", LTC_DEFAULT_KIND, rootKey],
    enabled: !!root && !!unlocked && enabled.includes("ltc"),
    queryFn: () => scanLtcAccount(root!, LTC_DEFAULT_KIND),
  });
  const dogeAccount = useQuery({
    queryKey: ["doge-account", DOGE_DEFAULT_KIND, rootKey],
    enabled: !!root && !!unlocked && enabled.includes("doge"),
    queryFn: () => scanDogeAccount(root!, DOGE_DEFAULT_KIND),
  });

  const evmAddress = useMemo(() => (root ? deriveEvmAccount(root).address : null), [root]);
  const evmBalances = useQueries({
    queries: evmEnabled.map((id) => ({
      queryKey: ["evm-balance", id, evmAddress],
      enabled: !!evmAddress,
      queryFn: () => evmClient(id).getBalance({ address: evmAddress! }),
      staleTime: 15_000,
    })),
  });

  const tronAddress = useMemo(() => (root ? deriveTronAccount(root).address : null), [root]);
  const tron = useTronData(tronAddress, !!unlocked && enabled.includes("tron"));
  const solanaAccount = useMemo(() => (seed ? deriveSolanaAccount(seed) : null), [seed]);
  const solana = useSolanaData(solanaAccount?.address ?? null, !!unlocked && solanaEnabled);

  const watchStats = useQueries({
    queries: watchList.map((w) => ({
      queryKey: ["watch-stats", w.chain, w.address],
      queryFn: () => watchApi(w.chain).getAddressStats(w.address),
    })),
  });
  const wifStats = useQueries({
    queries: wifList.map((w) => ({
      queryKey: ["wif-stats", w.chain, w.address],
      queryFn: () => wifApi(w.chain).getAddressStats(w.address),
      staleTime: 30_000,
    })),
  });

  const utxoPrice = (c: "txc" | "isk" | "btc" | "ltc" | "doge"): number | null =>
    (c === "txc"
      ? price.data?.usd
      : c === "isk"
        ? iskPrice.data?.usd
        : c === "btc"
          ? btcPrice.data?.usd
          : c === "ltc"
            ? ltcPrice.data?.usd
            : dogePrice.data?.usd) ?? null;

  const rows: Row[] = useMemo(() => {
    const out: Row[] = [];
    const utxo = {
      txc: { q: account, toCoin: satsToTxc, fmt: formatTxcCompact },
      isk: { q: iskAccount, toCoin: satsToIsk, fmt: formatIskCompact },
      btc: { q: btcAccount, toCoin: satsToBtc, fmt: formatBtcCompact },
      ltc: { q: ltcAccount, toCoin: satsToLtc, fmt: formatLtcCompact },
      doge: { q: dogeAccount, toCoin: satsToDoge, fmt: formatDogeCompact },
    } as const;

    for (const id of enabled) {
      const meta = CHAIN_META[id];
      if (!meta) continue;
      if (id in utxo) {
        const u = utxo[id as keyof typeof utxo];
        const sats = u.q.data?.balanceSats;
        const px = utxoPrice(id as keyof typeof utxo);
        out.push({
          key: id,
          label: getChainLabel(id) ?? meta.name,
          accent: meta.accent,
          ticker: meta.shortName,
          amountText: sats != null ? u.fmt(sats) : "—",
          usd: sats != null && px != null ? u.toCoin(sats) * px : null,
          loading: u.q.isLoading,
        });
        continue;
      }
      if (id in EVM_CHAINS) {
        const i = evmEnabled.indexOf(id as EvmChainId);
        const q = evmBalances[i];
        const wei = q?.data as bigint | undefined;
        const amount = wei != null ? Number(wei) / 1e18 : null;
        const px = allPrices.data?.prices?.[EVM_CHAINS[id as EvmChainId].priceSymbol] ?? null;
        out.push({
          key: id,
          label: getChainLabel(id) ?? meta.name,
          accent: meta.accent,
          ticker: meta.shortName,
          amountText: amount != null ? amount.toLocaleString(undefined, { maximumFractionDigits: 6 }) : "—",
          usd: amount != null && px != null ? amount * px : null,
          loading: !!q?.isLoading,
        });
        continue;
      }
      if (id === "tron") {
        const sun = tron.balance.data;
        const amount = sun != null ? sunToTrx(sun) : null;
        const px = tron.price.data?.usd ?? null;
        out.push({
          key: id,
          label: getChainLabel(id) ?? meta.name,
          accent: meta.accent,
          ticker: meta.shortName,
          amountText: amount != null ? amount.toLocaleString(undefined, { maximumFractionDigits: 6 }) : "—",
          usd: amount != null && px != null ? amount * px : null,
          loading: tron.balance.isLoading,
        });
        continue;
      }
      if (id === "solana") {
        const lam = solana.balance.data;
        const amount = lam != null ? lamportsToSol(lam) : null;
        const px = allPrices.data?.prices?.SOL ?? null;
        out.push({
          key: id,
          label: getChainLabel(id) ?? meta.name,
          accent: meta.accent,
          ticker: meta.shortName,
          amountText: amount != null ? amount.toLocaleString(undefined, { maximumFractionDigits: 6 }) : "—",
          usd: amount != null && px != null ? amount * px : null,
          loading: solana.balance.isLoading,
        });
      }
    }

    watchList.forEach((w, i) => {
      const m = WATCH_CHAIN_META[w.chain];
      const sats = statsSats(watchStats[i]?.data as AddressStats | undefined);
      const px = utxoPrice(w.chain);
      out.push({
        key: `w:${w.id}`,
        label: `${w.label} · watch-only`,
        accent: CHAIN_META[w.chain].accent,
        ticker: m.ticker,
        amountText: sats != null ? m.formatCompact(sats) : "—",
        usd: sats != null && px != null ? m.toCoin(sats) * px : null,
        loading: !!watchStats[i]?.isLoading,
      });
    });

    wifList.forEach((w, i) => {
      const m = WATCH_CHAIN_META[w.chain];
      const sats = statsSats(wifStats[i]?.data as AddressStats | undefined);
      const px = utxoPrice(w.chain);
      out.push({
        key: `k:${w.id}`,
        label: `${w.label} · imported key`,
        accent: CHAIN_META[w.chain].accent,
        ticker: m.ticker,
        amountText: sats != null ? m.formatCompact(sats) : "—",
        usd: sats != null && px != null ? m.toCoin(sats) * px : null,
        loading: !!wifStats[i]?.isLoading,
      });
    });

    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    enabled,
    account.data,
    account.isLoading,
    iskAccount.data,
    btcAccount.data,
    ltcAccount.data,
    dogeAccount.data,
    evmBalances.map((q) => String(q.data ?? "")).join(","),
    allPrices.data,
    price.data,
    iskPrice.data,
    btcPrice.data,
    ltcPrice.data,
    dogePrice.data,
    tron.balance.data,
    tron.price.data,
    solana.balance.data,
    watchList,
    watchStats.map((q) => (q.data ? "1" : "0")).join(""),
    wifList,
    wifStats.map((q) => (q.data ? "1" : "0")).join(""),
  ]);

  const priced = rows.filter((r) => r.usd != null);
  const total = priced.reduce((s, r) => s + (r.usd ?? 0), 0);
  const stillLoading = rows.some((r) => r.loading);
  const totalText = priced.length === 0 ? "—" : formatFiat(total);
  const sorted = [...rows].sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1));

  return (
    <section className="px-4 pt-5">
      <div className="rounded-2xl border border-border/60 bg-card/50 backdrop-blur px-4 py-5">
        <div className="text-center">
          <div className="text-[10px] font-medium uppercase tracking-[0.22em] text-muted-foreground">
            Total balance
          </div>
          <div className="mt-1.5 flex items-baseline justify-center gap-2">
            <span className="text-4xl sm:text-5xl font-semibold tracking-tight tabular-nums">
              {hidden ? maskAmount(totalText) : totalText}
            </span>
            {stillLoading && (
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            )}
          </div>
          <div className="mt-1 text-[11px] text-muted-foreground">
            {rows.length} {rows.length === 1 ? "wallet" : "wallets"}
            {stillLoading ? " · updating…" : ""}
          </div>
        </div>

        <button
          onClick={() => setExpanded((e) => !e)}
          className="mt-4 w-full flex items-center justify-between rounded-xl border border-border/50 px-3 py-2 text-xs font-medium text-muted-foreground transition hover:bg-muted/40"
        >
          <span>{expanded ? "Hide breakdown" : "Show breakdown"}</span>
          <ChevronDown className={`h-4 w-4 transition-transform ${expanded ? "rotate-180" : ""}`} />
        </button>

        {expanded && (
          <div className="mt-2 space-y-1.5">
            {sorted.map((r) => (
              <div key={r.key} className="flex items-center gap-3 rounded-xl px-2 py-2">
                <div
                  className="h-8 w-8 shrink-0 rounded-full flex items-center justify-center text-[10px] font-semibold"
                  style={{
                    background: `color-mix(in oklab, ${r.accent} 22%, transparent)`,
                    color: r.accent,
                  }}
                >
                  {r.ticker.slice(0, 4)}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium">{r.label}</span>
                    <span className="text-sm font-semibold tabular-nums">
                      {r.usd != null
                        ? hidden
                          ? maskAmount(formatFiat(r.usd))
                          : formatFiat(r.usd)
                        : r.loading
                          ? "…"
                          : "—"}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                    <span className="truncate">{r.ticker}</span>
                    <span className="tabular-nums">
                      {hidden ? maskAmount(r.amountText) : r.amountText}
                    </span>
                  </div>
                </div>
              </div>
            ))}
            {rows.length === 0 && (
              <div className="py-3 text-center text-xs text-muted-foreground">
                No wallets to summarize yet.
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
