# Going public — my read of the auditor's report (Nov 20)

**Short version:** the auditor is right that we shouldn't flip the switch yet, but the gap is small. Every round-4 fix checked out. No passwords or keys have ever been saved in the code. What's left is one real bug, some tidying, and a few choices only you can make.

## What I checked myself today

- **Every past save (1,695 of them) scanned for leaked keys:** nothing real. The 16 hits are the public sign-in key that every visitor's browser already gets, plus labels like "hme.chain-order" that only look like keys.
- **Save notes:** no secrets, but a handful contain terminal output pasted from your Mac (your computer name and folder paths). The history also carries the whole HME Wallet past that BeeKeeper was copied from.
- **README:** already fixed. The auditor's copy was made before we rewrote it.
- **The repository is still private**, so nothing is "overdue".

## The one real bug (auditor is right)

When a wallet checks its VectorPay status, the first wallet to ask about a customer ID becomes its owner for good. If someone got hold of a merchant's ID, they could ask first and lock that merchant out of cash-out. I also found a second hole the auditor missed: even the "link" step claims the ID *before* VectorPay confirms the code is real, so a made-up code would work too.

**Fix:** only a real, VectorPay-confirmed link code claims an ID. A status check for an unclaimed ID just says "linked, please confirm once" and doesn't show bank details.
**Cost:** merchants who linked before Nov 14 enter one fresh code from their VectorPay dashboard. Only 2 wallets are claimed today, so very few people are affected.

## Going public: three ways to do it

1. **A separate, clean public copy (my pick).** One fresh save with just the app code, README, licence and security contact. No audit reports, no roadmap, no plans, no history. We keep working in the private one.
2. **Make this repository public after cleanup.** The full history, terminal pastes and old audit reports would come along.
3. **Stay private.** Nothing to do.

## Things I can do safely whenever you say go

- Lock the GitHub build steps to exact versions and give the old Android build only the access it needs (the auditor's "pinned actions" item). No effect on the app.
- Turn on automatic dependency update alerts.
- Write a SECURITY file that tells researchers how to report a bug (needs an email from you).

## Things I'd skip or leave as they are

- **Removing the settings file (.env) from the code:** it only holds public values and Lovable manages it. I'd leave it in the private copy and simply not include it in a public copy.
- **Hiding how the server works:** normal for open source, and nothing in it relies on being secret. Your call, but not a blocker.
- **Secret scanning, push protection, branch protection on GitHub:** these are switches in GitHub's settings that you flip (I can't reach them). Five minutes, worth doing.

## Your decisions

- **Five-tap Top up:** once the code is public, anyone can read the trick. It still only opens the practice version, and real ID checks stay off until TSD delivery is connected, so it's low risk. I'd remove it from a public copy, or remove it altogether.
- **Licence:** "all rights reserved, source available" means people can read it but not reuse it. MIT or Apache means anyone can reuse it.
- **Security contact email:** I won't make one up.

## Still waiting on others (unchanged)

VectorPay: proof message v2, fee computed on their side, webhook timestamp, bank-linking rule, 0% merchant fee check. TSD team: mint address. Bridge: one test notice to confirm the signature.
