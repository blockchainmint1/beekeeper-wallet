import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";

import appCss from "../styles.css?url";
import { CONTENT_SECURITY_POLICY_META } from "../lib/security/headers";
import { reportLovableError } from "../lib/lovable-error-reporting";
import { WalletProvider } from "../lib/txc/wallet-context";
import { SiteFooter } from "../components/SiteFooter";
import { Toaster } from "../components/ui/sonner";
import { ThemeProvider } from "../lib/theme";
import { installNativeServerFnBridge } from "../lib/native/server-fn-bridge";
import icon192 from "../assets/icons/icon-192.webp";
import icon512 from "../assets/icons/icon-512.webp";

if (typeof window !== "undefined") {
  installNativeServerFnBridge();
  // Capacitor's console bridge JSON-stringifies each argument, and
  // JSON.stringify(new Error(...)) / JSON.stringify({}) is "{}" because
  // Error props are non-enumerable and plain empty rejections stringify to
  // nothing useful. Expand every arg so message + stack + own-props survive
  // the bridge and show up in Xcode / Android Studio logs.
  const expand = (a: unknown): unknown => {
    try {
      if (a == null) return String(a);
      if (typeof a === "string" || typeof a === "number" || typeof a === "boolean") return a;
      if (a instanceof Error) {
        const extra: Record<string, unknown> = {};
        for (const k of Object.getOwnPropertyNames(a)) {
          if (k === "message" || k === "stack" || k === "name") continue;
          try { extra[k] = (a as unknown as Record<string, unknown>)[k]; } catch { /* noop */ }
        }
        const extras = Object.keys(extra).length ? ` ${JSON.stringify(extra)}` : "";
        return `${a.name}: ${a.message}\n${a.stack ?? ""}${extras}`;
      }
      // Serialize including non-enumerable own props (covers DOMException, etc.)
      const obj = a as Record<string, unknown>;
      const props = Object.getOwnPropertyNames(obj);
      const out: Record<string, unknown> = {};
      for (const k of props) {
        try { out[k] = obj[k]; } catch { /* noop */ }
      }
      const s = JSON.stringify(out);
      if (s && s !== "{}") return s;
      // Last resort: toString / constructor name
      const proto = Object.getPrototypeOf(a) as { constructor?: { name?: string } } | null;
      const tag = proto?.constructor?.name ?? typeof a;
      return `[${tag}] ${String(a)}`;
    } catch {
      return String(a);
    }
  };
  for (const level of ["error", "warn", "log"] as const) {
    const orig = console[level].bind(console);
    console[level] = (...args: unknown[]) => orig(`[${level}]`, ...args.map(expand));
  }
  window.addEventListener("error", (e) => {
    console.error("[window.error]", e.error ?? e.message ?? e, `@${e.filename}:${e.lineno}:${e.colno}`);
  });
  window.addEventListener("unhandledrejection", (e) => {
    console.error("[unhandledrejection]", (e as PromiseRejectionEvent).reason);
  });
}


const THEME_INIT_SCRIPT = `(function(){try{var k='txc.theme';var t=localStorage.getItem(k)||'system';var d=t==='dark'||(t==='system'&&matchMedia('(prefers-color-scheme: dark)').matches);var r=document.documentElement;r.classList.toggle('dark',d);r.style.colorScheme=d?'dark':'light';}catch(e){document.documentElement.classList.add('dark');}})();`;
// Lock the webview scale to 1 inside the native shell BEFORE first paint. A
// stuck/implicit zoom renders the page wider than the window and clips the
// right edge (App Store 4.0 rejection). Web keeps pinch-zoom for a11y.
const NATIVE_VIEWPORT_LOCK_SCRIPT = `(function(){try{var w=window;var native=(w.Capacitor&&w.Capacitor.isNativePlatform&&w.Capacitor.isNativePlatform())||(w.webkit&&w.webkit.messageHandlers&&w.webkit.messageHandlers.bridge)||location.protocol==='capacitor:';if(!native)return;var content='width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover';var apply=function(){var m=document.querySelector('meta[name="viewport"]');if(!m){m=document.createElement('meta');m.setAttribute('name','viewport');document.head.appendChild(m);}if(m.getAttribute('content')!==content)m.setAttribute('content',content);};apply();document.addEventListener('DOMContentLoaded',apply);var mo=new MutationObserver(apply);if(document.head)mo.observe(document.head,{childList:true,subtree:true,attributes:true});setTimeout(function(){mo.disconnect();},8000);var block=function(e){e.preventDefault();};document.addEventListener('gesturestart',block,{passive:false});document.addEventListener('gesturechange',block,{passive:false});}catch(e){}})();`;

const NATIVE_NAV_FALLBACK_SCRIPT = `(function(){if(window.__HME_NATIVE_NAV_FALLBACK__)return;window.__HME_NATIVE_NAV_FALLBACK__=true;function routeFromEvent(e){var t=e.target;if(!t||!t.closest)return null;var a=t.closest('a[data-native-route],a[href="/import"],a[href="/create"]');if(!a)return null;var h=a.getAttribute('data-native-route')||a.getAttribute('href');return h==='/import'||h==='/create'?h:null}function go(e){if(document.documentElement&&document.documentElement.dataset&&document.documentElement.dataset.hmeHydrated==='true')return;var h=routeFromEvent(e);if(!h)return;e.preventDefault();e.stopPropagation();location.assign(h)}document.addEventListener('pointerup',go,true);document.addEventListener('touchend',go,true);document.addEventListener('click',go,true);})();`;

function NotFoundComponent() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">Page not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}

/**
 * A failed dynamic import ("Importing a module script failed", "Failed to
 * fetch dynamically imported module") almost always means stale cached HTML is
 * pointing at code chunks that no longer exist — typical after a deploy, or in
 * a PWA/APK webview holding an old service-worker cache. Recover automatically
 * by dumping caches and reloading once.
 */
function isStaleChunkError(message: string): boolean {
  return /importing a module script failed|failed to fetch dynamically imported module|error loading dynamically imported module|module script failed|chunkloaderror/i.test(
    message,
  );
}

async function purgeCachesAndReload() {
  try {
    if ("serviceWorker" in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
    if ("caches" in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch {
    // best effort — reload anyway
  }
  const url = new URL(window.location.href);
  url.searchParams.set("_r", Date.now().toString(36));
  window.location.replace(url.toString());
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  console.error(error);
  const router = useRouter();
  useEffect(() => {
    reportLovableError(error, { boundary: "tanstack_root_error_component" });
  }, [error]);

  const message = error?.message || String(error);
  const stack = error?.stack || "";
  const stale = isStaleChunkError(message);

  useEffect(() => {
    if (!stale) return;
    // Only auto-recover once per session, so a genuinely broken build can't
    // put the app into a reload loop.
    try {
      if (sessionStorage.getItem("hme:chunk-recovered")) return;
      sessionStorage.setItem("hme:chunk-recovered", "1");
    } catch {
      return;
    }
    void purgeCachesAndReload();
  }, [stale]);


  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4">
      <div className="max-w-md w-full text-center">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          {stale ? "Updating the app…" : "This page didn't load"}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {stale
            ? "This app was updated since it was last opened, so part of it couldn't load from the cache. Clearing it and reloading now — your wallet data is unaffected."
            : "Something went wrong. Your wallet data is unaffected. Try again, or send this error to support so we can fix it."}
        </p>
        <details className="mt-4 text-left rounded-md border border-border/60 bg-muted/40 p-3 text-xs text-muted-foreground open:pb-3">
          <summary className="cursor-pointer font-medium text-foreground">
            Error details
          </summary>
          <p className="mt-2 break-words text-destructive font-mono">{message}</p>
          {stack && (
            <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words text-[10px] leading-tight">
              {stack}
            </pre>
          )}
        </details>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              if (stale) {
                void purgeCachesAndReload();
                return;
              }
              router.invalidate();
              reset();
            }}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            {stale ? "Reload now" : "Try again"}
          </button>

          <a
            href="/"
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            Go home
          </a>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      // Ship the CSP as a <meta> only in production builds. In dev, Vite's HMR
      // needs inline eval + websocket connections that a strict CSP blocks, so
      // we let the SSR server add headers there instead (also PROD-gated).
      ...(import.meta.env.PROD
        ? [{ "http-equiv": "Content-Security-Policy", content: CONTENT_SECURITY_POLICY_META }]
        : []),
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1, viewport-fit=cover",
      },
      { name: "mobile-web-app-capable", content: "yes" },
      { name: "apple-mobile-web-app-capable", content: "yes" },
      { name: "apple-mobile-web-app-status-bar-style", content: "black-translucent" },
      { name: "apple-mobile-web-app-title", content: "BeeKeeper" },
      { name: "format-detection", content: "telephone=no" },
      { title: "BeeKeeper Wallet — TEXITcoin & EVM multi-chain wallet" },
      {
        name: "description",
        content:
          "BeeKeeper Wallet — a self-custodial multi-chain wallet for TEXITcoin (TXC), Ethereum, Base, and BSC. Part of the honest.money ecosystem.",
      },
      { name: "theme-color", content: "#ffffff" },
      { property: "og:title", content: "BeeKeeper Wallet" },
      {
        property: "og:description",
        content:
          "Self-custodial multi-chain wallet for TEXITcoin and EVM assets. Hold your own keys.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: "BeeKeeper Wallet" },
      {
        name: "twitter:description",
        content:
          "Self-custodial multi-chain wallet for TEXITcoin and EVM assets. Hold your own keys.",
      },
      {
        property: "og:image",
        content:
          "https://pub-bb2e103a32db4e198524a2e9ed8f35b4.r2.dev/e5412ff3-3f36-4086-9590-b2e64dae9c49/id-preview-32bb6bc2--633f1235-4607-4b38-ad25-8b0c6b359acb.lovable.app-1782729338829.png",
      },
      {
        name: "twitter:image",
        content:
          "https://pub-bb2e103a32db4e198524a2e9ed8f35b4.r2.dev/e5412ff3-3f36-4086-9590-b2e64dae9c49/id-preview-32bb6bc2--633f1235-4607-4b38-ad25-8b0c6b359acb.lovable.app-1782729338829.png",
      },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", type: "image/webp", sizes: "192x192", href: icon192 },
      { rel: "apple-touch-icon", sizes: "512x512", href: icon512 },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <script dangerouslySetInnerHTML={{ __html: NATIVE_VIEWPORT_LOCK_SCRIPT }} />

        <HeadContent />
      </head>
      <body className="min-h-[100dvh] bg-background text-foreground antialiased">
        {children}
        <script dangerouslySetInnerHTML={{ __html: NATIVE_NAV_FALLBACK_SCRIPT }} />
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();
  const router = useRouter();

  // Browser tabs often fail a lazy chunk import without ever reaching the
  // router's error boundary (e.g. during a navigation the promise just
  // rejects). Catch those globally and run the same one-shot cache purge.
  useEffect(() => {
    const recover = (msg: string) => {
      if (!isStaleChunkError(msg)) return;
      try {
        if (sessionStorage.getItem("hme:chunk-recovered")) return;
        sessionStorage.setItem("hme:chunk-recovered", "1");
      } catch {
        return;
      }
      void purgeCachesAndReload();
    };
    const onError = (e: ErrorEvent) => recover(e.message || "");
    const onRejection = (e: PromiseRejectionEvent) => {
      const r = e.reason as unknown;
      recover(
        (r && typeof r === "object" && "message" in r
          ? String((r as { message?: unknown }).message)
          : String(r)) || "",
      );
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);


  // Wire up Nectar.Pay tap-to-pay deep links (nectar:// + https universal
  // link). Native-only — no-op on web. See lib/native/deeplink.ts.
  useEffect(() => {
    document.documentElement.dataset.hmeHydrated = "true";
    let cancel: (() => void) | undefined;
    let cancelled = false;
    import("../lib/native/deeplink").then(({ registerPayDeepLinkListener }) => {
      registerPayDeepLinkListener(router).then((unsub) => {
        if (cancelled) unsub();
        else cancel = unsub;
      });
    });
    return () => {
      cancelled = true;
      cancel?.();
    };
  }, [router]);

  // Configure iOS/Android status bar + keyboard once on mount. No-op on web.
  useEffect(() => {
    import("../lib/native/ui").then(({ initNativeChrome }) => {
      initNativeChrome();
    });
    // Fire-and-forget observability init (no-op when VITE_SENTRY_DSN is unset).
    import("../lib/native/observability").then(({ initObservability }) => {
      initObservability();
    });
  }, []);

  // Android hardware back button: navigate in-app when we can, otherwise
  // minimize the app instead of exiting so users don't lose transient state.
  useEffect(() => {
    let remove: (() => void) | undefined;
    void (async () => {
      try {
        const { isNative, nativePlatform } = await import("../lib/native/platform");
        if (!isNative() || nativePlatform() !== "android") return;
        const { App } = await import("@capacitor/app");
        const sub = await App.addListener("backButton", ({ canGoBack }) => {
          if (canGoBack && window.history.length > 1) window.history.back();
          else App.minimizeApp().catch(() => {});
        });
        remove = () => sub.remove().catch(() => {});
      } catch {
        /* plugin missing */
      }
    })();
    return () => remove?.();
  }, []);

  // SCREEN FIT (App Store 4.0/2.4.1): inside the native shell the webview must
  // never be pinch-zoomed — a stuck zoom makes the layout render wider than the
  // window and the right edge gets clipped (Apple's rejection screenshot).
  // Web keeps pinch-zoom for accessibility; only native locks the scale.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { isNative } = await import("../lib/native/platform");
        if (cancelled || !isNative()) return;
        const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
        if (meta) {
          meta.setAttribute(
            "content",
            "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover",
          );
        }
        const block = (e: Event) => e.preventDefault();
        document.addEventListener("gesturestart", block);
        document.addEventListener("gesturechange", block);
        return () => {
          document.removeEventListener("gesturestart", block);
          document.removeEventListener("gesturechange", block);
        };
      } catch {
        /* noop */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);


  // Simple offline banner — @capacitor/network is only wired natively; on
  // the web we fall back to the browser's navigator.onLine + events.
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    let remove: (() => void) | undefined;
    void (async () => {
      try {
        const { isNative } = await import("../lib/native/platform");
        if (isNative()) {
          const { Network } = await import("@capacitor/network");
          const status = await Network.getStatus();
          setOffline(!status.connected);
          const sub = await Network.addListener("networkStatusChange", (s) => {
            setOffline(!s.connected);
          });
          remove = () => sub.remove().catch(() => {});
          return;
        }
      } catch {
        /* fall through to web */
      }
      const on = () => setOffline(false);
      const off = () => setOffline(true);
      setOffline(typeof navigator !== "undefined" && navigator.onLine === false);
      window.addEventListener("online", on);
      window.addEventListener("offline", off);
      remove = () => {
        window.removeEventListener("online", on);
        window.removeEventListener("offline", off);
      };
    })();
    return () => remove?.();
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <WalletProvider>
          {/* Opaque status-bar scrim. Without this, scrolled content renders
              underneath the iOS clock/battery (App Review Guideline 4 rejection
              on iPhone 17 Pro Max). Fixed to the viewport so it never scrolls
              away; zero height on devices with no top inset. */}
          <div
            aria-hidden="true"
            className="pointer-events-none fixed inset-x-0 top-0 z-50 h-[env(safe-area-inset-top)] bg-background"
          />
          {/* Mobile-only frame: on phones it fills the screen; on larger screens
              we center a phone-width column so the app always feels like a mobile app. */}
          <div data-wallet-frame className="min-h-[100dvh] w-full bg-muted/40 sm:py-6">
            <div
              data-wallet-frame
              className="mx-auto flex h-[100dvh] w-full max-w-[480px] flex-col bg-background sm:h-[calc(100dvh-3rem)] sm:max-w-[520px] md:max-w-[600px] lg:max-w-[680px] sm:rounded-[2.25rem] sm:shadow-2xl sm:ring-1 sm:ring-border overflow-hidden"
            >
              <div className="pt-[env(safe-area-inset-top)]" />
              {offline && (
                <div className="bg-amber-500/15 text-amber-300 text-xs text-center py-1.5 px-3 border-b border-amber-500/30">
                  You&apos;re offline — balances and prices may be out of date.
                </div>
              )}
              {/* The frame itself is fixed-height and clips overflow, so this
                  wrapper must be the scroll container — otherwise long pages
                  (Settings) simply get cut off with no way to scroll. */}
              <div className="flex flex-1 min-h-0 flex-col overflow-y-auto overscroll-contain [-webkit-overflow-scrolling:touch]">
                <Outlet />
              </div>
              <div className="shrink-0 pb-[max(env(safe-area-inset-bottom),0.75rem)]">
                <SiteFooter />
              </div>

            </div>
          </div>

          <Toaster richColors closeButton position="top-center" />
        </WalletProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
