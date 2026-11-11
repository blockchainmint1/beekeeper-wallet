# BeeKeeper Wallet — reply to the round-2 interim notes (2026-11-11)

**Code package:** `beekeeper-wallet-audit-2026-11-11.zip`. It replaces the
2026-11-10 zip, which never reached you, and includes everything below.
Tests: 54 across 9 files, all passing. Typecheck clean.

## 1. Pointer corrections (your section 1)

| Item | Correct location |
|---|---|
| M7 (unlocked wallet not in sessionStorage) | `src/lib/txc/session-cache.ts` |
| L4 (no plain-http localhost in prod CORS) | `src/start.ts` (`headers.ts` only sets `connect-src`) |
| M6 `app_releases` read-only | Now in the repo: `drizzle/migrations/0000_app_releases_read_only_policy.sql`. It's idempotent and matches the live policy: one SELECT policy for anon/authenticated, no write grants. |

The six "new and unverified" items you listed are all in the new zip: proxy-guard
wiring, WIF v2, `security.yml`, the `new Function` loader removed, `cashout/verify*`, and the tests.

## 2. Fixed on BeeKeeper's side today

### 2.1 Order forgery
- **Only mined, successful transfers count.** `checkEvmTransferTx`
  (`src/lib/cashout/verify.ts`) now needs receipt status `0x1`. A pending tx
  comes back as `pending`. The server returns `retryable: true`, and the wallet
  waits and asks again (up to ~2 min) before it confirms the order.
- **Official contract check** was already there (`tx.to` must equal the
  official USDC/USDT address from `erc20.ts`). There's now a test showing a
  look-alike token at the deposit address counts as $0.
- Payee binding (`account` in the proof) and confirmation depth need
  VectorPay's side too. See section 3.

### 2.2 One-tap sequencing
1. **Txids are saved the moment each send returns.** The in-progress cash-out
   now lives in per-wallet `localStorage`
   (`src/lib/cashout/session.ts`, base `beekeeper.cashout.session.v1`, listed in
   `PROFILE_SCOPED_BASES`), not `sessionStorage`. Each line also stores a snapshot
   of what was sent. If the page reloads or crashes, the same order reopens on the
   send list, and "Complete cash-out" still works even though the fresh balance
   scan no longer shows the coins that left. Closing the dialog with sent but
   unconfirmed lines keeps the session.
2. **A retry never signs a second transfer by accident.** `sendEvmTransaction`
   (`src/lib/chains/evm-send.ts`) now saves the signed tx with a caller tag
   (`<reference>:<line>`) **before** broadcasting. `sendCashRow` and `ensureGas`
   (`src/lib/cashout/roundup.ts`) call the new `findLiveEvmTx` first. If that
   tagged tx is mined successfully, pending, or can still be pushed, it is reused.
   A fresh send is signed only when the old one can never confirm (nonce taken,
   reverted, or the node refuses it). A send interrupted by a reload comes back as
   "Interrupted — Try again checks whether it already went out".
   TSD lines get the same treatment: `sendOmniToken`
   (`src/lib/txc/omni-send.ts`) saves the signed tx under the tag before
   broadcasting, and a retry first checks the explorer, re-pushes it if it is
   still valid, and signs a fresh send only when the old one can never confirm.
3. Gas top-ups are not rolled back (accepted; the coin stays in the merchant's
   own derived address). A gas top-up retry reuses the earlier top-up through
   the same tag.
4. Re-auth / visible destination: not done yet (see section 4).
- **Test added:** a one-tap plan where the TSD line is the one that gets cut
  sends only the cut amount (`one-tap.test.ts`). `appliedAmount` moved to
  `src/lib/cashout/one-tap.ts` so it can be tested.

### 2.3 WIF v1 → v2
- Each version uses its own fingerprint: v1 uses the legacy SHA-256 `fp`, v2
  uses the HKDF `fp`.
- An entry tagged `v: 2` that fails falls back to the v1 key once. If that works,
  it is re-wrapped. (test)
- Upgrade compare-and-swap now compares the **whole serialised entry**, re-read
  right before writing.
- `reencryptAllWifs` decrypts every entry before writing anything; a throw
  leaves the old list intact. Mixed v1/v2 input in, v2 out.
- The HKDF label and salt are frozen: `WIF_HKDF_LABEL` is exported, and a test
  pins the fingerprint and an exact AES-GCM ciphertext for a fixed root.

### 2.4 Partner pass-throughs
New `relayJson` in `src/lib/security/proxy-guard.ts`, used by all three routes:
- `redirect: "manual"`; any 3xx → 502 `upstream_redirect`.
- Upstream body capped at 256 KB (Content-Length and streamed byte count).
- Body must parse as JSON. It is re-serialised and always served as
  `application/json` with `nosniff`. Anything else → 502. Partner HTML can never
  render on beekeeper.money.
- `/api/nectar/link` now forwards only two URL shapes (`isLinkProxyShape`): the
  NectarPay store link `/api/public/v1/wallet-link?token=…` (or `/status`), and a
  sign-in callback carrying `id=<uuid>`. This is the same check the client does
  before signing.
- Live check: `nectar-pay.com` 308-redirects invoice lookups to
  `app.nectar-pay.com`. Since we no longer follow redirects, the upstream was
  pinned to `app.nectar-pay.com`. Behaviour matches the live site.
- Per-isolate limiter: still best-effort. An edge rate-limit rule is a hosting
  setting (open).

### 2.5 Vault leakage
- `beekeeper.vectorpay.link.v1` is now stored per wallet (`scopedKey`, and listed
  in `PROFILE_SCOPED_BASES`). The default vault keeps the original key name, so
  existing links are kept.
- Address book, query cache, raw-tx and nonce stores: still device-wide on
  purpose, since they're all public data.

## 3. Sent to VectorPay (`vectorpay-requests_v2.md`)
Your section 3, bundled into one request: VectorPay computes the fee (0% only
after the NectarPay check; signed NectarPay attestation as the end state);
proof message v2 with `account` / `merchant` lines and a version line, plus
rejecting reuse of a reference with a different `account_ref`; a signed webhook
timestamp (L5); written confirmation of single-use txids, the official-contract,
receipt and Omni-validity checks, and their confirmation depth per chain.
BeeKeeper keeps sending `fee_bps` until VectorPay confirms it computes the fee,
because removing it first could leave orders with no fee.

## 4. Still open
- Proof v2 / payee binding, merchant-fee check, webhook timestamp: waiting on VectorPay.
- One-tap re-authentication and showing deposit addresses: not done yet.
- BeeKeeper-side `used_txids` table: not added (VectorPay single-use is the control).
- Argon2id (M1b).
- Edge rate limits on `/api/nectar/*`, `/api/tsd/*`.
- Frozen Android installs (your section 4): `mobile.honest.money` belongs to the
  separate HME deployment. Your steps (keep it running, publish a `mandatory`
  release row telling users to move, answer `getVectorPayConfig` with
  `configured: false`) have been passed to the owner. Nothing changed in this repo.
