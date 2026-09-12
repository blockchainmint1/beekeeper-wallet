import { createFileRoute, Link } from "@tanstack/react-router";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWallet } from "@/lib/txc/wallet-context";
import { deriveSolanaAccount, formatSol } from "@/lib/solana/network";
import { SolanaActivity, SolanaTile, useSolanaData } from "@/components/wallet/SolanaTile";
import { EvmDerivedAddresses } from "@/components/wallet/EvmDerivedAddresses";
import { scanAccount } from "@/lib/txc/scan";
import { scanIskAccount } from "@/lib/isk/scan";
import { ISK_DEFAULT_KIND } from "@/lib/isk/network";
import { formatIsk, formatIskCompact, satsToIsk } from "@/lib/isk/units";
import { getIskPriceUsd } from "@/lib/isk/price.functions";
import { getAddressTxs as getIskAddressTxs, type MempoolTx as IskMempoolTx } from "@/lib/isk/mempool";
import { scanBtcAccount } from "@/lib/btc/scan";
import { BTC_DEFAULT_KIND } from "@/lib/btc/network";
import { formatBtc, formatBtcCompact, satsToBtc } from "@/lib/btc/units";
import { getBtcPriceUsd } from "@/lib/btc/price.functions";
import { getAddressTxs as getBtcAddressTxs, type MempoolTx as BtcMempoolTx } from "@/lib/btc/mempool";
import { scanLtcAccount } from "@/lib/ltc/scan";
import { LTC_DEFAULT_KIND } from "@/lib/ltc/network";
import { formatLtc, formatLtcCompact, satsToLtc } from "@/lib/ltc/units";
import { getLtcPriceUsd } from "@/lib/ltc/price.functions";
import { getAddressTxs as getLtcAddressTxs, type MempoolTx as LtcMempoolTx } from "@/lib/ltc/mempool";
import { scanDogeAccount } from "@/lib/doge/scan";
import { DOGE_DEFAULT_KIND } from "@/lib/doge/network";
import { formatDoge, formatDogeCompact, satsToDoge } from "@/lib/doge/units";
import { getDogePriceUsd } from "@/lib/doge/price.functions";
import { getAddressTxs as getDogeAddressTxs, type MempoolTx as DogeMempoolTx } from "@/lib/doge/mempool";
import { deriveTronAccount } from "@/lib/tron/address";
import { TRC20_TOKENS } from "@/lib/tron/network";
import { formatTrx, sunToTrx } from "@/lib/tron/units";
import { TronActivity, TronTile, useTronData } from "@/components/wallet/TronTile";
import { formatTxc, formatTxcCompact, formatFiat, satsToTxc, compactNumberString } from "@/lib/txc/units";
import { getTxcPriceUsd } from "@/lib/txc/price.functions";
import { getAllPricesUsd } from "@/lib/chains/prices.functions";
import { getEvmHistory } from "@/lib/chains/history.functions";
import { readErc20Balance, tokenAmountFromRaw, USDC_BY_CHAIN } from "@/lib/chains/erc20";
import { useTokensForChain } from "@/lib/token-prefs";
import { useEnabledTxcTokens, formatTokenAmount } from "@/lib/txc/tokens";
import { useTxcTokenProps } from "@/lib/txc/token-props";
import { useTokenHolderTopUp } from "@/lib/txc/topup";
import { getTxcTokenBalancesForAddresses, getOmniTxValidity } from "@/lib/txc/tokens.functions";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ArrowDown, ArrowUp, ArrowLeftRight, ChevronLeft, ChevronRight, RefreshCw, Send, QrCode, Eye, Trash2, Lock, Key, Loader2 } from "lucide-react";
import { useFeature } from "@/lib/feature-prefs";
import { useExchangeFeaturesAllowed } from "@/lib/native/capabilities";
import { usePendingTxs, removePendingTx } from "@/lib/pending-tx";
import { getAddressStats, getAddressTxs, type MempoolTx } from "@/lib/txc/mempool";
import { decodeOmniSend } from "@/lib/txc/omni-decode";

import { getEnabledChains, CHAIN_META, type ChainId } from "@/lib/chain-prefs";
import { getChainLabel, CHAIN_LABEL_EVENT } from "@/lib/chain-labels";
import { EVM_CHAINS, deriveEvmAccount, evmClient, formatEth, setZcuExplorerBase, type EvmChainId } from "@/lib/chains/evm";

import { TxDetailSheet, type TxDetail } from "@/components/wallet/TxDetailSheet";
import { WalletDetailSheet } from "@/components/wallet/WalletDetailSheet";
import { ReorderTilesSheet } from "@/components/wallet/ReorderTilesSheet";
import { PortfolioSummary } from "@/components/wallet/PortfolioSummary";


import { useHideBalances, maskAmount } from "@/lib/hide-balances";
import { QrCode as QrCodeSvg } from "@/components/wallet/QrCode";
import {
  listWatchWallets,
  removeWatchWallet,
  watchChangedEvent,
  type WatchWallet,
} from "@/lib/watch-only";
import { WATCH_CHAIN_META, watchApi } from "@/lib/watch/chain-io";
import {
  listWifWallets,
  removeWifWallet,
  WIF_CHANGED_EVENT,
  type WifWalletEntry,
} from "@/lib/wif/store";
import { api as wifApi } from "@/lib/wif/chain-io";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export const Route = createFileRoute("/wallet/")({
  head: () => ({
    meta: [
      { title: "Full Wallet — BeeKeeper Wallet" },
      { name: "description", content: "Use the complete BeeKeeper wallet experience across every enabled blockchain." },
      { property: "og:title", content: "Full Wallet — BeeKeeper Wallet" },
      { property: "og:description", content: "Use the complete BeeKeeper wallet experience across every enabled blockchain." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: WalletHome,
});

function WalletHome() {
  const { root, unlocked, seed } = useWallet();
  const fetchPrice = useServerFn(getTxcPriceUsd);
  const fetchAllPrices = useServerFn(getAllPricesUsd);
  const qc = useQueryClient();

  // Reactive enabled chain list
  const [enabled, setEnabled] = useState<ChainId[]>(() => getEnabledChains());
  useEffect(() => {
    const h = () => setEnabled(getEnabledChains());
    window.addEventListener("hme:chains-changed", h);
    return () => window.removeEventListener("hme:chains-changed", h);
  }, []);

  // Watch-only wallets (appended after the derived-chain tiles).
  const [watchList, setWatchList] = useState<WatchWallet[]>(() => listWatchWallets());
  useEffect(() => {
    const h = () => setWatchList(listWatchWallets());
    window.addEventListener(watchChangedEvent(), h);
    return () => window.removeEventListener(watchChangedEvent(), h);
  }, []);

  // WIF (imported single-key) wallets. Each becomes its own tile.
  const [wifList, setWifList] = useState<WifWalletEntry[]>(() => listWifWallets());
  useEffect(() => {
    const h = () => setWifList(listWifWallets());
    window.addEventListener(WIF_CHANGED_EVENT, h);
    return () => window.removeEventListener(WIF_CHANGED_EVENT, h);
  }, []);
  // Force-refresh chain labels when renamed elsewhere.
  const [, bumpLabels] = useState(0);
  useEffect(() => {
    const h = () => bumpLabels((n) => n + 1);
    window.addEventListener(CHAIN_LABEL_EVENT, h);
    return () => window.removeEventListener(CHAIN_LABEL_EVENT, h);
  }, []);

  // Load the Zero Chill explorer base (server-provided) for tx links.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/zcu-explorer-base", { headers: { accept: "application/json" } })
      .then((res) => (res.ok ? res.json() : null))
      .then((r: { base?: string } | null) => {
        if (!cancelled && r?.base) setZcuExplorerBase(r.base);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Unified carousel item list — chains first, then watch-only, then WIF.
  type Slot =
    | { kind: "chain"; chain: ChainId }
    | { kind: "watch"; watch: WatchWallet }
    | { kind: "wif"; wif: WifWalletEntry };
  const slots: Slot[] = useMemo(
    () => [
      ...enabled.map((c) => ({ kind: "chain" as const, chain: c })),
      ...watchList.map((w) => ({ kind: "watch" as const, watch: w })),
      ...wifList.map((w) => ({ kind: "wif" as const, wif: w })),
    ],
    [enabled, watchList, wifList],
  );

  // Active tile tracked via scroll position
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [activeIdx, setActiveIdx] = useState(0);
  const scrollTo = useCallback((idx: number) => {
    const el = scrollerRef.current;
    if (!el) return;
    const w = el.clientWidth;
    if (!w) return;
    const clamped = Math.max(0, Math.min(idx, slots.length - 1));
    el.scrollTo({ left: clamped * w, behavior: "smooth" });
  }, [slots.length]);
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const onScroll = () => {
      const w = el.clientWidth;
      if (!w) return;
      setActiveIdx(Math.round(el.scrollLeft / w));
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [slots.length]);

  const activeSlot: Slot = slots[activeIdx] ?? { kind: "chain", chain: "txc" };
  const activeChain: ChainId = activeSlot.kind === "chain" ? activeSlot.chain : "txc";
  const activeWatch: WatchWallet | null = activeSlot.kind === "watch" ? activeSlot.watch : null;
  const activeWif: WifWalletEntry | null = activeSlot.kind === "wif" ? activeSlot.wif : null;

  // Selected transaction (opens in-page detail sheet)
  const [detail, setDetail] = useState<TxDetail | null>(null);
  // Which wallet tile's details are open
  const [tileOpen, setTileOpen] = useState<ChainId | null>(null);
  // Long-press to rearrange
  const [reorderOpen, setReorderOpen] = useState(false);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFired = useRef(false);
  const startLongPress = (action?: () => void) => {
    longPressFired.current = false;
    if (longPressTimer.current) clearTimeout(longPressTimer.current);
    longPressTimer.current = setTimeout(() => {
      longPressFired.current = true;
      if (typeof navigator !== "undefined" && navigator.vibrate) navigator.vibrate(15);
      if (action) action();
      else setReorderOpen(true);
    }, 550);
  };
  const cancelLongPress = () => {
    if (longPressTimer.current) clearTimeout(longPressTimer.current);
    longPressTimer.current = null;
  };


  // TXC data — balance/frontier scan runs always so the portfolio total is
  // accurate at open. With the persisted scan-hint this is only ~5–10
  // mempool.space calls after the first deep scan.
  const account = useQuery({
    queryKey: ["account", unlocked?.kind, root?.neutered().toBase58().slice(0, 24)],
    enabled: !!root && !!unlocked,
    queryFn: () => scanAccount(root!, unlocked!.kind),
  });
  const price = useQuery({
    queryKey: ["txc-price"],
    queryFn: () => fetchPrice(),
    staleTime: 10 * 60_000, // prices don't need per-open freshness
  });
  // TX history is heavy (one call per used address). Only fetch it when the
  // TXC tile is actually being viewed; cached data still renders on swipe-in.
  const txs = useQuery({
    queryKey: ["txs", account.data?.external.map((a) => a.address).join(",")],
    enabled: !!account.data && enabled.includes("txc"),
    queryFn: async () => {
      const all = await Promise.all(
        [...(account.data?.external ?? []), ...(account.data?.internal ?? [])].map((a) =>
          getAddressTxs(a.address).catch(() => [] as MempoolTx[]),
        ),
      );
      const map = new Map<string, MempoolTx>();
      for (const list of all) for (const tx of list) map.set(tx.txid, tx);
      // Unconfirmed first (mempool.space returns block_time undefined for them),
      // then newest confirmed.
      return [...map.values()].sort((a, b) => {
        if (a.status.confirmed !== b.status.confirmed) return a.status.confirmed ? 1 : -1;
        return (b.status.block_time ?? 0) - (a.status.block_time ?? 0);
      });
    },
    // TXC blocks are slow, so watch the mempool closely while the chain is
    // enabled: 5s while anything is unconfirmed, 12s otherwise, plus an
    // immediate refetch whenever the app comes back to the foreground. An
    // inbound payment shows up as "Pending" within seconds without pull refresh.
    refetchInterval: (q) => {
      if (!enabled.includes("txc")) return false;
      const data = q.state.data as MempoolTx[] | undefined;
      return data?.some((t) => !t.status.confirmed) ? 5_000 : 12_000;
    },
    refetchOnWindowFocus: true,
    refetchOnMount: "always",
  });


  // Unconfirmed activity also moves the balance (mempool UTXOs count), so
  // re-scan whenever the set of pending txids changes.
  const pendingTxcIds = (txs.data ?? [])
    .filter((t) => !t.status.confirmed)
    .map((t) => t.txid)
    .join(",");
  useEffect(() => {
    if (!pendingTxcIds) return;
    void account.refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingTxcIds]);

  const ownAddresses = new Set([
    ...(account.data?.external.map((a) => a.address) ?? []),
    ...(account.data?.internal.map((a) => a.address) ?? []),
  ]);

  // Incoming Omni transfers still sitting in the mempool. The node's balance
  // only counts confirmed transfers, so surface these as a "+X pending" line
  // on the token row the moment the tx hits the mempool.
  const pendingOmniIn = useMemo(() => {
    const map = new Map<number, bigint>();
    for (const tx of txs.data ?? []) {
      if (tx.status.confirmed) continue;
      const o = decodeOmniSend(tx);
      if (!o || !o.reference) continue;
      if (!ownAddresses.has(o.reference)) continue;
      if (o.sender && ownAddresses.has(o.sender)) continue; // self-move
      map.set(o.propertyId, (map.get(o.propertyId) ?? 0n) + o.amount);
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [txs.data, [...ownAddresses].join(",")]);



  // Omni token transfers ride inside ordinary TXC transactions — decode the
  // OP_RETURN so the history shows "Sent 25 TSD" instead of a dust move.
  const enabledTxcTokens = useEnabledTxcTokens();
  const omniTokenList = useMemo(() => {
    const byId = new Map<number, { id: number; symbol: string; divisible: boolean; name?: string }>();
    for (const t of enabledTxcTokens) byId.set(t.id, t);
    for (const tx of txs.data ?? []) {
      const o = decodeOmniSend(tx);
      if (o && !byId.has(o.propertyId))
        byId.set(o.propertyId, { id: o.propertyId, symbol: `#${o.propertyId}`, divisible: true });
    }
    return [...byId.values()];
  }, [enabledTxcTokens, txs.data]);
  const { resolve: resolveOmniToken } = useTxcTokenProps(omniTokenList);
  const omniMetaFor = (id: number) =>
    resolveOmniToken(
      omniTokenList.find((t) => t.id === id) ?? { id, symbol: `#${id}`, divisible: true },
    );

  // A confirmed TXC transaction can still carry an Omni transfer the node
  // rejected (wrong sending address, insufficient token balance…). Ask the
  // node so the history doesn't show a "sent" that never moved any tokens.
  const fetchOmniValidity = useServerFn(getOmniTxValidity);
  const confirmedOmniTxids = useMemo(() => {
    const ids: string[] = [];
    for (const tx of txs.data ?? []) {
      if (!tx.status.confirmed) continue;
      if (decodeOmniSend(tx)) ids.push(tx.txid);
    }
    return ids.slice(0, 50);
  }, [txs.data]);
  const omniValidity = useQuery({
    queryKey: ["omni-validity", confirmedOmniTxids.join(",")],
    enabled: confirmedOmniTxids.length > 0,
    queryFn: () => fetchOmniValidity({ data: { txids: confirmedOmniTxids } }),
    staleTime: 5 * 60_000,
  });

  // Keep token-holding addresses stocked with a small TXC reserve in the
  // background, so an in-person token payment is a single broadcast instead of
  // funding-then-sending while a cashier waits.
  useTokenHolderTopUp({
    root: root ?? null,
    walletKind: unlocked?.kind ?? null,
    snapshot: account.data,
    tokens: enabledTxcTokens,
    enabled: !!root && !!unlocked && activeChain === "txc",
    onFunded: () => void account.refetch(),
  });





  // ISK data — runs when ISK is enabled so the tile has a balance immediately.
  const iskEnabled = enabled.includes("isk");
  const fetchIskPrice = useServerFn(getIskPriceUsd);
  const iskAccount = useQuery({
    queryKey: ["isk-account", ISK_DEFAULT_KIND, root?.neutered().toBase58().slice(0, 24)],
    enabled: !!root && !!unlocked && iskEnabled,
    queryFn: () => scanIskAccount(root!, ISK_DEFAULT_KIND),
  });
  const iskPrice = useQuery({
    queryKey: ["isk-price"],
    queryFn: () => fetchIskPrice(),
    staleTime: 10 * 60_000,
    enabled: iskEnabled,
  });
  const iskTxs = useQuery({
    queryKey: ["isk-txs", iskAccount.data?.external.map((a) => a.address).join(",")],
    enabled: !!iskAccount.data && iskEnabled,
    queryFn: async () => {
      const all = await Promise.all(
        [...(iskAccount.data?.external ?? []), ...(iskAccount.data?.internal ?? [])].map((a) =>
          getIskAddressTxs(a.address).catch(() => [] as IskMempoolTx[]),
        ),
      );
      const map = new Map<string, IskMempoolTx>();
      for (const list of all) for (const tx of list) map.set(tx.txid, tx);
      return [...map.values()].sort(
        (a, b) => (b.status.block_time ?? 0) - (a.status.block_time ?? 0),
      );
    },
  });
  const iskOwnAddresses = new Set([
    ...(iskAccount.data?.external.map((a) => a.address) ?? []),
    ...(iskAccount.data?.internal.map((a) => a.address) ?? []),
  ]);

  // BTC data
  const btcEnabled = enabled.includes("btc");
  const fetchBtcPrice = useServerFn(getBtcPriceUsd);
  const btcAccount = useQuery({
    queryKey: ["btc-account", BTC_DEFAULT_KIND, root?.neutered().toBase58().slice(0, 24)],
    enabled: !!root && !!unlocked && btcEnabled,
    queryFn: () => scanBtcAccount(root!, BTC_DEFAULT_KIND),
  });
  const btcPrice = useQuery({
    queryKey: ["btc-price"],
    queryFn: () => fetchBtcPrice(),
    staleTime: 10 * 60_000,
    enabled: btcEnabled,
  });
  const btcTxs = useQuery({
    queryKey: ["btc-txs", btcAccount.data?.external.map((a) => a.address).join(",")],
    enabled: !!btcAccount.data && btcEnabled,
    queryFn: async () => {
      const all = await Promise.all(
        [...(btcAccount.data?.external ?? []), ...(btcAccount.data?.internal ?? [])].map((a) =>
          getBtcAddressTxs(a.address).catch(() => [] as BtcMempoolTx[]),
        ),
      );
      const map = new Map<string, BtcMempoolTx>();
      for (const list of all) for (const tx of list) map.set(tx.txid, tx);
      return [...map.values()].sort(
        (a, b) => (b.status.block_time ?? 0) - (a.status.block_time ?? 0),
      );
    },
  });
  const btcOwnAddresses = new Set([
    ...(btcAccount.data?.external.map((a) => a.address) ?? []),
    ...(btcAccount.data?.internal.map((a) => a.address) ?? []),
  ]);

  // LTC data
  const ltcEnabled = enabled.includes("ltc");
  const fetchLtcPrice = useServerFn(getLtcPriceUsd);
  const ltcAccount = useQuery({
    queryKey: ["ltc-account", LTC_DEFAULT_KIND, root?.neutered().toBase58().slice(0, 24)],
    enabled: !!root && !!unlocked && ltcEnabled,
    queryFn: () => scanLtcAccount(root!, LTC_DEFAULT_KIND),
  });
  const ltcPrice = useQuery({
    queryKey: ["ltc-price"],
    queryFn: () => fetchLtcPrice(),
    staleTime: 10 * 60_000,
    enabled: ltcEnabled,
  });
  const ltcTxs = useQuery({
    queryKey: ["ltc-txs", ltcAccount.data?.external.map((a) => a.address).join(",")],
    enabled: !!ltcAccount.data && ltcEnabled,
    queryFn: async () => {
      const all = await Promise.all(
        [...(ltcAccount.data?.external ?? []), ...(ltcAccount.data?.internal ?? [])].map((a) =>
          getLtcAddressTxs(a.address).catch(() => [] as LtcMempoolTx[]),
        ),
      );
      const map = new Map<string, LtcMempoolTx>();
      for (const list of all) for (const tx of list) map.set(tx.txid, tx);
      return [...map.values()].sort(
        (a, b) => (b.status.block_time ?? 0) - (a.status.block_time ?? 0),
      );
    },
  });
  const ltcOwnAddresses = new Set([
    ...(ltcAccount.data?.external.map((a) => a.address) ?? []),
    ...(ltcAccount.data?.internal.map((a) => a.address) ?? []),
  ]);

  // DOGE data
  const dogeEnabled = enabled.includes("doge");
  const fetchDogePrice = useServerFn(getDogePriceUsd);
  const dogeAccount = useQuery({
    queryKey: ["doge-account", DOGE_DEFAULT_KIND, root?.neutered().toBase58().slice(0, 24)],
    enabled: !!root && !!unlocked && dogeEnabled,
    queryFn: () => scanDogeAccount(root!, DOGE_DEFAULT_KIND),
  });
  const dogePrice = useQuery({
    queryKey: ["doge-price"],
    queryFn: () => fetchDogePrice(),
    staleTime: 10 * 60_000,
    enabled: dogeEnabled,
  });
  const dogeTxs = useQuery({
    queryKey: ["doge-txs", dogeAccount.data?.external.map((a) => a.address).join(",")],
    enabled: !!dogeAccount.data && dogeEnabled,
    queryFn: async () => {
      const all = await Promise.all(
        [...(dogeAccount.data?.external ?? []), ...(dogeAccount.data?.internal ?? [])].map((a) =>
          getDogeAddressTxs(a.address).catch(() => [] as DogeMempoolTx[]),
        ),
      );
      const map = new Map<string, DogeMempoolTx>();
      for (const list of all) for (const tx of list) map.set(tx.txid, tx);
      return [...map.values()].sort(
        (a, b) => (b.status.block_time ?? 0) - (a.status.block_time ?? 0),
      );
    },
  });
  const dogeOwnAddresses = new Set([
    ...(dogeAccount.data?.external.map((a) => a.address) ?? []),
    ...(dogeAccount.data?.internal.map((a) => a.address) ?? []),
  ]);

  // TRON data
  const tronEnabled = enabled.includes("tron");
  const tronAddress = useMemo(() => (root ? deriveTronAccount(root).address : null), [root]);
  const tron = useTronData(tronAddress, !!unlocked && tronEnabled);
  const tronTokenRows = TRC20_TOKENS.map((t, i) => ({
    symbol: t.symbol,
    decimals: t.decimals,
    amount: tron.tokens[i]?.data ?? 0n,
  }));

  // Solana native SOL data. The Ed25519 keypair is created only while unlocked.
  const solanaEnabled = enabled.includes("solana");
  const solanaAccount = useMemo(() => (seed ? deriveSolanaAccount(seed) : null), [seed]);
  const solana = useSolanaData(solanaAccount?.address ?? null, !!unlocked && solanaEnabled);

  // EVM data (only for enabled EVM chains)
  const evmEnabled = enabled.filter((c) => c in EVM_CHAINS) as EvmChainId[];
  const evmAddress = useMemo(() => (root ? deriveEvmAccount(root).address : null), [root]);
  // Prices are cheap and needed for portfolio total. Long stale time.
  const allPrices = useQuery({
    queryKey: ["all-prices"],
    queryFn: () => fetchAllPrices(),
    staleTime: 10 * 60_000,
    enabled: evmEnabled.length > 0 || solanaEnabled,
  });
  // Native balances always run for all enabled EVM chains so the portfolio
  // total is complete on open. One RPC call each = cheap.
  const evmBalances = useQueries({
    queries: evmEnabled.map((id) => ({
      queryKey: ["evm-balance", id, evmAddress],
      enabled: !!evmAddress,
      queryFn: () => evmClient(id).getBalance({ address: evmAddress! }),
      // Keep tiles live: poll every 30s and retry transient RPC hiccups.
      staleTime: 15_000,
      refetchInterval: 30_000,
      retry: 3,
      retryDelay: (attempt: number) => Math.min(1000 * 2 ** attempt, 8000),
    })),

  });

  // Watch-only balances + tx history. Balance query is always on so the
  // tile shows a number without needing to swipe to it; history only fires
  // when the tile is actually the active one (single-address = 1 API call
  // either way, but we still avoid the burst on cold open with many entries).
  const watchStats = useQueries({
    queries: watchList.map((w) => ({
      queryKey: ["watch-stats", w.chain, w.address],
      queryFn: () => watchApi(w.chain).getAddressStats(w.address),
    })),
  });
  const watchTxs = useQueries({
    queries: watchList.map((w) => ({
      queryKey: ["watch-txs", w.chain, w.address],
      enabled: !!w.address,
      queryFn: () => watchApi(w.chain).getAddressTxs(w.address),
    })),
  });

  /** Latest USD price for a watch-only tile's chain (null when unknown). */
  const watchPriceUsd = (c: WatchWallet["chain"]): number | null =>
    (c === "txc"
      ? price.data?.usd
      : c === "isk"
        ? iskPrice.data?.usd
        : c === "btc"
          ? btcPrice.data?.usd
          : c === "ltc"
            ? ltcPrice.data?.usd
            : dogePrice.data?.usd) ?? null;

  // Long-press to remove a watch-only entry (chain tiles use reorder sheet).
  const [watchRemove, setWatchRemove] = useState<WatchWallet | null>(null);
  const [wifRemove, setWifRemove] = useState<WifWalletEntry | null>(null);

  // Balances for imported WIF wallets — chain-aware.
  const wifStats = useQueries({
    queries: wifList.map((w) => ({
      queryKey: ["wif-stats", w.chain, w.address],
      queryFn: () => wifApi(w.chain).getAddressStats(w.address),
      staleTime: 30_000,
    })),
  });
  const wifTxs = useQueries({
    queries: wifList.map((w) => ({
      queryKey: ["wif-txs", w.chain, w.address],
      enabled: !!w.address,
      queryFn: () => wifApi(w.chain).getAddressTxs(w.address),
    })),
  });

  return (
    <main className="flex-1 flex flex-col min-h-0">
      <div className="flex-1 flex flex-col min-h-0 overflow-y-auto">
        <div className="mx-auto max-w-3xl w-full flex-1">
          {/* Swipeable chain tiles */}

          <div className="relative">
            <Button
              variant="ghost"
              size="icon"
              className="hidden md:flex absolute left-2 top-1/2 -translate-y-1/2 z-10 h-9 w-9 rounded-full bg-card/80 backdrop-blur supports-[backdrop-filter]:bg-card/60 border border-border/60 shadow-sm disabled:opacity-30"
              onClick={() => scrollTo(activeIdx - 1)}
              disabled={activeIdx === 0}
              aria-label="Previous wallet"
            >
              <ChevronLeft className="h-5 w-5" />
            </Button>
            <div
              ref={scrollerRef}
              className="flex overflow-x-auto snap-x snap-mandatory scroll-smooth no-scrollbar"
              style={{ scrollbarWidth: "none" }}
            >
            {slots.map((slot, slotIdx) => {
              const key =
                slot.kind === "chain"
                  ? `c:${slot.chain}`
                  : slot.kind === "watch"
                    ? `w:${slot.watch.id}`
                    : `k:${slot.wif.id}`;
              const onLongPress =
                slot.kind === "watch"
                  ? () => setWatchRemove(slot.watch)
                  : slot.kind === "wif"
                    ? () => setWifRemove(slot.wif)
                    : undefined;
              return (
                <div
                  key={key}
                  className="snap-center shrink-0 w-full px-4 pt-6"
                  onPointerDown={() => startLongPress(onLongPress)}
                  onPointerUp={cancelLongPress}
                  onPointerMove={cancelLongPress}
                  onPointerCancel={cancelLongPress}
                  onPointerLeave={cancelLongPress}
                  onContextMenu={(e) => e.preventDefault()}
                >
                  {slot.kind === "chain" && slot.chain === "txc" && (
                    <TxcTile
                      balanceSats={account.data?.balanceSats ?? 0}
                      loading={account.isLoading}
                      priceUsd={price.data?.usd ?? null}
                      onRefresh={() => account.refetch()}
                      refreshing={account.isFetching}
                      label={unlocked?.label ?? "TXC Wallet"}
                      onOpenDetails={() => {
                        if (longPressFired.current) return;
                        setTileOpen("txc");
                      }}
                    />
                  )}
                  {slot.kind === "chain" && slot.chain === "isk" && (
                    <BtcForkTile
                      variant="isk"
                      balanceSats={iskAccount.data?.balanceSats ?? 0}
                      loading={iskAccount.isLoading}
                      priceUsd={iskPrice.data?.usd ?? null}
                      onRefresh={() => iskAccount.refetch()}
                      refreshing={iskAccount.isFetching}
                      label={getChainLabel("isk")}
                      onOpenDetails={() => {
                        if (longPressFired.current) return;
                        setTileOpen("isk");
                      }}
                    />
                  )}
                  {slot.kind === "chain" && slot.chain === "btc" && (
                    <BtcForkTile
                      variant="btc"
                      balanceSats={btcAccount.data?.balanceSats ?? 0}
                      loading={btcAccount.isLoading}
                      priceUsd={btcPrice.data?.usd ?? null}
                      onRefresh={() => btcAccount.refetch()}
                      refreshing={btcAccount.isFetching}
                      label={getChainLabel("btc")}
                      onOpenDetails={() => {
                        if (longPressFired.current) return;
                        setTileOpen("btc");
                      }}
                    />
                  )}
                  {slot.kind === "chain" && slot.chain === "ltc" && (
                    <BtcForkTile
                      variant="ltc"
                      balanceSats={ltcAccount.data?.balanceSats ?? 0}
                      loading={ltcAccount.isLoading}
                      priceUsd={ltcPrice.data?.usd ?? null}
                      onRefresh={() => ltcAccount.refetch()}
                      refreshing={ltcAccount.isFetching}
                      label={getChainLabel("ltc")}
                      onOpenDetails={() => {
                        if (longPressFired.current) return;
                        setTileOpen("ltc");
                      }}
                    />
                  )}
                  {slot.kind === "chain" && slot.chain === "doge" && (
                    <BtcForkTile
                      variant="doge"
                      balanceSats={dogeAccount.data?.balanceSats ?? 0}
                      loading={dogeAccount.isLoading}
                      priceUsd={dogePrice.data?.usd ?? null}
                      onRefresh={() => dogeAccount.refetch()}
                      refreshing={dogeAccount.isFetching}
                      label={getChainLabel("doge")}
                      onOpenDetails={() => {
                        if (longPressFired.current) return;
                        setTileOpen("doge");
                      }}
                    />
                  )}
                  {slot.kind === "chain" && slot.chain === "tron" && (
                    <TronTile
                      address={tronAddress}
                      label={getChainLabel("tron")}
                      balanceSun={tron.balance.data ?? 0}
                      loading={tron.balance.isLoading}
                      priceUsd={tron.price.data?.usd ?? null}
                      tokenRows={tronTokenRows}
                      refreshing={tron.balance.isFetching}
                      onRefresh={() => void tron.refetch()}
                      onOpenDetails={() => {
                        if (longPressFired.current) return;
                        setTileOpen("tron");
                      }}
                    />
                  )}
                  {slot.kind === "chain" && slot.chain === "solana" && (
                    <SolanaTile
                      address={solanaAccount?.address ?? null}
                      label={getChainLabel("solana")}
                      balanceLamports={solana.balance.data ?? 0}
                      loading={solana.balance.isLoading}
                      priceUsd={allPrices.data?.prices?.SOL ?? null}
                      refreshing={solana.balance.isFetching}
                      onRefresh={() => void solana.refetch()}
                      onOpenDetails={() => {
                        if (longPressFired.current) return;
                        setTileOpen("solana");
                      }}
                    />
                  )}
                  {slot.kind === "chain" && slot.chain !== "txc" && slot.chain !== "btc" && slot.chain !== "isk" && slot.chain !== "ltc" && slot.chain !== "doge" && slot.chain !== "tron" && slot.chain !== "solana" && (
                    <EvmTile
                      chainId={slot.chain as EvmChainId}
                      address={evmAddress}
                      label={getChainLabel(slot.chain)}
                      balanceWei={evmBalances[evmEnabled.indexOf(slot.chain as EvmChainId)]?.data ?? null}
                      loading={evmBalances[evmEnabled.indexOf(slot.chain as EvmChainId)]?.isLoading ?? true}
                      priceUsd={
                        allPrices.data?.prices?.[EVM_CHAINS[slot.chain as EvmChainId].priceSymbol] ?? null
                      }
                      onRefresh={async () => {
                        const chain = slot.chain as EvmChainId;
                        const addr = evmAddress;
                        // Refetch native balance
                        await evmBalances[evmEnabled.indexOf(chain)]?.refetch();
                        // Invalidate ERC-20 balances and tx history for this chain+address
                        await Promise.all([
                          qc.invalidateQueries({ queryKey: ["erc20-balance", chain] }),
                          qc.invalidateQueries({ queryKey: ["evm-history", chain, addr] }),
                          qc.invalidateQueries({ queryKey: ["all-prices"] }),
                        ]);
                      }}
                      onOpenDetails={() => {
                        if (longPressFired.current) return;
                        setTileOpen(slot.chain);
                      }}
                    />
                  )}
                  {slot.kind === "watch" && (
                    <WatchOnlyTile
                      wallet={slot.watch}
                      stats={watchStats[watchList.findIndex((w) => w.id === slot.watch.id)]?.data ?? null}
                      loading={
                        watchStats[watchList.findIndex((w) => w.id === slot.watch.id)]?.isLoading ?? true
                      }
                      priceUsd={watchPriceUsd(slot.watch.chain)}
                      onRefresh={() =>
                        watchStats[watchList.findIndex((w) => w.id === slot.watch.id)]?.refetch()
                      }
                      onOpenDetails={() => {
                        if (longPressFired.current) return;
                        setActiveIdx(slotIdx);
                        setWatchRemove(slot.watch);
                      }}
                    />
                  )}
                  {slot.kind === "wif" && (
                    <WifTile
                      entry={slot.wif}
                      stats={wifStats[wifList.findIndex((w) => w.id === slot.wif.id)]?.data ?? null}
                      loading={
                        wifStats[wifList.findIndex((w) => w.id === slot.wif.id)]?.isLoading ?? true
                      }
                      priceUsd={
                        slot.wif.chain === "txc"
                          ? price.data?.usd ?? null
                          : iskPrice.data?.usd ?? null
                      }
                      onRefresh={() =>
                        wifStats[wifList.findIndex((w) => w.id === slot.wif.id)]?.refetch()
                      }
                      onOpenDetails={() => {
                        if (longPressFired.current) return;
                        setActiveIdx(slotIdx);
                      }}
                    />
                  )}
                </div>
              );
            })}

          </div>
            <Button
              variant="ghost"
              size="icon"
              className="hidden md:flex absolute right-2 top-1/2 -translate-y-1/2 z-10 h-9 w-9 rounded-full bg-card/80 backdrop-blur supports-[backdrop-filter]:bg-card/60 border border-border/60 shadow-sm disabled:opacity-30"
              onClick={() => scrollTo(activeIdx + 1)}
              disabled={activeIdx >= slots.length - 1}
              aria-label="Next wallet"
            >
              <ChevronRight className="h-5 w-5" />
            </Button>
          </div>

          {/* Dots indicator */}
          {slots.length > 1 && (
            <div className="flex justify-center gap-1.5 mt-3">
              {slots.map((s, i) => (
                <button
                  key={s.kind === "chain" ? `c:${s.chain}` : s.kind === "watch" ? `w:${s.watch.id}` : `k:${s.wif.id}`}
                  type="button"
                  onClick={() => scrollTo(i)}
                  className={`h-1.5 rounded-full transition-all ${
                    i === activeIdx ? "w-6 bg-foreground" : "w-1.5 bg-muted-foreground/40 hover:bg-muted-foreground/70"
                  }`}
                  aria-label={`Go to wallet ${i + 1}`}
                />
              ))}
            </div>
          )}

          {/* Coins found on old derivation paths (old app / BlueWallet import) */}
          {activeChain === "txc" && !activeWatch && !activeWif && (
            <OldPathBanner
              branches={account.isFetchedAfterMount ? account.data?.branches : undefined}
            />
          )}
          {activeChain === "txc" && !activeWatch && !activeWif && (
            <TxcTokens addresses={[...ownAddresses]} pendingIn={pendingOmniIn} />
          )}
          {/* Imported keys / watch-only TXC addresses can also hold Omni tokens */}
          {activeWif?.chain === "txc" && (
            <TxcTokens
              addresses={[activeWif.address]}
              readOnly
              sendFromWifId={activeWif.kind === "bip44" ? activeWif.id : undefined}
            />
          )}
          {activeWatch?.chain === "txc" && (
            <TxcTokens addresses={[activeWatch.address]} readOnly />
          )}

          {/* Extra derived addresses for the currently selected EVM wallet only. */}
          {!activeWatch && !activeWif && activeSlot.kind === "chain" && (
            activeChain === "eth" || activeChain === "base" || activeChain === "bsc"
          ) && (
            <div className="px-4">
              <EvmDerivedAddresses chainId={activeChain as EvmChainId} />
            </div>
          )}


          {/* Cross-chain recent activity — every enabled wallet's history is
              shown on the landing page, not just the currently selected tile. */}
          <section className="mt-8 px-4">
            <h2 className="text-lg font-semibold mb-3">Recent activity</h2>

            {enabled.includes("txc") && (
              <div className="mb-6">
                <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-2">
                  TEXITcoin
                </h3>
                {account.isLoading || txs.isLoading ? (
                  <div className="space-y-2">
                    {[0, 1, 2].map((i) => (
                      <div key={i} className="h-16 rounded-lg bg-muted/40 animate-pulse" />
                    ))}
                  </div>
                ) : account.isError ? (
                  <Card>
                    <CardContent className="pt-6 text-sm text-muted-foreground">
                      Couldn't reach mempool.texitcoin.org.{" "}
                      <button className="underline" onClick={() => account.refetch()}>
                        try again
                      </button>
                      .
                    </CardContent>
                  </Card>
                ) : (txs.data?.length ?? 0) === 0 ? (
                  <Card>
                    <CardContent className="pt-6 text-sm text-muted-foreground">
                      No TEXITcoin transactions yet.
                    </CardContent>
                  </Card>
                ) : (
                  <ul className="space-y-2">
                    {txs.data!.slice(0, 50).map((tx) => {
                      const inSum = tx.vin
                        .filter((v) => v.prevout?.scriptpubkey_address && ownAddresses.has(v.prevout?.scriptpubkey_address))
                        .reduce((s, v) => s + (v.prevout?.value ?? 0), 0);
                      const outToOwn = tx.vout
                        .filter((v) => v.scriptpubkey_address && ownAddresses.has(v.scriptpubkey_address))
                        .reduce((s, v) => s + v.value, 0);
                      const net = outToOwn - inSum;
                      const omni = decodeOmniSend(tx);
                      const omniMine =
                        omni &&
                        ((omni.sender && ownAddresses.has(omni.sender)) ||
                          (omni.reference && ownAddresses.has(omni.reference)));
                      const omniIncoming =
                        !!omni && !!omni.reference && ownAddresses.has(omni.reference) &&
                        !(omni.sender && ownAddresses.has(omni.sender));
                      const meta = omni && omniMine ? omniMetaFor(omni.propertyId) : null;
                      const incoming = meta ? omniIncoming : net > 0;
                      const pending = !tx.status.confirmed;
                      const omniInvalid =
                        !!meta && omniValidity.data?.[tx.txid]?.valid === false
                          ? omniValidity.data[tx.txid].reason ?? "Rejected by Omni Layer"
                          : null;
                      return (
                        <li key={tx.txid}>
                          <button
                            type="button"
                            onClick={() => setDetail({ kind: "txc", tx, net, incoming })}
                            className="w-full flex items-center gap-3 rounded-lg border border-border/60 bg-card/40 px-4 py-3 hover:bg-card transition-colors text-left"
                          >
                            <div
                              className={`w-9 h-9 rounded-full flex items-center justify-center ${
                                meta
                                  ? "bg-amber-500/15 text-amber-300 text-xs font-bold"
                                  : incoming
                                    ? "bg-emerald-500/15 text-emerald-400"
                                    : "bg-rose-500/15 text-rose-400"
                              }`}
                            >
                              {meta ? (
                                meta.symbol.slice(0, 2)
                              ) : incoming ? (
                                <ArrowDown className="h-4 w-4" />
                              ) : (
                                <ArrowUp className="h-4 w-4" />
                              )}
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium">
                                {incoming ? "Received" : "Sent"}
                                {meta ? ` ${meta.symbol}` : ""}
                                {omniInvalid && (
                                  <span className="ml-2 rounded bg-destructive/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-destructive">
                                    not applied
                                  </span>
                                )}
                              </p>
                              <p className="text-xs text-muted-foreground truncate">
                                {pending ? (
                                  <span className="inline-flex items-center gap-1 text-amber-400">
                                    <Loader2 className="h-3 w-3 animate-spin" /> In mempool · unconfirmed
                                  </span>
                                ) : omniInvalid ? (
                                  <span className="text-destructive">{omniInvalid}</span>
                                ) : (
                                  new Date((tx.status.block_time ?? 0) * 1000).toLocaleString()
                                )}
                              </p>
                            </div>
                            <div className="text-right">
                              <p
                                className={`text-sm font-semibold ${
                                  omniInvalid
                                    ? "text-muted-foreground line-through"
                                    : incoming
                                      ? "text-emerald-400"
                                      : ""
                                }`}
                              >
                                {incoming ? "+" : "−"}
                                {meta && omni
                                  ? `${formatTokenAmount(omni.amount, meta.divisible)} ${meta.symbol}`
                                  : formatTxc(Math.abs(net))}
                              </p>
                              {meta && net !== 0 && (
                                <p className="text-[11px] text-muted-foreground">
                                  {net > 0 ? "+" : "−"}
                                  {formatTxc(Math.abs(net))}
                                </p>
                              )}
                            </div>
                            <ChevronRight className="h-4 w-4 text-muted-foreground" />
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            )}

            {enabled.includes("isk") && (
              <div className="mb-6">
                <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-2">
                  IskanderCoin
                </h3>
                <BtcForkActivity
                  variant="isk"
                  loading={iskAccount.isLoading || iskTxs.isLoading}
                  error={iskAccount.isError}
                  txs={iskTxs.data ?? null}
                  ownAddresses={iskOwnAddresses}
                  onRefresh={() => iskAccount.refetch()}
                  onOpen={(tx, net, incoming) => setDetail(utxoTxDetail("isk", tx, net, incoming))}
                />
              </div>
            )}
            {enabled.includes("btc") && (
              <div className="mb-6">
                <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-2">
                  Bitcoin
                </h3>
                <BtcForkActivity
                  variant="btc"
                  loading={btcAccount.isLoading || btcTxs.isLoading}
                  error={btcAccount.isError}
                  txs={btcTxs.data ?? null}
                  ownAddresses={btcOwnAddresses}
                  onRefresh={() => btcAccount.refetch()}
                  onOpen={(tx, net, incoming) => setDetail(utxoTxDetail("btc", tx, net, incoming))}
                />
              </div>
            )}
            {enabled.includes("ltc") && (
              <div className="mb-6">
                <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-2">
                  Litecoin
                </h3>
                <BtcForkActivity
                  variant="ltc"
                  loading={ltcAccount.isLoading || ltcTxs.isLoading}
                  error={ltcAccount.isError}
                  txs={ltcTxs.data ?? null}
                  ownAddresses={ltcOwnAddresses}
                  onRefresh={() => ltcAccount.refetch()}
                  onOpen={(tx, net, incoming) => setDetail(utxoTxDetail("ltc", tx, net, incoming))}
                />
              </div>
            )}
            {enabled.includes("doge") && (
              <div className="mb-6">
                <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-2">
                  Dogecoin
                </h3>
                <BtcForkActivity
                  variant="doge"
                  loading={dogeAccount.isLoading || dogeTxs.isLoading}
                  error={dogeAccount.isError}
                  txs={dogeTxs.data ?? null}
                  ownAddresses={dogeOwnAddresses}
                  onRefresh={() => dogeAccount.refetch()}
                  onOpen={(tx, net, incoming) => setDetail(utxoTxDetail("doge", tx, net, incoming))}
                />
              </div>
            )}
            {enabled.includes("tron") && (
              <div className="mb-6">
                <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-2">
                  Tron
                </h3>
                <TronActivity address={tronAddress} />
              </div>
            )}
            {enabled.includes("solana") && (
              <div className="mb-6">
                <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-2">
                  Solana
                </h3>
                <SolanaActivity address={solanaAccount?.address ?? null} rows={solana.history.data ?? null} />
              </div>
            )}
            {evmEnabled.map((evmId) => (
              <div key={evmId} className="mb-6">
                <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-2">
                  {CHAIN_META[evmId].name}
                </h3>
                <EvmActivity
                  chainId={evmId}
                  address={evmAddress}
                  onOpen={(t) => setDetail({ kind: "evm", chain: evmId, transfer: t })}
                />
                {activeChain === evmId && <EvmDerivedAddresses chainId={evmId} />}
              </div>
            ))}
            {watchList.map((w, i) => (
              <div key={w.id} className="mb-6">
                <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-2">
                  {w.label} · watch-only
                </h3>
                <WatchOnlyActivity
                  wallet={w}
                  txs={watchTxs[i]?.data ?? null}
                  loading={watchTxs[i]?.isLoading ?? false}
                  error={watchTxs[i]?.isError ?? false}
                  onRefresh={() => watchTxs[i]?.refetch()}
                  onOpen={(tx, net, incoming) => setDetail({ kind: "txc", tx, net, incoming })}
                />
              </div>
            ))}
            {wifList.map((w, i) => (
              <div key={w.id} className="mb-6">
                <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-2">
                  {w.label} · imported key
                </h3>
                <WifActivity
                  entry={w}
                  txs={wifTxs[i]?.data ?? null}
                  loading={wifTxs[i]?.isLoading ?? false}
                  error={wifTxs[i]?.isError ?? false}
                  onRefresh={() => wifTxs[i]?.refetch()}
                />
              </div>
            ))}
          </section>
        </div>

        {/* Sticky bottom send/receive — routes based on the active slot.
            Sticky (not fixed) so it stays visible inside the WKWebView frame,
            which clips/contains fixed positioning on iOS. */}
        <div className="sticky bottom-0 z-10 mt-auto shrink-0 border-t border-border/60 bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/80 pb-[env(safe-area-inset-bottom)]">
          <div className="mx-auto max-w-3xl px-4 py-3 flex gap-2">
            {activeWatch ? (
              <WatchOnlyBottomActions wallet={activeWatch} />
            ) : activeWif ? (
              <WifBottomActions entry={activeWif} />
            ) : (
              <BottomActions chain={activeChain} />
            )}
          </div>
        </div>
      </div>
      <TxDetailSheet detail={detail} onClose={() => setDetail(null)} />
      <ReorderTilesSheet open={reorderOpen} onClose={() => setReorderOpen(false)} />
      <WifRemoveDialog entry={wifRemove} onClose={() => setWifRemove(null)} />
      {tileOpen === "txc" && (
        <WalletDetailSheet
          open
          onClose={() => setTileOpen(null)}
          kind="txc"
          balanceText={`${formatTxc(account.data?.balanceSats ?? 0)} TXC`}
          fiatText={
            price.data?.usd != null
              ? formatFiat(satsToTxc(account.data?.balanceSats ?? 0) * price.data.usd)
              : null
          }
          receiveAddress={account.data?.nextReceiveAddress ?? null}
          txCount={txs.data?.length ?? null}
        />
      )}
      {tileOpen === "isk" && (
        <WalletDetailSheet
          open
          onClose={() => setTileOpen(null)}
          kind="isk"
          balanceText={`${formatIsk(iskAccount.data?.balanceSats ?? 0)}`}
          fiatText={
            iskPrice.data?.usd != null
              ? formatFiat(satsToIsk(iskAccount.data?.balanceSats ?? 0) * iskPrice.data.usd)
              : null
          }
          receiveAddress={iskAccount.data?.nextReceiveAddress ?? null}
          txCount={iskTxs.data?.length ?? null}
        />
      )}
      {tileOpen === "btc" && (
        <WalletDetailSheet
          open
          onClose={() => setTileOpen(null)}
          kind="btc"
          balanceText={`${formatBtc(btcAccount.data?.balanceSats ?? 0)}`}
          fiatText={
            btcPrice.data?.usd != null
              ? formatFiat(satsToBtc(btcAccount.data?.balanceSats ?? 0) * btcPrice.data.usd)
              : null
          }
          receiveAddress={btcAccount.data?.nextReceiveAddress ?? null}
          txCount={btcTxs.data?.length ?? null}
        />
      )}
      {tileOpen === "ltc" && (
        <WalletDetailSheet
          open
          onClose={() => setTileOpen(null)}
          kind="ltc"
          balanceText={`${formatLtc(ltcAccount.data?.balanceSats ?? 0)}`}
          fiatText={
            ltcPrice.data?.usd != null
              ? formatFiat(satsToLtc(ltcAccount.data?.balanceSats ?? 0) * ltcPrice.data.usd)
              : null
          }
          receiveAddress={ltcAccount.data?.nextReceiveAddress ?? null}
          txCount={ltcTxs.data?.length ?? null}
        />
      )}
      {tileOpen === "doge" && (
        <WalletDetailSheet
          open
          onClose={() => setTileOpen(null)}
          kind="doge"
          balanceText={`${formatDoge(dogeAccount.data?.balanceSats ?? 0)}`}
          fiatText={
            dogePrice.data?.usd != null
              ? formatFiat(satsToDoge(dogeAccount.data?.balanceSats ?? 0) * dogePrice.data.usd)
              : null
          }
          receiveAddress={dogeAccount.data?.nextReceiveAddress ?? null}
          txCount={dogeTxs.data?.length ?? null}
        />
      )}
      {tileOpen === "tron" && (
        <WalletDetailSheet
          open
          onClose={() => setTileOpen(null)}
          kind="tron"
          address={tronAddress}
          balanceText={formatTrx(tron.balance.data ?? 0)}
          fiatText={
            tron.price.data?.usd != null
              ? formatFiat(sunToTrx(tron.balance.data ?? 0) * tron.price.data.usd)
              : null
          }
          txCount={null}
        />
      )}
      {tileOpen === "solana" && (
        <WalletDetailSheet
          open
          onClose={() => setTileOpen(null)}
          kind="solana"
          address={solanaAccount?.address ?? null}
          balanceText={`${formatSol(solana.balance.data ?? 0)} SOL`}
          fiatText={allPrices.data?.prices?.SOL != null ? formatFiat((solana.balance.data ?? 0) / 1e9 * allPrices.data.prices.SOL) : null}
          txCount={solana.history.data?.length ?? null}
        />
      )}
      {tileOpen && tileOpen !== "txc" && tileOpen !== "btc" && tileOpen !== "isk" && tileOpen !== "ltc" && tileOpen !== "doge" && tileOpen !== "tron" && tileOpen !== "solana" && tileOpen in EVM_CHAINS && (
        <WalletDetailSheet
          open
          onClose={() => setTileOpen(null)}
          kind="evm"
          chainId={tileOpen as EvmChainId}
          address={evmAddress}
          balanceText={(() => {
            const idx = evmEnabled.indexOf(tileOpen as EvmChainId);
            const wei = evmBalances[idx]?.data ?? null;
            const sym = EVM_CHAINS[tileOpen as EvmChainId].nativeSymbol;
            return `${wei != null ? formatEth(wei) : "0"} ${sym}`;
          })()}
          fiatText={(() => {
            const idx = evmEnabled.indexOf(tileOpen as EvmChainId);
            const wei = evmBalances[idx]?.data ?? null;
            const p = allPrices.data?.prices?.[EVM_CHAINS[tileOpen as EvmChainId].priceSymbol];
            if (wei == null || p == null) return null;
            return formatFiat((Number(wei) / 1e18) * p);
          })()}
        />
      )}
      <WatchRemoveDialog wallet={watchRemove} onClose={() => setWatchRemove(null)} />
    </main>
  );
}

function BottomActions({ chain }: { chain: ChainId }) {
  if (chain === "txc") {
    return (
      <>
        <Button asChild size="lg" variant="outline" className="flex-1">
          <Link to="/wallet/receive">
            <QrCode className="h-4 w-4 mr-2" /> Receive
          </Link>
        </Button>
        <Button asChild size="lg" className="flex-1">
          <Link to="/wallet/send">
            <Send className="h-4 w-4 mr-2" /> Send
          </Link>
        </Button>
      </>
    );
  }
  if (chain === "isk") {
    return (
      <>
        <Button asChild size="lg" variant="outline" className="flex-1">
          <Link to="/wallet/isk/receive">
            <QrCode className="h-4 w-4 mr-2" /> Receive
          </Link>
        </Button>
        <Button asChild size="lg" className="flex-1">
          <Link to="/wallet/isk/send">
            <Send className="h-4 w-4 mr-2" /> Send
          </Link>
        </Button>
      </>
    );
  }
  if (chain === "btc") {
    return (
      <>
        <Button asChild size="lg" variant="outline" className="flex-1">
          <Link to="/wallet/btc/receive">
            <QrCode className="h-4 w-4 mr-2" /> Receive
          </Link>
        </Button>
        <Button asChild size="lg" className="flex-1">
          <Link to="/wallet/btc/send">
            <Send className="h-4 w-4 mr-2" /> Send
          </Link>
        </Button>
      </>
    );
  }
  if (chain === "ltc") {
    return (
      <>
        <Button asChild size="lg" variant="outline" className="flex-1">
          <Link to="/wallet/ltc/receive">
            <QrCode className="h-4 w-4 mr-2" /> Receive
          </Link>
        </Button>
        <Button asChild size="lg" className="flex-1">
          <Link to="/wallet/ltc/send">
            <Send className="h-4 w-4 mr-2" /> Send
          </Link>
        </Button>
      </>
    );
  }
  if (chain === "doge") {
    return (
      <>
        <Button asChild size="lg" variant="outline" className="flex-1">
          <Link to="/wallet/doge/receive">
            <QrCode className="h-4 w-4 mr-2" /> Receive
          </Link>
        </Button>
        <Button asChild size="lg" className="flex-1">
          <Link to="/wallet/doge/send">
            <Send className="h-4 w-4 mr-2" /> Send
          </Link>
        </Button>
      </>
    );
  }
  if (chain === "tron") {
    return (
      <>
        <Button asChild size="lg" variant="outline" className="flex-1">
          <Link to="/wallet/tron/receive">
            <QrCode className="h-4 w-4 mr-2" /> Receive
          </Link>
        </Button>
        <Button asChild size="lg" className="flex-1">
          <Link to="/wallet/tron/send">
            <Send className="h-4 w-4 mr-2" /> Send
          </Link>
        </Button>
      </>
    );
  }
  if (chain === "solana") {
    return (
      <>
        <Button asChild size="lg" variant="outline" className="flex-1">
          <Link to="/wallet/solana/receive"><QrCode className="h-4 w-4 mr-2" /> Receive</Link>
        </Button>
        <Button asChild size="lg" className="flex-1">
          <Link to="/wallet/solana/send"><Send className="h-4 w-4 mr-2" /> Send</Link>
        </Button>
      </>
    );
  }
  if (chain in EVM_CHAINS) {
    const c = chain as EvmChainId;
    return (
      <>
        <Button asChild size="lg" variant="outline" className="flex-1">
          <Link to="/wallet/evm/$chain/receive" params={{ chain: c }}>
            <QrCode className="h-4 w-4 mr-2" /> Receive
          </Link>
        </Button>
        <Button asChild size="lg" className="flex-1">
          <Link to="/wallet/evm/$chain/send" params={{ chain: c }}>
            <Send className="h-4 w-4 mr-2" /> Send
          </Link>
        </Button>
      </>
    );
  }


  return (
    <>
      <Button size="lg" variant="outline" disabled className="flex-1">
        <QrCode className="h-4 w-4 mr-2" /> Coming soon
      </Button>
      <Button size="lg" disabled className="flex-1">
        <Send className="h-4 w-4 mr-2" /> Coming soon
      </Button>
    </>
  );
}

function TxcTile({
  balanceSats,
  loading,
  priceUsd,
  onRefresh,
  refreshing,
  label,
  onOpenDetails,
}: {
  balanceSats: number;
  loading: boolean;
  priceUsd: number | null;
  onRefresh: () => void;
  refreshing: boolean;
  label: string;
  onOpenDetails: () => void;
}) {
  const [hidden] = useHideBalances();
  const balanceUsd = priceUsd ? satsToTxc(balanceSats) * priceUsd : null;
  const balText = loading ? "..." : formatTxcCompact(balanceSats);
  const fiatText = balanceUsd != null ? formatFiat(balanceUsd) : "Price unavailable";
  return (
    <button
      type="button"
      onClick={onOpenDetails}
      className="w-full text-left rounded-2xl bg-gradient-to-br from-amber-600 via-orange-700 to-amber-900 p-6 text-white shadow-xl shadow-amber-950/30 active:scale-[0.99] transition-transform"
    >
      <div className="flex items-center justify-between">
        <p className="text-sm text-amber-100/80">{label}</p>
        <span
          role="button"
          tabIndex={0}
          onClick={(e) => {
            e.stopPropagation();
            onRefresh();
          }}
          className="text-amber-100/80 hover:text-white"
          aria-label="Refresh"
        >
          <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
        </span>
      </div>
      <p className="mt-3 text-[10px] uppercase tracking-widest text-amber-100/70">Native</p>
      <p className="mt-0.5 text-4xl font-bold tracking-tight">
        {hidden ? maskAmount(balText) : balText}
        <span className="ml-2 text-2xl font-semibold opacity-90">TXC</span>
      </p>
      <p className="text-amber-100/80 text-sm">
        {hidden ? maskAmount(fiatText) : fiatText}
      </p>
      <div className="mt-3 pt-3 border-t border-white/15">
        <p className="text-[10px] uppercase tracking-widest text-amber-100/70">Chain total</p>
        <p className="text-lg font-semibold">
          {hidden ? maskAmount(fiatText) : fiatText}
        </p>
      </div>
    </button>
  );
}

/**
 * Imported wallets often hold coins on the old app's derivation paths
 * (Bitcoin's coin type, and/or native segwit). They're already scanned and
 * spendable — this just offers to move them onto the legacy 696969' path,
 * which is the only one Omni tokens work on.
 */
function OldPathBanner({
  branches,
}: {
  branches?: { kind: string; balanceSats: number; usedAddresses: number }[];
}) {
  const [dismissed, setDismissed] = useState(false);
  const stray = (branches ?? []).filter((b) => b.kind !== "bip44" && b.balanceSats > 0);
  const total = stray.reduce((s, b) => s + b.balanceSats, 0);
  if (dismissed || stray.length === 0 || total <= 0) return null;
  return (
    <section className="mt-6 px-4">
      <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4">
        <p className="text-sm font-medium">Coins on an old address type</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {formatTxc(total)} TXC sits on derivation paths from your previous wallet. It's safe and
          spendable — move it to your main <span className="font-mono">T…</span> address so tokens
          like TSD work there too.
        </p>
        <div className="mt-3 flex items-center gap-3">
          <Link
            to="/wallet/txc/migrate"
            className="rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-semibold text-amber-950"
          >
            Review & move
          </Link>
          <button
            type="button"
            onClick={() => setDismissed(true)}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            Not now
          </button>
        </div>
      </div>
    </section>
  );
}


function TxcTokens({
  addresses,
  readOnly = false,
  sendFromWifId,
  pendingIn,
}: {
  addresses: string[];
  /** Hides HD-only actions (old paths / consolidate). */
  readOnly?: boolean;
  /** Imported-key wallets can still spend their tokens via the WIF send route. */
  sendFromWifId?: string;
  /** Unconfirmed incoming amounts per property id, from the mempool. */
  pendingIn?: Map<number, bigint>;
}) {
  const localTokens = useEnabledTxcTokens();
  const { resolved: tokens } = useTxcTokenProps(localTokens);
  const fetchBalances = useServerFn(getTxcTokenBalancesForAddresses);
  const [hideSpam] = useFeature("hideSpamTokens");

  const [hidden] = useHideBalances();
  const enabled = addresses.length > 0 && tokens.length > 0;
  const pendingKey = pendingIn
    ? [...pendingIn.entries()].map(([k, v]) => `${k}:${v}`).join(",")
    : "";
  const balances = useQuery({
    queryKey: [
      "txc-token-balances",
      addresses.slice().sort().join(","),
      tokens.map((t) => t.id).join(","),
    ],
    enabled,
    queryFn: () =>
      fetchBalances({
        data: { addresses, propertyIds: tokens.map((t) => t.id) },
      }),
    staleTime: 10_000,
    // Keep token balances close to the mempool view: poll while something is
    // pending so the number flips the instant the transfer confirms.
    refetchInterval: pendingKey ? 10_000 : 30_000,
    refetchOnWindowFocus: true,
  });

  // A new pending transfer means the confirmed balance may be about to change.
  useEffect(() => {
    if (pendingKey) void balances.refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingKey]);

  if (!enabled) return null;

  const rows = tokens.map((t) => {
    const raw = balances.data?.[t.id] ?? "0";
    const units = BigInt(raw);
    return { token: t, units, pending: pendingIn?.get(t.id) ?? 0n };
  });
  const visible = hideSpam
    ? rows.filter((r) => balances.isLoading || r.units > 0n || r.pending > 0n)
    : rows;
  const hiddenCount = rows.length - visible.length;


  return (
    <section className="mt-8 px-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-lg font-semibold">TXC tokens</h2>
        {!readOnly && (
          <div className="flex items-center gap-3">
            <Link
              to="/wallet/txc/migrate"
              className="text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
            >
              Old paths
            </Link>
            <Link
              to="/wallet/txc/consolidate"
              search={{ token: undefined }}
              className="text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
            >
              Consolidate
            </Link>
            <Link
              to="/wallet/receive"
              search={{ asset: "tsd" }}
              className="text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
            >
              Receive
            </Link>
          </div>
        )}
      </div>

      <ul className="space-y-2">

        {visible.map(({ token: t, units, pending }) => {
          const amtStr = formatTokenAmount(units, t.divisible);
          const pendingStr =
            pending > 0n ? formatTokenAmount(pending, t.divisible) : null;
          const inner = (
            <>
              <div className="w-9 h-9 rounded-full flex items-center justify-center text-xs font-bold bg-amber-500/15 text-amber-300">
                {t.symbol.slice(0, 2)}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium">{t.symbol}</p>
                <p className="text-xs text-muted-foreground truncate">
                  {t.name ?? "Omni #" + t.id} · #{t.id}
                </p>
              </div>
              <div className="text-right">
                <p className="text-sm font-semibold">
                  {balances.isLoading && !balances.data
                    ? "…"
                    : hidden
                      ? maskAmount(amtStr)
                      : amtStr}
                </p>
                {pendingStr ? (
                  <p className="text-xs text-amber-400 inline-flex items-center gap-1">
                    <Loader2 className="h-3 w-3 animate-spin" />+
                    {hidden ? maskAmount(pendingStr) : pendingStr} pending
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    {balances.isError && !balances.data ? "unavailable" : "—"}
                  </p>
                )}
              </div>

              {(!readOnly || sendFromWifId) && (
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              )}
            </>
          );
          return (
            <li key={t.id}>
              {sendFromWifId ? (
                <Link
                  to="/wallet/wif/$id/send"
                  params={{ id: sendFromWifId }}
                  search={{ to: undefined, amount: undefined, token: String(t.id) }}
                  className="flex items-center gap-3 rounded-lg border border-border/60 bg-card/40 px-4 py-3 hover:bg-card transition-colors"
                >
                  {inner}
                </Link>
              ) : readOnly ? (
                <div className="flex items-center gap-3 rounded-lg border border-border/60 bg-card/40 px-4 py-3">
                  {inner}
                </div>
              ) : (
                <Link
                  to="/wallet/send"
                  search={{ token: String(t.id) }}
                  className="flex items-center gap-3 rounded-lg border border-border/60 bg-card/40 px-4 py-3 hover:bg-card transition-colors"
                >
                  {inner}
                </Link>
              )}
            </li>
          );
        })}
        {readOnly && !sendFromWifId && visible.some((r) => r.units > 0n) && (
          <li className="text-xs text-muted-foreground pt-1">
            These token balances are view-only — Omni transfers need a legacy T… address with
            its private key.
          </li>
        )}
        {hideSpam && hiddenCount > 0 && (
          <li className="text-xs text-muted-foreground text-center pt-1">
            {hiddenCount} zero-balance {hiddenCount === 1 ? "token" : "tokens"} hidden
          </li>
        )}
      </ul>
    </section>
  );
}

const BTC_FORK_VARIANTS = {
  isk: {
    ticker: "ISK",
    gradient: "from-emerald-500 via-green-700 to-emerald-900",
    shadow: "shadow-emerald-950/30",
    subText: "text-emerald-50/80",
    subTextFaint: "text-emerald-50/70",
    mempoolHost: "mempool.iskandercoin.com",
    txLabel: "IskanderCoin",
    toCoin: satsToIsk,
    formatCompact: formatIskCompact,
    format: formatIsk,
  },
  btc: {
    ticker: "BTC",
    gradient: "from-orange-400 via-orange-600 to-amber-900",
    shadow: "shadow-orange-950/30",
    subText: "text-orange-50/80",
    subTextFaint: "text-orange-50/70",
    mempoolHost: "mempool.space",
    txLabel: "Bitcoin",
    toCoin: satsToBtc,
    formatCompact: formatBtcCompact,
    format: formatBtc,
  },
  ltc: {
    ticker: "LTC",
    gradient: "from-slate-500 via-slate-700 to-slate-900",
    shadow: "shadow-slate-950/30",
    subText: "text-slate-50/80",
    subTextFaint: "text-slate-50/70",
    mempoolHost: "litecoinspace.org",
    txLabel: "Litecoin",
    toCoin: satsToLtc,
    formatCompact: formatLtcCompact,
    format: formatLtc,
  },
  doge: {
    ticker: "DOGE",
    gradient: "from-yellow-500 via-amber-600 to-yellow-800",
    shadow: "shadow-amber-950/30",
    subText: "text-amber-50/80",
    subTextFaint: "text-amber-50/70",
    mempoolHost: "doge1.trezor.io",
    txLabel: "Dogecoin",
    toCoin: satsToDoge,
    formatCompact: formatDogeCompact,
    format: formatDoge,
  },
} as const;

type BtcForkVariant = keyof typeof BTC_FORK_VARIANTS;
type AnyBtcForkTx = IskMempoolTx | LtcMempoolTx | DogeMempoolTx | BtcMempoolTx;

/** Build the in-page detail sheet payload for any BTC-fork chain transaction. */
function utxoTxDetail(
  variant: BtcForkVariant,
  tx: AnyBtcForkTx,
  net: number,
  incoming: boolean,
): TxDetail {
  const v = BTC_FORK_VARIANTS[variant];
  return {
    kind: "utxo",
    tx,
    net,
    incoming,
    formatAmount: (sats) => v.format(sats),
    explorerTxUrl: (txid) => `https://${v.mempoolHost}/tx/${txid}`,
    explorerName: v.mempoolHost,
  };
}

function BtcForkTile({
  variant,
  balanceSats,
  loading,
  priceUsd,
  onRefresh,
  refreshing,
  label,
  onOpenDetails,
}: {
  variant: BtcForkVariant;
  balanceSats: number;
  loading: boolean;
  priceUsd: number | null;
  onRefresh: () => void;
  refreshing: boolean;
  label: string;
  onOpenDetails: () => void;
}) {
  const [hidden] = useHideBalances();
  const [utxoSwapPref] = useFeature("utxoSwap");
  const exchangeAllowed = useExchangeFeaturesAllowed();
  const utxoSwapEnabled = utxoSwapPref && exchangeAllowed;
  const v = BTC_FORK_VARIANTS[variant];
  const balanceUsd = priceUsd ? v.toCoin(balanceSats) * priceUsd : null;
  const balText = loading ? "..." : v.formatCompact(balanceSats);
  const fiatText = balanceUsd != null ? formatFiat(balanceUsd) : "Price unavailable";
  return (
    <button
      type="button"
      onClick={onOpenDetails}
      className={`w-full text-left rounded-2xl bg-gradient-to-br ${v.gradient} p-6 text-white shadow-xl ${v.shadow} active:scale-[0.99] transition-transform`}
    >
      <div className="flex items-center justify-between">
        <p className={`text-sm ${v.subText}`}>{label}</p>
        <div className="flex items-center gap-2">
          {utxoSwapEnabled && (variant === "ltc" || variant === "doge") && (
            <Link
              to={variant === "ltc" ? "/wallet/ltc/swap" : "/wallet/doge/swap"}
              onClick={(e) => e.stopPropagation()}
              className="inline-flex items-center gap-1 rounded-full bg-white/15 hover:bg-white/25 px-2.5 py-1 text-[11px] font-medium"
              aria-label={`Swap ${v.ticker}`}
            >
              <ArrowLeftRight className="h-3 w-3" /> Swap
            </Link>
          )}
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              onRefresh();
            }}
            className={`${v.subText} hover:text-white`}
            aria-label="Refresh"
          >
            <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
          </span>
        </div>
      </div>

      <p className={`mt-3 text-[10px] uppercase tracking-widest ${v.subTextFaint}`}>Native</p>
      <p className="mt-0.5 text-4xl font-bold tracking-tight">
        {hidden ? maskAmount(balText) : balText}
        <span className="ml-2 text-2xl font-semibold opacity-90">{v.ticker}</span>
      </p>
      <p className={`${v.subText} text-sm`}>
        {hidden ? maskAmount(fiatText) : fiatText}
      </p>
      <div className="mt-3 pt-3 border-t border-white/15">
        <p className={`text-[10px] uppercase tracking-widest ${v.subTextFaint}`}>Chain total</p>
        <p className="text-lg font-semibold">
          {hidden ? maskAmount(fiatText) : fiatText}
        </p>
      </div>
    </button>
  );
}

function BtcForkActivity({
  variant,
  loading,
  error,
  txs,
  ownAddresses,
  onRefresh,
  onOpen,
}: {
  variant: BtcForkVariant;
  loading: boolean;
  error: boolean;
  txs: AnyBtcForkTx[] | null;
  ownAddresses: Set<string>;
  onRefresh: () => void;
  onOpen: (tx: AnyBtcForkTx, net: number, incoming: boolean) => void;
}) {
  const v = BTC_FORK_VARIANTS[variant];
  return (
    <section>
      {loading && !txs ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-16 rounded-lg bg-muted/40 animate-pulse" />
          ))}
        </div>
      ) : error ? (
        <Card>
          <CardContent className="pt-6 text-sm text-muted-foreground">
            Couldn't reach {v.mempoolHost}.
          </CardContent>
        </Card>
      ) : (txs?.length ?? 0) === 0 ? (
        <Card>
          <CardContent className="pt-6 text-sm text-muted-foreground">
            No {v.txLabel} transactions yet.
          </CardContent>
        </Card>
      ) : (
        <ul className="space-y-2">
          {txs!.slice(0, 50).map((tx) => {
            const inSum = tx.vin
              .filter(
                (vv) =>
                  vv.prevout?.scriptpubkey_address &&
                  ownAddresses.has(vv.prevout?.scriptpubkey_address),
              )
              .reduce((s, vv) => s + (vv.prevout?.value ?? 0), 0);
            const outToOwn = tx.vout
              .filter(
                (vv) =>
                  vv.scriptpubkey_address && ownAddresses.has(vv.scriptpubkey_address),
              )
              .reduce((s, vv) => s + vv.value, 0);
            const net = outToOwn - inSum;
            const incoming = net > 0;
            return (
              <li key={tx.txid}>
                <button
                  className="w-full flex items-center gap-3 rounded-lg border border-border/60 bg-card/40 px-4 py-3 text-left hover:bg-accent/40 transition-colors"
                  onClick={() => onOpen(tx, net, incoming)}
                >
                  <div
                    className={`w-9 h-9 rounded-full flex items-center justify-center ${
                      incoming
                        ? "bg-emerald-500/15 text-emerald-400"
                        : "bg-rose-500/15 text-rose-400"
                    }`}
                  >
                    {incoming ? (
                      <ArrowDown className="h-4 w-4" />
                    ) : (
                      <ArrowUp className="h-4 w-4" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium">{incoming ? "Received" : "Sent"}</p>
                    <p className="text-xs text-muted-foreground truncate">
                      {tx.status.confirmed
                        ? new Date((tx.status.block_time ?? 0) * 1000).toLocaleString()
                        : "Pending"}
                    </p>
                  </div>
                  <div className="text-right">
                    <p
                      className={`text-sm font-semibold ${incoming ? "text-emerald-400" : ""}`}
                    >
                      {incoming ? "+" : "−"}
                      {v.format(Math.abs(net))}
                    </p>
                  </div>
                  <ChevronRight className="h-4 w-4 text-muted-foreground" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}



function EvmTile({
  chainId,
  address,
  label,
  balanceWei,
  loading,
  priceUsd,
  onRefresh,
  onOpenDetails,
}: {
  chainId: EvmChainId;
  address: string | null;
  label: string;
  balanceWei: bigint | null;
  loading: boolean;
  priceUsd: number | null;
  onRefresh: () => void | Promise<void>;
  onOpenDetails: () => void;
}) {
  const [hidden] = useHideBalances();
  const [refreshing, setRefreshing] = useState(false);
  const [evmSwapPref] = useFeature("evmSwap");
  const exchangeAllowed = useExchangeFeaturesAllowed();
  // Zero Chill has no DEX aggregator coverage yet — no swap entry point.
  const swapEnabled = evmSwapPref && exchangeAllowed && chainId !== "zcu";


  const meta = EVM_CHAINS[chainId];
  const balanceEth = balanceWei != null ? Number(balanceWei) / 1e18 : null;
  const balanceUsd = balanceEth != null && priceUsd != null ? balanceEth * priceUsd : null;
  const rawEthText = balanceWei != null ? formatEth(balanceWei) : "0";
  const compactEthText = compactNumberString(rawEthText, 10, 5);
  const balText = loading ? "..." : `${compactEthText} ${meta.nativeSymbol}`;
  const fiatText =
    balanceUsd != null ? formatFiat(balanceUsd) : priceUsd == null ? "Price unavailable" : "—";

  // Token balances on this chain (USDC/USDT are ~$1 stables — safe to treat as USD 1:1)
  const tokens = useTokensForChain(chainId);
  const tokenBalances = useQueries({
    queries: tokens.map((t) => ({
      queryKey: ["erc20-balance", chainId, t.address, address],
      enabled: !!address,
      queryFn: () => readErc20Balance(chainId, t, address as `0x${string}`),
      staleTime: 30_000,
    })),
  });
  const tokensUsd = tokens.reduce((sum, t, i) => {
    const raw = tokenBalances[i]?.data ?? 0n;
    if (raw <= 0n) return sum;
    const amt = Number(tokenAmountFromRaw(raw, t.decimals));
    // Stables are USD-pegged; if we ever add non-stable ERC-20s, price them here.
    return sum + amt;
  }, 0);
  const chainTotalUsd =
    balanceUsd != null || tokensUsd > 0 ? (balanceUsd ?? 0) + tokensUsd : null;
  const chainTotalText = chainTotalUsd != null ? formatFiat(chainTotalUsd) : "—";

  return (
    <button
      type="button"
      onClick={onOpenDetails}
      className="w-full text-left rounded-2xl p-6 text-white shadow-xl active:scale-[0.99] transition-transform"
      style={{ background: `linear-gradient(135deg, ${meta.accent} 0%, ${meta.accent}CC 60%, #111 140%)` }}
    >
      <div className="flex items-center justify-between">
        <p className="text-sm opacity-80 truncate">{label}</p>
        <div className="flex items-center gap-2">
          {swapEnabled && (
            <Link
              to="/wallet/evm/$chain/swap"
              params={{ chain: chainId }}
              onClick={(e) => e.stopPropagation()}
              className="inline-flex items-center gap-1 rounded-full bg-white/15 hover:bg-white/25 px-2.5 py-1 text-[11px] font-medium"
              aria-label="Swap"
            >
              <ArrowLeftRight className="h-3 w-3" /> Swap
            </Link>
          )}
          <span
            role="button"
            tabIndex={0}
            onClick={async (e) => {
              e.stopPropagation();
              if (refreshing) return;
              setRefreshing(true);
              try {
                await onRefresh();
              } finally {
                setRefreshing(false);
              }
            }}
            className="opacity-80 hover:opacity-100"
            aria-label="Refresh"
          >
            <RefreshCw
              className={`h-4 w-4 ${refreshing || loading ? "animate-spin" : ""}`}
            />
          </span>
        </div>
      </div>


      <p className="mt-3 text-[10px] uppercase tracking-widest opacity-70">Native</p>
      <p className="mt-0.5 text-4xl font-bold tracking-tight">
        {hidden ? maskAmount(balText) : balText}
      </p>
      <p className="text-sm opacity-80">{hidden ? maskAmount(fiatText) : fiatText}</p>
      <div className="mt-3 pt-3 border-t border-white/15">
        <p className="text-[10px] uppercase tracking-widest opacity-70">Chain total</p>
        <p className="text-lg font-semibold">
          {hidden ? maskAmount(chainTotalText) : chainTotalText}
        </p>
      </div>
    </button>
  );
}

function EvmActivity({
  chainId,
  address,
  onOpen,
}: {
  chainId: EvmChainId;
  address: string | null;
  onOpen: (t: import("@/lib/chains/history.functions").EvmTransfer) => void;
}) {
  const meta = EVM_CHAINS[chainId];
  const fetchHistory = useServerFn(getEvmHistory);
  const tokens = useTokensForChain(chainId);

  const tokenBalances = useQueries({
    queries: tokens.map((t) => ({
      queryKey: ["erc20-balance", chainId, t.address, address],
      enabled: !!address,
      queryFn: () => readErc20Balance(chainId, t, address as `0x${string}`),
      staleTime: 30_000,
      retry: 3,
      retryDelay: (attempt: number) => Math.min(1000 * 2 ** attempt, 8000),
    })),
  });

  const history = useQuery({
    queryKey: ["evm-history", chainId, address],
    enabled: !!address,
    queryFn: () => fetchHistory({ data: { chain: chainId, address: address! } }),
    staleTime: 20_000,
    refetchInterval: 45_000,
  });
  const [hideSpam] = useFeature("hideSpamTokens");
  const visibleTokens = useMemo(() => {
    if (!hideSpam) return tokens.map((t, i) => ({ token: t, index: i }));
    return tokens
      .map((t, i) => ({ token: t, index: i }))
      .filter(({ index }) => {
        const q = tokenBalances[index];
        // Hide zero balances only after the query settles — avoid flicker while loading.
        if (q?.isLoading || q?.isError) return true;
        return (q?.data ?? 0n) > 0n;
      });
  }, [tokens, tokenBalances, hideSpam]);
  const hiddenTokenCount = tokens.length - visibleTokens.length;
  const transfersList = history.data?.transfers ?? [];
  const visibleTransfers = useMemo(() => {
    return hideSpam ? transfersList.filter((t) => !t.spam) : transfersList;
  }, [transfersList, hideSpam]);
  const spamCount = transfersList.length - visibleTransfers.length;

  // Locally-tracked sends: shown at the top until the indexer catches up.
  const indexedHashes = useMemo(
    () => transfersList.map((t) => t.hash),
    [transfersList],
  );
  const pending = usePendingTxs(chainId, address, indexedHashes);
  // Once a tx confirms, refresh indexed history so the real row replaces ours.
  const qc = useQueryClient();
  const confirmedCount = pending.filter((p) => p.status).length;
  useEffect(() => {
    if (confirmedCount > 0) {
      qc.invalidateQueries({ queryKey: ["evm-history", chainId, address] });
      qc.invalidateQueries({ queryKey: ["evm-balance", chainId, address] });
    }
  }, [confirmedCount, qc, chainId, address]);

  return (
    <>
      <section>
        <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground mb-2">Tokens</h2>
        <ul className="space-y-2">
          {visibleTokens.map(({ token: t, index: i }) => {
            const q = tokenBalances[i];
            const raw = q?.data ?? 0n;
            const amt = raw > 0n ? tokenAmountFromRaw(raw, t.decimals) : "0";
            const isStable = t.symbol.startsWith("USD");
            const accent =
              t.symbol === "USDC"
                ? "bg-blue-500/15 text-blue-400"
                : t.symbol === "USDT"
                  ? "bg-emerald-500/15 text-emerald-400"
                  : "bg-muted text-foreground";
            return (
              <li key={t.address}>
                <Link
                  to="/wallet/evm/$chain/send"
                  params={{ chain: chainId }}
                  search={{ asset: t.symbol }}
                  className="flex items-center gap-3 rounded-lg border border-border/60 bg-card/40 px-4 py-3 hover:bg-card transition-colors"
                >
                  <div className={`w-9 h-9 rounded-full flex items-center justify-center text-xs font-bold ${accent}`}>
                    $
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium">{t.symbol}</p>
                    <p className="text-xs text-muted-foreground">on {meta.name}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-semibold">
                      {q?.isLoading && q?.data == null ? "…" : Number(amt).toLocaleString(undefined, { maximumFractionDigits: 4 })}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {q?.data == null && q?.isError ? "unavailable" : isStable ? formatFiat(Number(amt)) : "—"}
                    </p>
                  </div>
                  <ChevronRight className="h-4 w-4 text-muted-foreground" />
                </Link>
              </li>
            );
          })}
          {hideSpam && hiddenTokenCount > 0 && (
            <li className="text-xs text-muted-foreground text-center pt-1">
              {hiddenTokenCount} zero-balance {hiddenTokenCount === 1 ? "token" : "tokens"} hidden
            </li>
          )}
        </ul>
      </section>


      <section className="mt-4">
        {pending.length > 0 && (
          <ul className="space-y-2 mb-2">
            {pending.map((p) => {
              const reverted = p.status === "reverted";
              const confirmed = p.status === "success";
              return (
                <li key={p.hash}>
                  <div className="w-full flex items-center gap-3 rounded-lg border border-dashed border-border/70 bg-card/30 px-4 py-3">
                    <div
                      className={`w-9 h-9 rounded-full flex items-center justify-center ${
                        reverted
                          ? "bg-rose-500/15 text-rose-400"
                          : confirmed
                            ? "bg-emerald-500/15 text-emerald-400"
                            : "bg-amber-500/15 text-amber-400"
                      }`}
                    >
                      {confirmed ? (
                        <ArrowUp className="h-4 w-4" />
                      ) : (
                        <Loader2 className={`h-4 w-4 ${reverted ? "" : "animate-spin"}`} />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium">
                        Sent
                        <span
                          className={`ml-2 text-[10px] uppercase tracking-wide ${
                            reverted
                              ? "text-rose-400"
                              : confirmed
                                ? "text-emerald-400"
                                : "text-amber-400"
                          }`}
                        >
                          {reverted ? "reverted" : confirmed ? "confirmed" : "pending"}
                        </span>
                      </p>
                      <a
                        href={meta.explorerTx(p.hash)}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs text-muted-foreground underline truncate block"
                      >
                        {p.hash.slice(0, 10)}…{p.hash.slice(-8)}
                      </a>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-semibold">
                        −{Number(p.value).toLocaleString(undefined, { maximumFractionDigits: 6 })}{" "}
                        {p.asset}
                      </p>
                      <button
                        type="button"
                        className="text-[10px] text-muted-foreground hover:text-foreground"
                        onClick={() => removePendingTx(p.hash)}
                      >
                        dismiss
                      </button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {history.isLoading ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-16 rounded-lg bg-muted/40 animate-pulse" />
            ))}
          </div>
        ) : !history.data?.supported ? (
          <Card>
            <CardContent className="pt-6 text-sm text-muted-foreground">
              History for {meta.name} isn't indexed here yet.{" "}
              {address && (
                <a
                  href={meta.explorerAddress(address)}
                  target="_blank"
                  rel="noreferrer"
                  className="underline"
                >
                  Open in {meta.shortName} explorer
                </a>
              )}
            </CardContent>
          </Card>
        ) : visibleTransfers.length === 0 ? (
          <Card>
            <CardContent className="pt-6 text-sm text-muted-foreground">
              {history.data?.unavailable ? (
                <>
                  {meta.name} activity can't be loaded right now — the block
                  explorer isn't responding. Your balance is unaffected.{" "}
                  {address && (
                    <a
                      href={meta.explorerAddress(address)}
                      target="_blank"
                      rel="noreferrer"
                      className="underline"
                    >
                      Open in {meta.shortName} explorer
                    </a>
                  )}
                </>
              ) : spamCount > 0
                ? `${spamCount} spam / imposter ${spamCount === 1 ? "transfer" : "transfers"} hidden. Toggle "Hide worthless / spam tokens" in Settings to view.`
                : `No transactions on ${meta.name} yet.`}
            </CardContent>
          </Card>
        ) : (
          <ul className="space-y-2">
            {visibleTransfers.map((t) => (
              <li key={`${t.hash}-${t.category}-${t.outgoing ? "o" : "i"}`}>
                <button
                  type="button"
                  onClick={() => onOpen(t)}
                  className="w-full flex items-center gap-3 rounded-lg border border-border/60 bg-card/40 px-4 py-3 hover:bg-card transition-colors text-left"
                >
                  <div
                    className={`w-9 h-9 rounded-full flex items-center justify-center ${
                      t.outgoing ? "bg-rose-500/15 text-rose-400" : "bg-emerald-500/15 text-emerald-400"
                    }`}
                  >
                    {t.outgoing ? <ArrowUp className="h-4 w-4" /> : <ArrowDown className="h-4 w-4" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium">
                      {t.outgoing ? "Sent" : "Received"}
                      {t.spam && (
                        <span className="ml-2 text-[10px] uppercase tracking-wide text-amber-400/80">
                          suspicious
                        </span>
                      )}
                    </p>
                    <p className="text-xs text-muted-foreground truncate">
                      {t.timestamp ? new Date(t.timestamp).toLocaleString() : `Block ${t.blockNum}`}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className={`text-sm font-semibold ${t.outgoing ? "" : "text-emerald-400"}`}>
                      {t.outgoing ? "−" : "+"}
                      {Number(t.value).toLocaleString(undefined, { maximumFractionDigits: 6 })} {t.asset}
                    </p>
                  </div>
                  <ChevronRight className="h-4 w-4 text-muted-foreground" />
                </button>
              </li>
            ))}
            {hideSpam && spamCount > 0 && (
              <li className="pt-1 text-center text-xs text-muted-foreground">
                {spamCount} spam / imposter {spamCount === 1 ? "transfer" : "transfers"} hidden
              </li>
            )}
          </ul>
        )}
      </section>
    </>
  );
}

/**
 * Watch-only tile. Distinct dark/slate treatment + Eye badge so it reads at a
 * glance as "look but don't touch" — no send button, no key material.
 */
function WatchOnlyTile({
  wallet,
  stats,
  loading,
  priceUsd,
  onRefresh,
  onOpenDetails,
}: {
  wallet: WatchWallet;
  stats: import("@/lib/txc/mempool").MempoolAddressStats | null;
  loading: boolean;
  priceUsd: number | null;
  onRefresh: () => void;
  onOpenDetails: () => void;
}) {
  const [hidden] = useHideBalances();
  const balSats = stats
    ? stats.chain_stats.funded_txo_sum -
      stats.chain_stats.spent_txo_sum +
      stats.mempool_stats.funded_txo_sum -
      stats.mempool_stats.spent_txo_sum
    : 0;
  const meta = WATCH_CHAIN_META[wallet.chain];
  const balUsd = priceUsd != null ? meta.toCoin(balSats) * priceUsd : null;
  const balText = loading && !stats ? "..." : meta.formatCompact(balSats);
  const fiatText = balUsd != null ? formatFiat(balUsd) : "Price unavailable";
  return (
    <button
      type="button"
      onClick={onOpenDetails}
      className="w-full text-left rounded-2xl p-6 text-white shadow-xl shadow-black/40 active:scale-[0.99] transition-transform relative overflow-hidden"
      style={{
        background:
          "linear-gradient(135deg, #1f2937 0%, #0f172a 55%, #000 140%)",
      }}
    >
      {/* subtle diagonal hatch so watch-only reads differently from live tiles */}
      <div
        aria-hidden
        className="absolute inset-0 opacity-[0.06] pointer-events-none"
        style={{
          backgroundImage:
            "repeating-linear-gradient(135deg, #fff 0 2px, transparent 2px 10px)",
        }}
      />
      <div className="relative">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 min-w-0">
            <span className="inline-flex items-center gap-1 rounded-full bg-white/10 px-2 py-0.5 text-[10px] uppercase tracking-wide">
              <Eye className="h-3 w-3" /> Watch-only
            </span>
            <p className="text-sm text-white/80 truncate">{wallet.label}</p>
          </div>
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              onRefresh();
            }}
            className="text-white/70 hover:text-white"
            aria-label="Refresh"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </span>
        </div>
        <p className="mt-2 text-4xl font-bold tracking-tight">
          {hidden ? maskAmount(balText) : balText}
          <span className="ml-2 text-2xl font-semibold opacity-90">{meta.ticker}</span>
        </p>
        <p className="text-white/70 text-sm">{hidden ? maskAmount(fiatText) : fiatText}</p>
        <p className="mt-3 text-[11px] font-mono text-white/50 truncate">
          {wallet.address}
        </p>
      </div>
    </button>
  );
}

/**
 * Activity list for a watch-only address. We only know one address, so
 * incoming/outgoing is inferred by whether that address appears in vouts
 * (received) or as an input's prevout (spent).
 */
function WatchOnlyActivity({
  wallet,
  txs,
  loading,
  error,
  onRefresh,
  onOpen,
}: {
  wallet: WatchWallet;
  txs: MempoolTx[] | null;
  loading: boolean;
  error: boolean;
  onRefresh: () => void;
  onOpen: (tx: MempoolTx, net: number, incoming: boolean) => void;
}) {
  const own = wallet.address;
  const meta = WATCH_CHAIN_META[wallet.chain];
  return (
    <section>
      {loading && !txs ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-16 rounded-lg bg-muted/40 animate-pulse" />
          ))}
        </div>
      ) : error ? (
        <Card>
          <CardContent className="pt-6 text-sm text-muted-foreground">
            Couldn't reach the {meta.ticker} explorer.
          </CardContent>
        </Card>
      ) : (txs?.length ?? 0) === 0 ? (
        <Card>
          <CardContent className="pt-6 text-sm text-muted-foreground">
            No transactions on this address yet.
          </CardContent>
        </Card>
      ) : (
        <ul className="space-y-2">
          {txs!.slice(0, 50).map((tx) => {
            const inSum = tx.vin
              .filter((v) => v.prevout?.scriptpubkey_address === own)
              .reduce((s, v) => s + (v.prevout?.value ?? 0), 0);
            const outToOwn = tx.vout
              .filter((v) => v.scriptpubkey_address === own)
              .reduce((s, v) => s + v.value, 0);
            const net = outToOwn - inSum;
            const incoming = net > 0;
            return (
              <li key={tx.txid}>
                <button
                  type="button"
                  onClick={() => onOpen(tx, net, incoming)}
                  className="w-full flex items-center gap-3 rounded-lg border border-border/60 bg-card/40 px-4 py-3 hover:bg-card transition-colors text-left"
                >
                  <div
                    className={`w-9 h-9 rounded-full flex items-center justify-center ${
                      incoming
                        ? "bg-emerald-500/15 text-emerald-400"
                        : "bg-rose-500/15 text-rose-400"
                    }`}
                  >
                    {incoming ? (
                      <ArrowDown className="h-4 w-4" />
                    ) : (
                      <ArrowUp className="h-4 w-4" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium">{incoming ? "Received" : "Sent"}</p>
                    <p className="text-xs text-muted-foreground truncate">
                      {tx.status.confirmed
                        ? new Date((tx.status.block_time ?? 0) * 1000).toLocaleString()
                        : "Pending"}
                    </p>
                  </div>
                  <div className="text-right">
                    <p
                      className={`text-sm font-semibold ${incoming ? "text-emerald-400" : ""}`}
                    >
                      {incoming ? "+" : "−"}
                      {meta.format(Math.abs(net))}
                    </p>
                  </div>
                  <ChevronRight className="h-4 w-4 text-muted-foreground" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/**
 * Bottom actions when a watch-only tile is active. Receive shows the address
 * (people scanning a Cold Storage Coin often want to display it again to a
 * payer); Send is intentionally disabled — we don't hold the key.
 */
function WatchOnlyBottomActions({ wallet }: { wallet: WatchWallet }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="lg" variant="outline" onClick={() => setOpen(true)}>
        <QrCode className="h-4 w-4 mr-2" /> Show address
      </Button>
      <Button size="lg" disabled title="Watch-only wallets cannot send">
        <Lock className="h-4 w-4 mr-2" /> Watch-only
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Eye className="h-5 w-5" /> {wallet.label}
            </DialogTitle>
            <DialogDescription>
              Watch-only address. Share to receive {WATCH_CHAIN_META[wallet.chain].ticker} — signing must happen on the
              device that holds the key (e.g. your Cold Storage Coin).
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col items-center gap-3">
            <div className="rounded-lg bg-white p-3">
              <QrCodeSvg value={wallet.address} size={220} />
            </div>
            <code className="text-xs break-all text-center px-2">{wallet.address}</code>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * Confirm removing a watch-only entry. Since no key material is stored, this
 * is purely cosmetic — the address on-chain is untouched — but we still ask
 * before deleting so a stray long-press doesn't nuke someone's tile.
 */
function WatchRemoveDialog({
  wallet,
  onClose,
}: {
  wallet: WatchWallet | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={!!wallet} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{wallet?.label ?? "Watch-only wallet"}</DialogTitle>
          <DialogDescription>
            Watch-only · {wallet?.chain.toUpperCase()}
          </DialogDescription>
        </DialogHeader>
        {wallet && (
          <div className="space-y-3">
            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground mb-1">
                Address
              </p>
              <p className="font-mono text-xs break-all rounded-md border border-border/60 bg-card/40 px-3 py-2">
                {wallet.address}
              </p>
            </div>
            <p className="text-xs text-muted-foreground">
              Removing only deletes the tile from this app. The address itself
              is not affected on-chain — you can add it back anytime.
            </p>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              if (wallet) removeWatchWallet(wallet.id);
              onClose();
            }}
          >
            <Trash2 className="h-4 w-4 mr-1" /> Remove
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}


/**
 * Tile for an imported single-key (WIF) wallet. Colored per chain, with a
 * "Key" chip so it reads visually distinct from HD-derived tiles.
 */
function WifTile({
  entry,
  stats,
  loading,
  priceUsd,
  onRefresh,
  onOpenDetails,
}: {
  entry: WifWalletEntry;
  stats: import("@/lib/txc/mempool").MempoolAddressStats | null;
  loading: boolean;
  priceUsd: number | null;
  onRefresh: () => void;
  onOpenDetails: () => void;
}) {
  const [hidden] = useHideBalances();
  const balSats = stats
    ? stats.chain_stats.funded_txo_sum -
      stats.chain_stats.spent_txo_sum +
      stats.mempool_stats.funded_txo_sum -
      stats.mempool_stats.spent_txo_sum
    : 0;
  const isIsk = entry.chain === "isk";
  const balCoins = isIsk ? satsToIsk(balSats) : satsToTxc(balSats);
  const balUsd = priceUsd != null ? balCoins * priceUsd : null;
  const balText = loading && !stats
    ? "..."
    : isIsk
      ? formatIskCompact(balSats)
      : formatTxcCompact(balSats);
  const fiatText = balUsd != null ? formatFiat(balUsd) : "Price unavailable";
  const symbol = isIsk ? "ISK" : "TXC";
  const bg = isIsk
    ? "linear-gradient(135deg, #065f46 0%, #064e3b 55%, #022c22 140%)"
    : "linear-gradient(135deg, #4c1d95 0%, #312e81 55%, #1e1b4b 140%)";
  return (
    <button
      type="button"
      onClick={onOpenDetails}
      className="w-full text-left rounded-2xl p-6 text-white shadow-xl shadow-black/40 active:scale-[0.99] transition-transform relative overflow-hidden"
      style={{ background: bg }}
    >
      <div className="relative">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 min-w-0">
            <span className="inline-flex items-center gap-1 rounded-full bg-white/10 px-2 py-0.5 text-[10px] uppercase tracking-wide">
              <Key className="h-3 w-3" /> Imported key
            </span>
            <p className="text-sm text-white/80 truncate">{entry.label}</p>
          </div>
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              onRefresh();
            }}
            className="text-white/70 hover:text-white"
            aria-label="Refresh"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </span>
        </div>
        <p className="mt-2 text-4xl font-bold tracking-tight">
          {hidden ? maskAmount(balText) : balText}
          <span className="ml-2 text-2xl font-semibold opacity-90">{symbol}</span>
        </p>
        <p className="text-white/70 text-sm">{hidden ? maskAmount(fiatText) : fiatText}</p>
        <p className="mt-3 text-[11px] font-mono text-white/50 truncate">{entry.address}</p>
      </div>
    </button>
  );
}

/**
 * Activity feed for a WIF wallet — same shape as the watch-only view since
 * we're inspecting a single address on a single chain.
 */
function WifActivity({
  entry,
  txs,
  loading,
  error,
  onRefresh,
}: {
  entry: WifWalletEntry;
  txs: MempoolTx[] | null;
  loading: boolean;
  error: boolean;
  onRefresh: () => void;
}) {
  const own = entry.address;
  const isIsk = entry.chain === "isk";
  const fmt = (n: number) => (isIsk ? formatIsk(n) : formatTxc(n));
  return (
    <section>
      {loading && !txs ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-16 rounded-lg bg-muted/40 animate-pulse" />
          ))}
        </div>
      ) : error ? (
        <Card>
          <CardContent className="pt-6 text-sm text-muted-foreground">
            Couldn't reach the {isIsk ? "ISK" : "TXC"} mempool.
          </CardContent>
        </Card>
      ) : (txs?.length ?? 0) === 0 ? (
        <Card>
          <CardContent className="pt-6 text-sm text-muted-foreground">
            No transactions on this address yet.
          </CardContent>
        </Card>
      ) : (
        <ul className="space-y-2">
          {txs!.slice(0, 50).map((tx) => {
            const inSum = tx.vin
              .filter((v) => v.prevout?.scriptpubkey_address === own)
              .reduce((s, v) => s + (v.prevout?.value ?? 0), 0);
            const outToOwn = tx.vout
              .filter((v) => v.scriptpubkey_address === own)
              .reduce((s, v) => s + v.value, 0);
            const net = outToOwn - inSum;
            const incoming = net > 0;
            return (
              <li key={tx.txid}>
                <div className="w-full flex items-center gap-3 rounded-lg border border-border/60 bg-card/40 px-4 py-3">
                  <div
                    className={`w-9 h-9 rounded-full flex items-center justify-center ${
                      incoming
                        ? "bg-emerald-500/15 text-emerald-400"
                        : "bg-rose-500/15 text-rose-400"
                    }`}
                  >
                    {incoming ? <ArrowDown className="h-4 w-4" /> : <ArrowUp className="h-4 w-4" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium">{incoming ? "Received" : "Sent"}</p>
                    <p className="text-xs text-muted-foreground truncate">
                      {tx.status.confirmed
                        ? new Date((tx.status.block_time ?? 0) * 1000).toLocaleString()
                        : "Pending"}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className={`text-sm font-semibold ${incoming ? "text-emerald-400" : ""}`}>
                      {incoming ? "+" : "−"}
                      {fmt(Math.abs(net))}
                    </p>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/**
 * Bottom actions when a WIF tile is active — routes to the dedicated
 * per-entry send/receive screens.
 */
function WifBottomActions({ entry }: { entry: WifWalletEntry }) {
  return (
    <>
      <Button asChild size="lg" variant="outline">
        <Link to="/wallet/wif/$id/receive" params={{ id: entry.id }}>
          <QrCode className="h-4 w-4 mr-2" /> Receive
        </Link>
      </Button>
      <Button asChild size="lg">
        <Link to="/wallet/wif/$id/send" params={{ id: entry.id }}>
          <Send className="h-4 w-4 mr-2" /> Send
        </Link>
      </Button>
    </>
  );
}

/**
 * Confirm removing an imported key. This deletes the encrypted WIF and the
 * tile — funds remain on-chain, but you'll need the original private key to
 * spend them again. We spell that out loudly.
 */
function WifRemoveDialog({
  entry,
  onClose,
}: {
  entry: WifWalletEntry | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={!!entry} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{entry?.label ?? "Imported key"}</DialogTitle>
          <DialogDescription>
            Imported private key · {entry?.chain.toUpperCase()}
          </DialogDescription>
        </DialogHeader>
        {entry && (
          <div className="space-y-3">
            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground mb-1">
                Address
              </p>
              <p className="font-mono text-xs break-all rounded-md border border-border/60 bg-card/40 px-3 py-2">
                {entry.address}
              </p>
            </div>
            <p className="text-xs text-rose-400">
              Removing deletes the encrypted key stored in this app. If you don't
              have the original WIF written down elsewhere, you will lose access
              to any funds at this address.
            </p>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              if (entry) removeWifWallet(entry.id);
              onClose();
            }}
          >
            <Trash2 className="h-4 w-4 mr-1" /> Remove
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
