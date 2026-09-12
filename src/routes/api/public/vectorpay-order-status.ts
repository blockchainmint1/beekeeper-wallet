/**
 * Listener for VectorPay cash-out order updates.
 *
 * VectorPay POSTs here whenever an order changes state. The body is signed with
 * the shared BEEKEEPER_WEBHOOK_SECRET (the same secret we sign outbound orders
 * with), HMAC-SHA256 over the exact raw bytes, sent as
 * `x-beekeeper-signature: sha256=<hex>`.
 *
 * Deliberately privacy-minimal: we store only the order reference, its status,
 * a short human detail line and the payout amount. No bank details, no identity
 * documents, no customer PII ever land in our database.
 */
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

const payloadSchema = z.object({
  reference: z.string().trim().min(6).max(64).regex(/^BK-[A-Z0-9-]+$/i),
  status: z.string().trim().min(2).max(40),
  detail: z.string().trim().max(300).optional(),
  payout_usd: z.union([z.number(), z.string()]).optional(),
});

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
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
  return `sha256=${toHex(await crypto.subtle.sign("HMAC", key, encoder.encode(body)))}`;
}

export const Route = createFileRoute("/api/public/vectorpay-order-status")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secret = process.env["BEEKEEPER_WEBHOOK_SECRET"]?.trim();
        if (!secret) return new Response("Not configured", { status: 503 });

        const raw = await request.text();
        if (raw.length > 8_000) return new Response("Payload too large", { status: 413 });

        const provided = request.headers.get("x-beekeeper-signature") ?? "";
        const expected = await signatureFor(raw, secret);
        if (!timingSafeEqual(provided.trim().toLowerCase(), expected)) {
          return new Response("Invalid signature", { status: 401 });
        }

        let parsed: z.infer<typeof payloadSchema>;
        try {
          parsed = payloadSchema.parse(JSON.parse(raw));
        } catch {
          return new Response("Invalid payload", { status: 400 });
        }

        const payout = parsed.payout_usd === undefined ? null : Number(parsed.payout_usd);
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { error } = await supabaseAdmin.from("cashout_order_status").upsert(
          {
            reference: parsed.reference.toUpperCase(),
            status: parsed.status.toLowerCase(),
            detail: parsed.detail ?? null,
            payout_usd: payout !== null && Number.isFinite(payout) ? payout : null,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "reference" },
        );
        if (error) {
          console.error("cashout status upsert failed", error.message);
          return new Response("Storage error", { status: 500 });
        }
        return Response.json({ ok: true });
      },
    },
  },
});
