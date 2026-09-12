# Separate dashboard from full wallet

## Goal
Make the first screen after unlock a simple BeeKeeper dashboard, while restoring the complete pre-remix wallet interface at `/wallet`.

## Changes
- Add `/dashboard` as the post-unlock destination.
- Move the current cross-chain summary logic to the dashboard.
- Redesign the dashboard order as:
  1. Large, unframed total balance
  2. Expandable wallet breakdown directly beneath it
  3. A clearly bordered “Link to Nectar Pay” tile
  4. A “Continue to wallet” link with a right arrow
  5. One combined, newest-first transaction list across supported chains
- Keep wallet selection and transaction details available from the dashboard, but remove the full-wallet controls and Send/Receive bar from this summary screen.
- Restore `/wallet` to the detailed wallet experience from immediately before the recent dashboard redesign, including wallet tiles, chain controls, token tools, and Send/Receive actions.
- Update successful unlock, onboarding, profile import, and relevant “done” destinations to open `/dashboard`; keep operational wallet pages returning to `/wallet` where that is the natural full-wallet destination.
- Add unique metadata for `/dashboard` and preserve `/wallet` metadata.

## Technical details
- Create a dedicated dashboard route under the existing authenticated wallet layout so it retains the shared header, scanner, profile switcher, and lock behavior.
- Reuse the current balance and normalized activity calculations rather than introducing new storage or network behavior.
- Recover the detailed `/wallet` view from repository history, then preserve newer chain fixes and data integrations where needed.
- Keep all exchange/swap controls behind the existing iOS capability gates.

## Verification
- Confirm unlock and first-time activation land on `/dashboard`.
- Confirm the dashboard matches the requested visual hierarchy on mobile and desktop.
- Confirm “Continue to wallet” opens the full detailed wallet.
- Confirm combined activity, breakdown, Nectar Pay linking, wallet details, Send/Receive, and existing child wallet pages still work.
- Run focused type checks, the development build, and browser checks with no new runtime errors.
