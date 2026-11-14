# BeeKeeper Wallet — Response to Round 4 Review

Date: 2026-11-14
Responds to: `beekeeper-wallet-security-audit-round4-2026-11-14.md` (round-4 review of `beekeeper-wallet_4.zip`).
Package: `beekeeper-wallet-audit-round5-2026-11-14.zip` (source only; `.env`, `node_modules`, build output and `.git` excluded, which closes N4).

Checks run for this package: `bunx vitest run`, 19 files and 109 tests passing (14 new); typecheck clean; build OK.
Run in the preview against Bridge's sandbox: a new wallet went through ID check, test approval and the new
`create-account` step, and got a deposit account. A captured signed `status` request and a captured signed
bank lookup were each replayed once, and both were refused. A Cash out bank check recorded the owning wallet.

## Summary

| ID | Decision | Where |
|----|----------|-------|
| N1 | **Fixed** | `vectorpay.functions.ts`, `keyed-limit.ts`, `CashoutActions.tsx` |
| N2 | **Fixed on BeeKeeper's side**, trust-on-first-use for existing links (owner's decision) | `cashout/account-owner*.ts`, `vectorpay-link.functions.ts`, migration `0002_cashout_account_owners.sql` |
| N3 | **Fixed** | `cashout/verify.server.ts` |
| N4 | **Fixed**: `.env` left out of the package | this ZIP |
| B1 | **Accepted risk, kept by the owner's decision**; B2 removes the live-key consequence | `bridge/visibility.ts` |
| B2 | **Fixed** | `bridge/topup.functions.ts` (`startTopupKyc`) |
| B3 | **Fixed** | `routes/api/public/bridge.webhook.ts`, migration 0002 |
| B4 | Open: go-live check | `docs/bridge-go-live.md` step 4 |
| B5 | **Fixed** (seen-nonce set, also applied to bank lookups) | `security/seen-nonce.ts` |
| B6 | **Fixed** | `bridge/idempotency.ts` |
| B7 | **Fixed** | `bridge/topup-proof.ts`, `topup.functions.ts` (`openTopupAccount`), `TopupDialog.tsx` |
| B8 | Recorded for when TSD delivery is wired | `docs/bridge-go-live.md` |
| B9 | **Documented** | `docs/topup-data-retention.md` |
| B10 | Accepted: NowNodes stays first; the three public Blockbooks are fallback only | `routes/api/utxo.$coin.$.ts` |

## Details

**N1: re-checks no longer count as new attempts.** The server remembers each `(customer ID, reference)`
it has seen for 30 minutes. A request for a reference that customer already started goes through a
separate per-order cap of 40 per 10 minutes, not the 6-per-10-minutes new-order limiter. The settlement budget
of 80 lookups and the 60-txid cap per request still apply. The wallet now polls 20 × 15 s (about 5 minutes)
instead of 8 × 15 s, so Ethereum's 12-confirmation rule fits. Test: `keyed-limit.test.ts` (1 start + 20 re-checks fit the cap).

**N2: bank details are bound to one wallet.** The new service-role-only table `cashout_account_owners` stores
`account_ref → TXC holder address` (RLS on, no policies, `REVOKE ALL` from anon/authenticated). Both
`redeemVectorPayLink` and `vectorPayLinkStatus` now require the signed bank-lookup proof. The first valid signer
claims the ID; any other address is refused with "belongs to a different wallet". The check fails closed if the
table can't be read. Redeem now needs a signature too, because its reply also carries the bank mask.
Existing links: the owner chose trust-on-first-use over making every merchant re-link. The first signed check
after this release claims the ID, and the wallet runs that check every time Cash out opens. The residual window
is someone who already holds a victim's `bk_` ID and checks before the victim next opens Cash out. Tests: `account-owner.test.ts`.

**N3:** settlement-budget exhaustion is now `retryable: true`. It happens when many sends are still confirming,
and each of those costs 3 lookups. The re-check limiter keeps the retries bounded.

**B1: the five-tap unlock stays.** Owner's decision. What it can reach now:
- With the sandbox key, a tester gets Bridge's sandbox: fake bank numbers, no real money. A merchant who finds the gesture could still type a real name and email into sandbox KYC. Accepted.
- With a live key, `startTopupKyc` refuses before calling Bridge, because `destinationFor("live")` is null (B2). The gesture can't start live KYC or create live customers until TSD delivery exists, and at that point the feature is meant to go live anyway.

**B2:** `startTopupKyc` refuses (`"Live top-ups switch on once TSD delivery is connected."`) before calling
`/kyc_links` whenever `destinationFor(env)` is null.

**B3:** the webhook no longer writes `payload`. The column is marked deprecated, and existing rows were
cleared to `{}` in the same migration. Only the extracted IDs, amounts and the destination tx hash are kept.

**B5:** each top-up action and each bank lookup or redeem remembers its `address:nonce` for 11 minutes, which is more than
twice the 5-minute validity window. A replay gets "request already used". The memory is per isolate, the bar you accepted.

**B6:** the Idempotency-Key for `/kyc_links` is `bk-kyc-<env>-<address>-<sha256(name|email|type)[:8 bytes]>`.
A double submit collapses into one Bridge customer, and a corrected email still gets a new key.

**B7:** a new signed action `create-account` (`openTopupAccount`) is the only path that POSTs
`/virtual_accounts`. `status` only reports `canOpenAccount: true`, and the wallet then signs and sends the
create step itself.

## Still open
- B4: confirm the webhook signature with one real sandbox delivery before enabling the live webhook.
- B8: per-customer TSD mint address, waiting on the TSD bridge team (requirements copied into the go-live note).
- From earlier rounds, waiting on VectorPay: proof message v2, VectorPay-computed fee, webhook timestamp, 0% merchant-fee verification.

## §5 Hosting
No hosting change. BeeKeeper still runs on the same hosting behind `https://beekeeper.money` with the same origins, CSP, CORS and workflows.
