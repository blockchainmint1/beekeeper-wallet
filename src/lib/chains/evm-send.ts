/**
 * Reliable EVM broadcast helper.
 *
 * Why sends used to stall:
 *  1. Thin fees — viem caps maxFeePerGas at 1.2x base fee, so a short fee
 *     spike leaves the tx parked in the mempool.
 *  2. Nonce gaps — we reserved nonces locally (needed for ZCU's node, which
 *     under-reports pending txs). On Ethereum/Base/BNB a dropped earlier tx
 *     left a stale reservation, so the next send used a nonce ahead of the
 *     chain and could NEVER be mined.
 *  3. Silent drops — once broadcast we never checked the node kept the tx.
 *
 * Fix: the node's pending nonce is authoritative on public chains (local
 * reservation only on ZCU), fees get real headroom, we sign locally and keep
 * the raw tx so it can be re-broadcast until it's mined, and we confirm the
 * node actually has it before reporting success.
 */
import type { Address, Hex, WalletClient } from "viem";
import { evmClient, type EvmChainId } from "./evm";

export interface EvmTxRequest {
  to: Address;
  data?: `0x${string}`;
  value?: bigint;
  gas?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  gasPrice?: bigint;
}

const KEY = (chain: EvmChainId, address: string) =>
  `evm-nonce:${chain}:${address.toLowerCase()}`;
const RAW_KEY = "hme.evm-raw-tx.v1";
const RAW_TTL = 24 * 60 * 60_000;
const RAW_TAGGED_TTL = 7 * 24 * 60 * 60_000;

function readReserved(chain: EvmChainId, address: string): number | null {
  try {
    const raw = localStorage.getItem(KEY(chain, address));
    if (!raw) return null;
    const { nonce, at } = JSON.parse(raw) as { nonce: number; at: number };
    if (!Number.isFinite(nonce) || Date.now() - at > 60 * 60_000) return null;
    return nonce;
  } catch {
    return null;
  }
}

function writeReserved(chain: EvmChainId, address: string, nonce: number) {
  try {
    localStorage.setItem(KEY(chain, address), JSON.stringify({ nonce, at: Date.now() }));
  } catch {
    /* ignore */
  }
}

/** Signed raw txs we may need to re-broadcast (public data only). */
type RawStore = Record<
  string,
  {
    chain: EvmChainId;
    raw: Hex;
    nonce: number;
    from: string;
    at: number;
    /** Caller's label for this send (e.g. cash-out reference + line) so a retry can find it. */
    tag?: string;
    /** false until the node accepted it at least once. */
    broadcast?: boolean;
  }
>;

function readRaw(): RawStore {
  try {
    const s = JSON.parse(localStorage.getItem(RAW_KEY) ?? "{}") as RawStore;
    const now = Date.now();
    // A tagged entry belongs to a cash-out order that may still be open, so it
    // must outlive the plain 24h re-broadcast window (round-2 audit 2.2).
    for (const k of Object.keys(s)) {
      const e = s[k]!;
      if (now - e.at > (e.tag ? RAW_TAGGED_TTL : RAW_TTL)) delete s[k];
    }
    return s;
  } catch {
    return {};
  }
}
function writeRaw(s: RawStore) {
  try {
    localStorage.setItem(RAW_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}
export function forgetRawTx(hash: string) {
  const s = readRaw();
  delete s[hash.toLowerCase()];
  writeRaw(s);
}

function msgOf(e: unknown): string {
  const err = e as { message?: string; details?: string; shortMessage?: string };
  return `${err?.message ?? ""} ${err?.details ?? ""} ${err?.shortMessage ?? ""}`.toLowerCase();
}
const isAlreadyKnown = (m: string) => m.includes("already known") || m.includes("known transaction");
const isNonceCollision = (m: string) =>
  m.includes("replacement transaction underpriced") ||
  m.includes("replacement_underpriced") ||
  m.includes("nonce too low");

/**
 * The node's own "that transaction isn't here" answers, as opposed to a node
 * that never answered (round-2 audit 2.2). Only the first may be read as
 * "that send never happened" — an RPC hiccup must never let a retry sign a
 * second transfer for a line that already moved.
 */
const NOT_FOUND_NAMES = new Set(["TransactionNotFoundError", "TransactionReceiptNotFoundError", "BlockNotFoundError"]);
const NOT_FOUND_TEXT = [
  "could not be found",
  "not found",
  "no such transaction",
  "does not exist",
  "unknown transaction",
  "no information given",
];

function isTxNotFound(e: unknown): boolean {
  const name = (e as { name?: string } | null)?.name;
  if (name && NOT_FOUND_NAMES.has(name)) return true;
  const m = msgOf(e);
  return NOT_FOUND_TEXT.some((t) => m.includes(t));
}

/** Node lookup where "not there" means null; anything else stops the retry. */
async function lookupOrNull<T>(run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch (e) {
    if (isTxNotFound(e)) return null;
    throw new Error("Couldn't check the network for an earlier attempt — try again in a moment.");
  }
}

export async function fees(chainId: EvmChainId) {
  const pub = evmClient(chainId);
  try {
    const block = await pub.getBlock({ blockTag: "latest" });
    if (block.baseFeePerGas == null) return {};
    const minTip = chainId === "eth" ? 1_500_000_000n : 100_000_000n;
    let tip = await pub.estimateMaxPriorityFeePerGas().catch(() => minTip);
    if (tip < minTip) tip = minTip;
    // 2x base fee headroom survives ~6 consecutive full blocks of fee rises.
    return { maxPriorityFeePerGas: tip, maxFeePerGas: block.baseFeePerGas * 2n + tip };
  } catch {
    return {};
  }
}

export async function sendEvmTransaction(
  chainId: EvmChainId,
  walletClient: WalletClient,
  tx: EvmTxRequest,
  /** Optional label; see findLiveEvmTx. */
  tag?: string,
): Promise<`0x${string}`> {
  const pub = evmClient(chainId);
  const account = walletClient.account;
  if (!account) throw new Error("Wallet locked");
  const address = account.address as Address;

  const [latest, pending] = await Promise.all([
    pub.getTransactionCount({ address, blockTag: "latest" }),
    pub.getTransactionCount({ address, blockTag: "pending" }).catch(() => 0),
  ]);
  let nonce = Math.max(latest, pending);
  // Only ZCU's node under-reports pending txs; elsewhere a local reservation
  // can only create a gap that blocks the tx forever.
  if (chainId === "zcu") {
    const reserved = readReserved(chainId, address);
    if (reserved != null) nonce = Math.max(nonce, reserved + 1);
  }

  const feeFields = await fees(chainId);
  let lastErr: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const request = await walletClient.prepareTransactionRequest({
        account,
        chain: walletClient.chain,
        ...feeFields,
        ...tx,
        nonce,
      } as Parameters<WalletClient["prepareTransactionRequest"]>[0]);
      const raw = await walletClient.signTransaction(
        request as Parameters<WalletClient["signTransaction"]>[0],
      );
      // Keep the signed tx BEFORE broadcasting (round-2 audit 2.2): if the
      // broadcast call errors after the node actually took it, a retry finds
      // this exact tx instead of signing a second transfer.
      const { keccak256 } = await import("viem");
      const hash: Hex = keccak256(raw);
      {
        const s = readRaw();
        s[hash.toLowerCase()] = { chain: chainId, raw, nonce, from: address, at: Date.now(), tag, broadcast: false };
        writeRaw(s);
      }
      try {
        await pub.sendRawTransaction({ serializedTransaction: raw });
      } catch (e) {
        if (!isAlreadyKnown(msgOf(e))) throw e;
      }
      if (chainId === "zcu") writeReserved(chainId, address, nonce);
      {
        const s = readRaw();
        if (s[hash.toLowerCase()]) s[hash.toLowerCase()]!.broadcast = true;
        writeRaw(s);
      }
      // Make sure the node really kept it; re-push once if not.
      await new Promise((r) => setTimeout(r, 2500));
      const seen = await pub.getTransaction({ hash }).catch(() => null);
      if (!seen) await pub.sendRawTransaction({ serializedTransaction: raw }).catch(() => undefined);
      return hash;
    } catch (e) {
      lastErr = e;
      if (isNonceCollision(msgOf(e))) {
        // Re-read the chain rather than guessing; never skip ahead of it.
        const fresh = await pub.getTransactionCount({ address, blockTag: "pending" }).catch(() => nonce + 1);
        nonce = Math.max(fresh, nonce + 1);
        continue;
      }
      throw e;
    }
  }
  const detail = lastErr instanceof Error ? ` (${lastErr.message.split("\n")[0]})` : "";
  throw new Error(
    `Couldn't broadcast: earlier transactions from this wallet are still pending. Wait for one to confirm, then try again.${detail}`,
  );
}

/**
 * Called while a tx is pending. Re-broadcasts the signed tx if the node lost
 * it, and reports "dropped" if its nonce slot was filled by something else
 * (i.e. it can never confirm — funds never moved).
 */
export async function checkPendingEvmTx(
  chainId: EvmChainId,
  hash: string,
): Promise<"pending" | "dropped"> {
  const entry = readRaw()[hash.toLowerCase()];
  if (!entry) return "pending";
  const pub = evmClient(chainId);
  let seen: unknown;
  try {
    seen = await pub.getTransaction({ hash: hash as Hex });
  } catch (e) {
    // A node that didn't answer proves nothing: keep waiting, never report dropped.
    if (!isTxNotFound(e)) return "pending";
    seen = null;
  }
  if (seen) return "pending";
  const mined = await pub
    .getTransactionCount({ address: entry.from as Address, blockTag: "latest" })
    .catch(() => -1);
  if (mined > entry.nonce) return "dropped";
  await pub.sendRawTransaction({ serializedTransaction: entry.raw }).catch(() => undefined);
  return "pending";
}

/**
 * A send with this tag that is already on the network (pending or mined
 * successfully), or one we can still push — returns its hash so the caller
 * re-uses it instead of signing a second transfer. Returns null when no such
 * tx exists or it can never confirm (nonce taken by another tx, or reverted).
 */
export async function findLiveEvmTx(chainId: EvmChainId, from: string, tag: string): Promise<`0x${string}` | null> {
  const entries = Object.entries(readRaw())
    .filter(([, e]) => e.chain === chainId && e.tag === tag && e.from.toLowerCase() === from.toLowerCase())
    .sort((a, b) => b[1].at - a[1].at);
  if (entries.length === 0) return null;
  const pub = evmClient(chainId);
  for (const [hash, entry] of entries) {
    const h = hash as Hex;
    const receipt = await lookupOrNull(() => pub.getTransactionReceipt({ hash: h }));
    if (receipt) {
      if (receipt.status === "success") return h;
      continue; // reverted — nothing moved, a fresh send is fine
    }
    const seen = await lookupOrNull(() => pub.getTransaction({ hash: h }));
    if (seen) return h;
    const mined = await lookupOrNull(() =>
      pub.getTransactionCount({ address: entry.from as Address, blockTag: "latest" }),
    );
    if (mined === null) throw new Error("Couldn't check the network for an earlier attempt — try again in a moment.");
    if (mined > entry.nonce) continue; // its nonce slot went to another tx: it can never confirm
    try {
      await pub.sendRawTransaction({ serializedTransaction: entry.raw });
      return h;
    } catch (e) {
      if (isAlreadyKnown(msgOf(e))) return h;
      /* node refuses it (e.g. not enough gas) — safe to sign a new one */
    }
  }
  return null;
}
