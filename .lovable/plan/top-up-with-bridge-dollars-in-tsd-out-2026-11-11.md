# Top Up with Bridge — dollars in, TSD out

## What the customer sees

```text
Dashboard → Top Up
  1. First time only: "Get your personal deposit account"
     - Enter name + email (sent to Bridge only, to start their ID check)
     - Open Bridge's terms page, then Bridge's ID-check page
     - BeeKeeper shows "Checking your ID…" until Bridge approves
  2. Approved: "Your BeeKeeper deposit account"
     - Bank name, routing number, account number, name on account (copy buttons)
     - "Send dollars from your bank by ACH or wire. They arrive as TSD in this wallet, minus 3%."
  3. Top-up history: Received → Converting → TSD delivered (with links to the chain)
```

The account number is permanent, so the customer can save it in their own bank as a payee and top up any time without opening BeeKeeper.

## How the money moves

```text
Customer's bank --ACH/wire--> Bridge account in their name
Bridge --takes 3%--> turns the rest into USDC on Base
USDC on Base --> TSD bridge vault (tsd.honest.money)
TSD bridge --mints 1:1--> TSD to the customer's BeeKeeper T... address
```

## The one open piece: turning USDC into TSD

Bridge can only send USDC to one fixed address per customer. The TSD bridge has to know which customer each deposit belongs to. Three ways to do that:

- **A. A permanent TSD mint address for each customer (recommended).** The TSD bridge gives each T... address its own Base USDC deposit address. Bridge sends there, and TSD gets minted automatically. BeeKeeper never holds anyone's money. This needs one new feature on the TSD bridge side.
- **B. One shared vault, matched by transaction.** BeeKeeper tells the TSD bridge "this Bridge delivery belongs to T... address X", with a server signature. It works, but the TSD bridge has to trust BeeKeeper's word.
- **C. BeeKeeper holds a TSD stockpile and sends TSD itself.** This is the fastest to build, but BeeKeeper's server would hold a hot wallet with real money in it. Not recommended.

I'll write a handoff note for the TSD bridge team asking for option A. I couldn't find the TSD bridge project in this workspace, so you'll need to forward it.

In the meantime, sandbox test top-ups go to the customer's own Base address in BeeKeeper. That's harmless, because no real money moves in the sandbox. Switching to the TSD mint address is a one-line change once option A exists.

## What gets built now (sandbox)

1. **Top Up button turned on.** It opens the new top-up screen, with steps 1 to 3 above.
2. **ID-check start.** This creates Bridge's hosted terms and ID-check links from the name and email. The links open in a new tab, and BeeKeeper keeps checking the status. Test mode adds an "Approve me (test)" button that uses Bridge's sandbox approval.
3. **Deposit account.** This creates the customer's permanent US account once approval comes through, with the 3% fee set on it.
4. **Deposit tracking.** Bridge reports each deposit to a new BeeKeeper address, and the history list reads from those reports. Test mode adds a "Simulate a $50 deposit" button.
5. **Locked down.** Bank details only show after the wallet signs the request, using the same rule as cash-out bank details. BeeKeeper stores only Bridge's reference numbers, never the name, email or ID documents.
6. **Handoff notes.** One note for the TSD bridge team (option A). One for going live with Bridge: live key, webhook key, and Bridge's approval of your business.

## Not included
- Debit cards or Apple Pay. Bridge does bank transfers only.
- Euro or other currencies. Bridge supports them, so they can be added later.
- Any swap screen. TSD minting happens behind the scenes.

## Technical details
- New tables (Lovable Cloud, RLS on, no client policies; server-only access after a wallet-signature check): `topup_customers` (account_ref = wallet-derived bk_ id, bridge_customer_id, kyc_link_id, virtual_account_id, destination address/rail, env) and `topup_events` (bridge event id unique, virtual_account_id, type, amounts, developer fee, destination tx hash, raw JSON).
- `src/lib/bridge/client.server.ts`: fetch wrapper with `Api-Key`, `Idempotency-Key` on POSTs, base URL picked by key prefix (`sk-test` → api.sandbox.bridge.xyz, else api.bridge.xyz). It reads `BRIDGE_API_TEST` now and `BRIDGE_API_KEY` for live. The duplicate lowercase `bridge_api_test` secret can be deleted.
- `src/lib/bridge/topup.functions.ts`: `startTopupKyc`, `topupStatus`, `createTopupAccount`, `topupDeposits`, plus sandbox-only `simulateKycApproval` and `simulateDeposit`. Each one checks a fresh wallet signature over its account_ref, using the `checkBankLookup` pattern in src/lib/cashout/proof.ts, and is rate limited per account_ref.
- Virtual account: `source.currency=usd`, `destination={payment_rail:"base", currency:"usdc", address}`, `developer_fee_percent:"3.0"`. Bridge enforces its minimum after the fee.
- `src/routes/api/public/bridge/webhook.ts`: verifies `X-Webhook-Signature: t=…,v0=…` (RSA over `t.body`, 10-minute timestamp window) with the `BRIDGE_WEBHOOK_PUBLIC_KEY` secret. It stores events idempotently by event id and returns no data.
- Fee constant and tests: 3% fee math, signature/timestamp checks, webhook verification, base-URL choice.
- Docs: `docs/tsd-mint-address-request.md`, `docs/bridge-go-live.md`; AGENTS.md rule for the Bridge boundary; roadmap updated.
