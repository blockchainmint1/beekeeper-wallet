/**
 * Updates card.
 *
 * One source of truth: the published release feed (`/api/public/latest-release`,
 * backed by the `app_releases` table). The card asks it on mount and on demand,
 * compares the answer with the version this device actually has installed, and
 * — when a newer build exists — hands the user a single Install button.
 *
 * Version vocabulary shown to the user:
 *  - native: "Installed <shell version>" (the APK/IPA actually on the phone)
 *  - web:    "Installed <bundle version>" (the JS build this tab is running)
 * The web-bundle stamp is only shown as a secondary detail on native, because
 * it is never what a user needs to act on.
 */
import { useCallback, useEffect, useState } from "react";
import { Check, Copy, Download, RefreshCw, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import {
  APK_URL,
  APP_VERSION,
  applyWebUpdate,
  checkForWebUpdate,
  compareVersions,
  fetchLatestRelease,
  installedVersion,
  releaseDownloadUrl,
  type AppRelease,
} from "@/lib/app-release";
import { copyToClipboard } from "@/lib/clipboard";
import { isNative, nativePlatform } from "@/lib/native/platform";

/**
 * Open the APK link in the *system* browser. Android's in-app Custom Tab can
 * silently drop file downloads, which is the #1 reason "update" felt broken.
 */
async function openDownload(url: string) {
  if (isNative()) {
    try {
      const { AppLauncher } = await import("@capacitor/app-launcher");
      const { completed } = await AppLauncher.openUrl({ url });
      if (completed) return;
    } catch {
      /* fall through */
    }
    try {
      const { Browser } = await import("@capacitor/browser");
      await Browser.open({ url, windowName: "_system" });
      return;
    } catch {
      /* fall through */
    }
  }
  window.open(url, "_system", "noopener,noreferrer") ||
    window.open(url, "_blank", "noopener,noreferrer");
}

type Status = "idle" | "checking" | "current" | "update" | "unknown";

export function UpdateCheckCard({ compact }: { compact?: boolean }) {
  const [status, setStatus] = useState<Status>("idle");
  const [latest, setLatest] = useState<AppRelease | null>(null);
  const [webStale, setWebStale] = useState(false);
  const [installed, setInstalled] = useState(APP_VERSION);
  const [copied, setCopied] = useState(false);
  const native = isNative();
  const platform = nativePlatform();
  const releasePlatform = native ? (platform === "ios" ? "ios" : "android") : "web";

  const check = useCallback(
    async (opts?: { quiet?: boolean }) => {
      if (!opts?.quiet) setStatus("checking");
      setWebStale(false);

      const current = await installedVersion();
      setInstalled(current);

      const [rel, web] = await Promise.all([
        fetchLatestRelease(releasePlatform),
        checkForWebUpdate(),
      ]);
      setLatest(rel);
      setWebStale(web === "update");

      if (rel && compareVersions(rel.version, current) > 0) return setStatus("update");
      if (web === "update") return setStatus("update");
      if (!rel && web === "unknown") return setStatus("unknown");
      setStatus("current");
    },
    [releasePlatform],
  );

  // Check automatically when the card opens — the user shouldn't have to ask.
  useEffect(() => {
    void check({ quiet: true });
  }, [check]);

  const downloadUrl = releaseDownloadUrl(latest) || APK_URL;
  const newerRelease = !!latest && compareVersions(latest.version, installed) > 0;
  const shellDiffersFromBundle = native && installed !== APP_VERSION;

  const versionLine = (
    <>
      Installed {installed}
      {native ? ` · ${platform}` : " · web"}
      {latest ? ` · latest ${latest.version}` : ""}
      {shellDiffersFromBundle ? (
        <span className="block text-xs opacity-70">app code build {APP_VERSION}</span>
      ) : null}
    </>
  );

  return (
    <Card
      className={compact ? "rounded-none border-0 bg-transparent shadow-none" : "mt-5"}
    >
      {compact ? (
        <p className="mb-3 text-sm text-muted-foreground">{versionLine}</p>
      ) : (
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <RotateCw className="h-5 w-5" /> Updates
          </CardTitle>
          <CardDescription>{versionLine}</CardDescription>
        </CardHeader>
      )}
      <CardContent className={compact ? "space-y-3 p-0" : "space-y-3"}>
        {status === "update" && newerRelease && latest && (
          <div className="rounded-lg border border-primary/40 bg-primary/5 p-3 space-y-2">
            <p className="text-sm">
              <span className="font-medium">Version {latest.version}</span> is available
              {latest.mandatory ? " — required update." : "."}
            </p>
            {latest.notes && <p className="text-sm text-muted-foreground">{latest.notes}</p>}

            {releasePlatform === "ios" ? (
              <p className="text-sm text-muted-foreground">
                iOS updates arrive through the App Store.
              </p>
            ) : (
              <>
                <Button className="w-full" onClick={() => void openDownload(downloadUrl)}>
                  <Download className="h-4 w-4 mr-2" /> Install {latest.version}
                </Button>
                <p className="text-xs text-muted-foreground">
                  Your browser downloads the APK — tap the finished download and confirm
                  &ldquo;Update&rdquo;. Your wallet and settings stay on this device.
                </p>
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full"
                  onClick={async () => {
                    await copyToClipboard(downloadUrl);
                    setCopied(true);
                    toast.success("Download link copied");
                    setTimeout(() => setCopied(false), 2000);
                  }}
                >
                  {copied ? (
                    <Check className="h-4 w-4 mr-2" />
                  ) : (
                    <Copy className="h-4 w-4 mr-2" />
                  )}
                  Copy download link
                </Button>
              </>
            )}
          </div>
        )}

        {status === "current" && (
          <p className="text-sm text-muted-foreground">
            You&apos;re on the latest version{latest ? ` (${latest.version})` : ""}.
          </p>
        )}

        {status === "unknown" && (
          <p className="text-sm text-muted-foreground">
            Couldn&apos;t reach the update server. Check your connection and try again.
          </p>
        )}

        {/* When an update banner (native) or app-code refresh (web) is already
            on screen, that is the single primary action — no duplicate check button. */}
        {!(status === "update" && newerRelease) && !webStale && (
          <Button
            variant="outline"
            className="w-full"
            onClick={() => void check()}
            disabled={status === "checking"}
          >
            <RefreshCw className={`h-4 w-4 mr-2 ${status === "checking" ? "animate-spin" : ""}`} />
            {status === "checking" ? "Checking…" : "Check for updates"}
          </Button>
        )}

        {webStale && !(status === "update" && newerRelease) && (
          <>
            <p className="text-sm">Newer app code is live. Reload to get it.</p>
            <Button className="w-full" onClick={() => void applyWebUpdate()}>
              Update app code
            </Button>
            <p className="text-xs text-muted-foreground">
              Your wallet stays on this device — this only refreshes the app code. You&apos;ll be
              asked to unlock again.
            </p>
          </>
        )}

        {native && platform === "android" && !newerRelease && status !== "checking" && (
          <Button
            variant="ghost"
            className="w-full"
            onClick={async () => {
              // Never trust this build's baked-in link — ask the feed right now.
              setStatus("checking");
              const rel = await fetchLatestRelease(releasePlatform);
              if (rel) setLatest(rel);
              setStatus("idle");
              await openDownload(rel ? releaseDownloadUrl(rel) : downloadUrl);
            }}
          >
            <Download className="h-4 w-4 mr-2" /> Reinstall latest APK
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
