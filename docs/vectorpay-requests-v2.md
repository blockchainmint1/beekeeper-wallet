# Note for VectorPay — one bundle of changes (v2)

**From:** BeeKeeper Wallet
**Date:** Nov 11, 2026
**Replaces:** "Please verify the NectarPay merchant before giving 0%" (Nov 11, v1)

Our security auditor reviewed how BeeKeeper and VectorPay hand cash-out orders
to each other. A few of the remaining fixes have to happen on your side, or on
both sides together. They're grouped here so you only have to change things once.

## 1. Merchant fee (0% vs 1%): you decide, not the wallet

Today, when a wallet is linked to a NectarPay store, BeeKeeper sends
`merchant_ref` and also sets `fee_bps: 0`. Nothing checks that merchant ID.

Please:

1. Ignore `fee_bps` / `fee_usd` from BeeKeeper. Work out the fee yourself.
2. Give 0% only when NectarPay confirms that `merchant_ref` is a real, active
   merchant **and** that this BeeKeeper customer (`account_ref`, the `bk_…` ID)
   or one of the sending addresses (`transfers[].from_address`) belongs to it.
3. If you can't confirm it, charge 1% and say so on checkout.

Once you confirm you compute the fee, BeeKeeper will stop sending `fee_bps`.

**Long term:** at link time NectarPay could sign a short token
`{merchant_id, identity_address, exp}` with its key. BeeKeeper would forward
it on every order, and you'd check it without calling NectarPay each time.
Until then, checking with NectarPay directly is fine.

## 2. Tie each proof to the customer (proof message v2)

Each transfer's signed proof covers the order reference, chain, asset,
sender, deposit address and txids. It doesn't cover **who gets paid**
(`account_ref`). Someone who got hold of a finished order payload could resend
it under a different customer ID with the same reference.

Proposal (both sides switch together):

```
BeeKeeper cash-out proof v2
order: <reference>
account: <account_ref>
merchant: <merchant_ref or "-">
chain: <chain>
asset: <asset>
from: <from_address>
to: <deposit address>
txids: <comma-separated>
```

Please also **reject any order whose reference was seen before with a different
`account_ref`.** Tell us when you can accept v2. We'll send v2 and keep v1
accepted for a short overlap.

## 3. Webhook replay protection

On `POST https://beekeeper.money/api/public/vectorpay-order-status`, please add a
signed timestamp header (for example `X-VectorPay-Timestamp`, unix seconds).
Sign `timestamp + "." + body` instead of just the body. We'll reject anything
older than 5 minutes. We'll accept both formats during the switch.

## 4. Please confirm in writing what we rely on

BeeKeeper now checks every amount against the blockchain before it signs an
order. It counts only **mined, successful** transfers of the **official**
USDC/USDT contracts, plus TSD (Omni property 39), sent from the signed address
to your deposit address. VectorPay is still the last line of defence. Please
confirm:

1. **Each txid is used once, across all orders, forever.**
2. You credit a transfer only after checking on chain that:
   - EVM: it called the official token contract for that chain, the receipt
     status is success, and its `Transfer` log pays your deposit address.
   - TSD: property id 39, Omni Core says `valid: true` **after it confirms**, the
     reference output is your deposit address, and the sender matches the signed
     `from` address.
3. Your **confirmation depth** before payout on each chain (Ethereum, Base, BNB,
   TEXITcoin).
4. You pay out only what actually landed, never the amount on the order.

## 5. Small items

- The link record is now stored per wallet. If a merchant has two wallets in
  BeeKeeper, each one keeps its own VectorPay link and `bk_…` customer ID.
  That's expected.

## Reply we need

- Fee: "we compute it" + which merchant check you'll use (NectarPay lookup or signed token).
- Proof v2: yes/no + a date.
- Webhook timestamp: header name + a date.
- Written confirmation of the four points in section 4.
