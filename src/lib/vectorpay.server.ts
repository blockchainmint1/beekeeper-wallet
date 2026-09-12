import type { CashoutAsset, CashoutChain } from "./vectorpay";

const DEFAULT_ORDER_URL = "https://vector-pay.com/api/public/beekeeper";
const CHECKOUT_HOSTS = new Set(["vector-pay.com", "www.vector-pay.com"]);

type RelayOrder = {
  side: "sell";
  reference: string;
  account_ref: string;
  customer_name: string;
  customer_email: string;
  asset: CashoutAsset;
  chain: CashoutChain;
  destination_address: string;
  usd_amount: string;
  asset_amount: string;
  rate: "1";
  fee_bps: number;
  fee_usd: string;
  return_url: string;
  cancel_url: string;
  accepted_disclaimers: string[];
  /** Wallet-by-wallet transfers the merchant actually sent for this order. */
  transfers: Array<{ chain: string; asset: string; usd: string; destination_address?: string }>;
  /** NectarPay merchant id when the wallet is linked (0% fee tier). */
  merchant_ref?: string;
};


export function vectorPayConfigured(): boolean {
  return Boolean(
    process.env["BEEKEEPER_WEBHOOK_SECRET"]?.trim() &&
      process.env["VECTORPAY_ORDER_WEBHOOK_URL"]?.trim() &&
      process.env["CASHOUT_DEPOSIT_ADDRESSES"]?.trim(),
  );
}

export function cashoutDepositAddress(chain: string): string | null {
  try {
    const parsed = JSON.parse(process.env["CASHOUT_DEPOSIT_ADDRESSES"] ?? "{}") as Record<string, unknown>;
    const value = typeof parsed[chain] === "string" ? parsed[chain].trim() : "";
    if (["base", "eth", "bsc"].includes(chain) && !/^0x[0-9a-fA-F]{40}$/.test(value)) return null;
    if (chain === "txc" && !/^[A-Za-z0-9]{26,64}$/.test(value)) return null;
    if (chain === "tron" && !/^[T][A-Za-z1-9]{33}$/.test(value)) return null;
    return value || null;
  } catch {
    return null;
  }
}

/** Deposit addresses the wallet may send to. Safe for the owner's device. */
export function cashoutDestinations(): Record<CashoutChain, string | null> {
  const chains: CashoutChain[] = ["txc", "base", "eth", "bsc", "tron"];
  return Object.fromEntries(chains.map((c) => [c, cashoutDepositAddress(c)])) as Record<CashoutChain, string | null>;
}


async function signatureFor(body: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  const hex = Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `sha256=${hex}`;
}

function safeCheckoutUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && CHECKOUT_HOSTS.has(url.hostname.toLowerCase()) ? url.toString() : null;
  } catch {
    return null;
  }
}

export async function postVectorPayOrder(order: RelayOrder): Promise<{
  ok: boolean;
  detail: string;
  checkoutUrl: string | null;
}> {
  const secret = process.env["BEEKEEPER_WEBHOOK_SECRET"]?.trim();
  const endpoint = process.env["VECTORPAY_ORDER_WEBHOOK_URL"]?.trim() || DEFAULT_ORDER_URL;
  if (!secret || !process.env["VECTORPAY_ORDER_WEBHOOK_URL"]?.trim()) {
    return { ok: false, detail: "Cash out is not configured yet.", checkoutUrl: null };
  }

  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return { ok: false, detail: "The VectorPay order endpoint is invalid.", checkoutUrl: null };
  }
  if (url.protocol !== "https:" || !CHECKOUT_HOSTS.has(url.hostname.toLowerCase())) {
    return { ok: false, detail: "The VectorPay order endpoint is not approved.", checkoutUrl: null };
  }

  const body = JSON.stringify(order);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-beekeeper-signature": await signatureFor(body, secret),
        "x-partner-name": "BeeKeeper",
      },
      body,
    });
    const text = await response.text();
    if (!response.ok) {
      const detail = response.status === 401
        ? "VectorPay rejected the order signature."
        : response.status === 503
          ? "VectorPay is not accepting orders right now."
          : `VectorPay rejected the order (HTTP ${response.status}).`;
      return { ok: false, detail, checkoutUrl: null };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, detail: "VectorPay returned an unexpected response.", checkoutUrl: null };
    }
    const checkoutUrl = safeCheckoutUrl((parsed as { checkout_url?: unknown }).checkout_url);
    if (!checkoutUrl) return { ok: false, detail: "VectorPay returned an invalid checkout link.", checkoutUrl: null };
    return { ok: true, detail: "Your order is ready at VectorPay.", checkoutUrl };
  } catch {
    return { ok: false, detail: "Could not reach VectorPay. Try again in a moment.", checkoutUrl: null };
  }
}
