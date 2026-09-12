/**
 * Sweep and gas-funding helpers for derived EVM addresses.
 *
 * Order of operations matters and the UI enforces it:
 *   1. fund gas at the source address (token transfers pay gas there)
 *   2. sweep tokens out
 *   3. sweep native last (it pays for itself and empties the address)
 *
 * Every transaction goes through `sendEvmTransaction`, which owns the
 * nonce-reservation logic, so repeated sweeps don't replace each other.
 */
import {
  createWalletClient,
  http,
  type Address,
  type PrivateKeyAccount,
} from "viem";
import type { BIP32Interface } from "bip32";
import { evmClient, deriveEvmAccountAt, EVM_CHAINS, type EvmChainId } from "./evm";
import { encodeTransfer, type Erc20TokenMeta } from "./erc20";
import { sendEvmTransaction } from "./evm-send";

/** Gas units: plain native transfer / typical ERC-20 transfer. */
const NATIVE_GAS = 21_000n;
const TOKEN_GAS = 90_000n;

function walletFor(chain: EvmChainId, account: PrivateKeyAccount) {
  return createWalletClient({
    account,
    chain: EVM_CHAINS[chain].viemChain,
    transport: http(`/api/evm/${chain}`),
  });
}

/** Per-gas price we can safely budget against (includes a headroom buffer). */
export async function effectiveGasPrice(chain: EvmChainId): Promise<bigint> {
  const client = evmClient(chain);
  try {
    const fees = await client.estimateFeesPerGas();
    const max = fees.maxFeePerGas ?? fees.gasPrice ?? 0n;
    if (max > 0n) return (max * 12n) / 10n;
  } catch {
    /* fall through to gasPrice */
  }
  const gp = await client.getGasPrice();
  return (gp * 12n) / 10n;
}

export interface NativeSweepEstimate {
  balance: bigint;
  gasCost: bigint;
  /** What we can actually move (balance − gas), never negative. */
  sendable: bigint;
}

export async function estimateNativeSweep(
  chain: EvmChainId,
  address: Address,
): Promise<NativeSweepEstimate> {
  const client = evmClient(chain);
  const [balance, perGas] = await Promise.all([
    client.getBalance({ address }),
    effectiveGasPrice(chain),
  ]);
  const gasCost = perGas * NATIVE_GAS;
  const sendable = balance > gasCost ? balance - gasCost : 0n;
  return { balance, gasCost, sendable };
}

/** Cost of one token sweep from a derived address (paid in native coin). */
export async function estimateTokenSweepGas(chain: EvmChainId): Promise<bigint> {
  const perGas = await effectiveGasPrice(chain);
  return perGas * TOKEN_GAS;
}

/**
 * Send just enough native coin from the main account to a derived address so
 * it can pay for its own token sweeps. Defaults to ~1.5 sweeps of headroom.
 */
export async function fundGas(opts: {
  chain: EvmChainId;
  root: BIP32Interface;
  /** Derived address that needs gas. */
  to: Address;
  /** How many token sweeps it must cover (default 1). */
  transfers?: number;
}): Promise<`0x${string}`> {
  const { chain, root, to } = opts;
  const from = deriveEvmAccountAt(root, 0);
  const perSweep = await estimateTokenSweepGas(chain);
  const needed = (perSweep * BigInt(opts.transfers ?? 1) * 3n) / 2n;
  const client = evmClient(chain);
  const [have, mainBalance] = await Promise.all([
    client.getBalance({ address: to }),
    client.getBalance({ address: from.address }),
  ]);
  const top = have >= needed ? 0n : needed - have;
  if (top === 0n) throw new Error("This address already has enough gas.");
  const reserve = perSweep; // keep something at the main address for its own tx
  if (mainBalance < top + reserve) {
    throw new Error(
      `Not enough ${EVM_CHAINS[chain].nativeSymbol} in your main address to cover gas.`,
    );
  }
  return sendEvmTransaction(chain, walletFor(chain, from), { to, value: top });
}

/** Move a derived address's full token balance to the destination. */
export async function sweepToken(opts: {
  chain: EvmChainId;
  root: BIP32Interface;
  index: number;
  token: Erc20TokenMeta;
  amount: bigint;
  to: Address;
}): Promise<`0x${string}`> {
  const { chain, root, index, token, amount, to } = opts;
  if (amount <= 0n) throw new Error("Nothing to sweep.");
  const account = deriveEvmAccountAt(root, index);
  const client = evmClient(chain);
  const [nativeBalance, gasNeeded] = await Promise.all([
    client.getBalance({ address: account.address }),
    estimateTokenSweepGas(chain),
  ]);
  if (nativeBalance < gasNeeded) {
    throw new Error(
      `This address needs a little ${EVM_CHAINS[chain].nativeSymbol} for gas first — use "Fund gas".`,
    );
  }
  return sendEvmTransaction(chain, walletFor(chain, account), {
    to: token.address,
    data: encodeTransfer(to, amount),
    value: 0n,
  });
}

/** Empty a derived address's native balance, leaving only the gas it costs. */
export async function sweepNative(opts: {
  chain: EvmChainId;
  root: BIP32Interface;
  index: number;
  to: Address;
}): Promise<`0x${string}`> {
  const { chain, root, index, to } = opts;
  const account = deriveEvmAccountAt(root, index);
  const est = await estimateNativeSweep(chain, account.address);
  if (est.sendable <= 0n) {
    throw new Error(
      `Balance is too small to cover its own gas on ${EVM_CHAINS[chain].name}.`,
    );
  }
  return sendEvmTransaction(chain, walletFor(chain, account), {
    to,
    value: est.sendable,
  });
}
