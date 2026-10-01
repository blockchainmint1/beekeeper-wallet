# BeeKeeper → VectorPay cash-out: deposit attribution

BeeKeeper sends every customer's stables to **one VectorPay deposit address per
chain** (`CASHOUT_DEPOSIT_ADDRESSES`). VectorPay credits a deposit to an
order only when it can verify that the order owns it. Amounts are never used for matching.

## What arrives on the order webhook

`transfers[]` now carries, for each send:

| field | meaning |
|---|---|
| `chain` | `eth`, `base`, `bsc` or `txc` |
| `asset` | `USDC`, `USDT` or `TSD` |
| `usd` | wallet's estimate (informational only) |
| `asset_amount` | token amount the wallet sent (informational only) |
| `destination_address` | VectorPay deposit address for that chain |
| `from_address` | address that sent the funds |
| `txids` | transaction hashes (always present for EVM; may be empty for TSD) |
| `proof_message` | exact signed text (see below) |
| `proof_signature` | signature over `proof_message` by `from_address` |

## Signed message (UTF-8, `\n` line breaks, no trailing newline)

```
BeeKeeper cash-out proof
order: <reference>
chain: <chain>
asset: <asset>
from: <from_address>
to: <destination_address>
txids: <txid1>,<txid2>
```

## VectorPay must check, per transfer

1. Rebuild `proof_message` from the fields and require an exact match (including `order` = this order's `reference`).
2. Verify the signature:
   - **EVM**: EIP-191 `personal_sign`. Use `viem.verifyMessage({ address: from_address, message, signature })` or ethers `verifyMessage`.
   - **TXC (TSD)**: Bitcoin-style compact signature (base64), message prefix `"\x1aTEXITcoin Signed Message:\n"` (0x1a length byte), legacy P2PKH address. Use bitcoinjs-message with the TEXITcoin prefix.
3. For each txid, read the chain yourself and confirm that it's a token transfer of `asset` **from `from_address` to your deposit address**. Credit the **on-chain amount**, never `usd` or `asset_amount`.
4. Store each txid as used and reject any txid already credited to another order.
5. **TSD with no txids**: credit unclaimed TSD transfers from `from_address` to the TXC deposit address that were seen after the order was created. Only a signed `from_address` can claim them.
6. Failed sends are left out of the order. A transfer that never lands is simply not credited.

Signatures prove that the person submitting the order controls the sending address, so nobody can claim someone else's deposit by guessing its amount or txid.
