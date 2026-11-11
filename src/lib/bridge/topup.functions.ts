/**
 * Top-up server calls (Bridge, bridge.xyz). Every call carries a fresh wallet
 * signature from the TEXITcoin holder address (src/lib/bridge/topup-proof.ts);
 * the Bridge customer record is keyed by that address, so the browser never
 * names a Bridge ID and nobody else's account can be read.
 *
 * Name and email go straight to Bridge to start its hosted ID check. They are
 * never stored here.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { makeKeyedLimiter } from "@/lib/security/keyed-limit";
import type { TopupAction } from "./topup-proof";
import type { TopupLine } from "./history";

const signed = {
  address: z.string().min(26).max(40),
  base: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  message: z.string().min(60).max(500),
  signature: z.string().min(40).max(200),
};
const signedSchema = z.object(signed);
type Signed = z.infer<typeof signedSchema>;

const readLimit = makeKeyedLimiter(40, 10 * 60_000);
const writeLimit = makeKeyedLimiter(8, 10 * 60_000);

export interface DepositInstructions {
  bankName: string;
  bankAddress: string | null;
  routingNumber: string;
  accountNumber: string;
  beneficiaryName: string;
  beneficiaryAddress: string | null;
  rails: string[];
}

export interface TopupStatus {
  ok: boolean;
  configured: boolean;
  sandbox: boolean;
  stage: "new" | "verifying" | "ready" | "blocked";
  kycStatus: string | null;
  tosStatus: string | null;
  kycUrl: string | null;
  tosUrl: string | null;
  deposit: DepositInstructions | null;
  deliversTo: { rail: string; currency: string; address: string } | null;
  detail: string;
}

const empty = (over: Partial<TopupStatus>): TopupStatus => ({
  ok: false,
  configured: true,
  sandbox: true,
  stage: "new",
  kycStatus: null,
  tosStatus: null,
  kycUrl: null,
  tosUrl: null,
  deposit: null,
  deliversTo: null,
  detail: "",
  ...over,
});

interface CustomerRow {
  id: string;
  txc_address: string;
  env: string;
  base_address: string | null;
  bridge_customer_id: string | null;
  kyc_link_id: string | null;
  virtual_account_id: string | null;
  destination_rail: string | null;
  destination_currency: string | null;
  destination_address: string | null;
}

/** Verify the signature and rate limit; returns the Bridge config + db on success. */
async function open(action: TopupAction, data: Signed, write = false) {
  const { checkTopupProof } = await import("./topup-proof");
  const problem = checkTopupProof({ action, ...data });
  if (problem) return { error: `This wallet couldn't prove itself (${problem}).` } as const;
  if ((write ? writeLimit : readLimit)(`${action}:${data.address}`)) {
    return { error: "Too many tries — wait a few minutes and try again." } as const;
  }
  const { bridgeConfig } = await import("./client.server");
  const cfg = bridgeConfig();
  if (!cfg) return { error: "Top-ups are not set up yet.", unconfigured: true } as const;
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: row } = await supabaseAdmin
    .from("topup_customers")
    .select("*")
    .eq("txc_address", data.address)
    .eq("env", cfg.env)
    .maybeSingle();
  return { cfg, db: supabaseAdmin, row: (row as CustomerRow | null) ?? null } as const;
}

/**
 * Where Bridge delivers. Sandbox: the wallet's own Base address (no real
 * money moves). Live: a TSD mint address for this wallet's T… address from
 * the TSD bridge — until that exists, live accounts are not created at all.
 */
function destinationFor(env: "sandbox" | "live", data: Signed) {
  if (env === "sandbox") return { payment_rail: "base", currency: "usdc", address: data.base };
  return null;
}

function toDeposit(va: Record<string, unknown> | null): DepositInstructions | null {
  const s = (va?.["source_deposit_instructions"] ?? null) as Record<string, unknown> | null;
  if (!s || typeof s["bank_account_number"] !== "string" || typeof s["bank_routing_number"] !== "string") return null;
  const str = (k: string) => (typeof s[k] === "string" ? (s[k] as string) : null);
  return {
    bankName: str("bank_name") ?? "Bank",
    bankAddress: str("bank_address"),
    routingNumber: s["bank_routing_number"] as string,
    accountNumber: s["bank_account_number"] as string,
    beneficiaryName: str("bank_beneficiary_name") ?? "",
    beneficiaryAddress: str("bank_beneficiary_address"),
    rails: Array.isArray(s["payment_rails"]) ? (s["payment_rails"] as unknown[]).filter((x): x is string => typeof x === "string") : [],
  };
}

async function buildStatus(ctx: Exclude<Awaited<ReturnType<typeof open>>, { error: string }>, data: Signed): Promise<TopupStatus> {
  const { cfg, db } = ctx;
  let row = ctx.row;
  const sandbox = cfg.env === "sandbox";
  if (!row?.kyc_link_id) return empty({ ok: true, sandbox, stage: "new", detail: "No deposit account yet." });

  const { bridgeFetch } = await import("./client.server");
  const kyc = await bridgeFetch(cfg, "GET", `/kyc_links/${encodeURIComponent(row.kyc_link_id)}`);
  if (!kyc.ok || !kyc.json) return empty({ sandbox, stage: "verifying", detail: "Couldn't reach Bridge — try again in a moment." });
  const k = kyc.json as Record<string, unknown>;
  const kycStatus = typeof k["kyc_status"] === "string" ? (k["kyc_status"] as string) : null;
  const tosStatus = typeof k["tos_status"] === "string" ? (k["tos_status"] as string) : null;
  const customerId = typeof k["customer_id"] === "string" ? (k["customer_id"] as string) : row.bridge_customer_id;
  const links = {
    kycUrl: kycStatus === "approved" ? null : typeof k["kyc_link"] === "string" ? (k["kyc_link"] as string) : null,
    tosUrl: tosStatus === "approved" ? null : typeof k["tos_link"] === "string" ? (k["tos_link"] as string) : null,
  };
  if (customerId && customerId !== row.bridge_customer_id) {
    await db.from("topup_customers").update({ bridge_customer_id: customerId, updated_at: new Date().toISOString() }).eq("id", row.id);
    row = { ...row, bridge_customer_id: customerId };
  }
  const base = { sandbox, kycStatus, tosStatus, ...links };
  if (kycStatus === "rejected" || kycStatus === "offboarded") {
    return empty({ ok: true, ...base, stage: "blocked", detail: "Bridge couldn't approve this ID check." });
  }
  if (kycStatus !== "approved" || tosStatus !== "approved" || !customerId) {
    return empty({ ok: true, ...base, stage: "verifying", detail: "Waiting for Bridge to approve your ID check." });
  }

  // Approved: make (or read) the permanent deposit account.
  let va: Record<string, unknown> | null = null;
  if (row.virtual_account_id) {
    const r = await bridgeFetch(cfg, "GET", `/customers/${encodeURIComponent(customerId)}/virtual_accounts/${encodeURIComponent(row.virtual_account_id)}`);
    va = r.ok ? (r.json as Record<string, unknown>) : null;
    if (!va) return empty({ ...base, stage: "ready", detail: "Couldn't load your deposit account — try again in a moment." });
  } else {
    const dest = destinationFor(cfg.env, data);
    if (!dest) {
      return empty({ ok: true, ...base, stage: "verifying", detail: "You're approved. Live top-ups switch on once TSD delivery is connected." });
    }
    const { bridgeFeeString } = await import("./fees");
    const r = await bridgeFetch(
      cfg,
      "POST",
      `/customers/${encodeURIComponent(customerId)}/virtual_accounts`,
      { source: { currency: "usd" }, destination: dest, developer_fee_percent: bridgeFeeString() },
      `bk-va-${cfg.env}-${row.id}`,
    );
    va = r.ok ? (r.json as Record<string, unknown>) : null;
    const vaId = typeof va?.["id"] === "string" ? (va["id"] as string) : null;
    if (!va || !vaId) return empty({ ...base, stage: "verifying", detail: "Bridge couldn't open your deposit account yet — try again shortly." });
    await db
      .from("topup_customers")
      .update({
        virtual_account_id: vaId,
        destination_rail: dest.payment_rail,
        destination_currency: dest.currency,
        destination_address: dest.address,
        base_address: data.base,
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id);
  }
  const d = (va["destination"] ?? null) as Record<string, unknown> | null;
  return empty({
    ok: true,
    ...base,
    stage: "ready",
    deposit: toDeposit(va),
    deliversTo: d
      ? { rail: String(d["payment_rail"] ?? ""), currency: String(d["currency"] ?? ""), address: String(d["address"] ?? "") }
      : null,
    detail: "Ready.",
  });
}

/** Where this wallet's top-up account stands, with deposit details once ready. */
export const topupStatus = createServerFn({ method: "POST" })
  .inputValidator((d) => signedSchema.parse(d))
  .handler(async ({ data }): Promise<TopupStatus> => {
    const ctx = await open("status", data);
    if ("error" in ctx) return empty({ configured: !("unconfigured" in ctx), detail: ctx.error });
    return buildStatus(ctx, data);
  });

const startSchema = z.object({
  ...signed,
  fullName: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(200),
  type: z.enum(["individual", "business"]),
});

/** Start Bridge's hosted terms + ID check. Name/email are passed through, never stored. */
export const startTopupKyc = createServerFn({ method: "POST" })
  .inputValidator((d) => startSchema.parse(d))
  .handler(async ({ data }): Promise<TopupStatus> => {
    const proof = { address: data.address, base: data.base, message: data.message, signature: data.signature };
    const ctx = await open("start", proof, true);
    if ("error" in ctx) return empty({ configured: !("unconfigured" in ctx), detail: ctx.error });
    if (ctx.row?.kyc_link_id) return buildStatus(ctx, proof);

    const { bridgeFetch } = await import("./client.server");
    const r = await bridgeFetch(ctx.cfg, "POST", "/kyc_links", { full_name: data.fullName, email: data.email, type: data.type });
    const j = (r.json ?? {}) as Record<string, unknown>;
    const linkId = typeof j["id"] === "string" ? (j["id"] as string) : null;
    if (!r.ok || !linkId) {
      const msg = typeof j["message"] === "string" ? (j["message"] as string) : "";
      return empty({ sandbox: ctx.cfg.env === "sandbox", detail: /email/i.test(msg) ? "Bridge didn't accept that email." : "Bridge couldn't start the ID check — try again." });
    }
    const { data: inserted, error } = await ctx.db
      .from("topup_customers")
      .upsert(
        {
          txc_address: data.address,
          env: ctx.cfg.env,
          base_address: data.base,
          kyc_link_id: linkId,
          bridge_customer_id: typeof j["customer_id"] === "string" ? (j["customer_id"] as string) : null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "txc_address,env" },
      )
      .select("*")
      .single();
    if (error || !inserted) return empty({ detail: "Couldn't save your top-up account — try again." });
    return buildStatus({ ...ctx, row: inserted as CustomerRow }, proof);
  });

/** One line per deposit: amount, our fee, and how far it has got. */
export const topupHistory = createServerFn({ method: "POST" })
  .inputValidator((d) => signedSchema.parse(d))
  .handler(async ({ data }): Promise<{ ok: boolean; lines: TopupLine[]; detail: string }> => {
    const ctx = await open("history", data);
    if ("error" in ctx) return { ok: false, lines: [], detail: ctx.error ?? "" };
    const row = ctx.row;
    if (!row?.bridge_customer_id || !row.virtual_account_id) return { ok: true, lines: [], detail: "" };
    const { bridgeFetch } = await import("./client.server");
    const r = await bridgeFetch(
      ctx.cfg,
      "GET",
      `/customers/${encodeURIComponent(row.bridge_customer_id)}/virtual_accounts/${encodeURIComponent(row.virtual_account_id)}/history?limit=50`,
    );
    if (!r.ok) return { ok: false, lines: [], detail: "Couldn't load your top-ups right now." };
    const { groupActivity } = await import("./history");
    const rows = Array.isArray((r.json as { data?: unknown })?.data) ? ((r.json as { data: unknown[] }).data as never[]) : [];
    return { ok: true, lines: groupActivity(rows), detail: "" };
  });

/** Sandbox only: pretend Bridge approved the ID check. */
export const simulateTopupApproval = createServerFn({ method: "POST" })
  .inputValidator((d) => signedSchema.parse(d))
  .handler(async ({ data }): Promise<TopupStatus> => {
    const ctx = await open("simulate-approval", data, true);
    if ("error" in ctx) return empty({ detail: ctx.error });
    if (ctx.cfg.env !== "sandbox") return empty({ sandbox: false, detail: "Test approval only works in test mode." });
    if (!ctx.row?.bridge_customer_id) return buildStatus(ctx, data);
    const { bridgeFetch } = await import("./client.server");
    await bridgeFetch(ctx.cfg, "POST", `/customers/${encodeURIComponent(ctx.row.bridge_customer_id)}/simulate_kyc_approval`, {});
    return buildStatus(ctx, data);
  });

const simDepositSchema = z.object({ ...signed, amount: z.number().min(5).max(1000) });

/** Sandbox only: pretend the customer's bank sent a deposit. */
export const simulateTopupDeposit = createServerFn({ method: "POST" })
  .inputValidator((d) => simDepositSchema.parse(d))
  .handler(async ({ data }): Promise<{ ok: boolean; detail: string }> => {
    const proof = { address: data.address, base: data.base, message: data.message, signature: data.signature };
    const ctx = await open("simulate-deposit", proof, true);
    if ("error" in ctx) return { ok: false, detail: ctx.error ?? "" };
    if (ctx.cfg.env !== "sandbox") return { ok: false, detail: "Test deposits only work in test mode." };
    const row = ctx.row;
    if (!row?.bridge_customer_id || !row.virtual_account_id) return { ok: false, detail: "Open your deposit account first." };
    const { bridgeFetch } = await import("./client.server");
    const r = await bridgeFetch(
      ctx.cfg,
      "POST",
      `/customers/${encodeURIComponent(row.bridge_customer_id)}/virtual_accounts/${encodeURIComponent(row.virtual_account_id)}/simulate_deposit`,
      { currency: "usd", amount: data.amount.toFixed(2) },
    );
    return r.ok ? { ok: true, detail: "Test deposit sent." } : { ok: false, detail: "Bridge didn't accept the test deposit." };
  });
