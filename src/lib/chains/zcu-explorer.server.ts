/**
 * Zero Chill history via the Honest Money ZCU mempool + transaction indexer.
 * The indexer base URL comes from the ZCU_MEMPOOL secret (server-only).
 * Alchemy doesn't index our own L1, so this fills the ZCU activity list.
 */
export interface ZcuTransfer {
  hash: string;
  from: string;
  to: string | null;
  value: string;
  asset: string;
  category: string;
  blockNum: number;
  timestamp: string | null;
  outgoing: boolean;
  contractAddress: string | null;
  spam: boolean;
  spamReason: string | null;
}

/** Indexer base URL, no trailing slash. Read at call time (env is injected then). */
export function zcuIndexerBase(): string {
  const raw = process.env['ZCU_MEMPOOL'] ?? "";
  return raw.replace(/\/+$/, "");
}

interface IndexerTx {
  hash: string;
  blockNumber?: number;
  from?: string;
  to?: string | null;
  value?: string;
  timestamp?: number;
  status?: number;
  direction?: string;
}

interface IndexerTokenTransfer {
  hash?: string;
  transactionHash?: string;
  blockNumber?: number;
  from?: string;
  to?: string | null;
  value?: string;
  timestamp?: number;
  contractAddress?: string;
  token?: { address?: string; symbol?: string; decimals?: number | string };
  tokenSymbol?: string;
  tokenDecimals?: number | string;
  tokenDecimal?: number | string;
  symbol?: string;
  decimals?: number | string;
}

function scaled(raw: string, decimals: number): string {
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

async function getJson(path: string): Promise<unknown> {
  const base = zcuIndexerBase();
  if (!base) throw new Error("ZCU indexer not configured");
  const res = await fetch(`${base}${path}`, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`zcu indexer ${res.status}`);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("zcu indexer returned a non-JSON response");
  }
}

export async function fetchZcuHistory(address: string): Promise<ZcuTransfer[]> {
  const lower = address.toLowerCase();
  const [nativeRes, tokenRes] = await Promise.allSettled([
    getJson(`/api/v1/address/${address}?page=1&pageSize=50`),
    getJson(`/api/v1/address/${address}/tokens?page=1&pageSize=50`),
  ]);

  // If the indexer is down entirely, surface it instead of returning an empty
  // list that looks like "no transactions".
  if (nativeRes.status === "rejected" && tokenRes.status === "rejected") {
    throw nativeRes.reason instanceof Error
      ? nativeRes.reason
      : new Error("zcu indexer unavailable");
  }

  const rows: ZcuTransfer[] = [];

  if (nativeRes.status === "fulfilled") {
    const body = nativeRes.value as { history?: { transactions?: IndexerTx[] } };
    const txs = Array.isArray(body?.history?.transactions) ? body.history!.transactions! : [];
    for (const t of txs) {
      if (!t?.hash) continue;
      if (!t.value || t.value === "0") continue; // value movement only
      rows.push({
        hash: t.hash,
        from: t.from ?? "",
        to: t.to ?? null,
        value: scaled(t.value, 18),
        asset: "ZCU",
        category: "external",
        blockNum: Number(t.blockNumber) || 0,
        timestamp: t.timestamp ? new Date(t.timestamp * 1000).toISOString() : null,
        outgoing:
          t.direction === "out" || (t.from ?? "").toLowerCase() === lower,
        contractAddress: null,
        spam: false,
        spamReason: null,
      });
    }
  }

  if (tokenRes.status === "fulfilled") {
    const body = tokenRes.value as { transfers?: IndexerTokenTransfer[] };
    const transfers = Array.isArray(body?.transfers) ? body.transfers! : [];
    for (const t of transfers) {
      const hash = t.hash ?? t.transactionHash;
      if (!hash) continue;
      const decimalsRaw =
        t.token?.decimals ?? t.tokenDecimals ?? t.tokenDecimal ?? t.decimals ?? 18;
      const decimals = Number(decimalsRaw) || 18;
      const contract = (t.token?.address ?? t.contractAddress ?? null);
      rows.push({
        hash,
        from: t.from ?? "",
        to: t.to ?? null,
        value: scaled(t.value ?? "0", decimals),
        asset: t.token?.symbol ?? t.tokenSymbol ?? t.symbol ?? "TOKEN",
        category: "erc20",
        blockNum: Number(t.blockNumber) || 0,
        timestamp: t.timestamp ? new Date(t.timestamp * 1000).toISOString() : null,
        outgoing: (t.from ?? "").toLowerCase() === lower,
        contractAddress: contract ? contract.toLowerCase() : null,
        spam: false,
        spamReason: null,
      });
    }
  }

  return rows.sort((a, b) => b.blockNum - a.blockNum).slice(0, 50);
}
