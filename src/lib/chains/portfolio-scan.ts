/**
 * Portfolio-wide EVM scan for the home total: native coin + USD stablecoins
 * across the first 20 derived addresses on each scannable EVM chain.
 */
import { useQueries } from "@tanstack/react-query";
import type { BIP32Interface } from "bip32";
import { deriveEvmAddresses, type EvmChainId } from "./evm";
import { isScannableChain, scanEvmAddresses } from "./evm-scan";
import { USD_STABLE_SYMBOLS } from "./erc20";
import { getKnownTokens } from "@/lib/token-prefs";

export const PORTFOLIO_DERIVED_COUNT = 20;

export interface EvmChainTotal {
  /** Native balance in wei summed over all scanned addresses. */
  nativeWei: bigint;
  /** USD value of stablecoins (counted at $1). */
  stableUsd: number;
  /** Per-symbol stable amounts (decimal). */
  stables: Record<string, number>;
}

export function useEvmPortfolioTotals(
  root: BIP32Interface | null,
  chains: EvmChainId[],
  enabled: boolean,
): Record<string, { data: EvmChainTotal | null; loading: boolean }> {
  const scannable = chains.filter(isScannableChain);
  const results = useQueries({
    queries: scannable.map((chain) => ({
      queryKey: ["evm-portfolio-total", chain, root ? root.neutered().toBase58().slice(0, 24) : null],
      enabled: enabled && !!root,
      staleTime: 60_000,
      refetchInterval: 120_000,
      retry: 2,
      queryFn: async (): Promise<EvmChainTotal> => {
        const addrs = deriveEvmAddresses(root!, PORTFOLIO_DERIVED_COUNT, 0);
        const tokens = getKnownTokens(chain).filter((t) =>
          USD_STABLE_SYMBOLS.has(t.symbol.toUpperCase()),
        );
        const rows = await scanEvmAddresses(chain, addrs, tokens);
        let nativeWei = 0n;
        const stables: Record<string, number> = {};
        for (const r of rows) {
          nativeWei += r.native;
          for (const t of tokens) {
            const raw = r.tokens[t.symbol] ?? 0n;
            if (raw > 0n) stables[t.symbol] = (stables[t.symbol] ?? 0) + Number(raw) / 10 ** t.decimals;
          }
        }
        const stableUsd = Object.values(stables).reduce((a, b) => a + b, 0);
        return { nativeWei, stableUsd, stables };
      },
    })),
  });
  const out: Record<string, { data: EvmChainTotal | null; loading: boolean }> = {};
  scannable.forEach((c, i) => {
    out[c] = { data: results[i]?.data ?? null, loading: results[i]?.isLoading ?? false };
  });
  return out;
}
