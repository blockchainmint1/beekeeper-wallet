/**
 * Reliable EVM broadcast helper.
 *
 * Problem this solves: sending twice in a row would reuse the same nonce.
 * viem asks the node for the "pending" nonce, but several nodes we talk to
 * (ZCU especially) answer with the mined ("latest") count, so the second send
 * collides with the first and the node rejects it as
 * `replacement transaction underpriced`.
 *
 * Fix: every send *reserves* its own nonce. We take max(latest, pending,
 * locally-reserved + 1) so the counter stays ahead even when the node
 * under-reports pending transactions, and a collision retries on the NEXT
 * nonce (a new transaction) instead of bumping the fee, which would have
 * replaced — and cancelled — the earlier send.
 */
import type { Address, WalletClient } from "viem";
import { evmClient, type EvmChainId } from "./evm";

export interface EvmTxRequest {
  to: Address;
  data?: `0x${string}`;
  value?: bigint;
  gas?: bigint;
}

const KEY = (chain: EvmChainId, address: string) =>
  `evm-nonce:${chain}:${address.toLowerCase()}`;

/**
 * How long a local reservation is trusted. This used to be an hour, which
 * caused the opposite failure: if a reserved transaction was dropped by the
 * node, every later send used a nonce *above* the chain's next one, so it sat
 * in the mempool forever — a hash came back but nothing was ever mined.
 */
const RESERVATION_TTL_MS = 3 * 60_000;

/** Last nonce we handed out locally (survives reloads). */
function readReserved(chain: EvmChainId, address: string): number | null {
  try {
    const raw = localStorage.getItem(KEY(chain, address));
    if (!raw) return null;
    const { nonce, at } = JSON.parse(raw) as { nonce: number; at: number };
    if (!Number.isFinite(nonce) || Date.now() - at > RESERVATION_TTL_MS) return null;
    return nonce;
  } catch {
    return null;
  }
}

function writeReserved(chain: EvmChainId, address: string, nonce: number) {
  try {
    localStorage.setItem(
      KEY(chain, address),
      JSON.stringify({ nonce, at: Date.now() }),
    );
  } catch {
    /* storage unavailable — chain nonce still works */
  }
}

function msgOf(e: unknown): string {
  const err = e as { message?: string; details?: string; shortMessage?: string };
  return `${err?.message ?? ""} ${err?.details ?? ""} ${err?.shortMessage ?? ""}`.toLowerCase();
}

const isNonceCollision = (m: string) =>
  m.includes("replacement transaction underpriced") ||
  m.includes("replacement_underpriced") ||
  m.includes("already known") ||
  m.includes("nonce too low") ||
  m.includes("known transaction");

export async function sendEvmTransaction(
  chainId: EvmChainId,
  walletClient: WalletClient,
  tx: EvmTxRequest,
): Promise<`0x${string}`> {
  const pub = evmClient(chainId);
  const account = walletClient.account;
  if (!account) throw new Error("Wallet locked");
  const address = account.address as Address;

  const [latest, pending] = await Promise.all([
    pub.getTransactionCount({ address, blockTag: "latest" }),
    pub.getTransactionCount({ address, blockTag: "pending" }).catch(() => 0),
  ]);
  const reserved = readReserved(chainId, address);
  let nonce = Math.max(latest, pending, reserved != null ? reserved + 1 : 0);

  let lastErr: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const hash = await walletClient.sendTransaction({
        account,
        chain: walletClient.chain,
        ...tx,
        nonce,
      } as Parameters<WalletClient["sendTransaction"]>[0]);
      writeReserved(chainId, address, nonce);
      return hash;
    } catch (e) {
      lastErr = e;
      if (isNonceCollision(msgOf(e))) {
        // Someone (an earlier send) already owns this slot — take the next one
        // so we add a transaction instead of replacing theirs.
        nonce += 1;
        continue;
      }
      throw e;
    }
  }
  const detail =
    lastErr instanceof Error ? ` (${lastErr.message.split("\n")[0]})` : "";
  throw new Error(
    `Couldn't broadcast: earlier transactions from this wallet are still pending. Wait for one to confirm, then try again.${detail}`,
  );
}
