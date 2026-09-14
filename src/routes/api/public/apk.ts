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
  "https://beekeeper.money/__l5e/assets-v1/0d176b7d-812b-44b2-95e7-073f6eba6db9/beekeeper-wallet-0.1.202609141124-release.apk";
const APK_FILENAME = "beekeeper-wallet-0.1.202609141124-release.apk";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Expose-Headers": "Content-Length, Content-Disposition, Accept-Ranges",
  "Access-Control-Max-Age": "86400",
} as const;

function downloadHeaders(length: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/vnd.android.package-archive",
    "Content-Disposition": `attachment; filename="${APK_FILENAME}"`,
    "Cache-Control": "public, max-age=300",
    "Accept-Ranges": "none",
    ...corsHeaders,
  };
  if (length) headers["Content-Length"] = length;
  return headers;
}

async function upstreamLength(): Promise<string | null> {
  try {
    const response = await fetch(APK_SOURCE_URL, { method: "HEAD" });
    return response.headers.get("content-length");
  } catch {
    return null;
  }
}

export const Route = createFileRoute("/api/public/apk")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: corsHeaders }),
      HEAD: async () =>
        new Response(null, { status: 200, headers: downloadHeaders(await upstreamLength()) }),
      GET: async () => {
        const upstream = await fetch(APK_SOURCE_URL, {
          headers: { "Accept-Encoding": "identity" },
        });
        if (!upstream.ok || !upstream.body) {
          return new Response("Download unavailable", { status: 502, headers: corsHeaders });
        }
        return new Response(upstream.body, {
          status: 200,
          headers: downloadHeaders(upstream.headers.get("content-length")),
        });
      },
    },
  },
});

