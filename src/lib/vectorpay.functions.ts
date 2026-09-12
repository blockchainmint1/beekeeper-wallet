import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { CASHOUT_DISCLOSURES, ORDER_FEE_BPS, ORDER_MAX_USD, ORDER_MIN_USD } from "./vectorpay";

const allowedDisclosureIds = new Set(CASHOUT_DISCLOSURES.map((item) => item.id));
const assetChain = z.discriminatedUnion("asset", [
  z.object({ asset: z.literal("TSD"), chain: z.literal("txc") }),
  z.object({ asset: z.literal("USDC"), chain: z.literal("base") }),
]);

const startSchema = z
  .object({
    usd: z.number().finite().min(ORDER_MIN_USD).max(ORDER_MAX_USD),
    name: z.string().trim().min(2).max(120),
    email: z.string().trim().email().max(200),
    acceptedDisclaimers: z.array(z.string().min(1).max(64)).length(CASHOUT_DISCLOSURES.length),
  })
  .and(assetChain)
  .superRefine((value, context) => {
    const unique = new Set(value.acceptedDisclaimers);
    if (unique.size !== CASHOUT_DISCLOSURES.length || [...unique].some((id) => !allowedDisclosureIds.has(id as never))) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["acceptedDisclaimers"], message: "All disclosures must be accepted." });
    }
  });

export const getVectorPayConfig = createServerFn({ method: "GET" }).handler(async () => {
  const { vectorPayConfigured } = await import("./vectorpay.server");
  return { configured: vectorPayConfigured() };
});

export const startVectorPayCashout = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => startSchema.parse(raw))
  .handler(async ({ data }) => {
    const { cashoutDepositAddress, postVectorPayOrder, vectorPayConfigured } = await import("./vectorpay.server");
    const orderId = `BK-${Date.now().toString(36).toUpperCase()}-${crypto.randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase()}`;
    const feeUsd = Math.round(data.usd * (ORDER_FEE_BPS / 10_000) * 100) / 100;
    if (!vectorPayConfigured()) {
      return { orderId, feeUsd, registered: false, handoffUrl: null, detail: "Cash out is not configured yet." };
    }
    const destination = cashoutDepositAddress(data.chain);
    if (!destination) {
      return { orderId, feeUsd, registered: false, handoffUrl: null, detail: `The ${data.chain === "txc" ? "TEXITcoin" : "Base"} cash-out address is not configured.` };
    }

    const returnOrigin = "https://beekeeper.money";
    const returnUrl = `${returnOrigin}/wallet/order/${encodeURIComponent(orderId)}`;
    const relay = await postVectorPayOrder({
      side: "sell",
      reference: orderId,
      account_ref: data.email.toLowerCase(),
      customer_name: data.name,
      customer_email: data.email.toLowerCase(),
      asset: data.asset,
      chain: data.chain,
      destination_address: destination,
      usd_amount: data.usd.toFixed(2),
      asset_amount: data.usd.toFixed(2),
      rate: "1",
      fee_bps: ORDER_FEE_BPS,
      fee_usd: feeUsd.toFixed(2),
      return_url: returnUrl,
      cancel_url: returnUrl,
      accepted_disclaimers: data.acceptedDisclaimers,
    });
    return { orderId, feeUsd, registered: relay.ok, handoffUrl: relay.checkoutUrl, detail: relay.detail };
  });
