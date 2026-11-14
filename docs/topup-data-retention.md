# Top-up data: what we keep and how to delete it (round-4 audit B9)

## What BeeKeeper stores
- `topup_customers`: the wallet's TXC holder address, the test/live flag, the Base address, Bridge reference IDs (customer, KYC link, deposit account) and the delivery address. No name, email, ID document or bank details.
- `topup_events`: Bridge webhook events, reduced to IDs, amounts, fee and the destination tx hash. The raw payload is no longer kept, because it can carry sender bank details.
- `cashout_account_owners`: VectorPay customer ID → TXC holder address. Nothing else.

Name and email typed into the Top up form go straight to Bridge and are never saved by BeeKeeper. Bridge, and its ID-check provider, hold the KYC data under their own retention rules.

## Deleting someone's data on request
1. The person proves which wallet they hold, for example by signing a message with the wallet's TXC holder address.
2. Delete their `topup_customers` row(s) for that address, their `topup_events` rows (matched by `virtual_account_id`) and any `cashout_account_owners` row for that address.
3. Ask Bridge, through the Bridge dashboard or support, to delete the customer and their KYC data. Bridge may have to keep some records by law.
4. Removing a wallet on the device ("Delete wallet") only affects that device. It doesn't touch server rows, so the steps above are needed.

## Retention
- Keep rows only while the deposit account is open, plus whatever bookkeeping period the business needs (to decide). Delete on request as above.
