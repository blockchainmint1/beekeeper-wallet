# Bridge top-ups: going live

Top-ups run on Bridge's **sandbox** today (key `BRIDGE_API_TEST`, starts with `sk-test`).
The test flow was run end to end on 2026-11-11: test customer → test approval → deposit
account → $50 test deposit, with a $1.50 (3%) fee.

## Steps to go live

1. **Bridge approves the business.** Finish Bridge's business onboarding in the Bridge
   dashboard so live keys are allowed.
2. **TSD delivery is connected.** The TSD bridge provides a per-customer mint address
   (docs/tsd-mint-address-request.md). Until then, BeeKeeper will **not** open live deposit
   accounts. The server refuses on purpose, so no live USDC goes to the wrong place.
   Wire it into `destinationFor()` in src/lib/bridge/topup.functions.ts.
3. **Live key.** Save the live key as the secret `BRIDGE_API_KEY`. It takes priority over
   the sandbox key. The environment follows the key's prefix automatically.
4. **Webhook.** In Bridge, create a webhook for
   `https://beekeeper.money/api/public/bridge/webhook` with the `virtual_account` and
   `transfer` categories. Copy the webhook's public key into the secret
   `BRIDGE_WEBHOOK_PUBLIC_KEY`, then enable the webhook. Do the same separately in the
   sandbox if you want test events.
5. **Clean-up.** The sandbox key is saved twice (`bridge_api_test` and `BRIDGE_API_TEST`).
   Only `BRIDGE_API_TEST` is used, so the lowercase one can be deleted.

## How it is wired

- Fee: 3%, set as Bridge's `developer_fee_percent` on each deposit account (src/lib/bridge/fees.ts).
- Every top-up call is signed by the wallet's TEXITcoin holder key, and the Bridge record
  is keyed by that address (src/lib/bridge/topup-proof.ts).
- Stored: only Bridge reference IDs and the delivery address (`topup_customers`) and
  signed webhook events (`topup_events`). No names, emails or ID documents.
- The deposit history is read live from Bridge's virtual-account activity.

## Turn on the Top up button
- Set `TOPUP_LIVE = true` in `src/lib/bridge/visibility.ts`. Until then beekeeper.money shows "Top up · soon"; only the preview runs the sandbox flow.
