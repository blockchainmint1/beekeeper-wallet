import { createFileRoute, Link, Outlet, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useWallet } from "@/lib/txc/wallet-context";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Plus, Settings as Cog, Download, Sparkles, Eye, Key } from "lucide-react";
import { scanAccount } from "@/lib/txc/scan";
import { satsToTxc, formatFiat } from "@/lib/txc/units";
import { getTxcPriceUsd } from "@/lib/txc/price.functions";
import { getAllPricesUsd } from "@/lib/chains/prices.functions";
import { EVM_CHAIN_LIST, deriveEvmAccount, evmClient, type EvmChainId } from "@/lib/chains/evm";
import { listWatchWallets, watchChangedEvent, type WatchWallet } from "@/lib/watch-only";
import { getAddressStats } from "@/lib/txc/mempool";
import { getEnabledChains } from "@/lib/chain-prefs";
import { deriveSolanaAccount } from "@/lib/solana/network";
import { getSolBalance } from "@/lib/solana/api";
import { parsePaymentUri } from "@/lib/pay-uri";
import { rootFingerprintHex } from "@/lib/txc/fingerprint";
import { QrScanButton } from "@/components/wallet/QrScanButton";
import { looksLikeLoginQr } from "@/lib/nectar/auth";
import { ProfileSwitcher } from "@/components/wallet/ProfileSwitcher";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";

export const Route = createFileRoute("/wallet")({
  head: () => ({
    meta: [{ title: "Wallet — BeeKeeper Wallet" }],
  }),
  component: WalletLayout,
});

function WalletLayout() {
  const { unlocked, root, seed } = useWallet();
  const navigate = useNavigate();
  const [showPortfolio, setShowPortfolio] = useState(false);

  useEffect(() => {
    if (!unlocked) navigate({ to: "/" });
  }, [unlocked, navigate]);

  const fetchPrice = useServerFn(getTxcPriceUsd);
  const price = useQuery({
    queryKey: ["txc-price"],
    queryFn: () => fetchPrice(),
    staleTime: 60_000,
    enabled: !!unlocked,
  });

  const account = useQuery({
    queryKey: ["account", unlocked?.kind, root ? rootFingerprintHex(root) : null],
    enabled: !!root && !!unlocked,
    queryFn: () => scanAccount(root!, unlocked!.kind),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  const evmAddress = useMemo(() => (root ? deriveEvmAccount(root).address : null), [root]);
  const solanaAddress = useMemo(() => (seed ? deriveSolanaAccount(seed).address : null), [seed]);
  const solanaBalance = useQuery({
    queryKey: ["solana-balance", solanaAddress],
    enabled: !!solanaAddress && !!unlocked,
    queryFn: () => getSolBalance(solanaAddress ?? ""),
    staleTime: 30_000,
    refetchInterval: 30_000,
  });
  const allPricesFn = useServerFn(getAllPricesUsd);
  const allPrices = useQuery({
    queryKey: ["all-prices"],
    queryFn: () => allPricesFn(),
    staleTime: 60_000,
    enabled: !!unlocked,
  });
  const evmBalances = useQueries({
    queries: EVM_CHAIN_LIST.map((c) => ({
      queryKey: ["evm-balance", c.id, evmAddress],
      enabled: !!evmAddress,
      queryFn: () => evmClient(c.id).getBalance({ address: evmAddress! }),
      staleTime: 30_000,
    })),
  });

  // Watch-only wallets contribute to the portfolio total too.
  const [watchList, setWatchList] = useState<WatchWallet[]>(() => listWatchWallets());
  useEffect(() => {
    const h = () => setWatchList(listWatchWallets());
    window.addEventListener(watchChangedEvent(), h);
    return () => window.removeEventListener(watchChangedEvent(), h);
  }, []);
  const watchBalances = useQueries({
    queries: watchList.map((w) => ({
      queryKey: ["watch-stats", w.chain, w.address],
      queryFn: () => getAddressStats(w.address),
      staleTime: 60_000,
      enabled: !!unlocked,
    })),
  });

  const portfolioUsd = useMemo(() => {
    let total = 0;
    if (price.data?.usd && account.data) {
      total += satsToTxc(account.data.balanceSats) * price.data.usd;
    }
    EVM_CHAIN_LIST.forEach((c, i) => {
      const bal = evmBalances[i]?.data;
      const usd = allPrices.data?.prices?.[c.priceSymbol];
      if (bal != null && usd != null) {
        total += (Number(bal) / 1e18) * usd;
      }
    });
    const solUsd = allPrices.data?.prices?.SOL;
    if (solanaBalance.data != null && solUsd != null) {
      total += (solanaBalance.data / 1e9) * solUsd;
    }
    // Watch-only TXC balances (funded - spent, in sats).
    if (price.data?.usd) {
      watchList.forEach((_, i) => {
        const s = watchBalances[i]?.data;
        if (!s) return;
        const bal =
          s.chain_stats.funded_txo_sum -
          s.chain_stats.spent_txo_sum +
          s.mempool_stats.funded_txo_sum -
          s.mempool_stats.spent_txo_sum;
        total += satsToTxc(bal) * (price.data?.usd ?? 0);
      });
    }
    return total;
  }, [price.data, account.data, evmBalances, allPrices.data, solanaBalance.data, watchList, watchBalances]);

  // EVM chain picker when a scanned URI doesn't specify a chain.
  const [pickChain, setPickChain] = useState<
    | { address: string; assetSymbol?: string; amount?: string }
    | null
  >(null);

  function handleScan(raw: string) {
    // Website sign-in QR (NectarPay, streamTXC, …) — go straight to the
    // sign-in page with the scanned payload.
    if (looksLikeLoginQr(raw)) {
      navigate({ to: "/wallet/signin", search: { payload: raw } });
      return;
    }
    const intent = parsePaymentUri(raw);
    if (intent.kind === "txc") {
      navigate({
        to: "/wallet/send",
        search: {
          to: intent.address,
          amount: intent.amount,
          token: intent.tokenId ? String(intent.tokenId) : undefined,
        },
      });
      return;
    }
    if (intent.kind === "btc") {
      navigate({
        to: "/wallet/btc/send",
        search: { to: intent.address, amount: intent.amount },
      });
      return;
    }
    if (intent.kind === "isk") {
      navigate({
        to: "/wallet/isk/send",
        search: { to: intent.address, amount: intent.amount },
      });
      return;
    }
    if (intent.kind === "evm") {
      if (!intent.address) {
        toast.error("QR is missing a recipient address");
        return;
      }
      const enabledEvm = getEnabledChains().filter((c) =>
        (["eth", "base", "bsc"] as string[]).includes(c),
      ) as EvmChainId[];
      if (intent.chain && enabledEvm.includes(intent.chain)) {
        navigate({
          to: "/wallet/evm/$chain/send",
          params: { chain: intent.chain },
          search: {
            to: intent.address,
            amount: intent.amount,
            asset: intent.assetSymbol,
          },
        });
        return;
      }
      // No chain in URI (or chain disabled) — ask the user which EVM network to use.
      setPickChain({
        address: intent.address,
        assetSymbol: intent.assetSymbol,
        amount: intent.amount,
      });
      return;
    }
    if (intent.kind === "nectar-invoice") {
      // Hosted checkout — open in the system browser (SFSafariViewController /
      // Custom Tabs). window.open('_blank') is silently dropped by WKWebView.
      void (async () => {
        try {
          const { isNative } = await import("@/lib/native/platform");
          if (isNative()) {
            const { Browser } = await import("@capacitor/browser");
            await Browser.open({ url: intent.url });
            return;
          }
        } catch {
          /* fall through to web open */
        }
        window.open(intent.url, "_blank", "noopener,noreferrer");
      })();
      return;
    }
    toast.error("Couldn't recognize that QR code");
  }

  if (!unlocked) return null;

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      {/* Pinned header: the root frame already applies the top safe-area
          spacer, so this stays shrink-0 at the top of the column instead of
          sticky-with-inset (which let tiles slide under it on Android). */}
      <header className="shrink-0 border-b border-border/60 bg-card/40 backdrop-blur supports-[backdrop-filter]:bg-card/30 z-20">


        <div className="mx-auto max-w-3xl px-4 py-3 flex items-center justify-between gap-2">
          <button
            onClick={() => setShowPortfolio((v) => !v)}
            className="flex-1 min-w-0 text-left group"
            title="Tap to toggle"
          >
            {showPortfolio ? (
              <div className="flex flex-col leading-tight">
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Portfolio</span>
                <span className="font-semibold truncate">
                  {formatFiat(portfolioUsd)}
                </span>
              </div>
            ) : (
              <div className="flex flex-col leading-tight">
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground">TXC</span>
                <span className="font-semibold truncate">
                  {price.data?.usd
                    ? `$${price.data.usd.toLocaleString(undefined, { maximumFractionDigits: 6 })}`
                    : "—"}
                </span>
              </div>
            )}
          </button>

          <ProfileSwitcher />

          <QrScanButton onScan={handleScan} />




          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" title="Add wallet">
                <Plus className="h-5 w-5" />
                <span className="sr-only">Add wallet</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem asChild>
                <Link to="/create" search={{ add: true }}>
                  <Sparkles className="h-4 w-4 mr-2" /> Create new wallet
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link to="/import" search={{ add: true }}>
                  <Download className="h-4 w-4 mr-2" /> Import wallet
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link to="/wallet/watch-add">
                  <Eye className="h-4 w-4 mr-2" /> Add watch-only
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link to="/wallet/wif-add">
                  <Key className="h-4 w-4 mr-2" /> Import private key
                </Link>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <Button asChild variant="ghost" size="icon" title="Settings">
            <Link to="/wallet/settings">
              <Cog className="h-5 w-5" />
              <span className="sr-only">Settings</span>
            </Link>
          </Button>
        </div>
      </header>
      {/* Own scroller so sub-pages (Settings, sends) scroll while the header
          stays pinned; the dashboard fills this exactly and scrolls internally. */}
      <div className="flex-1 flex flex-col min-h-0 overflow-y-auto overscroll-contain">
        <Outlet />
      </div>

      <Dialog open={!!pickChain} onOpenChange={(o) => !o && setPickChain(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Which network?</DialogTitle>
            <DialogDescription>
              This payment request didn&apos;t specify a chain. Pick the network to send{" "}
              {pickChain?.assetSymbol ?? "the payment"} on.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            {(getEnabledChains().filter((c) =>
              (["eth", "base", "bsc"] as string[]).includes(c),
            ) as EvmChainId[]).map((c) => (
              <Button
                key={c}
                variant="outline"
                className="justify-start"
                onClick={() => {
                  if (!pickChain) return;
                  const target = pickChain;
                  setPickChain(null);
                  navigate({
                    to: "/wallet/evm/$chain/send",
                    params: { chain: c },
                    search: {
                      to: target.address,
                      amount: target.amount,
                      asset: target.assetSymbol,
                    },
                  });
                }}
              >
                {c.toUpperCase()}
              </Button>
            ))}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPickChain(null)}>
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
