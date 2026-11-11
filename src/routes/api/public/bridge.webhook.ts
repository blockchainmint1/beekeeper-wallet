/**
 * Bridge webhook receiver: https://beekeeper.money/api/public/bridge/webhook
 *
 * Public by necessity, so nothing is trusted until the RSA signature checks
 * out against BRIDGE_WEBHOOK_PUBLIC_KEY (the per-endpoint key Bridge shows
 * when the webhook is created). Stores each event once; returns no data.
 */
import { createFileRoute } from "@tanstack/react-router";

const MAX_BODY = 256 * 1024;

export const Route = createFileRoute("/api/public/bridge/webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const publicKey = process.env["BRIDGE_WEBHOOK_PUBLIC_KEY"]?.trim();
        if (!publicKey) return new Response("not configured", { status: 503 });
        const len = Number(request.headers.get("content-length") ?? "0");
        if (len > MAX_BODY) return new Response("too large", { status: 413 });
        const raw = await request.text();
        if (raw.length > MAX_BODY) return new Response("too large", { status: 413 });

        const { verifyBridgeWebhook } = await import("@/lib/bridge/webhook");
        const problem = await verifyBridgeWebhook({
          publicKeyPem: publicKey,
          header: request.headers.get("x-webhook-signature"),
          rawBody: raw,
        });
        // 400 asks Bridge to retry with a fresh timestamp.
        if (problem) return new Response("invalid", { status: 400 });

        let evt: Record<string, unknown>;
        try {
          evt = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          return new Response("invalid", { status: 400 });
        }
        const eventId = typeof evt["event_id"] === "string" ? (evt["event_id"] as string) : null;
        if (!eventId) return new Response("ok");
        const obj = (evt["event_object"] ?? {}) as Record<string, unknown>;
        const str = (v: unknown) => (typeof v === "string" ? v : null);
        const receipt = (obj["receipt"] ?? {}) as Record<string, unknown>;

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { error } = await supabaseAdmin.from("topup_events").upsert(
          {
            bridge_event_id: eventId,
            event_category: str(evt["event_category"]),
            event_type: str(evt["event_type"]),
            virtual_account_id: str(obj["virtual_account_id"]),
            deposit_id: str(obj["deposit_id"]),
            activity_type: str(obj["type"]),
            amount: str(obj["amount"]),
            developer_fee_amount: str(obj["developer_fee_amount"]),
            destination_tx_hash: str(obj["destination_tx_hash"]) ?? str(receipt["destination_tx_hash"]),
            payload: evt as never,
          },
          { onConflict: "bridge_event_id", ignoreDuplicates: true },
        );
        if (error) return new Response("retry", { status: 500 });
        return new Response("ok");
      },
    },
  },
});
