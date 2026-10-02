/**
 * VectorPay wallet-link server calls. The wallet redeems the one-time code
 * shown on the customer's VectorPay dashboard, binding this wallet's private
 * customer ID (account_ref) to their VectorPay account. Signing matches
 * VectorPay's authenticateSignedPartner: HMAC-SHA256 over the raw body with
 * BEEKEEPER_WEBHOOK_SECRET, sent as `x-beekeeper-signature: sha256=<hex>`.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const DEFAULT_LINK_URL = "https://vector-pay.com/api/public/beekeeper/link";
const ALLOWED_HOSTS = new Set(["vector-pay.com", "www.vector-pay.com"]);

const inputSchema = z.object({
  code: z.string().max(16).optional(),
  accountRef: z.string().min(1).max(200),
});

export interface VectorPayLinkReply {
  ok: boolean;
  linked: boolean;
  firstName: string | null;
  bank: { institution: string | null; mask: string; subtype: string | null } | null;
  detail: string;
}

async function callLinkEndpoint(input: { code?: string; accountRef: string }): Promise<VectorPayLinkReply> {
  const secret = process.env["BEEKEEPER_WEBHOOK_SECRET"]?.trim();
  if (!secret) {
    return { ok: false, linked: false, firstName: null, bank: null, detail: "VectorPay linking is not configured yet." };
  }
  const endpoint = process.env["VECTORPAY_LINK_URL"]?.trim() || DEFAULT_LINK_URL;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return { ok: false, linked: false, firstName: null, bank: null, detail: "The VectorPay link endpoint is invalid." };
  }
  if (url.protocol !== "https:" || !ALLOWED_HOSTS.has(url.hostname.toLowerCase())) {
    return { ok: false, linked: false, firstName: null, bank: null, detail: "The VectorPay link endpoint is not approved." };
  }

  const body = JSON.stringify({
    account_ref: input.accountRef,
    ...(input.code ? { code: input.code } : {}),
  });
  const { createHmac } = await import("node:crypto");
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-beekeeper-signature": signature,
        "x-partner-name": "BeeKeeper",
      },
      body,
    });
    const json = (await response.json().catch(() => null)) as {
      linked?: boolean;
      error?: string;
      customer?: { first_name?: string | null } | null;
      payout_bank?: { institution: string | null; mask: string; subtype: string | null } | null;
    } | null;
    if (!response.ok) {
      const err = json?.error ?? `http_${response.status}`;
      const detail =
        err === "invalid_or_expired_code"
          ? "That code is invalid or has expired — codes last 10 minutes. Get a fresh one from VectorPay."
          : err === "wallet_linked_to_another_account"
            ? "This wallet is already linked to a different VectorPay account."
            : err === "too_many_attempts"
              ? "Too many tries with that code. Get a fresh one from VectorPay."
              : "VectorPay could not link this wallet right now.";
      return { ok: false, linked: false, firstName: null, bank: null, detail };
    }
    return {
      ok: true,
      linked: !!json?.linked,
      firstName: json?.customer?.first_name ?? null,
      bank: json?.payout_bank ?? null,
      detail: json?.linked ? "Linked." : "Not linked yet.",
    };
  } catch {
    return { ok: false, linked: false, firstName: null, bank: null, detail: "Could not reach VectorPay." };
  }
}

/** Redeem the one-time code from the customer's VectorPay dashboard. */
export const redeemVectorPayLink = createServerFn({ method: "POST" })
  .inputValidator((data) => inputSchema.parse(data))
  .handler(async ({ data }) => {
    if (!data.code) return { ok: false, linked: false, firstName: null, bank: null, detail: "Missing code." };
    return callLinkEndpoint({ code: data.code, accountRef: data.accountRef });
  });

/** Report whether this wallet's customer ID is linked (no code needed). */
export const vectorPayLinkStatus = createServerFn({ method: "POST" })
  .inputValidator((data) => inputSchema.parse(data))
  .handler(async ({ data }) => callLinkEndpoint({ accountRef: data.accountRef }));
