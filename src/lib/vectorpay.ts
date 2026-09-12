import { scopedKey } from "@/lib/profiles";

export type CashoutAsset = "TSD" | "USDC";
export type CashoutChain = "txc" | "base";

export const ORDER_MIN_USD = 25;
export const ORDER_MAX_USD = 1000;
export const ORDER_FEE_BPS = 100;

export const CASHOUT_ASSETS = [
  { asset: "TSD", chain: "txc", label: "TSD on TEXITcoin" },
  { asset: "USDC", chain: "base", label: "USDC on Base" },
] as const;

export const CASHOUT_DISCLOSURES = [
  { id: "partner_of_record", text: "VectorPay fulfills this order and is the buyer of record. BeeKeeper only starts the order." },
  { id: "partner_kyc", text: "Identity verification and bank linking happen at VectorPay for required screening." },
  { id: "pricing", text: "Pricing is set when funds clear. The amount shown is an estimate and includes a 1% service fee." },
  { id: "settlement_window", text: "Bank settlement usually takes 1–3 business days." },
  { id: "irreversible", text: "Blockchain transactions are final and cannot be recalled." },
  { id: "self_custody", text: "BeeKeeper never holds your crypto or recovery phrase." },
  { id: "no_advice", text: "This is not investment advice. Crypto is not FDIC or SIPC insured." },
  { id: "terms", text: "I have read and accept the Terms of Service and Privacy Policy." },
] as const;

export function quoteCashout(usd: number) {
  const feeUsd = Math.round(usd * (ORDER_FEE_BPS / 10_000) * 100) / 100;
  return {
    usd: Math.round(usd * 100) / 100,
    feeUsd,
    settlementUsd: Math.max(0, Math.round((usd - feeUsd) * 100) / 100),
    assetAmount: Math.round(usd * 100) / 100,
  };
}

export interface LocalVectorPayOrder {
  id: string;
  side: "sell";
  createdAt: number;
  status: "ready" | "registration_failed";
  usd: number;
  feeUsd: number;
  settlementUsd: number;
  assetAmount: number;
  asset: CashoutAsset;
  chain: CashoutChain;
  checkoutUrl: string | null;
  detail: string;
}

const ORDER_STORE = "beekeeper.vectorpay.orders.v1";

function readOrders(): LocalVectorPayOrder[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(scopedKey(ORDER_STORE)) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter(isLocalOrder) : [];
  } catch {
    return [];
  }
}

function isLocalOrder(value: unknown): value is LocalVectorPayOrder {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<LocalVectorPayOrder>;
  return typeof row.id === "string" && row.side === "sell" && typeof row.createdAt === "number";
}

export function saveLocalVectorPayOrder(order: LocalVectorPayOrder): void {
  if (typeof window === "undefined") return;
  const next = [order, ...readOrders().filter((row) => row.id !== order.id)].slice(0, 50);
  localStorage.setItem(scopedKey(ORDER_STORE), JSON.stringify(next));
}

export function getLocalVectorPayOrder(id: string): LocalVectorPayOrder | null {
  return readOrders().find((row) => row.id === id) ?? null;
}

export async function openVectorPayCheckout(value: string): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || !["vector-pay.com", "www.vector-pay.com"].includes(url.hostname.toLowerCase())) {
    return false;
  }
  try {
    const { isNative } = await import("@/lib/native/platform");
    if (isNative()) {
      const { Browser } = await import("@capacitor/browser");
      await Browser.open({ url: url.toString() });
      return true;
    }
  } catch {
    return false;
  }
  window.location.assign(url.toString());
  return true;
}
