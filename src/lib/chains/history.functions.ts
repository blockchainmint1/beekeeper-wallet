/**
 * EVM transaction history via Alchemy `alchemy_getAssetTransfers`.
 * Runs server-side so the API key stays hidden. Supports ETH + Base.
 * BSC is not supported by alchemy_getAssetTransfers — we return empty and
 * the UI shows an "open in explorer" link instead.
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
  // getAssetTransfers unsupported on BSC through Alchemy.
  bsc: () => null,
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

// -------------------- BSC via NOWNodes Blockbook --------------------
// Alchemy doesn't index BNB Chain transfers, so BSC history comes from the
// NOWNodes-hosted Blockbook indexer (NOWNODES_API_KEY stays server-side).

interface BlockbookTx {
  txid: string;
  blockHeight: number;
  blockTime?: number;
  vin?: { addresses?: string[]; value?: string }[];
  vout?: { addresses?: string[]; value?: string }[];
  tokenTransfers?: {
    /** Newer Blockbook builds use `contract`; older ones used `token`. */
    contract?: string;
    token?: string;
    symbol?: string;
    decimals?: number;
    from?: string;
    to?: string;
    value?: string;
  }[];
}

async function blockbookJson(base: string, apiKey: string, path: string): Promise<unknown> {
  const res = await fetch(`${base}${path}`, {
    headers: { accept: "application/json", "api-key": apiKey },
  });
  if (!res.ok) throw new Error(`blockbook ${res.status}`);
  return res.json();
}

function scaledWei(raw: string, decimals: number): string {
  try {
    const v = BigInt(raw);
    const d = BigInt(10) ** BigInt(decimals);
    const whole = v / d;
    const frac = (v % d).toString().padStart(decimals, "0").replace(/0+$/, "");
    return frac ? `${whole}.${frac}` : whole.toString();
  } catch {
    return "0";
  }
}

async function fetchBscHistory(address: string): Promise<EvmTransfer[]> {
  const apiKey = process.env.NOWNODES_API_KEY;
  if (!apiKey) throw new Error("NOWNODES_API_KEY not configured");
  const base = "https://bsc-blockbook.nownodes.io";
  const lower = address.toLowerCase();

  // Step 1: recent tx ids touching this address.
  const addrBody = (await blockbookJson(
    base,
    apiKey,
    `/api/v2/address/${address}?details=txslight&pageSize=25`,
  )) as { transactions?: (string | { txid?: string })[] };
  const txids = (Array.isArray(addrBody?.transactions) ? addrBody.transactions! : [])
    .map((t) => (typeof t === "string" ? t : t?.txid))
    .filter((t): t is string => typeof t === "string" && t.length > 0)
    .slice(0, 25);
  if (txids.length === 0) return [];

  // Step 2: fetch each tx for value/token detail (best-effort, parallel).
  const results = await Promise.allSettled(
    txids.map((id) => blockbookJson(base, apiKey, `/api/v2/tx/${id}`)),
  );

  const rows: EvmTransfer[] = [];
  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    const tx = r.value as BlockbookTx;
    if (!tx?.txid) continue;
    try {
    const timestamp = tx.blockTime ? new Date(tx.blockTime * 1000).toISOString() : null;

    // Native BNB movement.
    const vinMine = (tx.vin ?? []).some((i) =>
      (i.addresses ?? []).some((a) => a.toLowerCase() === lower),
    );
    const received = (tx.vout ?? []).reduce((sum, o) => {
      const mine = (o.addresses ?? []).some((a) => a.toLowerCase() === lower);
      return mine ? sum + BigInt(o.value ?? "0") : sum;
    }, BigInt(0));
    const sent = (tx.vin ?? []).reduce((sum, i) => {
      const mine = (i.addresses ?? []).some((a) => a.toLowerCase() === lower);
      return mine ? sum + BigInt(i.value ?? "0") : sum;
    }, BigInt(0));
    const net = received - sent;
    // Skip zero-net rows unless the user paid in (contract call with no BNB out).
    if (net !== BigInt(0)) {
      const outgoing = net < 0;
      const amount = net < 0 ? -net : net;
      const from = tx.vin?.[0]?.addresses?.[0] ?? "";
      const to = tx.vout?.find((o) =>
        (o.addresses ?? []).some((a) => a.toLowerCase() === (outgoing ? a.toLowerCase() : lower)),
      )?.addresses?.[0] ?? null;
      rows.push({
        hash: tx.txid,
        from,
        to,
        value: scaledWei(amount.toString(), 18),
        asset: "BNB",
        category: "external",
        blockNum: tx.blockHeight ?? 0,
        timestamp,
        outgoing,
        contractAddress: null,
        spam: false,
        spamReason: null,
      });
    } else if (vinMine && (tx.tokenTransfers ?? []).length === 0) {
      // Pure outgoing contract interaction / fee-only — skip to avoid noise.
    }

    // BEP-20 token transfers.
    for (const t of tx.tokenTransfers ?? []) {
      const from = t.from ?? "";
      const to = t.to ?? "";
      const outgoing = from.toLowerCase() === lower;
      const incoming = to.toLowerCase() === lower;
      if (!outgoing && !incoming) continue;
      const decimals = t.decimals ?? 18;
      const valueStr = scaledWei(t.value ?? "0", decimals);
      const contractRaw = t.contract ?? t.token ?? null;
      const contract = contractRaw ? contractRaw.toLowerCase() : null;
      const { spam, reason } = classifySpam(
        "bsc",
        "erc20",
        t.symbol ?? null,
        contract,
        outgoing,
        Number(valueStr) || null,
      );
      rows.push({
        hash: tx.txid,
        from,
        to,
        value: valueStr,
        asset: t.symbol ?? "TOKEN",
        category: "erc20",
        blockNum: tx.blockHeight ?? 0,
        timestamp,
        outgoing,
        contractAddress: contract,
        spam,
        spamReason: reason,
      });
    }
    } catch {
      // One malformed tx shouldn't blank out the whole activity list.
      continue;
    }
  }

  return rows.sort((a, b) => b.blockNum - a.blockNum).slice(0, 50);
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

    // BNB Chain: Alchemy's getAssetTransfers doesn't support it — use the
    // NOWNodes Blockbook indexer instead.
    if (data.chain === "bsc") {
      try {
        return { transfers: await fetchBscHistory(data.address), supported: true };
      } catch {
        return { transfers: [], supported: true, unavailable: true };
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
