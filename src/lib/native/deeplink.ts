/**
 * Listen for deep-link / universal-link opens from Nectar.Pay terminals.
 *
 * Two URL shapes per HME-MOBILE-NFC-SPEC.md:
 *   nectar://pay?inv=<id>&t=<nonce>
 *   https://nectar-pay.com/pay/<id>?t=<nonce>
 *
 * In both cases we navigate the in-app router to `/pay/<id>?t=<nonce>`.
 *
 * On web (Lovable preview) the listener is a no-op — there's no system
 * deep-link to receive. The `/pay/$invoiceId` route is reachable directly
 * from the URL bar for testing.
 */
import type { AnyRouter } from "@tanstack/react-router";
import { isNative } from "./platform";
import { parseVectorPayLinkInput, stashPendingVectorPayCode } from "@/lib/vectorpay-link";

/** beekeeper://link-vectorpay?code=... — stash the code and open Settings. */
function handleWalletLinkUrl(raw: string, router: AnyRouter): boolean {
  if (!raw.startsWith("beekeeper://")) return false;
  const code = parseVectorPayLinkInput(raw);
  if (!code) return false;
  stashPendingVectorPayCode(code);
  router.navigate({ to: "/wallet/settings" });
  return true;
}

export interface ParsedPayUrl {
  invoiceId: string;
  nonce: string;
}

/** Parse either URL shape into `{invoiceId, nonce}`. Returns null on miss. */
export function parsePayUrl(raw: string): ParsedPayUrl | null {
  if (!raw) return null;
  try {
    // Custom scheme: `nectar://pay?inv=...&t=...`
    if (raw.startsWith("nectar://")) {
      const url = new URL(raw);
      // host is "pay"; query carries inv + t
      if (url.host !== "pay" && url.pathname.replace(/^\/+/, "") !== "pay") return null;
      const inv = url.searchParams.get("inv");
      const t = url.searchParams.get("t");
      if (!inv || !t) return null;
      return { invoiceId: inv, nonce: t };
    }
    // Universal link: `https://nectar-pay.com/pay/<id>?t=...`
    const url = new URL(raw);
    if (url.hostname !== "nectar-pay.com") return null;
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] !== "pay" || !parts[1]) return null;
    const t = url.searchParams.get("t");
    if (!t) return null;
    return { invoiceId: parts[1], nonce: t };
  } catch {
    return null;
  }
}

/**
 * Wire the Capacitor App plugin to push pay URLs into the router.
 * Returns an unsubscribe function. Safe to call on web (returns a noop).
 */
export async function registerPayDeepLinkListener(router: AnyRouter): Promise<() => void> {
  if (!isNative()) return () => {};
  try {
    const { App } = await import("@capacitor/app");

    const handle = (url: string) => {
      if (handleWalletLinkUrl(url, router)) return;
      const parsed = parsePayUrl(url);
      if (!parsed) return;
      router.navigate({
        to: "/pay/$invoiceId",
        params: { invoiceId: parsed.invoiceId },
        search: { t: parsed.nonce },
      });
    };

    // Cold-start: app launched via a link.
    try {
      const launch = await App.getLaunchUrl();
      if (launch?.url) handle(launch.url);
    } catch {
      /* not all platforms expose this; ignore */
    }

    // Warm: link received while app is running.
    const sub = await App.addListener("appUrlOpen", (event) => {
      handle(event.url);
    });

    return () => {
      sub.remove().catch(() => {});
    };
  } catch {
    return () => {};
  }
}
