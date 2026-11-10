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

## iOS App Store compliance — features that must NOT appear on iOS

The iOS App Store build is produced with `VITE_DISABLE_EXCHANGE=true`
(`bun run build:ios`). Any feature that could be classified as crypto
exchange, swap, bridge, trading, or off-ramp must be hidden on iOS.

Before adding such a feature:

1. Add a gate in `src/lib/native/capabilities.ts` (or extend an existing one).
2. Wrap the UI entry point(s) with that gate so the feature is unreachable
   when the gate returns `false`.
3. Ensure the feature's route/component does not appear in iOS screenshots or
   navigation when gated.
4. Build iOS with `bun run build:ios` and verify the feature is absent.

Current gates:

- `exchangeFeaturesAllowed()` / `useExchangeFeaturesAllowed()` — swap and
  bridge features (LI.FI EVM swaps, THORChain LTC/DOGE swaps, Tron bridge).

If the user asks for a feature and does not explicitly say it should be on iOS,
default to excluding it from iOS. Ask the user for confirmation when unsure.
- Cash-out deposits are attributed by txid + sending-address signature (docs/vectorpay-cashout-proof.md), never by amount — VectorPay uses one shared deposit address per chain.
- Trusted origins live only in `src/lib/native/origins.ts` (native bridge target, CSP, CORS, proxy caller checks import it) — the native app once forwarded money-moving calls to the separate HME deployment.
- Every Tron transaction built by TronGrid goes through `assertTronTxMatches` (src/lib/tron/verify.ts) before signing — the wallet signs a node-supplied hash.
- Store any new per-wallet localStorage key via `scopedKey()` and list its base in `PROFILE_SCOPED_BASES` (src/lib/profiles.ts) — delete-wallet relies on it; tests enforce the list.
- Release signing keys are never generated or echoed in CI — the repo is public and Actions logs are readable.
- Run `bunx vitest run` for unit tests (src/**/*.test.ts).
- Android APK support is discontinued — BeeKeeper is the web merchant entry point and merchants who want a native mobile app use the HME Wallet. Don't build Android-only features or chase APK work; leave the APK endpoint, native bridge and update card untouched so existing installs keep working.
