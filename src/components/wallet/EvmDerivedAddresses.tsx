/**
 * Expandable list of derived addresses for one EVM chain.
 *
 * The wallet used to show only address #0, so funds sitting on other derived
 * paths (old app, payouts, rotated deposit addresses) were invisible. This
 * scans addresses in pages of 5 with a single Multicall3 call per page, shows
 * the combined total, and offers gas funding + sweeping back to address #0.
 */
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ChevronDown,
  ChevronUp,
  Copy,
  ExternalLink,
  Fuel,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { copyToClipboard } from "@/lib/clipboard";
import { useHideBalances, maskAmount } from "@/lib/hide-balances";
import { useWallet } from "@/lib/txc/wallet-context";
import {
  EVM_CHAINS,
  evmClient,
  deriveEvmAddresses,
  formatEth,
  type EvmChainId,
} from "@/lib/chains/evm";
import { tokenAmountFromRaw, type Erc20TokenMeta } from "@/lib/chains/erc20";
import { useTokensForChain } from "@/lib/token-prefs";
import {
  isScannableChain,
  rowHasFunds,
  scanEvmAddresses,
  type EvmScanRow,
} from "@/lib/chains/evm-scan";
import { fundGas, sweepNative, sweepToken } from "@/lib/chains/evm-sweep";
import { formatFiat } from "@/lib/txc/units";
import { addPendingTx } from "@/lib/pending-tx";

const PAGE = 5;

export function EvmDerivedAddresses({ chainId }: { chainId: EvmChainId }) {
  const { root } = useWallet();
  const qc = useQueryClient();
  const [hidden] = useHideBalances();
  const [open, setOpen] = useState(false);
  const [pages, setPages] = useState(1);
  const [busy, setBusy] = useState<string | null>(null);
  const tokens = useTokensForChain(chainId);
  const meta = EVM_CHAINS[chainId];

  // Addresses #1 and up — #0 is the main address shown everywhere else.
  const count = pages * PAGE;
  const derived = useMemo(
    () => (root ? deriveEvmAddresses(root, count, 1) : []),
    [root, count],
  );
  const mainAddress = useMemo(
    () => (root ? deriveEvmAddresses(root, 1, 0)[0]?.address ?? null : null),
    [root],
  );

  const scan = useQuery({
    queryKey: [
      "evm-derived",
      chainId,
      mainAddress,
      count,
      tokens.map((t) => t.address).join(","),
    ],
    enabled: open && derived.length > 0 && isScannableChain(chainId),
    queryFn: () => scanEvmAddresses(chainId, derived, tokens),
    staleTime: 30_000,
  });

  if (!isScannableChain(chainId) || !root) return null;

  const rows = scan.data ?? [];
  const funded = rows.filter(rowHasFunds);

  const totals = rows.reduce(
    (acc, r) => {
      acc.native += r.native;
      for (const t of tokens) {
        const raw = r.tokens[t.symbol] ?? 0n;
        if (raw > 0n && t.symbol.startsWith("USD")) {
          acc.usd += Number(tokenAmountFromRaw(raw, t.decimals));
        }
      }
      return acc;
    },
    { native: 0n, usd: 0 },
  );

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["evm-derived", chainId] });
    void qc.invalidateQueries({ queryKey: ["evm-balance", chainId] });
    void qc.invalidateQueries({ queryKey: ["erc20-balance", chainId] });
  };

  const run = async (
    key: string,
    fn: () => Promise<`0x${string}`>,
    label: string,
    track: { from: string; to: string; value: string; asset: string },
  ) => {
    if (busy) return;
    setBusy(key);
    try {
      const hash = await fn();
      // Record it locally so it shows up in history right away — indexers lag,
      // and until now these transactions were invisible until they were indexed.
      addPendingTx({
        hash,
        chain: chainId,
        from: track.from,
        to: track.to,
        value: track.value,
        asset: track.asset,
        createdAt: Date.now(),
      });
      const url = meta.explorerTx(hash);
      toast.success(`${label} sent`, {
        description: `${hash.slice(0, 10)}…${hash.slice(-8)}`,
        action: url
          ? { label: "View", onClick: () => window.open(url, "_blank", "noreferrer") }
          : undefined,
      });
      // Confirm it actually lands, instead of only reporting the broadcast.
      void evmClient(chainId)
        .waitForTransactionReceipt({ hash, timeout: 180_000 })
        .then((receipt) => {
          if (receipt.status === "success") toast.success(`${label} confirmed`);
          else toast.error(`${label} failed on chain`);
          refresh();
        })
        .catch(() => {
          toast.error(
            `${label} hasn't confirmed yet. It's still pending on ${meta.name} — check the explorer link.`,
          );
        });
      setTimeout(refresh, 4000);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const doSweepToken = (row: EvmScanRow, token: Erc20TokenMeta) => {
    const raw = row.tokens[token.symbol] ?? 0n;
    return run(
      `${row.index}-${token.address}`,
      () =>
        sweepToken({
          chain: chainId,
          root,
          index: row.index,
          token,
          amount: raw,
          to: mainAddress as `0x${string}`,
        }),
      `${token.symbol} sweep`,
      {
        from: row.address,
        to: mainAddress ?? "",
        value: tokenAmountFromRaw(raw, token.decimals),
        asset: token.symbol,
      },
    );
  };

  const doSweepNative = (row: EvmScanRow) =>
    run(
      `${row.index}-native`,
      () =>
        sweepNative({
          chain: chainId,
          root,
          index: row.index,
          to: mainAddress as `0x${string}`,
        }),
      `${meta.nativeSymbol} sweep`,
      {
        from: row.address,
        to: mainAddress ?? "",
        value: formatEth(row.native),
        asset: meta.nativeSymbol,
      },
    );

  const doFundGas = (row: EvmScanRow) => {
    const tokenCount = tokens.filter((t) => (row.tokens[t.symbol] ?? 0n) > 0n).length;
    return run(
      `${row.index}-fund`,
      () =>
        fundGas({
          chain: chainId,
          root,
          to: row.address,
          transfers: Math.max(1, tokenCount),
        }),
      "Gas top-up",
      {
        from: mainAddress ?? "",
        to: row.address,
        value: "",
        asset: meta.nativeSymbol,
      },
    );
  };

  return (
    <div className="mt-2 rounded-lg border border-border/60 bg-card/30">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left"
      >
        <div>
          <p className="text-sm font-medium">Other addresses from your seed</p>
          <p className="text-xs text-muted-foreground">
            {open
              ? `Scanned #1–#${count} on ${meta.name}`
              : "Check for funds on additional derived addresses"}
          </p>
        </div>
        {open ? (
          <ChevronUp className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        )}
      </button>

      {open && (
        <div className="px-4 pb-4 space-y-3">
          <div className="flex items-center justify-between gap-3 rounded-md bg-muted/40 px-3 py-2">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">
              Combined on #1+
            </p>
            <p className="text-sm font-semibold">
              {scan.isLoading
                ? "…"
                : hidden
                  ? maskAmount("0.0")
                  : `${formatEth(totals.native)} ${meta.nativeSymbol}${
                      totals.usd > 0 ? ` + ${formatFiat(totals.usd)}` : ""
                    }`}
            </p>
          </div>

          {scan.isError && (
            <p className="text-xs text-destructive">
              Couldn&apos;t read balances right now. Try again in a moment.
            </p>
          )}

          {!scan.isLoading && funded.length === 0 && !scan.isError && (
            <p className="text-xs text-muted-foreground">
              No funds found on addresses #1–#{count}.
            </p>
          )}

          {funded.map((row) => {
            const tokenRows = tokens
              .map((t) => ({ token: t, raw: row.tokens[t.symbol] ?? 0n }))
              .filter((t) => t.raw > 0n);
            return (
              <div
                key={row.address}
                className="rounded-md border border-border/60 bg-background/40 px-3 py-2 space-y-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="font-mono text-xs">
                    #{row.index} {row.address.slice(0, 8)}…{row.address.slice(-6)}
                  </p>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      aria-label="Copy address"
                      onClick={() => void copyToClipboard(row.address)}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </button>
                    <a
                      href={meta.explorerAddress(row.address)}
                      target="_blank"
                      rel="noreferrer"
                      aria-label="View on explorer"
                      className="text-muted-foreground hover:text-foreground"
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  </div>
                </div>

                {tokenRows.map(({ token, raw }) => (
                  <div
                    key={token.address}
                    className="flex items-center justify-between gap-2"
                  >
                    <p className="text-sm">
                      {hidden
                        ? maskAmount("0")
                        : Number(tokenAmountFromRaw(raw, token.decimals)).toLocaleString(
                            undefined,
                            { maximumFractionDigits: 4 },
                          )}{" "}
                      <span className="text-muted-foreground">{token.symbol}</span>
                    </p>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy !== null}
                      onClick={() => void doSweepToken(row, token)}
                    >
                      {busy === `${row.index}-${token.address}` ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        "Sweep"
                      )}
                    </Button>
                  </div>
                ))}

                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm">
                    {hidden ? maskAmount("0") : formatEth(row.native)}{" "}
                    <span className="text-muted-foreground">{meta.nativeSymbol}</span>
                  </p>
                  <div className="flex items-center gap-2">
                    {tokenRows.length > 0 && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy !== null}
                        onClick={() => void doFundGas(row)}
                      >
                        {busy === `${row.index}-fund` ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <>
                            <Fuel className="h-3.5 w-3.5 mr-1" /> Fund gas
                          </>
                        )}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy !== null || row.native === 0n}
                      onClick={() => void doSweepNative(row)}
                    >
                      {busy === `${row.index}-native` ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        "Sweep"
                      )}
                    </Button>
                  </div>
                </div>
              </div>
            );
          })}

          {funded.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Sweeping sends funds to your main address. Move tokens first — a token
              transfer needs a little {meta.nativeSymbol} for gas at that address —
              and sweep {meta.nativeSymbol} last.
            </p>
          )}

          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              className="flex-1"
              disabled={scan.isFetching}
              onClick={() => setPages((p) => p + 1)}
            >
              {scan.isFetching ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                "Show 5 more"
              )}
            </Button>
            <Button size="sm" variant="ghost" onClick={refresh} disabled={scan.isFetching}>
              Refresh
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
