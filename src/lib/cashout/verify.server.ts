/**
 * Server-side chain lookups that settle each cash-out line to a real amount.
 * Only imported from server function handlers.
 */
import { erc20Abi, encodeFunctionData } from "viem";
import { USDC_BY_CHAIN, USDT_BY_CHAIN } from "@/lib/chains/erc20";
import { decodeOmniSend } from "@/lib/txc/omni-decode";
import type { MempoolTx } from "@/lib/txc/mempool";
import { MEMPOOL_API } from "@/lib/txc/network";
import { TSD_PROPERTY_ID, capAtBalance, checkEvmTransferTx, checkTsdSend, unitsToUsd } from "./verify";

type EvmChain = "eth" | "base" | "bsc";
const EVM = new Set(["eth", "base", "bsc"]);
const ALCHEMY: Record<EvmChain, string> = {
  eth: "https://eth-mainnet.g.alchemy.com/v2/",
  base: "https://base-mainnet.g.alchemy.com/v2/",
  bsc: "https://bnb-mainnet.g.alchemy.com/v2/",
};
const PUBLIC_FALLBACK: Partial<Record<EvmChain, string>> = { bsc: "https://bsc-dataseed.binance.org" };

function tokenFor(chain: string, asset: string) {
  if (!EVM.has(chain)) return null;
  const c = chain as EvmChain;
  if (asset === "USDC") return USDC_BY_CHAIN[c];
  if (asset === "USDT") return USDT_BY_CHAIN[c];
  return null;
}

async function evmRpc<T>(chain: EvmChain, method: string, params: unknown[]): Promise<T> {
  const key = process.env.ALCHEMY_KEY?.trim();
  const urls = [key ? ALCHEMY[chain] + key : null, PUBLIC_FALLBACK[chain] ?? null].filter(Boolean) as string[];
  let last: unknown = new Error("no RPC configured");
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`http ${res.status}`);
      const json = (await res.json()) as { result?: T; error?: { message: string } };
      if (json.error) throw new Error(json.error.message);
      return json.result as T;
    } catch (cause) {
      last = cause;
    }
  }
  throw last;
}

async function txcRpc<T>(method: string, params: unknown[]): Promise<T> {
  const raw = process.env.TXC_RPC_URL ?? process.env.TXC_RPC_ADDRESS;
  const user = process.env.TXC_RPC_USER;
  const pass = process.env.TXC_RPC_PASS ?? process.env.TXC_RPC_PASSWORD;
  if (!raw || !user || !pass) throw new Error("TEXITcoin node not configured");
  const url = raw.startsWith("http") ? raw : `https://${raw}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "text/plain", authorization: "Basic " + btoa(`${user}:${pass}`) },
    body: JSON.stringify({ jsonrpc: "1.0", id: "bk-cashout", method, params }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`http ${res.status}`);
  const json = (await res.json()) as { result: T; error: { message: string } | null };
  if (json.error) throw new Error(json.error.message);
  return json.result;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface SettleLine {
  chain: string;
  asset: string;
  from?: string;
  to: string;
  txids?: string[];
  /** What the wallet says it is sending / sent (dollars). Only ever lowered. */
  claimedUsd: number;
}

/** Real dollar amount for one line, or a reason it can't be confirmed. */
export async function settleLine(line: SettleLine, seen: Set<string>): Promise<{ usd: number } | { error: string }> {
  if (!line.from) return { error: "missing sender" };
  const txids = (line.txids ?? []).map((t) => t.toLowerCase().replace(/^0x/, ""));

  if (txids.length === 0) {
    // Before coins move: cap at the sending address's balance right now.
    try {
      const balance = await balanceUsd(line);
      return { usd: capAtBalance(line.claimedUsd, balance) };
    } catch {
      return { error: "couldn't check the balance right now — try again in a moment" };
    }
  }

  let total = 0;
  for (const id of txids) {
    if (seen.has(id)) continue; // same txid listed twice never counts twice
    seen.add(id);
    let result: { ok: true; raw: bigint } | { ok: false; reason: string } = { ok: false, reason: "not found" };
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        result = await lookupTx(line, id);
      } catch {
        result = { ok: false, reason: "not found" };
      }
      if (result.ok || result.reason !== "not found") break;
      await sleep(2000);
    }
    if (!result.ok) {
      return {
        error:
          result.reason === "not found"
            ? "the send isn't visible on the blockchain yet — try again in a minute"
            : `the send was ${result.reason}`,
      };
    }
    const decimals = line.chain === "txc" ? 8 : tokenFor(line.chain, line.asset)!.decimals;
    total += unitsToUsd(result.raw, decimals);
  }
  return { usd: Math.round(total * 100) / 100 };
}

async function balanceUsd(line: SettleLine): Promise<number> {
  if (line.chain === "txc" && line.asset === "TSD") {
    const bal = await txcRpc<{ balance: string }>("omni_getbalance", [line.from, TSD_PROPERTY_ID]);
    const n = Number(bal.balance);
    return Number.isFinite(n) ? Math.floor(n * 100) / 100 : 0;
  }
  const token = tokenFor(line.chain, line.asset);
  if (!token) throw new Error("unsupported");
  const data = encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [line.from as `0x${string}`] });
  const hex = await evmRpc<string>(line.chain as EvmChain, "eth_call", [{ to: token.address, data }, "latest"]);
  return unitsToUsd(BigInt(hex || "0x0"), token.decimals);
}

async function lookupTx(line: SettleLine, txid: string) {
  if (line.chain === "txc" && line.asset === "TSD") {
    const res = await fetch(`${MEMPOOL_API}/tx/${txid}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8000) });
    if (res.status === 404 || res.status === 400) return { ok: false as const, reason: "not found" };
    if (!res.ok) throw new Error(`mempool ${res.status}`);
    const tx = (await res.json()) as MempoolTx;
    const checked = checkTsdSend(decodeOmniSend(tx), { from: line.from!, to: line.to });
    if (!checked.ok) return checked;
    // Once confirmed, Omni Core says whether the send was actually valid
    // (e.g. the sender really had the TSD). Unconfirmed sends can't be judged yet.
    if (tx.status?.confirmed) {
      try {
        const omni = await txcRpc<{ valid?: boolean }>("omni_gettransaction", [txid]);
        if (omni.valid === false) return { ok: false as const, reason: "rejected by the TSD ledger" };
      } catch {
        /* node unreachable — the decoded amount still stands; VectorPay re-checks */
      }
    }
    return checked;
  }
  const token = tokenFor(line.chain, line.asset);
  if (!token) return { ok: false as const, reason: "unsupported coin" };
  const chain = line.chain as EvmChain;
  const hash = `0x${txid}`;
  const [tx, receipt] = await Promise.all([
    evmRpc<{ from: string; to: string; input: string } | null>(chain, "eth_getTransactionByHash", [hash]),
    evmRpc<{ status?: string } | null>(chain, "eth_getTransactionReceipt", [hash]).catch(() => null),
  ]);
  return checkEvmTransferTx(tx, receipt?.status ?? null, { from: line.from!, to: line.to, token: token.address });
}
