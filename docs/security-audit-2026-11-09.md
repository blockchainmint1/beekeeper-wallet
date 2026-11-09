# BeeKeeper Wallet — Security Audit (code review of `75272015-beekeeper-wallet.zip`)

Date: 2026-11-09
Scope: full source tree (393 files, ~50k lines): TanStack Start web app, Capacitor iOS/Android shell, server routes and server functions, Supabase migration, CI workflows, build scripts, docs. Static review only; nothing was built, deployed or executed against live services.
Prior work: the repo contains `SECURITY-AUDIT.md` from an earlier pass. Part 5 of this report records which of those items are fixed, open, or regressed.

## 1. Verdict

The cryptographic core is sound and has improved since the last audit: seed generation, encryption at rest, local signing for every chain, exact-amount ERC-20 approvals, and the website sign-in protocol are all done carefully. The serious exposure is operational, not cryptographic:

1. The release signing keystore and its password are written to GitHub Actions logs and uploaded as a downloadable artifact.
2. The native app sends every server call, including the cash-out deposit addresses users send funds to, to `mobile.honest.money`, which the codebase itself describes as the retired HME deployment, while the web app and APK feed live on `beekeeper.money`.
3. Biometric unlock still stores the wallet password in the keychain with no OS-level biometric binding (prior H3, unchanged).
4. The KDF was quietly lowered from 1,000,000 to 600,000 PBKDF2 iterations and existing stronger envelopes are downgraded on unlock.
5. The iOS project still carries the honest.money bundle identifier, so an iOS build from this repo would replace the existing TXC Wallet app, which the README says must never happen.

Fix items 1, 2 and 5 before any release. Items 3 and 4 are the next priority.

## 2. Findings summary

| ID | Severity | Finding |
|----|----------|---------|
| C1 | Critical | Release keystore and password printed to CI logs and uploaded as an artifact |
| H1 | High | Native app routes all server calls (incl. cash-out destinations) to a different origin than the web app |
| H2 | High | Biometric unlock stores the password in the keystore without OS biometric binding (prior H3, open) |
| M1 | Medium | KDF cost regressed to 600k and stronger envelopes are silently downgraded; Argon2id not adopted |
| M2 | Medium | Tron transactions are signed from a server-built `txID` without verifying `raw_data` |
| M3 | Medium | iOS project still uses `money.honest.txcwallet`; would overwrite the existing app |
| M4 | Medium | Unauthenticated server functions act as an open HMAC-signing relay to VectorPay; link proxies are open relays |
| M5 | Medium | "Delete wallet and all data" leaves the TSD Swap API key and other data on the device |
| M6 | Medium | In-app update channel has no integrity binding beyond Android's signature check |
| M7 | Medium | Wallet password kept in JS memory for the whole session and written (encrypted) to sessionStorage |
| L1 | Low | Explorer/Tron proxies allow `..` path traversal to other endpoints on the upstream host with the paid API key |
| L2 | Low | Seed phrase copied to clipboard with no auto-clear |
| L3 | Low | Aggregator-supplied spender/router addresses and calldata are signed without an allow-list |
| L4 | Low | CORS allows `http://localhost` with credentials in production; headers are gated on `NODE_ENV`; limiter is per-isolate |
| L5 | Low | Webhook has no replay protection; `vectorPayLinkStatus` returns bank mask for any account ref |
| L6 | Low | Hygiene: `bs58check` undeclared, beta Nitro on the money path, `.env` not ignored, no CI security gate |

## 3. Detailed findings

### C1. Release keystore and password leak into CI logs and artifacts (Critical)

Evidence: `.github/workflows/generate-keystore.yml:284-298` writes the base64 keystore and the generated password to step outputs and to `keystore-info/secrets.txt`; lines 300-306 upload the `.jks` and `secrets.txt` as a workflow artifact; lines 308-326 `echo` the base64 keystore and the password into the job log. GitHub masks only registered secrets, not step outputs, so these values appear in clear text in the log. Workflow logs and artifacts are readable by anyone with read access to the repository (everyone, if the repository is public) and are retained for 90 days by default.

Impact: anyone who can read Actions output can sign APKs that Android accepts as a genuine BeeKeeper Wallet update. The app has its own sideload update channel (`/api/public/apk`, `UpdateCheckCard`), so a signed malicious APK that reaches the CDN asset or the release row (see M6) would be installed over users' wallets with access to the WebView storage holding the encrypted seed and to the keychain copy of the password (see H2).

Fix:
- Delete this workflow. Generate the keystore offline (or use Play App Signing) and add only the four secrets to GitHub.
- If the workflow has ever been run, treat the key as compromised and rotate before the first public release. Purge the run's logs and artifacts.
- In `android-apk.yml:138`, pass `-storepass` through an environment variable instead of interpolating `${{ secrets.* }}` into the shell script.
- Add `::add-mask::` for any derived value that must be echoed in CI.

### H1. Native app talks to a different backend than the web app (High)

Evidence: `src/lib/native/server-fn-bridge.ts:16-17` forwards every `/_serverFn/*` and `/api/*` request from the Capacitor shell to `PROD_ORIGIN = "https://mobile.honest.money"`. Meanwhile the APK feed, download endpoint and VectorPay return URL are on `beekeeper.money` (`src/lib/app-release.ts:18,68-71`; `src/lib/vectorpay.functions.ts:606`), the README names `beekeeper-wallet.lovable.app` as the live app, and `.lovable/plan/correct-beekeeper-apk-downloads-2026-09-14.md` calls the honest.money endpoint "retired". `CapacitorHttp` runs outside the WebView, so the CSP `connect-src` list in `src/lib/security/headers.ts:148-158` does not constrain it.

What flows over this path: `getVectorPayConfig` returns the deposit addresses users send stablecoins and TSD to (`vectorpay.functions.ts:551-554`, consumed at `CashoutActions.tsx:172-182,383,404`); `startVectorPayCashout` carries signed proofs; LI.FI swap calldata and approval spender; Relay bridge steps the Tron key signs blind; THORChain inbound vault addresses; price and token metadata; TSD cash-out orders carrying the user's TSD Swap API key.

Impact: whoever operates or later acquires `mobile.honest.money` can hand every native user attacker-chosen cash-out addresses and swap/bridge calldata. Even if the same team runs both deployments today, every env secret (`CASHOUT_*`, `BEEKEEPER_WEBHOOK_SECRET`, `VECTORPAY_ORDER_WEBHOOK_URL`, RPC credentials) must be duplicated exactly or native and web users cash out to different treasuries. Side effect already visible in code: on native, `fetchLatestRelease` tries `beekeeper.money` and the Supabase host, neither of which is forwarded by the bridge nor allowed by CSP, so the update check can only fail.

Fix:
- One constant for the production origin (`https://beekeeper.money`), shared by the bridge, `CSP connect-src`, the CORS allowlist in `src/start.ts:67-72`, and the proxies' `ALLOWED_HOSTS`. Fail the build if they disagree.
- Add TLS pinning for `CapacitorHttp` (a pinning-capable plugin) for the server-function origin, since it carries destination addresses.
- Remove `hme-mobile.lovable.app` and `mobile.honest.money` from allowlists once the HME deployment is decommissioned.

### H2. Biometric unlock is not OS-enforced (High, unchanged from prior audit H3)

Evidence: `src/lib/native/biometric.ts:109-123` stores the plaintext wallet password in `@aparajita/capacitor-secure-storage` after a JavaScript-side `BiometricAuth.authenticate()`; `:151-170` reads it back after another JS-side prompt. The keychain item is not created with a biometric access-control flag, so the OS never requires a biometric to release it. The call does not pass an explicit access level, so the item uses the plugin default; verify it is not a backup-eligible accessibility class, otherwise the password can travel with device backups while the encrypted seed in WebView storage travels too.

Impact: a rooted/jailbroken device, a keychain dump, malicious JavaScript in the WebView, or a malicious update (C1) reads the password without any biometric and decrypts every profile, because one password unlocks all vaults (`storage.ts:399-434`).

Fix: as in the prior plan. Generate a random 32-byte key K in a secure item created with `kSecAccessControlBiometryCurrentSet` / Android `setUserAuthenticationRequired(true)` (StrongBox where available), `ThisDeviceOnly`, non-syncable; encrypt a second copy of the envelope under K; never store the password. The current plugin does not expose this, so a small native shim or a different plugin is required.

### M1. KDF regressed and silently downgrades (Medium)

Evidence: `src/lib/txc/storage.ts:37-43` sets `PBKDF2_ITERATIONS = 600_000` (the prior audit raised it to 1,000,000). `:288-292` re-encrypts any envelope whose `iterations` differs from the current default, which downgrades wallets written at 1,000,000 back to 600,000. Argon2id (prior M1 follow-up) is not implemented.

Impact: the on-device ciphertext in `localStorage` is the offline brute-force target. PBKDF2-SHA256 is GPU-friendly; 600k iterations on a 10-character password is within reach of a determined attacker who obtains the device storage.

Fix: change the normalization to upgrade-only (`<` not `!==`), move new envelopes to Argon2id via `hash-wasm` with a memory cost of 64 MB or more, keep the PBKDF2 read path for migration, and await the re-encrypt or serialize it so it cannot race with `setStoredKind`/`renameStoredWallet`.

### M2. Tron: blind signing of node-built transactions (Medium)

Evidence: `src/lib/tron/api.ts:203-275` and `:302-326` post the intent to TronGrid through the proxy, receive `{ txID, raw_data, raw_data_hex }`, and `signTxId(tx.txID, privateKey)` (`tron/sign.ts:12-19`) signs the returned hash without recomputing `sha256(raw_data_hex)` or decoding `raw_data` to confirm `to_address`, `amount`, `contract_address` and `data` match the request. The bridge uses the same path with a 150 TRX fee limit (`wallet.tron.bridge.tsx:188-194`).

Impact: a compromised proxy (see H1) or upstream response can substitute the recipient or contract, and the wallet signs and broadcasts it.

Fix: before signing, assert `sha256(hexToBytes(raw_data_hex)) === txID`, decode the `raw_data` protobuf (TransferContract / TriggerSmartContract) and compare owner, destination/contract, amount, call value, data and fee limit against the local intent. Reject on any mismatch.

### M3. iOS build still has the honest.money identity (Medium, release blocker)

Evidence: `ios/App/App.xcodeproj/project.pbxproj:312,333` `PRODUCT_BUNDLE_IDENTIFIER = money.honest.txcwallet`; `ios/App/App/capacitor.config.json:2-3` appId/appName are honest.money; `ios/App/App/Info.plist` display name and `CFBundleURLName money.honest.txcwallet.nectar`; `scripts/harden-ios-native.mjs:292-355` re-writes Info.plist with the honest.money strings on every `ios:harden`.

Impact: contradicts README requirement 5. An iOS archive from this repo is the old app to the App Store and to the device, so it would replace users' existing wallet app rather than install alongside it. Android was fixed (`money.beekeeper.wallet`); iOS was not.

Fix: new bundle id, display name and URL-type name in the pbxproj, Info.plist and the harden script; update `CFBundleURLSchemes` if the `nectar://` scheme must remain owned by the old app; regenerate `ios/App/App/capacitor.config.json` from `capacitor.config.ts`.

### M4. Open signing relay and open proxies (Medium)

Evidence:
- `src/lib/vectorpay.functions.ts:582-635` `startVectorPayCashout` accepts any `reference`, `customerId`, `transfers[]` (including proof `message`/`signature` strings) from any caller and the server HMAC-signs the body with `BEEKEEPER_WEBHOOK_SECRET` before forwarding. The signature therefore only proves "passed through BeeKeeper's server". `vectorPayLinkStatus` (`vectorpay-link.functions.ts:202-204`) returns first name and bank institution/mask for any `accountRef`.
- `/api/nectar/pay/$invoiceId` has no caller check or rate limit (`routes/api/nectar.pay.$invoiceId.ts`). `/api/nectar/link` and `/api/tsd/link` accept any path on the trusted hosts (`nectar.link.ts:74-85`, `tsd.link.ts:136-148`) and forward GET/POST bodies verbatim.
- `tsd.functions.ts` forwards arbitrary caller-supplied TSD Swap API keys to the partner with the wallet server as the source IP.

Impact: order spam and quota abuse against partners from BeeKeeper's IP and signature; forged order payloads that VectorPay must fully re-verify (the docs require it, but the trust is one-sided); privacy leak if an `account_ref` is ever observed in logs.

Fix: require proof of possession on money-moving server functions (sign the request body with the wallet's identity key, the BIP-137 signer already exists, and verify server-side); add a shared-store rate limiter keyed by IP and customer id; restrict link proxies to the exact protocol paths; state in the VectorPay contract that the HMAC is transport authentication only.

### M5. "Delete wallet and all data" does not delete all data (Medium)

Evidence: `src/lib/txc/storage.ts:301-310` removes only the envelope for the default profile (`purgeProfileStorage` skips `default`); `wallet-context.tsx:161-169` adds `clearWalletTraces()`, which clears the query cache and scan hints only (`query-persist.ts:192-206`). The dialog at `wallet.settings.tsx:256-259` promises deletion of "the encrypted wallet, biometric unlock, address book, and all cached data".

Left on the device for the default profile: the TSD Swap API key in plaintext (`cashout/api-key.ts:16,33`), which can change the account's USDC payout address via `setCashoutPayoutAddress` (`tsd.functions.ts:405-420`); the VectorPay link record; address book; imported WIF ciphertexts; watch-only entries; Nectar/TSD link records; custom tokens; ecosystem links; cached raw transactions.

Fix: give every app key a common prefix and purge by prefix on delete; store the TSD API key inside the encrypted envelope or wrap it under the root-derived key as WIFs are; make the dialog text match behaviour.

### M6. Update channel integrity (Medium; High when combined with C1)

Evidence: `routes/api/public/latest-release.ts:368-380` reads `app_releases` with the publishable key, so anon SELECT must be allowed; no migration in `supabase/migrations/` defines that table or its RLS, so anon INSERT/UPDATE cannot be ruled out from the repo. `routes/api/public/apk.ts:414-416,452-463` streams a hard-coded CDN URL with no hash verification. `app-release.ts:147` always points Android at that single file regardless of the version the feed reports.

Fix: confirm RLS on `app_releases` denies anon writes; store `sha256` in each release row and verify the streamed bytes server-side (or at least publish `SHA256SUMS` from `android-apk.yml:229` alongside); sign release rows with an offline key and verify in the client.

### M7. Password retained for the whole session (Medium)

Evidence: `session-cache.ts:190-199,250-253` keeps the password in `memPayload`; `wallet-context.tsx:120-131` saves it after unlock; it is also encrypted into `sessionStorage` under a per-process key (which never survives a reload, so that copy is dead weight).

Impact: XSS or a compromised dependency obtains the password alongside the seed; the password unlocks every profile and equals the keychain copy when biometrics are enabled.

Fix: after unlock, derive a random session key, wrap each profile's envelope key with it, and discard the password; drop the `sessionStorage` write.

### L1. Proxy path traversal to other upstream endpoints (Low)

Evidence: `routes/api/utxo.$coin.$.ts:242-245` prefix-matches the decoded splat, then `:291` builds `${base}/${path}`; `address/../../../v2/other` passes the check and `fetch` normalizes it, sending the NowNodes `api-key` (`:295`) to any path on that host. Same pattern in `routes/api/tron.$.ts:369-373,416`.

Fix: reject `.`/`..` segments and encoded separators; build with `new URL(path, base)` and assert the final pathname still starts with the allowed base.

### L2. Seed phrase copied to clipboard without auto-clear (Low)

Evidence: `routes/create.tsx:279` calls `copyToClipboard(mnemonic)` without `autoClearMs`, although `lib/clipboard.ts:9-12` documents that option for seeds. Clipboard managers and keyboard cloud sync can capture the seed.

Fix: remove the copy button on native, or pass a short `autoClearMs` and warn.

### L3. Aggregator-supplied targets signed without an allow-list (Low)

Evidence: `wallet.evm.$chain.swap.tsx:199-234` approves LI.FI's `approvalAddress` (exact amount, good) and signs `transactionRequest.to/data`; `wallet.tron.bridge.tsx:170-199` signs Relay's `contractHex`/`data`; `UtxoSwap.tsx:185-189` sends to `quote.inbound_address` from THORNode gateways. Mitigations present: exact approvals, USDT reset, step dedupe, allowance check, expiry check. Missing: per-chain allow-list of known router/spender/receiver contracts and a human-readable display of the spender before approval. The `beekeeper://link-vectorpay` deep link requires a tap but shows only the code, not whose account will be bound (`VectorPayLinkCard.tsx:70-77`).

### L4. Transport configuration (Low)

- `src/start.ts:67-72,79` allows `http://localhost` and `https://localhost` with `Access-Control-Allow-Credentials: true` in production. Harmless today (no cookie auth), a hole if sessions are added.
- Security headers apply only when `process.env.NODE_ENV === "production"` (`start.ts:61,90`); verify with `curl -I` on the deployed worker that the CSP header is present.
- `routes/api/evm.$chain.ts:93-130` rate limiter is per-isolate and the origin check is spoofable by non-browser clients; Alchemy quota drain remains possible.
- `script-src 'unsafe-inline'` remains (`headers.ts:163`).

### L5. Webhook and status lookups (Low)

`routes/api/public/vectorpay-order-status.ts` verifies the HMAC correctly but has no timestamp or nonce, so a replayed webhook can roll an order's displayed status back. `getCashoutOrderStatus` is reference-scoped (about 80-128 bits), acceptable.

### L6. Hygiene (Low)

- `src/lib/wif/decode.ts:315` imports `bs58check`, which is not in `package.json` (resolved transitively as 4.0.0).
- `nitro@3.0.260603-beta` and `@tanstack/react-start@1.168.60` on the money path (prior L3).
- `.env` is committed and `.gitignore` does not exclude it; it currently holds only the Supabase publishable key, which is public by design.
- None of the Part 5 CI gates from the prior audit exist (no secret-pattern scan, CSP check, or dependency audit workflow).
- `lib/wif/store.ts:53-66` wraps WIFs under `SHA-256(master private key)`; use HKDF with a domain label.
- `observability.ts:14` uses `new Function` for a dynamic import; blocked by CSP and only active with a Sentry DSN; dead code.

## 4. Reviewed and sound

- Entropy: `lib/txc/entropy.ts` uses `crypto.getRandomValues` with health checks, an HMAC-SHA256 extractor over two independent draws, optional user entropy, and a final XOR with a fresh draw; `lib/txc/wallet.ts:64-81` verifies the BIP39 round trip; new wallets are 24 words.
- At rest: AES-256-GCM with a random 16-byte salt and 12-byte IV per envelope; iteration count stored per envelope so unlock never breaks (`storage.ts:141-175,247-298`).
- Signing is local on every chain (TXC/BTC/LTC/DOGE/ISK via PSBT, EVM via viem, Solana via web3.js, Tron via noble). RPC proxies allow-list methods and block `eth_sign`, `eth_accounts`, `wallet_*`.
- Tap-to-pay shows the full recipient address and requires biometric re-confirmation on native (`pay.$invoiceId.tsx:194-197,338-349`); all send screens call `confirmWithBiometric`.
- Password policy with blocklist and strength meter on all creation paths (`security/password-strength.ts`; `create.tsx`, `import.tsx`, `import-key.tsx`, `BeeKeeperOnboarding.tsx`).
- Website sign-in: callback host allow-list, challenge id and nonce binding, fixed six-line message template, self-verification before posting (`nectar/auth.ts:183-219,221-254`).
- ERC-20 swap approvals are exact-amount with the USDT reset-to-zero quirk handled; Relay steps are de-duplicated client and server side.
- Seed backup page reveals on tap, clears state on unmount, and enables the privacy screen on native (`wallet.backup.tsx`).
- Error telemetry scrubs mnemonics, WIFs, xprv and long hex before leaving the device (`lovable-error-reporting.ts`).
- The service-role Supabase client is only reached through dynamic imports inside server handlers.
- Legacy BeeKeeper import validates blob shape and iteration bounds before decrypting (`legacy-beekeeper.ts`).

## 5. Status of the prior audit's items

| Prior ID | Item | Status now |
|----------|------|------------|
| H1 | Remote code loading | Fixed in config (bundled assets). New H1 above: the bundled app still phones the old origin for every server call. |
| H2 | No CSP | Meta tag and headers exist; `'unsafe-inline'` remains; `connect-src` lists the old origins and not `beekeeper.money` or the Supabase host. |
| H3 | Biometric gate in JS only | Open, unchanged (H2 above). |
| M1 | Weak KDF | Regressed: 1M reverted to 600k with silent downgrade; Argon2id not done (M1 above). |
| M2 | Password policy | Fixed. |
| M3 | Deep-link phishing | Pay flow shows the full address (fixed). Universal-link verification files are not in the repo; custom schemes still unowned. |
| M4 | Third-party error reporting | Scrubbing added; reporting still active in production. |
| M5 | RPC proxy caller check | Wildcard gated in production; limiter is per-isolate (L4). |
| L1 | Seed present in DOM | Backup page fixed; create page copy button lacks auto-clear (L2). |
| L2 | xpub material in localStorage | Query cache cleared on delete; other stores remain (M5). |
| L3 | Beta framework | Unchanged (L6). |
| Part 5 | CI gates | Not implemented. |

## 6. Remediation order

Before any release:
1. C1: delete `generate-keystore.yml`, rotate the key if it ever ran, fix the `-storepass` interpolation.
2. H1: single production origin for bridge, CSP, CORS and proxy allow-lists; add a build check.
3. M3: rename the iOS bundle id and strings.

Next sprint:
4. H2: biometric-bound key design.
5. M1: upgrade-only KDF normalization, then Argon2id.
6. M2: verify Tron `raw_data` before signing.
7. M5: full wipe on delete; encrypt the TSD API key.
8. M6: hash-pinned APK and RLS confirmation on `app_releases`.

Then:
9. M4 and L1: proof-of-possession on money-moving server functions, shared rate limiting, strict proxy paths.
10. M7, L2, L3, L4, L5, L6, and the CI gates from the prior plan.

## 7. Not verified here

- Whether `generate-keystore.yml` has ever been run (check the Actions history).
- RLS policies on `app_releases` (table is not in the repo's migrations).
- Whether the deployed worker actually emits the security headers (`NODE_ENV` at runtime).
- The default keychain accessibility class used by `@aparajita/capacitor-secure-storage` 8.0.0.
- Any behaviour of the partner services (VectorPay, TSD Swap, NectarPay, Relay, LI.FI, THORChain).
