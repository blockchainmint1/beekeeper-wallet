/**
 * Locally-tracked pending EVM transactions.
 *
 * After we broadcast a transaction we know its hash immediately, but the
 * indexed history (Alchemy) only shows it once it's mined *and* indexed —
 * which can lag by a minute or more. Without this, the wallet looks like
 * nothing happened and users re-send.
 *
 * Storage: localStorage, per chain + address. No key material, only public
 * broadcast metadata (hash, asset, amount, recipient).
 */
import { useCallback, useEffect, useState } from "react";
import { evmClient, type EvmChainId } from "@/lib/chains/evm";
import { checkPendingEvmTx } from "@/lib/chains/evm-send";

export interface PendingTx {
  hash: string;
  chain: EvmChainId;
  from: string;
  to: string;
  /** Decimal amount string as typed by the user. */
  value: string;
  asset: string;
  /** ms epoch when we broadcast. */
  createdAt: number;
  /** Set once we've seen a receipt. */
  status?: "success" | "reverted" | "dropped";
}

const KEY = "hme.pending-evm-tx.v1";
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const EVENT = "hme:pending-evm-tx";

function readAll(): PendingTx[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const list = JSON.parse(raw) as PendingTx[];
    if (!Array.isArray(list)) return [];
    const now = Date.now();
    return list.filter((t) => t && t.hash && now - t.createdAt < MAX_AGE_MS);
  } catch {
    return [];
  }
}

function writeAll(list: PendingTx[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* storage unavailable */
  }
  window.dispatchEvent(new Event(EVENT));
}

export function addPendingTx(tx: PendingTx): void {
  const list = readAll().filter((t) => t.hash.toLowerCase() !== tx.hash.toLowerCase());
  writeAll([tx, ...list]);
}

export function removePendingTx(hash: string): void {
  writeAll(readAll().filter((t) => t.hash.toLowerCase() !== hash.toLowerCase()));
}

/** Wipe every locally tracked pending tx (used when a wallet is deleted). */
export function clearPendingTxs(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new Event(EVENT));
}

/**
 * Pending transactions for one chain + address, polled against the node until
 * each one has a receipt. Confirmed entries linger briefly (so the user sees
 * the state flip) and are dropped once the indexed history contains the hash.
 *
 * @param confirmedHashes hashes already present in indexed history — these are
 *   removed from local tracking so we never render a duplicate row.
 */
export function usePendingTxs(
  chain: EvmChainId,
  address: string | null,
  confirmedHashes: string[] = [],
): PendingTx[] {
  const [all, setAll] = useState<PendingTx[]>([]);

  useEffect(() => {
    const sync = () => setAll(readAll());
    sync();
    window.addEventListener(EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  const mine = all.filter(
    (t) =>
      t.chain === chain &&
      !!address &&
      t.from.toLowerCase() === address.toLowerCase(),
  );

  // Drop anything the indexer has already picked up.
  useEffect(() => {
    if (!confirmedHashes.length) return;
    const seen = new Set(confirmedHashes.map((h) => h.toLowerCase()));
    const dupes = mine.filter((t) => seen.has(t.hash.toLowerCase()));
    if (dupes.length) for (const d of dupes) removePendingTx(d.hash);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirmedHashes.join(","), mine.length]);

  const poll = useCallback(async () => {
    const unresolved = readAll().filter((t) => t.chain === chain && !t.status);
    for (const t of unresolved) {
      try {
        const r = await evmClient(chain).getTransactionReceipt({
          hash: t.hash as `0x${string}`,
        });
        if (r) {
          const list = readAll().map((x) =>
            x.hash.toLowerCase() === t.hash.toLowerCase()
              ? { ...x, status: r.status as "success" | "reverted" }
              : x,
          );
          writeAll(list);
        } else if ((await checkPendingEvmTx(chain, t.hash)) === "dropped") {
          writeAll(readAll().map((x) => x.hash.toLowerCase() === t.hash.toLowerCase() ? { ...x, status: "dropped" as const } : x));
        }
      } catch {
        // No receipt yet: make sure the node still has it (re-broadcasts if lost).
        try {
          if ((await checkPendingEvmTx(chain, t.hash)) === "dropped") {
            writeAll(readAll().map((x) => x.hash.toLowerCase() === t.hash.toLowerCase() ? { ...x, status: "dropped" as const } : x));
          }
        } catch { /* ignore */ }
        /* still pending / not indexed */
      }
    }
  }, [chain]);

  useEffect(() => {
    if (!mine.some((t) => !t.status)) return;
    void poll();
    const id = window.setInterval(() => void poll(), 10_000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [poll, mine.filter((t) => !t.status).length]);

  return mine;
}
