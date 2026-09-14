/**
 * APK download endpoint with correct Android headers.
 *
 * The raw CDN asset is served with a generic binary content-type, which makes
 * Chrome save the APK as a ".zip" (an APK is a zip archive internally), so
 * users can't tap-to-install it. This route streams the same bytes with the
 * official Android MIME type and an attachment filename so the browser treats
 * it as an installable package.
 *
 *   GET /api/public/apk
 */
import { createFileRoute } from "@tanstack/react-router";

const APK_SOURCE_URL =
  "https://beekeeper.money/__l5e/assets-v1/41bec2f0-41c5-4f06-b289-cc1d754851cc/beekeeper-wallet-0.1.202609141037-release.apk";
const APK_FILENAME = "beekeeper-wallet-0.1.202609141037-release.apk";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Max-Age": "86400",
} as const;

/**
 * Redirect instead of proxying.
 *
 * Streaming the bytes through the Worker meant the response had no reliable
 * Content-Length, so Android's download manager sat at "99%" waiting for an
 * end-of-stream it could not predict, and never flipped to "complete". The
 * gateway serves the exact same bytes with a real Content-Length, ETag and
 * range support, so the download finishes (and can resume) properly.
 */
const redirect = () =>
  new Response(null, {
    status: 302,
    headers: {
      Location: APK_SOURCE_URL,
      "Content-Disposition": `attachment; filename="${APK_FILENAME}"`,
      "Cache-Control": "public, max-age=300",
      ...corsHeaders,
    },
  });

export const Route = createFileRoute("/api/public/apk")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: corsHeaders }),
      HEAD: async () => redirect(),
      GET: async () => redirect(),
    },
  },
});

