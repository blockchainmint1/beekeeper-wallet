import { Link, useRouterState } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { isNative } from "@/lib/native/platform";
import { APK_URL } from "@/lib/app-release";

async function openExternal(url: string) {
  if (isNative()) {
    try {
      const { Browser } = await import("@capacitor/browser");
      await Browser.open({ url });
      return;
    } catch {
      /* fall through */
    }
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

export function SiteFooter() {
  // Inside the native app the footer takes up scarce vertical real estate and
  // the external <a> targets would try to hijack the WebView. Skip it entirely.
  const [native, setNative] = useState(false);
  useEffect(() => setNative(isNative()), []);
  // Marketing/legal footer belongs on the public pages (landing, manifesto,
  // legal) — never inside the unlocked wallet app, where it eats space and
  // duplicates in-app navigation.
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  if (native || pathname.startsWith("/wallet")) return null;

  return (
    <footer className="border-t border-border/60 bg-background/60 py-8 mt-12">
      <div className="mx-auto max-w-5xl px-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between text-sm text-muted-foreground">
        <p>
          Part of the{" "}
          <button
            type="button"
            onClick={() => openExternal("https://honest.money")}
            className="font-medium text-foreground underline-offset-4 hover:underline"
          >
            honest.money
          </button>{" "}
          ecosystem.
        </p>
        <nav className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <Link to="/manifesto" className="hover:text-foreground">
            Manifesto
          </Link>
          <Link to="/legal/terms" className="hover:text-foreground">
            Terms
          </Link>
          <Link to="/legal/privacy" className="hover:text-foreground">
            Privacy
          </Link>
          <button
            type="button"
            onClick={() => openExternal("https://texitcoin.org/build")}
            className="hover:text-foreground"
          >
            Build
          </button>
          <button
            type="button"
            onClick={() => openExternal("https://github.com/blockchainmint1/beekeeper-wallet")}
            className="hover:text-foreground"
          >
            GitHub
          </button>
          <button
            type="button"
            onClick={() => openExternal(APK_URL)}
            className="hover:text-foreground"
          >
            APK
          </button>
        </nav>
      </div>
    </footer>
  );
}
