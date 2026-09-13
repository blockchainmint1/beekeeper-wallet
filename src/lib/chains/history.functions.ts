/**
 * EVM transaction history. Runs server-side so API keys stay hidden.
 * ETH + Base use Alchemy `alchemy_getAssetTransfers`. BSC uses the
 * NOWNodes Blockbook indexer (Alchemy doesn't support
 * alchemy_getAssetTransfers on BNB Chain), with Alchemy as a fallback.
 * Zero Chill uses its own explorer API instead.
 */
import { createServerFn } from "@tanstack/react-start";
import { fetchZcuHistory } from "./zcu-explorer.server";

export type EvmChainId = "eth" | "base" | "bsc" | "zcu";

export interface EvmTransfer {
  hash: string;
  from: string;
  to: string | null;
  /** Decimal value string, already scaled (e.g. "0.05"). */
  value: string;
  asset: string; // "ETH", "USDC", etc.
  category: string; // "external" | "erc20" | "internal"
  blockNum: number;
  /** ISO timestamp when available. */
  timestamp: string | null;
  /** true if this address was the sender. */
  outgoing: boolean;
  /** ERC-20 contract address (lowercase) when category === "erc20". */
  contractAddress: string | null;
  /**
   * Heuristic spam / imposter flag. True for airdropped tokens that
   * impersonate real stablecoins, use phishing symbols/URLs, or come from
   * unknown contracts the user never interacted with. UI hides these when
   * the "Hide worthless / spam tokens" setting is on (default).
   */
  spam: boolean;
  /** Short reason string for the spam classification (for debugging / UI hover). */
  spamReason: string | null;
}

/**
 * Verified ERC-20 contract addresses per chain. Any erc20 transfer whose
 * contract is NOT in this list is treated with suspicion (see classifySpam).
 * Keep in sync with `src/lib/chains/erc20.ts` — this copy exists so the
 * server function stays self-contained and worker-safe.
 */
const VERIFIED_CONTRACTS: Record<EvmChainId, Set<string>> = {
  eth: new Set([
    "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", // USDC
    "0xdac17f958d2ee523a2206206994597c13d831ec7", // USDT
    "0x6b175474e89094c44da98b954eedeac495271d0f", // DAI
    "0x6c3ea9036406852006290770bedfcaba0e23a0e8", // PYUSD
    "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", // WETH
    "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599", // WBTC
  ]),
  base: new Set([
    "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", // USDC
    "0xfde4c96c8593536e31f229ea8f37b2ada2699bb2", // USDT (USD₮0 bridge)
    "0x4200000000000000000000000000000000000006", // WETH
    "0x50c5725949a6f0c72e6c4a641f24049a917db0cb", // DAI
  ]),
  bsc: new Set([
    "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", // USDC
    "0x55d398326f99059ff775485246999027b3197955", // USDT
    "0xe9e7cea3dedca5984780bafc599bd69add087d56", // BUSD
    "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c", // WBNB
  ]),
  // No canonical token deployments on Zero Chill yet.
  zcu: new Set<string>(),
};

/** Well-known "real" symbols that spammers love to impersonate. */
const IMPERSONATED_SYMBOLS = new Set([
  "USDC", "USDT", "DAI", "WETH", "ETH", "WBTC", "BTC",
  "USD", "PYUSD", "BUSD", "WBNB", "USDC.E", "USDT.E",
]);

/** Regex fragments common in phishing token names/symbols. */
const PHISHING_PATTERNS = [
  /https?:/i,
  /\.(com|net|io|xyz|org|app|site|link|gift|claim)\b/i,
  /\b(visit|claim|reward|airdrop|bonus|winner|check|verify)\b/i,
  /[!$@#*]/,
  /\s/,
  // non-ASCII (emoji, cyrillic look-alikes)
  /[^\x20-\x7e]/,
];

function classifySpam(
  chain: EvmChainId,
  category: string,
  asset: string | null,
  contract: string | null,
  outgoing: boolean,
  value: number | null,
): { spam: boolean; reason: string | null } {
  // Native ETH/BNB transfers are never spam.
  if (category !== "erc20") return { spam: false, reason: null };

  const sym = (asset ?? "").trim();
  const symUpper = sym.toUpperCase();
  const addr = (contract ?? "").toLowerCase();
  const verified = addr && VERIFIED_CONTRACTS[chain].has(addr);

  // Verified contract = never spam, regardless of symbol.
  if (verified) return { spam: false, reason: null };

  // No contract on an erc20 row shouldn't happen, but if it does, flag it.
  if (!addr) return { spam: true, reason: "missing contract" };

  // Symbol impersonation: claims to be USDC/USDT/etc but contract isn't the real one.
  if (IMPERSONATED_SYMBOLS.has(symUpper)) {
    return { spam: true, reason: `imposter ${symUpper}` };
  }

  // Phishing-looking name/symbol.
  for (const rx of PHISHING_PATTERNS) {
    if (rx.test(sym)) return { spam: true, reason: "phishing symbol" };
  }
  if (sym.length === 0 || sym.length > 12) {
    return { spam: true, reason: "bad symbol length" };
  }

  // Absurd airdrop amounts on unknown contracts are almost always spam.
  if (!outgoing && value != null && value > 1_000_000_000) {
    return { spam: true, reason: "dust airdrop" };
  }

  // Unknown contract, receive-only (never sent to it) → mark spam by default.
  if (!outgoing) return { spam: true, reason: "unknown contract" };

  return { spam: false, reason: null };
}

const ALCHEMY_URL: Record<EvmChainId, (k: string) => string | null> = {
  eth: (k) => `https://eth-mainnet.g.alchemy.com/v2/${k}`,
  base: (k) => `https://base-mainnet.g.alchemy.com/v2/${k}`,
  // BNB Smart Chain is indexed by Alchemy under bnb-mainnet.
  bsc: (k) => `https://bnb-mainnet.g.alchemy.com/v2/${k}`,
  // Zero Chill is not indexed by Alchemy.
  zcu: () => null,
};

interface AlchemyTransfer {
  hash: string;
  from: string;
  to: string | null;
  value: number | null;
  asset: string | null;
  category: string;
  blockNum: string;
  rawContract?: { address?: string | null };
  metadata?: { blockTimestamp?: string };
}

async function rpc(url: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`Alchemy ${method} ${res.status}`);
  const j = (await res.json()) as { result?: unknown; error?: { message?: string } };
  if (j.error) throw new Error(j.error.message ?? "rpc error");
  return j.result;
}

async function fetchTransfers(
  url: string,
  address: string,
  direction: "from" | "to",
): Promise<AlchemyTransfer[]> {
  const params = [
    {
      fromBlock: "0x0",
      toBlock: "latest",
      [direction === "from" ? "fromAddress" : "toAddress"]: address,
      category: ["external", "erc20", "internal"],
      withMetadata: true,
      excludeZeroValue: true,
      maxCount: "0x19", // 25
      order: "desc",
    },
  ];
  const result = (await rpc(url, "alchemy_getAssetTransfers", params)) as {
    transfers?: AlchemyTransfer[];
  };
  return result.transfers ?? [];
}

// ---------- BSC via NOWNodes Blockbook ----------

interface BlockbookIo {
  addresses?: string[];
  value?: string;
}

interface BlockbookTokenTransfer {
  token?: string;
  symbol?: string;
  decimals?: number;
  from?: string;
  to?: string;
  value?: string;
}

interface BlockbookTx {
  txid: string;
  blockHeight?: number;
  blockTime?: number;
  vin?: BlockbookIo[];
  vout?: BlockbookIo[];
  tokenTransfers?: BlockbookTokenTransfer[];
}

/** Convert an integer base-unit string to a decimal string. */
function formatBaseUnits(value: string, decimals: number): string {
  let v: bigint;
  try {
    v = BigInt(value || "0");
  } catch {
    return "0";
  }
  if (decimals <= 0) return v.toString();
  const s = v.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, -decimals) || "0";
  const frac = s.slice(-decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

function bscSum(io: BlockbookIo[] | undefined, addrLower: string): bigint {
  let sum = 0n;
  for (const x of io ?? []) {
    if ((x.addresses ?? []).some((a) => a.toLowerCase() === addrLower)) {
      try {
        sum += BigInt(x.value || "0");
      } catch {
        /* ignore malformed value */
      }
    }
  }
  return sum;
}

async function fetchBscHistory(address: string, key: string): Promise<EvmTransfer[]> {
  const res = await fetch(
    `https://bscbook.nownodes.io/api/v2/address/${address}?details=txs&pageSize=50`,
    { headers: { "api-key": key } },
  );
  if (!res.ok) throw new Error(`Blockbook BSC ${res.status}`);
  const j = (await res.json()) as { transactions?: BlockbookTx[] };
  const addrLower = address.toLowerCase();
  const out: EvmTransfer[] = [];

  for (const tx of j.transactions ?? []) {
    const ts = tx.blockTime ? new Date(tx.blockTime * 1000).toISOString() : null;
    const blockNum = tx.blockHeight ?? 0;
    const sent = bscSum(tx.vin, addrLower);
    const recv = bscSum(tx.vout, addrLower);
    const counterparty = (io: BlockbookIo[] | undefined): string | null => {
      for (const x of io ?? []) {
        const other = (x.addresses ?? []).find((a) => a.toLowerCase() !== addrLower);
        if (other) return other;
      }
      return null;
    };

    // Native BNB movement (net, so self-transfers cancel out).
    if (sent > recv) {
      const value = formatBaseUnits((sent - recv).toString(), 18);
      out.push({
        hash: tx.txid,
        from: address,
        to: counterparty(tx.vout),
        value,
        asset: "BNB",
        category: "external",
        blockNum,
        timestamp: ts,
        outgoing: true,
        contractAddress: null,
        spam: false,
        spamReason: null,
      });
    } else if (recv > sent) {
      const value = formatBaseUnits((recv - sent).toString(), 18);
      out.push({
        hash: tx.txid,
        from: counterparty(tx.vin) ?? "",
        to: address,
        value,
        asset: "BNB",
        category: "external",
        blockNum,
        timestamp: ts,
        outgoing: false,
        contractAddress: null,
        spam: false,
        spamReason: null,
      });
    }

    // BEP-20 token transfers.
    for (const tt of tx.tokenTransfers ?? []) {
      const from = (tt.from ?? "").toLowerCase();
      const to = (tt.to ?? "").toLowerCase();
      if (from !== addrLower && to !== addrLower) continue;
      const outgoing = from === addrLower && to !== addrLower;
      const contract = tt.token ? tt.token.toLowerCase() : null;
      const num = Number(formatBaseUnits(tt.value ?? "0", tt.decimals ?? 18));
      const { spam, reason } = classifySpam(
        "bsc",
        "erc20",
        tt.symbol ?? null,
        contract,
        outgoing,
        Number.isFinite(num) ? num : null,
      );
      out.push({
        hash: tx.txid,
        from: tt.from ?? "",
        to: tt.to ?? null,
        value: formatBaseUnits(tt.value ?? "0", tt.decimals ?? 18),
        asset: tt.symbol ?? "TOKEN",
        category: "erc20",
        blockNum,
        timestamp: ts,
        outgoing,
        contractAddress: contract,
        spam,
        spamReason: reason,
      });
    }
  }

  return out.sort((a, b) => b.blockNum - a.blockNum).slice(0, 50);
}

export const getEvmHistory = createServerFn({ method: "POST" })
  .inputValidator((input: { chain: EvmChainId; address: string }) => {
    if (!input?.chain || !input?.address) throw new Error("chain and address required");
    if (!/^0x[0-9a-fA-F]{40}$/.test(input.address)) throw new Error("invalid address");
    return input;
  })
  .handler(async ({ data }): Promise<{ transfers: EvmTransfer[]; supported: boolean; unavailable?: boolean }> => {
    // Zero Chill is our own L1 — Alchemy doesn't index it. Use the explorer API.
    if (data.chain === "zcu") {
      try {
        return { transfers: await fetchZcuHistory(data.address), supported: true };
      } catch {
        // Explorer unreachable (outage / TLS) — tell the UI instead of
        // pretending the address has no history.
        return { transfers: [], supported: true, unavailable: true };
      }
    }

    // BSC: NOWNodes Blockbook indexes BNB Chain; Alchemy's
    // alchemy_getAssetTransfers does not. Prefer Blockbook, fall back to
    // Alchemy when no NOWNodes key is configured or Blockbook is down.
    if (data.chain === "bsc") {
      const nnKey = process.env.NOWNODES_API_KEY;
      if (nnKey) {
        try {
          return { transfers: await fetchBscHistory(data.address, nnKey), supported: true };
        } catch {
          // Fall through to Alchemy.
        }
      }
    }

    const key = process.env.ALCHEMY_KEY;
    const builder = ALCHEMY_URL[data.chain];
    const url = key ? builder(key) : null;
    if (!url) return { transfers: [], supported: false };

    try {
      const addrLower = data.address.toLowerCase();
      const [outgoing, incoming] = await Promise.all([
        fetchTransfers(url, data.address, "from"),
        fetchTransfers(url, data.address, "to"),
      ]);

      const map = new Map<string, EvmTransfer>();
      const push = (t: AlchemyTransfer, out: boolean) => {
        const key = `${t.hash}:${t.category}:${t.asset ?? ""}:${out ? "o" : "i"}`;
        if (map.has(key)) return;
        const contract = t.rawContract?.address ? t.rawContract.address.toLowerCase() : null;
        const { spam, reason } = classifySpam(
          data.chain,
          t.category,
          t.asset,
          contract,
          out,
          t.value,
        );
        map.set(key, {
          hash: t.hash,
          from: t.from,
          to: t.to,
          value: t.value != null ? String(t.value) : "0",
          asset: t.asset ?? "ETH",
          category: t.category,
          blockNum: parseInt(t.blockNum, 16),
          timestamp: t.metadata?.blockTimestamp ?? null,
          outgoing: out,
          contractAddress: contract,
          spam,
          spamReason: reason,
        });
      };
      for (const t of outgoing) push(t, t.from.toLowerCase() === addrLower);
      for (const t of incoming) push(t, t.from.toLowerCase() === addrLower);

      const list = [...map.values()].sort((a, b) => b.blockNum - a.blockNum).slice(0, 50);
      return { transfers: list, supported: true };
    } catch {
      return { transfers: [], supported: true };
    }
  });
