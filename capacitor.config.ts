import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Capacitor config for the BeeKeeper Wallet mobile app.
 *
 * The web app is served from TanStack Start's static SPA output.
 * `bun run build` writes or mirrors the static bundle to `dist/client` and
 * generates `dist/client/index.html`, which is the native webview entry point.
 * When developing against a live Lovable preview, set `server.url` to the
 * preview URL instead of bundling.
 */
/**
 * SECURITY: a release build MUST bundle the web assets inside the binary and
 * NOT load them from a remote URL. Loading `server.url` at runtime means the
 * store binary is a thin shell that executes whatever JavaScript the server
 * serves at launch, so a server/CDN compromise or one bad deploy can push code
 * that steals seed phrases from every user. It also has no Subresource
 * Integrity and is a poor fit for App Store 2.5.2 / Play policy. See
 * SECURITY-AUDIT.md (H1).
 *
 * Default here is BUNDLED (no `server.url`). To live-reload against a remote
 * preview during development only, set `HME_REMOTE_URL`, e.g.
 *   HME_REMOTE_URL=https://id-preview--xxxx.lovable.app bunx cap sync ios
 * Never ship a release with `HME_REMOTE_URL` set.
 *
 * MIGRATION-CRITICAL: `hostname` is kept at "mobile.honest.money" with the
 * https scheme so the bundled build serves its assets under the SAME origin
 * the remote build used. localStorage (the encrypted wallet) is keyed by
 * origin — if the origin changed (e.g. to capacitor://localhost), existing
 * users' wallets would become unreadable and they'd have to re-import from
 * seed. Do NOT change `hostname` without a data-migration plan. See
 * SECURITY-AUDIT.md (H1 migration note).
 */
const REMOTE_URL = process.env.HME_REMOTE_URL;
const WEBVIEW_HOSTNAME = "mobile.honest.money";

/**
 * IDENTITY: BeeKeeper Wallet must be its OWN Android app. The retired remix
 * shipped under `money.honest.txcwallet`, so any build reusing that id makes
 * Android offer the APK as an "update to honest.money" (and refuse it when the
 * signing key differs). This id is BeeKeeper-only — installing it never touches
 * the honest.money app. `server.hostname` stays unchanged so the webview origin
 * (and therefore the encrypted wallet storage keying) is untouched.
 */
const config: CapacitorConfig = {
  appId: "money.beekeeper.wallet",
  appName: "BeeKeeper Wallet",
  webDir: "dist/client",
  backgroundColor: "#ffffff",
  server: {
    ...(REMOTE_URL ? { url: REMOTE_URL } : {}),
    // Stable origin across the remote -> bundled switch (see note above).
    hostname: REMOTE_URL ? new URL(REMOTE_URL).hostname : WEBVIEW_HOSTNAME,
    cleartext: false,
    androidScheme: "https",
    iosScheme: "https",
    // Only the payment processor needs to be navigable; the app itself is
    // served from the local bundle under the hostname above.
    allowNavigation: ["nectar-pay.com"],
  },
  ios: {
    contentInset: "never",
    backgroundColor: "#ffffff",
  },
  android: {
    backgroundColor: "#ffffff",
    allowMixedContent: false,
  },
  plugins: {
    SplashScreen: {
      // Auto-hide so a JS/hydration failure can never leave an invisible native
      // splash overlay blocking every tap on the landing page.
      launchAutoHide: true,
      launchShowDuration: 900,
      backgroundColor: "#ffffff",
      androidScaleType: "CENTER_CROP",
      showSpinner: false,
    },
    StatusBar: {
      style: "LIGHT",
      backgroundColor: "#ffffff",
    },
    PrivacyScreen: {
      // Do NOT enable at app startup. On iOS 17+ the screenshot-prevention
      // implementation wraps the app window in a secure UITextField, and that
      // can swallow every tap on the landing page. We still enable the privacy
      // screen explicitly only while the seed phrase is being shown.
      enable: false,
      imageName: "Splash",
      contentMode: "center",
      // Keep the app-switcher privacy cover, but avoid the iOS secure-textfield
      // screenshot hack globally; it is the most likely cause of the "nothing is
      // clickable" native build.
      preventScreenshots: false,
    },
  },
};

export default config;
