# BeeKeeper Wallet: reply to the round-6 sign-off (2026-11-20)

## 1. The four public-copy edits (§3)
| # | Item | Done |
|---|---|---|
| 1 | `.env` not git-ignored | `make-public-copy.sh` now appends `.env`, `.env.*` and `!.env.example` to the copy's `.gitignore`. The private repo keeps `.env` tracked because Lovable Cloud generates and manages it, and it holds publishable values only. |
| 2 | `CAPACITOR.md`, `ANDROID.md` stale | Both are left out of the public copy (added to the script's private list). The one script comment that pointed at `ANDROID.md` now reads as a legacy note. |
| 3 | `package.json` name and licence | `"name": "beekeeper-wallet"`, `"license": "MIT"`. The `bun.lock` workspace name was updated to match so `--frozen-lockfile` still passes. |
| 4 | Comment pointing at `AGENTS.md` | `src/lib/native/capabilities.ts` comment rewritten (web-only, harmless switch). |

README wording: "every change ships only after one" was removed. The static test-count badge is now a neutral "tested with Vitest" badge, and the test table no longer shows a count.

## 2. Deployment gate: VectorPay's answer to a second code (§2)
We read VectorPay's own link handler (`src/lib/account/links.server.ts`, VectorPay commit `1e6bbdf3`). In `redeemLinkCode`, when the `account_ref` is already linked to the **same** VectorPay user who issued the code, it reuses the existing link, marks the code used and returns `ok: true`. The handler then replies with `linkReply`, which returns `linked: true` plus the bank mask. So `mayClaimAfterRedeem` is true and the merchant's wallet claims its ID. A code from a **different** VectorPay user returns `409 wallet_linked_to_another_account`, and BeeKeeper refuses it. Confirmed from source, not yet exercised end to end against VectorPay's live endpoint.

## 3. Recommended follow-up: owner check on order creation (§2) — done
`startVectorPayCashout` now requires an `owner` proof and checks it before anything else, including the per-customer rate limit:

- **What is signed.** The wallet's TXC holder key (bip44 0/0) signs `orderOwnerMessage` (`src/lib/cashout/proof.ts`): `BeeKeeper cash-out order` / `account:` / `order:` / `address:` / `nonce:` / `time:`. The first line differs from the bank lookup, so a lookup signature can't be replayed as an order. The message names the exact customer ID and order reference.
- **What the server checks.** `checkOrderOwner` (exact text, 5-minute freshness, BIP-137 signature), then a single-use nonce guard, then `readAccountOwner(customerId)` (fails closed). `ownerDecision(..., "lookup")`: `other-wallet` is refused; `unclaimed` is refused with `needsConfirm: true` (the wallet clears its local link and shows the code box; no coins have moved because the pre-send order is the first call); only `ok` proceeds to the limiter, transfer proofs and chain settlement.
- **Why before the limiter.** Someone holding a leaked customer ID can no longer use up the real merchant's six attempts per 10 minutes.
- **Wallet side.** `CashoutActions.submitOrder` signs a fresh owner proof inside every call, including the ~5-minute confirmation re-checks (`signOrderOwner` in `src/lib/cashout/sign-lookup.ts`).
- **Old open tabs.** A request with no owner proof is refused with "reload and try again".
- **Tests.** 7 new cases in `proof.test.ts` (accepted; wrong order; wrong ID; lookup signature reused; expired; other key; missing) and 2 in `account-owner.test.ts`. Live check against the preview with a throwaway key: unclaimed ID → `needsConfirm`; claimed ID + other key → refused; claimed ID + owner key → passes to the transfer-proof check; replayed proof → refused; no proof → refused. The temporary owner row was removed afterwards.
- **Effect on merchants.** Only 2 customer IDs are claimed today; every other linked merchant enters one fresh VectorPay code before their next cash-out (VectorPay accepts a second code from the same account, §2).

## 4. Public copy
Rebuilt with the script: 387 files, the private-path check passes, and `.gitignore` lists `.env`. 120 tests pass, the typecheck is clean, and the build is OK.
