/**
 * Batch balance scan for a list of EVM addresses.
 *
 * Why: the wallet only ever displayed index 0, so money that landed on other
 * derived addresses (old app, payouts, rotated deposit addresses) was
 * invisible. This reads native + token balances for many addresses in ONE
 * `eth_call` using Multicall3, so expanding a page of addresses is a single
 * round trip through our existing /api/evm/<chain> proxy.
 *
 * Multicall3 lives at the same address on Ethereum, Base and BSC. Zero Chill
 * has no deployment, so callers must not use this for `zcu`.
 */
import { erc20Abi, type Address } from "viem";
import { evmClient, type EvmChainId } from "./evm";
import type { Erc20TokenMeta } from "./erc20";

export const MULTICALL3_ADDRESS: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";

const MULTICALL3_ABI = [
  {
    type: "function",
    name: "getEthBalance",
    stateMutability: "view",
    inputs: [{ name: "addr", type: "address" }],
    outputs: [{ name: "balance", type: "uint256" }],
  },
] as const;

/** Chains where the derived-address scan is supported. */
export const SCANNABLE_CHAINS = ["eth", "base", "bsc"] as const;
export type ScannableChainId = (typeof SCANNABLE_CHAINS)[number];

export function isScannableChain(chain: EvmChainId): chain is ScannableChainId {
  return (SCANNABLE_CHAINS as readonly string[]).includes(chain);
}

export interface EvmScanRow {
  index: number;
  path: string;
  address: Address;
  /** Native balance in wei. */
  native: bigint;
  /** symbol -> raw token units. */
  tokens: Record<string, bigint>;
}

export interface EvmScanInput {
  index: number;
  path: string;
  address: Address;
}

function asBigInt(v: unknown): bigint {
  return typeof v === "bigint" ? v : 0n;
}

/**
 * Read native + token balances for every address in one multicall.
 * Individual failures degrade to 0 rather than failing the whole page.
 */
export async function scanEvmAddresses(
  chain: EvmChainId,
  addresses: EvmScanInput[],
  tokens: Erc20TokenMeta[],
): Promise<EvmScanRow[]> {
  if (addresses.length === 0) return [];
  const client = evmClient(chain);

  const contracts = addresses.flatMap((a) => [
    {
      address: MULTICALL3_ADDRESS,
      abi: MULTICALL3_ABI,
      functionName: "getEthBalance" as const,
      args: [a.address] as const,
    },
    ...tokens.map((t) => ({
      address: t.address,
      abi: erc20Abi,
      functionName: "balanceOf" as const,
      args: [a.address] as const,
    })),
  ]);

  const results = await client.multicall({
    contracts: contracts as never,
    allowFailure: true,
    multicallAddress: MULTICALL3_ADDRESS,
  });

  const perAddress = 1 + tokens.length;
  return addresses.map((a, i) => {
    const base = i * perAddress;
    const nativeRes = results[base];
    const row: EvmScanRow = {
      index: a.index,
      path: a.path,
      address: a.address,
      native: nativeRes?.status === "success" ? asBigInt(nativeRes.result) : 0n,
      tokens: {},
    };
    tokens.forEach((t, j) => {
      const r = results[base + 1 + j];
      row.tokens[t.symbol] = r?.status === "success" ? asBigInt(r.result) : 0n;
    });
    return row;
  });
}

/** True when an address holds anything at all. */
export function rowHasFunds(row: EvmScanRow): boolean {
  if (row.native > 0n) return true;
  return Object.values(row.tokens).some((v) => v > 0n);
}
