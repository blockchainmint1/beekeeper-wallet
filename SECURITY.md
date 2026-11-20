# Security policy

BeeKeeper Wallet is a self-custody wallet that moves real money, so we take
reports seriously and thank everyone who sends one.

## Reporting a problem

Email **help@honest.money** with "BeeKeeper security" in the subject.
Please do **not** open a public GitHub issue for a security problem.

Helpful to include:

- what you found and where (page, server route or file),
- steps to reproduce, or a proof of concept,
- what an attacker could do with it.

Never include anyone's recovery words, private keys or real customer data.

## What to expect

- We reply to confirm we have your report as soon as we can.
- We keep you posted while we fix it and tell you when the fix is live.
- We ask that you give us a reasonable time to fix it before talking about it
  publicly. We are happy to credit you once it is fixed.

## In scope

- The web wallet at <https://beekeeper.money> and the code in this repository.
- Anything that could expose a seed, key or password, move funds without the
  owner's approval, credit a cash-out or top-up to the wrong person, or reveal a
  customer's bank details.

## Out of scope

- Our partners' own services (VectorPay, Bridge, NectarPay, TSD): report those
  to them directly.
- Losing access to a wallet whose recovery words or password were lost.
- Reports that need a phone or computer already taken over by an attacker.
- Missing best-practice headers or settings with no realistic way to exploit them.

Please test only with your own wallets and small amounts, and never against
other people's funds or data.
