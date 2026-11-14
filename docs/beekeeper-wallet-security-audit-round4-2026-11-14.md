# BeeKeeper Wallet — Round 4 Review (`beekeeper-wallet_4.zip`)

Date: 2026-11-14
Baseline: the round-3 package (`beekeeper-wallet_3.zip`) and my round-3 report (N1–N4).
Method: full diff (7 files changed, 12 added), line-by-line review of the new Bridge top-up feature, re-check of the round-3 items. Static only; the 16 test files were not executed here. I tried to confirm Bridge's webhook signature scheme against its public docs; the documentation URLs returned 404, so that point stays unverified.

## 1. Verdict

This package adds a new money path, a fiat top-up through Bridge (bridge.xyz): the customer completes Bridge's KYC, receives a permanent US bank account, and deposits are meant to arrive as TSD. The implementation is careful in the places that matter most: every call is signed by the wallet's holder key and bound to the action, both delivery addresses, a nonce and a timestamp; the two new tables are service-role only with row-level security and no client policies; the Bridge API key never leaves the server; the environment follows the key prefix; and live deposit accounts are refused until a TSD delivery address exists. Nothing here moves customer funds yet, because delivery is not wired.

Two things need attention before the next publish, and two of them are carried over from round 3:

1. **The round-3 blockers are untouched.** The per-customer cash-out limiter still trips the client's own confirmation polling (N1), so Ethereum cash-outs will fail to confirm on the first pass, and the bank-mask lookup signature still does not prove ownership of the customer ID (N2). The roadmap now files N2 under "waiting on VectorPay"; it can be fixed on BeeKeeper's side, see §2.
2. **The hidden five-tap unlock exposes the top-up flow on the production site.** Today that opens Bridge's sandbox with real names and emails typed in; the day `BRIDGE_API_KEY` is set it would run live KYC from production while the feature is still officially "soon". Separately, live KYC can already start before delivery exists, because only the deposit-account step is gated.

The message says the project "moved to our secure environment". Nothing in this package reflects a hosting change (origins, CSP, CORS, workflows and the `.lovable/` directory are unchanged), so I could not assess it. §5 lists what to confirm after a move.

## 2. Round-3 items

| ID | Finding | Status |
|----|---------|--------|
| N1 | Per-customer limiter (6 per 10 min) blocks the client's 15-second confirmation polling under the 12-confirmation rule | **Unchanged.** `vectorpay.functions.ts:12,90`, `CashoutActions.tsx:570-572`. Exempt re-checks of an existing reference and lengthen the poll window. Fix before publish. |
| N2 | Bank-mask lookup signature not bound to the customer ID | **Unchanged.** Roadmap reframes it as waiting on VectorPay. It is not: `redeemVectorPayLink` is authenticated by the one-time code, so BeeKeeper can store `account_ref → identity address` there and require that signer on lookups. The same `topup_customers` pattern (service-role table keyed by address) now exists in this very package and could hold the mapping. |
| N3 | Budget exhaustion reported as a non-retryable error | Unchanged. |
| N4 | `.env` in the package | Still present (publishable key only). |

## 3. Bridge top-up review

### What is done well

- `checkTopupProof` binds action, holder address, Base address, nonce and time; a signature for `status` cannot be reused for `simulate-deposit`, and swapping the Base address breaks it (`topup-proof.ts`, tests).
- `topup_customers` and `topup_events`: `REVOKE ALL` from anon and authenticated, RLS enabled, no policies, service-role only (`0001_topup_bridge_tables.sql`).
- `client.server.ts` is only reached by dynamic import inside handlers; `redirect: "error"`, 20-second timeout, idempotency keys on POSTs; the environment is chosen by key prefix so a sandbox key can never reach the live API.
- `destinationFor("live")` returns null, so no live deposit account can be created until a TSD mint address exists.
- Name and email are passed to Bridge and not stored; bank details are copied with a two-minute clipboard auto-clear; KYC links open with `noopener noreferrer`.
- The webhook refuses everything when `BRIDGE_WEBHOOK_PUBLIC_KEY` is unset, caps the body, requires a signature within ten minutes, and inserts events idempotently.

### B1. Hidden five-tap unlock on the production site (Medium)

`visibility.ts:24-31` and `CashoutActions.tsx:199-206,668-671`: five taps within 2.5 seconds on "Top up · soon" open the full flow on `beekeeper.money`. The gesture is documented in the public repository and the roadmap. Consequences: today, merchants who find it type real names and emails into Bridge's sandbox; once a live key is saved, the same gesture runs real Bridge KYC and creates live Bridge customers from the production site while `TOPUP_LIVE` is still false. Replace it with an explicit server-side allowlist (for example a `TOPUP_TESTERS` list of holder addresses checked in `open()`), or remove it before the live key is saved.

### B2. Live KYC can start before delivery exists (Medium)

`startTopupKyc` creates a Bridge KYC link and customer whenever a key is configured; only `buildStatus` checks `destinationFor` and refuses the deposit account. With a live key, customers would complete real identity verification and then be told "Live top-ups switch on once TSD delivery is connected". Gate `start` on the same condition as the deposit account, so no live KYC data is collected before the product can deliver.

### B3. Webhook payloads may store sender bank details (Medium-Low, privacy)

`bridge.webhook.ts:57` stores the entire event as `payload` JSONB. Bridge virtual-account activity events carry a `source` block that can include the sender's name and bank routing details. That contradicts the migration comment "no name, email or ID data is stored" and the go-live note. The handler already extracts every field the app uses; drop `payload`, or strip `source` and any `sender_*` keys before storing.

### B4. Webhook signature scheme unverified (Low, go-live check)

`webhook.ts:48-50` assumes Bridge signs `SHA-256(SHA-256("t.body"))` with RSA PKCS#1 v1.5; the unit test reproduces that assumption rather than checking it against Bridge. I could not reach Bridge's documentation to confirm. If the assumption is wrong, every delivery is rejected with 400 and Bridge eventually disables the endpoint; nothing acts on webhook data today, so this is a functional risk, not a security one. Confirm with one real sandbox delivery before enabling the live webhook.

### B5. Signed requests are replayable for five minutes (Low)

The proof carries a nonce, but the server does not remember nonces. A captured `status` or `history` request can be replayed for five minutes to read the bank account details; writes are idempotent. Keep a short-lived set of seen nonces per address (in memory per isolate is acceptable), or shorten the window to one minute.

### B6. KYC link creation is not idempotent across a double submit (Low)

`startTopupKyc` posts to `/kyc_links` with a random idempotency key; two concurrent submits create two Bridge customers and the upsert keeps only the second. Use `bk-kyc-${env}-${address}` as the key, as the deposit-account call already does with `bk-va-…`.

### B7. A read action creates a Bridge resource (Low)

`buildStatus` creates the virtual account when a `status` request finds an approved customer without one. Since actions are bound into the signature, use a distinct `create-account` action for that step so a replayed read can never create a resource.

### B8. When TSD delivery is wired (Info)

`destinationFor` will call the TSD bridge for a per-customer mint address. Pin the TSD host (reuse `TSD_TRUSTED_HOSTS`), require the response to echo the same `txc_address`, store the address with the row, and treat the partner key as a server secret with its own rotation note. Once set, every future deposit mints to that T address for the life of the Bridge account; that is correct for a seed-based wallet but should be stated in the UI.

### B9. Data-subject rights (Info)

There is no path to delete a customer's Bridge record or KYC data from BeeKeeper, and "Delete wallet" on the device does not touch the server-side row. Document the retention and deletion process before live KYC starts.

### B10. More third-party explorers (Info)

`utxo.$coin.$.ts` adds three public Blockbook instances (atomicwallet, zelcore, guarda) as BTC failover. Address queries and broadcasts now reach more operators; acceptable, but they are unknown parties on the broadcast path.

## 4. Order of work

1. N1 (functional break of Ethereum cash-outs) and B1 (hidden unlock) before the next publish.
2. B2 before any live Bridge key is saved; B3 before the live webhook is enabled; B4 with one sandbox delivery.
3. N2 on BeeKeeper's side, B5–B7.
4. N3, N4, B8–B10 as they come up.

## 5. If hosting changed

Nothing in the package shows it, so confirm on the deployment itself: all server secrets present (`BEEKEEPER_WEBHOOK_SECRET`, `VECTORPAY_ORDER_WEBHOOK_URL`, `CASHOUT_*`, `ALCHEMY_KEY`, `TXC_RPC_*`, `BRIDGE_*`, `SUPABASE_SERVICE_ROLE_KEY`); `NODE_ENV=production` so the security headers and CSP are emitted; the served hostname equals `PROD_ORIGIN`; the VectorPay and Bridge webhook URLs point at the new host; the service-role key is reachable only by server code; `.env` with secrets is not deployed or committed; and `security.yml` still runs on the new repository.

## 6. Not verified

- The test suite and typecheck were not executed here.
- Bridge's webhook signature format (documentation unreachable) and the exact contents of Bridge activity events.
- Anything about the new hosting environment.
