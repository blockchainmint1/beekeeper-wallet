/**
 * Minimal ERC20 helpers plus per-chain token registry (USDC, USDT).
 * Decimals vary by chain — USDC/USDT are 6 on Ethereum/Base, 18 on BSC —
 * hard-coded here so we never accidentally truncate or 1e12 a decimal.
 */
import { encodeFunctionData, erc20Abi, parseUnits, formatUnits, type Address } from "viem";
import { evmClient, type EvmChainId, type StableEvmChainId } from "./evm";

export interface Erc20TokenMeta {
  symbol: string;
  address: Address;
  decimals: number;
}

/** Canonical USDC contracts. */
export const USDC_BY_CHAIN: Record<StableEvmChainId, Erc20TokenMeta> = {
  eth: { symbol: "USDC", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 },
  base: { symbol: "USDC", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 },
  bsc: { symbol: "USDC", address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", decimals: 18 },
};

/** Canonical USDT contracts. Base uses the USD₮0 bridge contract. */
export const USDT_BY_CHAIN: Record<StableEvmChainId, Erc20TokenMeta> = {
  eth: { symbol: "USDT", address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6 },
  base: { symbol: "USDT", address: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2", decimals: 6 },
  bsc: { symbol: "USDT", address: "0x55d398326f99059fF775485246999027B3197955", decimals: 18 },
};

/** Canonical PayPal USD (PYUSD). Currently Ethereum mainnet only. */
export const PYUSD_BY_CHAIN: Partial<Record<StableEvmChainId, Erc20TokenMeta>> = {
  eth: { symbol: "PYUSD", address: "0x6c3ea9036406852006290770BEdFcAbA0e23A0e8", decimals: 6 },
};

/** Canonical DAI contracts. */
export const DAI_BY_CHAIN: Record<StableEvmChainId, Erc20TokenMeta> = {
  eth: { symbol: "DAI", address: "0x6B175474E89094C44Da98b954EedeAC495271d0F", decimals: 18 },
  base: { symbol: "DAI", address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", decimals: 18 },
  bsc: { symbol: "DAI", address: "0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3", decimals: 18 },
};

/** Symbols counted at $1 in the portfolio total. */
export const USD_STABLE_SYMBOLS = new Set(["USDC", "USDT", "PYUSD", "DAI"]);

/**
 * Built-in tokens we know about per chain. Display / enable state is layered
 * on top via `token-prefs.ts` (users can hide any of these and add custom
 * ERC-20s). Order = default display order.
 */
export const BUILTIN_TOKENS_BY_CHAIN: Record<EvmChainId, Erc20TokenMeta[]> = {
  eth: [USDC_BY_CHAIN.eth, USDT_BY_CHAIN.eth, PYUSD_BY_CHAIN.eth!, DAI_BY_CHAIN.eth],
  base: [USDC_BY_CHAIN.base, USDT_BY_CHAIN.base, DAI_BY_CHAIN.base],
  bsc: [USDC_BY_CHAIN.bsc, USDT_BY_CHAIN.bsc, DAI_BY_CHAIN.bsc],
  // No canonical stablecoins deployed on Zero Chill yet — users can add
  // custom ERC-20s from settings.
  zcu: [],
};

/**
 * Back-compat alias: canonical built-in catalog. For the full known list
 * including user-added custom tokens, use `getKnownTokens()` from
 * `@/lib/token-prefs`.
 */
export const TOKENS_BY_CHAIN = BUILTIN_TOKENS_BY_CHAIN;

export function findToken(chain: EvmChainId, symbol: string): Erc20TokenMeta | null {
  const s = symbol.toUpperCase();
  return BUILTIN_TOKENS_BY_CHAIN[chain].find((t) => t.symbol.toUpperCase() === s) ?? null;
}

/** Read an ERC20 balance. Returns the raw integer (units of `decimals`). */
export async function readErc20Balance(
  chain: EvmChainId,
  token: Erc20TokenMeta,
  owner: Address,
): Promise<bigint> {
  const client = evmClient(chain);
  return client.readContract({
    address: token.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [owner],
  });
}

/** Encode `transfer(to, amount)` call data. */
export function encodeTransfer(to: Address, amount: bigint): `0x${string}` {
  return encodeFunctionData({
    abi: erc20Abi,
    functionName: "transfer",
    args: [to, amount],
  });
}

/** Convert a decimal string (e.g. "9.000123") to raw token units. */
export function tokenAmountToRaw(amount: string | number, decimals: number): bigint {
  return parseUnits(String(amount), decimals);
}

/** Pretty-print a raw token amount as a decimal string. */
export function tokenAmountFromRaw(raw: bigint, decimals: number): string {
  return formatUnits(raw, decimals);
}
