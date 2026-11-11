/**
 * Turn Bridge virtual-account activity (one row per step) into one line per
 * deposit, showing how far it got. Browser-safe.
 */
export interface BridgeActivity {
  id?: string;
  type?: string;
  deposit_id?: string;
  amount?: string;
  developer_fee_amount?: string;
  created_at?: string;
  destination_tx_hash?: string;
  receipt?: { destination_tx_hash?: string } | null;
}

export type TopupState = "received" | "in_review" | "converting" | "delivered" | "refunded";

export interface TopupLine {
  depositId: string;
  amountUsd: number;
  feeUsd: number;
  netUsd: number;
  state: TopupState;
  txHash: string | null;
  createdAt: string;
}

const RANK: Record<TopupState, number> = { received: 1, in_review: 2, converting: 3, delivered: 4, refunded: 5 };

export function activityState(type: string | undefined): TopupState | null {
  switch (type) {
    case "funds_received":
    case "funds_scheduled":
      return "received";
    case "in_review":
    case "microdeposit":
      return "in_review";
    case "payment_submitted":
      return "converting";
    case "payment_processed":
      return "delivered";
    case "refund":
    case "refunded":
      return "refunded";
    default:
      return null;
  }
}

const num = (s: string | undefined) => {
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
};

export function groupActivity(rows: BridgeActivity[]): TopupLine[] {
  const by = new Map<string, TopupLine>();
  for (const r of rows) {
    const state = activityState(r.type);
    const depositId = r.deposit_id || r.id;
    if (!state || !depositId) continue;
    const tx = r.destination_tx_hash || r.receipt?.destination_tx_hash || null;
    const cur = by.get(depositId);
    if (!cur) {
      const amount = num(r.amount);
      const fee = num(r.developer_fee_amount);
      by.set(depositId, {
        depositId,
        amountUsd: amount,
        feeUsd: fee,
        netUsd: Math.max(0, Math.round((amount - fee) * 100) / 100),
        state,
        txHash: tx,
        createdAt: r.created_at ?? "",
      });
      continue;
    }
    if (RANK[state] > RANK[cur.state]) cur.state = state;
    if (tx && !cur.txHash) cur.txHash = tx;
    if (r.created_at && (!cur.createdAt || r.created_at < cur.createdAt)) cur.createdAt = r.created_at;
    if (!cur.amountUsd && r.amount) {
      cur.amountUsd = num(r.amount);
      cur.feeUsd = num(r.developer_fee_amount);
      cur.netUsd = Math.max(0, Math.round((cur.amountUsd - cur.feeUsd) * 100) / 100);
    }
  }
  return [...by.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}
