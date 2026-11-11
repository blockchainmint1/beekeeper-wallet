# Request to the TSD bridge team: a permanent mint address per T… address

**From:** BeeKeeper (beekeeper.money)
**For:** TSD bridge (tsd.honest.money)
**Date:** 2026-11-11

## Why

BeeKeeper is adding bank top-ups through Bridge (bridge.xyz, Stripe's stablecoin
company). Each BeeKeeper customer gets a permanent US bank account in their own name.
When dollars land there, Bridge takes BeeKeeper's 3% fee, converts the rest to
**USDC on Base**, and sends it to **one fixed address that we choose for that customer**.
Every deposit goes there automatically, for as long as the account exists.

We want customers to receive **TSD**, not USDC. So the fixed address has to be a
TSD bridge deposit address that mints TSD 1:1 to that customer's TEXITcoin address.

## What we need

A persistent, reusable Base USDC deposit address bound to one legacy `T…` address:

```
POST https://tsd.honest.money/api/public/v1/mint/deposit-address
Authorization: <partner key issued to BeeKeeper>
{ "txc_address": "T…", "chain": "base", "asset": "USDC" }

200 { "deposit_address": "0x…", "txc_address": "T…", "chain": "base", "asset": "USDC" }
```

Requirements:
- The same `txc_address` always returns the same `deposit_address`. Calling it twice is safe.
- **Any** USDC that arrives at that address, at any time and in any amount, mints the same
  amount of TSD to `txc_address`. Bridge sends many separate deposits to the same address
  over months.
- No minimum above Bridge's own ($1 after our fee). If you need one, tell us and we'll
  show it on the top-up screen.
- `txc_address` must be a legacy `T…` address (Omni can't read bech32). BeeKeeper always
  sends the wallet's m/44'/696969'/0'/0/0 holder address.
- Optional but helpful: a status lookup (`GET …/mint/deposits?deposit_address=0x…`) or a
  signed webhook, so BeeKeeper can show "TSD delivered" with the TXC txid.

## What BeeKeeper does on its side

- Asks your endpoint for the address once, when the customer's Bridge account is created.
- Uses it as the Bridge destination (`payment_rail: base`, `currency: usdc`).
- Never holds customer funds. Bridge → your vault → TSD to the customer.

## The alternative, if a per-customer address isn't possible

One shared vault address, plus a signed server-to-server message from BeeKeeper for each
Bridge delivery: "Base tx 0x… (N USDC) belongs to T…". BeeKeeper would get those tx hashes
from Bridge's signed webhooks. It works, but your side then has to trust BeeKeeper's
attribution, so we prefer the per-customer address.

## Unverified

The public site shows the stablecoin → TSD direction marked "Coming soon". Please confirm
whether minting from Base USDC is live.
