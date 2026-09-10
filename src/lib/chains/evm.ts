/**
 * EVM chain registry and helpers. One address (m/44'/60'/0'/0/0) works on
 * every EVM network we support; only the RPC + native token differ.
 */
import {
  createPublicClient,
  defineChain,
  http,
  type PublicClient,
  type Chain,
  formatEther,
} from "viem";
import { mainnet, base, bsc } from "viem/chains";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { BIP32Interface } from "bip32";

export type EvmChainId = "eth" | "bsc" | "base" | "zcu";

/** Chains that have canonical stablecoin deployments we ship built-in. */
export type StableEvmChainId = Exclude<EvmChainId, "zcu">;

/**
 * Base URL of the Zero Chill explorer/indexer. Provided at runtime by the
 * server (ZCU_MEMPOOL) so no host is hardcoded here.
 */
let zcuExplorerBase = "";

export function setZcuExplorerBase(base: string): void {
  zcuExplorerBase = (base ?? "").replace(/\/+$/, "");
}

export function getZcuExplorerBaseUrl(): string {
  return zcuExplorerBase;
}

/** Zero Chill Units — Honest Money ecosystem L1 (EVM). */
export const zeroChill = defineChain({
  id: 90031273,
  name: "Zero Chill",
  nativeCurrency: { name: "Zero Chill Units", symbol: "ZCU", decimals: 18 },
  rpcUrls: { default: { http: ["https://node-zcu.honest.money"] } },
});

export interface EvmChainMeta {
  id: EvmChainId;
  name: string;
  shortName: string;
  nativeSymbol: string;
  /** CoinMarketCap symbol used to price the native token. */
  priceSymbol: string;
  /** viem chain definition */
  viemChain: Chain;
  /** Hex color used for tile accents. */
  accent: string;
  explorerTx: (hash: string) => string;
  explorerAddress: (address: string) => string;
}

export const EVM_CHAINS: Record<EvmChainId, EvmChainMeta> = {
  eth: {
    id: "eth",
    name: "Ethereum",
    shortName: "ETH",
    nativeSymbol: "ETH",
    priceSymbol: "ETH",
    viemChain: mainnet,
    accent: "#627EEA",
    explorerTx: (h) => `https://etherscan.io/tx/${h}`,
    explorerAddress: (a) => `https://etherscan.io/address/${a}`,
  },
  base: {
    id: "base",
    name: "Base",
    shortName: "BASE",
    nativeSymbol: "ETH",
    priceSymbol: "ETH",
    viemChain: base,
    accent: "#0052FF",
    explorerTx: (h) => `https://basescan.org/tx/${h}`,
    explorerAddress: (a) => `https://basescan.org/address/${a}`,
  },
  bsc: {
    id: "bsc",
    name: "BNB Smart Chain",
    shortName: "BSC",
    nativeSymbol: "BNB",
    priceSymbol: "BNB",
    viemChain: bsc,
    accent: "#F0B90B",
    explorerTx: (h) => `https://bscscan.com/tx/${h}`,
    explorerAddress: (a) => `https://bscscan.com/address/${a}`,
  },
  zcu: {
    id: "zcu",
    name: "Zero Chill",
    shortName: "ZCU",
    nativeSymbol: "ZCU",
    priceSymbol: "ZCU",
    viemChain: zeroChill,
    accent: "#0EA5E9",
    explorerTx: (h) => (zcuExplorerBase ? `${zcuExplorerBase}/tx/${h}` : ""),
    explorerAddress: (a) => (zcuExplorerBase ? `${zcuExplorerBase}/address/${a}` : ""),
  },
};

export const EVM_CHAIN_LIST = Object.values(EVM_CHAINS);

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Returns a viem PublicClient that talks to our same-origin JSON-RPC proxy. */
export function evmClient(id: EvmChainId): PublicClient {
  return createPublicClient({
    chain: EVM_CHAINS[id].viemChain,
    transport: http(`/api/evm/${id}`, { batch: true }),
  });
}

/** Derive the EVM account from the existing BIP32 root (single key, all chains). */
export function deriveEvmAccount(root: BIP32Interface): PrivateKeyAccount {
  const node = root.derivePath("m/44'/60'/0'/0/0");
  if (!node.privateKey) throw new Error("Failed to derive EVM private key");
  const hex = bytesToHex(node.privateKey);
  return privateKeyToAccount(`0x${hex}`);
}

export function formatEth(wei: bigint, decimals = 6): string {
  const s = formatEther(wei);
  const [whole, frac = ""] = s.split(".");
  if (!frac) return whole;
  return `${whole}.${frac.slice(0, decimals).replace(/0+$/, "") || "0"}`;
}
