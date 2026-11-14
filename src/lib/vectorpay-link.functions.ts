/**
 * VectorPay wallet-link server calls. The wallet redeems the one-time code
 * shown on the customer's VectorPay dashboard, binding this wallet's private
 * customer ID (account_ref) to their VectorPay account. Signing matches
 * VectorPay's authenticateSignedPartner: HMAC-SHA256 over the raw body with
 * BEEKEEPER_WEBHOOK_SECRET, sent as `x-beekeeper-signature: sha256=<hex>`.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { makeNonceGuard } from "@/lib/security/seen-nonce";
import { LOOKUP_MAX_AGE_MS } from "@/lib/cashout/proof";

const DEFAULT_LINK_URL = "https://vector-pay.com/api/public/beekeeper/link";
const ALLOWED_HOSTS = new Set(["vector-pay.com", "www.vector-pay.com"]);

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

/**
 * Signed proof shared by redeem and status: the wallet's holder key signs the
 * exact customer ID with a fresh nonce (round-2 audit 2.4). On top of that,
 * the customer ID is locked to the first wallet that proves itself, and each
 * nonce works once (round-4 audit N2, B5).
 */
const signedRef = {
  accountRef: z.string().regex(/^bk_[0-9a-f]{40}$/),
  address: z.string().min(20).max(64),
  message: z.string().min(40).max(400),
  signature: z.string().min(40).max(200),
};
const redeemSchema = z.object({ ...signedRef, code: z.string().min(1).max(16) });
const statusSchema = z.object(signedRef);

const lookupReplayed = makeNonceGuard(LOOKUP_MAX_AGE_MS * 2 + 60_000);

async function proveOwner(data: z.infer<typeof statusSchema>): Promise<string | null> {
  const { checkBankLookup } = await import("./cashout/proof");
  const problem = checkBankLookup(data);
  if (problem) return `This wallet couldn't prove itself (${problem}).`;
  if (lookupReplayed(`${data.address}:${data.message.split("\n")[3] ?? ""}`)) {
    return "This wallet couldn't prove itself (request already used — try again).";
  }
  const { ownsAccount } = await import("./cashout/account-owner.server");
  if (!(await ownsAccount(data.accountRef, data.address))) {
    const { OTHER_WALLET_DETAIL } = await import("./cashout/account-owner");
    return OTHER_WALLET_DETAIL;
  }
  return null;
}

/** Redeem the one-time code from the customer's VectorPay dashboard. */
export const redeemVectorPayLink = createServerFn({ method: "POST" })
  .inputValidator((data) => redeemSchema.parse(data))
  .handler(async ({ data }) => {
    const problem = await proveOwner(data);
    if (problem) return { ok: false, linked: false, firstName: null, bank: null, detail: problem };
    return callLinkEndpoint({ code: data.code, accountRef: data.accountRef });
  });

/**
 * Report whether this wallet's customer ID is linked (no code needed). The
 * reply carries the bank name and last-4, so only the owning wallet gets it.
 */
export const vectorPayLinkStatus = createServerFn({ method: "POST" })
  .inputValidator((data) => statusSchema.parse(data))
  .handler(async ({ data }) => {
    const problem = await proveOwner(data);
    if (problem) return { ok: false, linked: false, firstName: null, bank: null, detail: problem };
    return callLinkEndpoint({ accountRef: data.accountRef });
  });
