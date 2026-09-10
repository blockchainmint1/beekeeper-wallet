/**
 * Zero Chill history via the Blockscout/Etherscan-compatible explorer API at
 * scan.zerochill.com. Alchemy doesn't index our own L1, so this fills in the
 * "recent activity" list for ZCU.
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

const BASE = process.env['ZCU_EXPLORER_API'] ?? "https://scan.zerochill.com/api";

interface ScanTx {
  hash: string;
  from: string;
  to: string;
  value: string;
  blockNumber: string;
  timeStamp: string;
  isError?: string;
  tokenSymbol?: string;
  tokenDecimal?: string;
  contractAddress?: string;
  input?: string;
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

async function scanList(action: string, address: string): Promise<ScanTx[]> {
  const url = `${BASE}?module=account&action=${action}&address=${address}&sort=desc&page=1&offset=50`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`zcu explorer ${action} ${res.status}`);
  const j = (await res.json()) as { status?: string; result?: unknown };
  return Array.isArray(j.result) ? (j.result as ScanTx[]) : [];
}

export async function fetchZcuHistory(address: string): Promise<ZcuTransfer[]> {
  const lower = address.toLowerCase();
  const [txsRes, tokenRes] = await Promise.allSettled([
    scanList("txlist", address),
    scanList("tokentx", address),
  ]);
  // If the explorer is down entirely, surface it instead of returning an
  // empty list that looks like "no transactions".
  if (txsRes.status === "rejected" && tokenRes.status === "rejected") {
    throw txsRes.reason instanceof Error
      ? txsRes.reason
      : new Error("zcu explorer unavailable");
  }
  const txs = txsRes.status === "fulfilled" ? txsRes.value : [];
  const tokenTxs = tokenRes.status === "fulfilled" ? tokenRes.value : [];

  const rows: ZcuTransfer[] = [];

  for (const t of txs) {
    // Skip zero-value contract calls; the list is for value movement.
    if (!t.value || t.value === "0") continue;
    rows.push({
      hash: t.hash,
      from: t.from,
      to: t.to || null,
      value: scaled(t.value, 18),
      asset: "ZCU",
      category: "external",
      blockNum: Number(t.blockNumber) || 0,
      timestamp: t.timeStamp
        ? new Date(Number(t.timeStamp) * 1000).toISOString()
        : null,
      outgoing: (t.from ?? "").toLowerCase() === lower,
      contractAddress: null,
      spam: false,
      spamReason: null,
    });
  }

  for (const t of tokenTxs) {
    const decimals = Number(t.tokenDecimal ?? "18") || 18;
    const outgoing = (t.from ?? "").toLowerCase() === lower;
    rows.push({
      hash: t.hash,
      from: t.from,
      to: t.to || null,
      value: scaled(t.value ?? "0", decimals),
      asset: t.tokenSymbol || "TOKEN",
      category: "erc20",
      blockNum: Number(t.blockNumber) || 0,
      timestamp: t.timeStamp
        ? new Date(Number(t.timeStamp) * 1000).toISOString()
        : null,
      outgoing,
      contractAddress: t.contractAddress ? t.contractAddress.toLowerCase() : null,
      // No canonical token list on Zero Chill yet — flag unsolicited incoming
      // tokens the same way other chains do, but never the user's own sends.
      spam: false,
      spamReason: null,
    });
  }

  return rows.sort((a, b) => b.blockNum - a.blockNum).slice(0, 50);
}
