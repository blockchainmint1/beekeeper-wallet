import { describe, expect, it } from "vitest";
import { groupActivity } from "./history";

describe("top-up history", () => {
  it("one deposit's steps collapse to one line at its furthest state", () => {
    const lines = groupActivity([
      { id: "a1", deposit_id: "d1", type: "funds_received", amount: "50.0", developer_fee_amount: "1.5", created_at: "2026-11-11T18:10:47Z" },
      { id: "a2", deposit_id: "d1", type: "payment_submitted", amount: "50.0", created_at: "2026-11-11T18:11:00Z" },
      { id: "a3", deposit_id: "d1", type: "payment_processed", amount: "50.0", destination_tx_hash: "0x" + "1".repeat(64), created_at: "2026-11-11T18:12:00Z" },
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ amountUsd: 50, feeUsd: 1.5, netUsd: 48.5, state: "delivered", txHash: "0x" + "1".repeat(64) });
  });
  it("unknown activity types are ignored", () => {
    expect(groupActivity([{ id: "x", deposit_id: "d", type: "something_else", amount: "5" }])).toEqual([]);
  });
});
