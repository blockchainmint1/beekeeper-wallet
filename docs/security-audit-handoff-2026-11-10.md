# BeeKeeper Wallet: audit handoff, round 2 (2026-11-10)

For: the auditor who wrote `docs/security-audit-2026-11-09.md`.
Package: `beekeeper-wallet-audit-2026-11-10.zip`, the full source tree with no `.git`, no `node_modules`, no `.env` and no build output.
Live site: https://beekeeper.money

## 1. What changed in scope since round 1

BeeKeeper is now a **web-only merchant wallet**, so a lot of the code you reviewed last time is gone:

| Removed | Why it matters for the audit |
|---|---|
| iOS native project (`ios/`), iOS build/harden scripts | M3 is moot. No App Store build exists or will exist. |
| Android APK work (no new builds) | H2 and M6 apply only to Android installs **already out there**. The APK endpoint, native bridge and update card were left running so those installs keep working, but nothing new ships. |
| Swaps and bridges: LI.FI (EVM), THORChain (LTC/DOGE), Relay (Tron), their server functions and screens | L3 (aggregator calldata signed with no allow-list) is gone with them. |
| TSD Swap API key storage + the Send-screen TSD → USDC off-ramp (`src/lib/cashout/tsd*.ts`, `api-key.ts`, `TsdCashoutPanel`, `TsdCashoutKeyCard`) | No partner API key is stored on the device or forwarded by the server any more. Leftover keys are deleted on startup (`src/routes/__root.tsx`). |
| Dead `new Function("m","return import(m)")` loader (`src/lib/native/observability.ts`) | Removes the last dynamic-code eval. |

Net change since round 1: about 800 lines added and 4,600 removed.

## 2. Status of every round-1 finding

| ID | Status | Where to look |
|---|---|---|
| C1 keystore in CI logs | **Fixed.** Generator workflow deleted; `android-apk.yml` passes the store password via env (`-storepass:env`). The workflow never ran on this repo. | `.github/workflows/android-apk.yml` |
| H1 native app talks to HME deployment | **Fixed.** One origin list; bridge, CSP, CORS and caller checks all import it; a test keeps them in sync. | `src/lib/native/origins.ts`, `origins.test.ts` |
| H2 biometric password not OS-bound | **Dropped (no new APKs).** Still true for Android installs already in the field. See section 4. | — |
| M1 KDF downgrade | **Fixed.** Re-encryption is upgrade-only and pinned to the right vault. | `src/lib/txc/storage.ts`, `delete-and-kdf.test.ts` |
| M1b Argon2id | **Open.** Needs a migration plan that can't strand existing wallets. | — |
| M2 Tron signs server `txID` | **Fixed.** `assertTronTxMatches` rebuilds and compares `raw_data` before every Tron signature (tests use real TronGrid output). | `src/lib/tron/verify.ts`, `verify.test.ts` |
| M3 iOS bundle id | **Moot.** iOS project removed. | — |
| M4 open HMAC relay / open proxies | **Fixed on BeeKeeper's side** (details below). Per-request wallet signing of *every* call still needs VectorPay changes. | `src/lib/vectorpay.functions.ts`, `src/lib/cashout/proof.ts`, `src/lib/security/proxy-guard.ts` |
| M5 delete wallet leaves data | **Fixed.** Full wipe on last-wallet delete; per-wallet keys must be in `PROFILE_SCOPED_BASES` (test-enforced). | `src/lib/profiles.ts`, `delete-and-kdf.test.ts` |
| M6 update channel integrity | Release table is read-only to the public (confirmed). The APK SHA-256 check was dropped with the APK. | migration in `supabase/migrations/` |
| M7 password/session in sessionStorage | **Fixed.** The unlocked wallet is no longer written to sessionStorage. | `src/lib/txc/wallet-context.tsx` |
| L1 proxy path traversal | **Fixed.** | `src/lib/security/proxy-path.ts`, `proxy-path.test.ts` |
| L2 clipboard | **Fixed.** Seed copy clears the clipboard after 60 s. | — |
| L3 aggregator allow-list | **Moot.** Swaps and bridges removed. | — |
| L4 CORS localhost / headers | **Fixed.** No plain-http localhost in production; headers confirmed live. | `src/lib/security/headers.ts` |
| L5 webhook replay / link-status bank mask | **Open.** Needs VectorPay to add a signed timestamp and a request signature. | `src/routes/api/public/vectorpay-order-status.ts`, `src/lib/vectorpay-link.functions.ts` |
| L6 hygiene | **Fixed.** `bs58check` declared; CI security workflow added; HKDF for imported-key wrapping; dead loader removed. | `.github/workflows/security.yml`, `src/lib/wif/store.ts` |

### M4 in detail

- **Cash-out orders:** the server no longer HMAC-signs whatever it's given. Every transfer must carry a signature from its sending address over the exact proof text for *this* order reference and *the server's own* deposit address. The server checks it with EIP-191 for EVM chains and BIP-137 for TXC/TSD before anything goes to VectorPay. VectorPay still re-verifies, and txids are single-use on their side. (`proof.ts`, `vectorpay.functions.ts` lines 91–110)
- **Partner pass-throughs** (`/api/nectar/link`, `/api/nectar/pay/$invoiceId`, `/api/tsd/link`), via `proxy-guard.ts`:
  - https only, exact trusted hosts, default port, no credentials
  - encoded `.`/`/`/`\` and dot-segments are rejected before URL normalisation
  - TSD is limited to the documented `/api/public/v1/link/<id>` and `/claim` paths
  - invoice ids must match `[A-Za-z0-9_-]{1,128}`
  - per-IP rate limit (per isolate, fails open)
  - POSTs must come from BeeKeeper's own origin
  - bodies capped at 32 KB
  - a followed redirect that leaves the trusted hosts is refused
- **Not path-pinned:** NectarPay and streamTXC sign-in and link callbacks. Their paths come from the partner's QR code and aren't documented to us, so those routes are pinned to host only.
- Tests: `proxy-guard.test.ts`, `tsd-link-path.test.ts`.

### Imported-key (WIF) wrapping (L6)

New entries use an AES-GCM key from HKDF-SHA256 over the root private key with the label `beekeeper/wif-wrap/v2`, and are tagged `v: 2`. Entries saved the old way (bare SHA-256) are still readable. They are re-wrapped to v2 only after they decrypt successfully, and only if the stored entry hasn't changed in the meantime. A wrong seed leaves the stored data untouched. Tests: `src/lib/wif/store.test.ts`.

## 3. New code since round 1 worth a look

1. **One-tap cash-out:** `src/lib/cashout/one-tap.ts` (plan: $1,000 cap, skip dust and Ethereum balances under $10, skip balances that can't pay their own fee) and `runOneTap` in `src/components/wallet/CashoutActions.tsx`. It reuses the same order/send/confirm functions as the step-by-step picker. Agreement to the terms is remembered per wallet under a versioned key.
2. **Inline TSD (Omni) send** inside cash-out: `src/lib/txc/omni-send.ts`.
3. **EVM fee handling for sweeps:** native sweep value is computed from the exact fee cap that gets signed. See `src/lib/chains/evm-send.ts` and `evm-sweep.ts`.
4. **Installable web app:** `public/manifest.webmanifest` plus PNG icons. Manifest only; there is **no service worker**.
5. **VectorPay wallet link:** a one-time code redeemed through a server-signed call (`src/lib/vectorpay-link.functions.ts`, `src/components/wallet/EcosystemLinkCard.tsx`).

## 4. Known open items and accepted risk

- **Android installs already in the field** still use the old biometric path (password in secure storage with no OS biometric binding) and the old updater. No new APK will ship. Our plan is to steer those users to the web wallet or HME Wallet. Please tell us if you think they need an active warning.
- **M1b Argon2id:** open, as noted above.
- **L5 / request signing with VectorPay:** open until VectorPay ships their half.
- **Rate limiting is per isolate:** best-effort only. No shared store is used yet.
- **Dependencies:**
  - Lovable's production scan shows **no critical or high** issues.
  - Moderate issues remain in `@solana/web3.js` → `jayson` (`stream-json` 1.x, `uuid` 8). Fixing them needs a major version bump that `jayson` doesn't allow. The browser wallet doesn't use the affected code paths: `uuid` v3/v5/v6 with a buffer, and `stream-json` filters.
  - Moderate issues also remain in `@capacitor/cli` (`glob`, `minimatch`, `tar`), which is only a build tool for the frozen Android app.
  - `bun audit` (all packages) also flags build-only tools: `sharp` 0.32 inside `@capacitor/assets`, and `minimatch`/`tar` in tooling.
- **Lovable database scan:** one informational finding. The `app_releases` table can be read by anyone. That is intentional because it holds only public version numbers and download links, and there are no public writes.

## 5. How to verify

```
bun install --frozen-lockfile
bunx tsc --noEmit -p .        # type check
bunx vitest run               # 35 tests across 8 files
bun audit --prod --audit-level=critical
```

The same steps run in CI on every push (`.github/workflows/security.yml`). That workflow uses no secrets.

## 6. Where we'd most like your eyes

1. The cash-out proof check and the VectorPay order relay. Can a caller get BeeKeeper to sign an order for funds they didn't send?
2. The one-tap cash-out sequencing. It covers partial failures, retries, and making sure an order only covers what actually landed.
3. The WIF v1 → v2 upgrade path. Is there any way it can lose an imported key?
4. The partner pass-throughs: anything still relayable?
5. Anything that leaks between wallet profiles (vaults) sharing one password.

## Addendum — Nov 11, 2026 (deep scan follow-up)

- **Fixed: "Anyone can set the cash-out amount."** `startVectorPayCashout` no longer trusts the
  wallet's dollar figures. `src/lib/cashout/verify.server.ts` settles every line from the chain
  before the order is HMAC-signed: before coins move, a line is capped at the sending address's
  live balance (ERC-20 `balanceOf` / `omni_getbalance`); once a txid exists, the line becomes
  exactly what that tx moves from the signed sender to our deposit address (ERC-20 `transfer`
  calldata + receipt status; Omni Simple Send decoded from the raw tx, plus Omni Core validity
  once confirmed). Duplicate txids in one order count once. Order total and fee are recomputed
  from the settled lines. Pure checks + tests: `src/lib/cashout/verify.ts`, `verify.test.ts`.
- **Open (needs VectorPay): "Anyone can claim the cash-out merchant discount."** `merchant_ref`
  is still wallet-supplied. VectorPay has been asked to confirm the merchant with NectarPay
  before applying 0% and to fall back to 1% otherwise.
