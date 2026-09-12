import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { CASHOUT_DISCLOSURES, MERCHANT_FEE_BPS, ORDER_FEE_BPS, ORDER_MAX_USD, ORDER_MIN_USD } from "./vectorpay";

const allowedDisclosureIds = new Set(CASHOUT_DISCLOSURES.map((item) => item.id));

const startSchema = z
  .object({
    reference: z.string().regex(/^BK-[A-Z0-9]+-[A-F0-9]{20,32}$/).max(64),
    usd: z.number().finite().min(ORDER_MIN_USD).max(ORDER_MAX_USD),
    name: z.string().trim().min(2).max(120).regex(/^[\p{L}\p{M}.' -]+$/u, "Enter a valid legal name."),
    email: z.string().trim().email().max(200),
    acceptedDisclaimers: z.array(z.string().min(1).max(64)).length(CASHOUT_DISCLOSURES.length),
    /** NectarPay merchant id, when this wallet is linked — 0% fee tier. */
    merchantId: z.string().trim().min(3).max(64).regex(/^[A-Za-z0-9_-]+$/).optional(),
    /** What the merchant actually sent, wallet by wallet. */
    transfers: z
      .array(
        z.object({
          chain: z.string().trim().min(2).max(16).regex(/^[a-z0-9-]+$/),
          asset: z.string().trim().min(1).max(12).regex(/^[A-Za-z0-9]+$/),
          usd: z.number().finite().min(0).max(ORDER_MAX_USD),
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
      return { orderId, feeUsd, feeBps, registered: false, handoffUrl: null, detail: "Cash out is not configured yet." };
    }
    // Settlement leg: Base USDC when everything came from Base, otherwise TSD.
    const chain = data.transfers.every((row) => row.chain === "base") ? "base" : "txc";
    const asset = chain === "base" ? "USDC" : "TSD";
    const destination = cashoutDepositAddress(chain);
    if (!destination) {
      return { orderId, feeUsd, feeBps, registered: false, handoffUrl: null, detail: `The ${chain === "txc" ? "TEXITcoin" : "Base"} cash-out address is not configured.` };
    }

    const returnOrigin = "https://beekeeper.money";
    const returnUrl = `${returnOrigin}/wallet/order/${encodeURIComponent(orderId)}`;
    const relay = await postVectorPayOrder({
      side: "sell",
      reference: orderId,
      account_ref: data.email.toLowerCase(),
      customer_name: data.name,
      customer_email: data.email.toLowerCase(),
      asset,
      chain,
      destination_address: destination,
      usd_amount: data.usd.toFixed(2),
      asset_amount: data.usd.toFixed(2),
      rate: "1",
      fee_bps: feeBps,
      fee_usd: feeUsd.toFixed(2),
      return_url: returnUrl,
      cancel_url: returnUrl,
      accepted_disclaimers: data.acceptedDisclaimers,
      transfers: data.transfers.map((row) => ({ chain: row.chain, asset: row.asset, usd: row.usd.toFixed(2) })),
      ...(data.merchantId ? { merchant_ref: data.merchantId } : {}),
    });
    return { orderId, feeUsd, feeBps, chain, asset, registered: relay.ok, handoffUrl: relay.checkoutUrl, detail: relay.detail };

  });
