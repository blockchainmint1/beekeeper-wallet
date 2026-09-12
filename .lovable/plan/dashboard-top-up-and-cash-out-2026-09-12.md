# Dashboard Top Up and Cash Out

## Goal
Add the two requested actions directly below the expanded balance area on `/dashboard`:

- **Top up** — visible but disabled for now.
- **Cash out** — opens a BeeKeeper-styled, guided VectorPay handoff.
- Hide both actions from iOS builds under the existing exchange-feature rule.

## User flow
1. Choose **Cash out**.
2. Enter an amount from $25–$1,000.
3. Choose **TSD on TEXITcoin** or **USDC on Base**.
4. Enter legal name and email.
5. Review the 1% fee, estimated bank payout, settlement timing, and required disclosures.
6. Create the signed order and continue to VectorPay for identity verification, bank linking, and payout.
7. Return to a BeeKeeper order page showing the local order reference and known status.

## Implementation
- Add a compact dashboard action row below the balance breakdown and above NectarPay.
- Build the cash-out wizard as a focused sheet/dialog using existing BeeKeeper controls and honey styling.
- Derive the selected wallet balance in the dashboard, prevent cash-outs above the available amount, and never ask the customer for a treasury destination.
- Add a thin server function that validates order fields and imports the server-only VectorPay relay inside its handler.
- Serialize the order once, HMAC-sign those exact bytes, and validate that returned checkout links use HTTPS and an approved VectorPay host.
- Generate stronger unique order references and reuse the same reference for retries.
- Store a privacy-minimized local order record per wallet so the return page works without storing bank details or identity documents.
- Add `/wallet/order/$id` with unique page metadata and graceful handling for unknown references.
- Keep Top up disabled and non-interactive until its flow is approved.

## Safety and platform rules
- BeeKeeper never handles Plaid credentials, bank credentials, or identity documents.
- Cash-out uses configured treasury addresses only: TSD on TEXITcoin and USDC on Base.
- Validate chain, asset, amount, address, return origin, response status, and checkout URL server-side.
- Do not expose the shared signing secret or treasury addresses to the browser.
- Hide the buttons and order entry points when exchange features are disabled, including iOS builds.
- Do not add a webhook yet; local status will remain “Continue at VectorPay” until webhook storage is designed.

## Required secure settings
Before Cash out can create a live order, configure:

- `BEEKEEPER_WEBHOOK_SECRET` — the shared signing value also configured in VectorPay.
- `VECTORPAY_ORDER_WEBHOOK_URL` — VectorPay’s BeeKeeper order endpoint.
- `CASHOUT_DEPOSIT_ADDRESSES` — JSON containing protected `txc` and `base` treasury addresses.

Until all three are present, Cash out will be visibly unavailable with a concise setup message.

## Verification
- Check amount limits, fee math, both supported assets, retries, provider errors, and invalid checkout URLs.
- Verify dashboard placement and wizard layout at desktop and mobile sizes.
- Verify a normal build succeeds.
- Run the iOS build and confirm all Top up/Cash out entry points are absent.
