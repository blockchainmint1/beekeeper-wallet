import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { CASHOUT_DISCLOSURES, MERCHANT_FEE_BPS, ORDER_FEE_BPS, ORDER_MAX_USD, ORDER_MIN_USD, type CashoutAsset, type CashoutChain } from "./vectorpay";

const allowedDisclosureIds = new Set(CASHOUT_DISCLOSURES.map((item) => item.id));
const CASHOUT_CHAINS: CashoutChain[] = ["txc", "base", "eth", "bsc", "tron"];
const CASHOUT_ASSET_SYMBOLS: CashoutAsset[] = ["TSD", "USDC", "USDT"];

const startSchema = z
  .object({
    reference: z.string().regex(/^BK-[A-Z0-9]+-[A-F0-9]{20,32}$/).max(64),
    usd: z.number().finite().min(ORDER_MIN_USD).max(ORDER_MAX_USD),
    /** Wallet-derived customer ID (bk_ + 40 hex) — VectorPay keys saved banks to it. */
    customerId: z.string().regex(/^bk_[0-9a-f]{40}$/),
    acceptedDisclaimers: z.array(z.string().min(1).max(64)).length(CASHOUT_DISCLOSURES.length),
    /** NectarPay merchant id, when this wallet is linked — 0% fee tier. */
    merchantId: z.string().trim().min(3).max(64).regex(/^[A-Za-z0-9_-]+$/).optional(),
    /** What the merchant actually sent, wallet by wallet. */
    transfers: z
      .array(
        z.object({
          chain: z.enum(["txc", "base", "eth", "bsc", "tron"]),
          asset: z.enum(["TSD", "USDC", "USDT"]),
          usd: z.number().finite().min(0).max(ORDER_MAX_USD),
          /** Ownership proof: sending address signed the order + txids. */
          from: z.string().trim().min(20).max(80).optional(),
          txids: z.array(z.string().trim().regex(/^(0x)?[0-9a-fA-F]{64}$/)).max(20).optional(),
          amount: z.string().regex(/^\d+(\.\d+)?$/).max(40).optional(),
          message: z.string().max(2000).optional(),
          signature: z.string().min(40).max(200).optional(),
        }),
      )
      .min(1)
      .max(50),
  })
  .superRefine((value, context) => {
    const unique = new Set(value.acceptedDisclaimers);
    if (unique.size !== CASHOUT_DISCLOSURES.length || [...unique].some((id) => !allowedDisclosureIds.has(id as never))) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["acceptedDisclaimers"], message: "All disclosures must be accepted." });
    }
  });

export const getVectorPayConfig = createServerFn({ method: "GET" }).handler(async () => {
  const { cashoutDestinations, vectorPayConfigured } = await import("./vectorpay.server");
  return { configured: vectorPayConfigured(), destinations: cashoutDestinations() };
});


/**
 * Latest known status for one order reference, as reported by VectorPay's
 * webhook. References carry ~96 bits of entropy and the row holds no personal
 * or bank data, so a reference-scoped lookup is safe without a session.
 */
export const getCashoutOrderStatus = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) =>
    z.object({ reference: z.string().trim().min(6).max(64).regex(/^BK-[A-Z0-9-]+$/i) }).parse(raw),
  )
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: row } = await supabaseAdmin
      .from("cashout_order_status")
      .select("status, detail, payout_usd, updated_at")
      .eq("reference", data.reference.toUpperCase())
      .maybeSingle();
    if (!row) return null;
    return {
      status: row.status,
      detail: row.detail,
      payoutUsd: row.payout_usd === null ? null : Number(row.payout_usd),
      updatedAt: row.updated_at,
    };
  });

export const startVectorPayCashout = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => startSchema.parse(raw))
  .handler(async ({ data }) => {
    const { cashoutDepositAddress, postVectorPayOrder, vectorPayConfigured } = await import("./vectorpay.server");
    const orderId = data.reference;
    const feeBps = data.merchantId ? MERCHANT_FEE_BPS : ORDER_FEE_BPS;
    const feeUsd = Math.round(data.usd * (feeBps / 10_000) * 100) / 100;
    if (!vectorPayConfigured()) {
      return { orderId, feeUsd, feeBps, registered: false, handoffUrl: null, detail: "Cash out is not configured yet.", transfers: data.transfers };
    }

    // Every selected chain needs a treasury deposit address.
    for (const t of data.transfers) {
      if (!cashoutDepositAddress(t.chain)) {
        return { orderId, feeUsd, feeBps, registered: false, handoffUrl: null, detail: `The ${t.chain} cash-out address is not configured.`, transfers: data.transfers };
      }
    }

    // Proof of possession (audit M4): every transfer must carry a signature
    // from its sending address over the exact proof text for THIS order and
    // OUR deposit address. Without it the server would HMAC-sign anything.
    const { checkCashoutProof } = await import("./cashout/proof");
    for (const t of data.transfers) {
      const problem = await checkCashoutProof({
        reference: orderId,
        chain: t.chain,
        asset: t.asset,
        to: cashoutDepositAddress(t.chain)!,
        from: t.from,
        txids: t.txids,
        message: t.message,
        signature: t.signature,
      });
      if (problem) {
        return { orderId, feeUsd, feeBps, registered: false, handoffUrl: null, detail: `The ${t.asset} on ${t.chain} proof didn't check out (${problem}). Nothing was sent.`, transfers: data.transfers };
      }
    }

    // Settle every line from the chain (deep scan: "Anyone can set the
    // cash-out amount"). Before coins move, each line is capped at the
    // sending address's real balance; once a txid exists, the line becomes
    // exactly what that transaction moves to our deposit address. The
    // wallet's own numbers can only ever be lowered, never raised.
    const { settleLine } = await import("./cashout/verify.server");
    const seenTxids = new Set<string>();
    const settled: typeof data.transfers = [];
    for (const t of data.transfers) {
      const claimed = t.amount ? Math.min(Number(t.amount), t.usd || Number(t.amount)) : t.usd;
      const result = await settleLine(
        { chain: t.chain, asset: t.asset, from: t.from, to: cashoutDepositAddress(t.chain)!, txids: t.txids, claimedUsd: claimed },
        seenTxids,
      );
      if ("error" in result) {
        return { orderId, feeUsd, feeBps, registered: false, handoffUrl: null, detail: `Couldn't confirm the ${t.asset} on ${t.chain}: ${result.error}.`, transfers: data.transfers };
      }
      if (result.usd <= 0) continue;
      settled.push({ ...t, usd: result.usd, amount: result.usd.toFixed(2) });
    }
    const settledUsd = Math.min(ORDER_MAX_USD, Math.round(settled.reduce((sum, t) => sum + t.usd, 0) * 100) / 100);
    if (settled.length === 0 || settledUsd < ORDER_MIN_USD) {
      return { orderId, feeUsd, feeBps, registered: false, handoffUrl: null, detail: `The blockchain shows less than the $${ORDER_MIN_USD} minimum for this cash-out.`, transfers: data.transfers };
    }
    const usd = settledUsd;
    const settledFee = Math.round(usd * (feeBps / 10_000) * 100) / 100;

    // Use the largest transfer as the order's headline asset/chain.
    const primary = [...settled].sort((a, b) => b.usd - a.usd)[0];
    const chain = primary.chain;
    const asset = primary.asset;
    const destination = cashoutDepositAddress(chain)!;

    const returnOrigin = "https://beekeeper.money";
    const returnUrl = `${returnOrigin}/wallet/order/${encodeURIComponent(orderId)}`;
    const relay = await postVectorPayOrder({
      side: "sell",
      reference: orderId,
      account_ref: data.customerId,
      asset,
      chain,
      destination_address: destination,
      usd_amount: usd.toFixed(2),
      asset_amount: usd.toFixed(2),
      rate: "1",
      fee_bps: feeBps,
      fee_usd: settledFee.toFixed(2),
      return_url: returnUrl,
      cancel_url: returnUrl,
      accepted_disclaimers: data.acceptedDisclaimers,
      transfers: settled.map((row) => ({
        chain: row.chain,
        asset: row.asset,
        usd: row.usd.toFixed(2),
        destination_address: cashoutDepositAddress(row.chain)!,
        ...(row.from ? { from_address: row.from } : {}),
        ...(row.txids ? { txids: row.txids } : {}),
        ...(row.amount ? { asset_amount: row.amount } : {}),
        ...(row.message && row.signature ? { proof_message: row.message, proof_signature: row.signature } : {}),
      })),
      ...(data.merchantId ? { merchant_ref: data.merchantId } : {}),
    });
    return { orderId, usd, feeUsd: settledFee, feeBps, chain, asset, registered: relay.ok, handoffUrl: relay.checkoutUrl, detail: relay.detail, transfers: settled };

  });
