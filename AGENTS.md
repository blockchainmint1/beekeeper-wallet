<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

- There is no iOS app and never will be (ios/ project and build:ios scripts removed) — BeeKeeper is web-only; no App Store gating is needed for new features. `exchangeFeaturesAllowed()` in src/lib/native/capabilities.ts stays as a harmless always-true-on-web switch.
- No swap or bridge features in BeeKeeper — the LI.FI / THORChain / Relay screens, the Swap buttons on chain tiles and the Settings toggles were removed. Don't re-add them; merchants who want to swap or bridge use the HME Wallet.
- No TSD Swap API key and no TSD → USDC off-ramp in BeeKeeper — the key card, the stored key and the Send-screen off-ramp were removed. TSD leaves the wallet only through the VectorPay cash-out roundup; the TSD Swap account link (watch-only keys) in Ecosystem link stays.
- Cash-out deposits are attributed by txid + sending-address signature (docs/vectorpay-cashout-proof.md), never by amount — VectorPay uses one shared deposit address per chain.
- Trusted origins live only in `src/lib/native/origins.ts` (native bridge target, CSP, CORS, proxy caller checks import it) — the native app once forwarded money-moving calls to the separate HME deployment.
- Every Tron transaction built by TronGrid goes through `assertTronTxMatches` (src/lib/tron/verify.ts) before signing — the wallet signs a node-supplied hash.
- Store any new per-wallet localStorage key via `scopedKey()` and list its base in `PROFILE_SCOPED_BASES` (src/lib/profiles.ts) — delete-wallet relies on it; tests enforce the list.
- Release signing keys are never generated or echoed in CI — the repo is public and Actions logs are readable.
- Run `bunx vitest run` for unit tests (src/**/*.test.ts).
- Android APK support is discontinued — BeeKeeper is the web merchant entry point and merchants who want a native mobile app use the HME Wallet. Don't build Android-only features or chase APK work; leave the APK endpoint, native bridge and update card untouched so existing installs keep working.
- Cash-out defaults to one tap (`runOneTap` in CashoutActions.tsx, plan in src/lib/cashout/one-tap.ts) and reuses the same order/send/confirm functions as the step-by-step picker — one code path for money movement.
- Partner pass-through routes (/api/nectar/link, /api/nectar/pay/*, /api/tsd/link) must use `src/lib/security/proxy-guard.ts` (trusted host, documented URL shapes only, rate limit, own-app POSTs, 32 KB bodies) and answer through `relayJson` (no redirects, capped, JSON-only) — the auditor flagged them as open relays and as a way to serve partner HTML on our origin.
- Imported-key (WIF) encryption is versioned in src/lib/wif/store.ts: new entries use the HKDF v2 key; keep the legacy v1 read path, because keys saved before the change still need it to open and upgrade.
- Cash-out order amounts are settled server-side from the chain (`src/lib/cashout/verify.server.ts`) before the order is signed to VectorPay; the wallet's numbers may only lower a line, never raise it — the deep scan flagged client-set amounts.
- Every cash-out send passes a `<reference>:<line>` tag (`sendCashRow`, `ensureGas`, `sendOmniToken`); the signed tx is saved under it before broadcast so a retry re-uses it — a partial line must never move twice.
- The in-progress cash-out (status + txids + sent-line snapshot) lives in `src/lib/cashout/session.ts` (per-wallet localStorage), written the moment each send returns — a reload must never strand sent coins.
