/**
 * Single source of truth for the current published release.
 *
 * APP_VERSION / APK_URL are the values baked into *this* build. The live
 * "what's the newest release?" answer comes from the `app_releases` table in
 * the backend, so a freshly pinned APK is visible to already-installed apps
 * without shipping new code.
 */
import { supabase } from "@/integrations/supabase/client";

export const APP_VERSION = "0.1.202609050547";

/**
 * Download via our own endpoint, NOT the raw CDN asset: the CDN serves a
 * generic binary content-type and Chrome saves the APK as ".zip", breaking
 * tap-to-install. /api/public/apk streams it with the Android MIME type.
 */
export const APK_URL = "https://beekeeper.money/api/public/apk";


export type ReleasePlatform = "android" | "ios" | "web";

declare const __BUILD_ID__: string;

/** Build stamp of the JS bundle this tab/webview is currently running. */
export const LOCAL_BUILD_ID: string =
  typeof __BUILD_ID__ !== "undefined" ? __BUILD_ID__ : "dev";

/**
 * Version that actually matters for a native install.
 *
 * The app shell loads its web content from the server, so APP_VERSION is the
 * *web bundle's* version — not the installed APK/IPA's. Ask Capacitor for the
 * real native version whenever we're running inside the app.
 */
export async function installedVersion(): Promise<string> {
  try {
    const { Capacitor } = await import("@capacitor/core");
    if (Capacitor.isNativePlatform()) {
      const { App } = await import("@capacitor/app");
      const info = await App.getInfo();
      if (info?.version) return info.version;
    }
  } catch {
    /* not native, or plugin unavailable */
  }
  return APP_VERSION;
}

export type AppRelease = {
  platform: string;
  version: string;
  ipfs_cid: string | null;
  download_url: string | null;
  notes: string | null;
  mandatory: boolean;
  released_at: string;
};

/**
 * Fixed, key-free places to ask "what's the newest build?".
 *
 * Every build (past, present, future) checks the SAME endpoints in the SAME
 * order, so a release recorded once is visible to every installed app. The
 * Supabase SDK is only a last-ditch fallback — it depends on the API key
 * baked into whatever build the user happens to be running.
 */
export const RELEASE_FEED_HOSTS = [
  "https://beekeeper.money",
  "https://beekeeper-wallet.lovable.app",
] as const;

const RELEASE_FEED_PATH = "/api/public/latest-release";

async function fetchFeed(base: string, platform: ReleasePlatform): Promise<AppRelease | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const res = await fetch(`${base}${RELEASE_FEED_PATH}?platform=${platform}&_=${Date.now()}`, {
      cache: "no-store",
      signal: ctl.signal,
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { release?: AppRelease | null };
    return json?.release ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Newest published release for a platform, or null if we can't reach any source. */
export async function fetchLatestRelease(platform: ReleasePlatform): Promise<AppRelease | null> {
  const bases: string[] = [];
  // On the web, same-origin first (works on previews and custom domains alike).
  if (typeof window !== "undefined" && window.location.origin.startsWith("http")) {
    bases.push(window.location.origin);
  }
  for (const h of RELEASE_FEED_HOSTS) if (!bases.includes(h)) bases.push(h);

  for (const base of bases) {
    const rel = await fetchFeed(base, platform);
    if (rel) return rel;
  }

  // Last resort: direct Data API read with this build's key.
  try {
    const { data, error } = await supabase
      .from("app_releases")
      .select("platform, version, ipfs_cid, download_url, notes, mandatory, released_at")
      .eq("platform", platform)
      .order("released_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !data) return null;
    return data as AppRelease;
  } catch {
    return null;
  }
}


/** Numeric-aware version compare: 1 if a > b, -1 if a < b, 0 if equal. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.\-+]/);
  const pb = b.split(/[.\-+]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = Number(pa[i] ?? 0);
    const nb = Number(pb[i] ?? 0);
    if (Number.isNaN(na) || Number.isNaN(nb)) {
      const sa = pa[i] ?? "";
      const sb = pb[i] ?? "";
      if (sa !== sb) return sa > sb ? 1 : -1;
      continue;
    }
    if (na !== nb) return na > nb ? 1 : -1;
  }
  return 0;
}

/** Best download link for a release row (falls back to the IPFS gateway). */
export function releaseDownloadUrl(r: AppRelease | null): string {
  if (!r) return APK_URL;
  // Android installs always pass through BeeKeeper's own endpoint. This keeps
  // stale release rows and retired HME URLs from escaping into the UI.
  if (r.platform === "android") return APK_URL;
  if (r.download_url) return r.download_url;
  if (r.ipfs_cid) return `https://txc.mypinata.cloud/ipfs/${r.ipfs_cid}`;
  return APK_URL;
}

/** Build stamp the same-origin server is shipping right now, or null. */
export async function fetchServerBuildId(): Promise<string | null> {
  if (typeof window === "undefined") return null;
  try {
    const res = await fetch(`${window.location.origin}/api/public/build-id?_=${Date.now()}`, {
      cache: "no-store",
      headers: { "Cache-Control": "no-cache" },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { buildId?: string };
    return json?.buildId ?? null;
  } catch {
    return null;
  }
}

const RELOADED_FOR_KEY = "beekeeper.reloadedForBuild";

function reloadedFor(): string | null {
  try {
    return window.localStorage.getItem(RELOADED_FOR_KEY);
  } catch {
    return null;
  }
}

/**
 * Web/webview freshness: compare the build stamp baked into this bundle with
 * the one the server is serving now. A mismatch means a reload gets new code.
 */
export async function checkForWebUpdate(): Promise<"current" | "update" | "unknown"> {
  const serverBuild = await fetchServerBuildId();
  if (!serverBuild) return "unknown";
  if (LOCAL_BUILD_ID === "dev") return "current";
  if (serverBuild === LOCAL_BUILD_ID) return "current";
  if (reloadedFor() === serverBuild) return "current";
  return "update";
}

/** Drop caches (incl. service worker) and hard-reload into the new build. */
export async function applyWebUpdate(): Promise<void> {
  // A hard reload wipes the in-memory session key, so the wallet will lock and
  // the user lands back on the unlock screen. Flag that this was an *update*
  // reload (not a sign-out) so the landing screen can say so and fast-path
  // biometrics, instead of feeling like the app ejected them.
  try {
    window.sessionStorage.setItem("hme.postUpdate", "1");
  } catch {
    /* memory-only session; still fine */
  }
  try {
    const serverBuild = await fetchServerBuildId();
    if (serverBuild) window.localStorage.setItem(RELOADED_FOR_KEY, serverBuild);
  } catch {
    /* best effort */
  }
  try {
    if ("caches" in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
    if ("serviceWorker" in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister().catch(() => undefined)));
    }
  } catch {
    /* best effort */
  }
  // Cache-busting param: a plain reload can be served from the webview cache.
  const url = new URL(window.location.href);
  url.searchParams.set("_r", Date.now().toString());
  window.location.replace(url.toString());
}
