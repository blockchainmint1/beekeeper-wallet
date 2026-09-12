# Seeing and sweeping derived addresses on Ethereum, Base and BSC

Today the wallet only ever looks at **one** address per EVM chain — the first
one derived from your seed. Any money sent to the wallet's other derived
addresses (from the old wallet, from NectarPay payouts, from an exchange
withdrawal to a rotated address) is invisible and unspendable in BeeKeeper,
even though the seed controls it.

This plan adds an expandable address list on each EVM tile, plus the two
actions the standalone EVM Wallet already has: **fund** (send a little gas to
a derived address) and **sweep** (pull everything back to your main address).

## What you will see

1. On the Ethereum / Base / BSC tiles, a new row at the bottom:
   **"More addresses"** with a count and the combined extra balance.
2. Tapping it expands a list of derived addresses, **5 at a time**, each showing
   its index (#0, #1, #2 …), a shortened address, native balance, and any
   stablecoin balances (USDC / USDT / PYUSD). "Show 5 more" loads the next page.
3. A header line above the list: total combined balance across all scanned
   addresses, so the tile's headline number can finally match reality.
4. Each address with a balance gets **Sweep** (move funds to your main address)
   and, when it holds tokens but no gas, **Fund gas** (send just enough native
   coin from your main address so the token sweep can pay for itself).
5. A **Sweep all** button that walks every funded address in order: tokens
   first, native last (a token transfer needs gas at the source).
6. Copy-address and explorer links per row, so an address can be reused for a
   deposit.

Order of operations is enforced in the UI, because it is the thing people get
wrong: gas in first, tokens out, native out last.

## Where this happens in the code

**Derivation (new helper in `src/lib/chains/evm.ts`)**
`deriveEvmAccount(root)` is hardcoded to `m/44'/60'/0'/0/0`. Add
`deriveEvmAccountAt(root, index)` and `deriveEvmAddresses(root, count, offset)`
returning `{ index, path, address }`, keeping the existing function as
`index = 0` so nothing else changes. The reference project's
`src/lib/wallet/hd.ts` does exactly this shape.

**Batch balance scan (new `src/lib/chains/evm-scan.functions.ts`)**
Copy the Multicall3 approach from the reference project's
`src/lib/wallet/scan.functions.ts`: one `eth_call` to Multicall3
(`0xcA11bde05977b3631167028862bE2a173976CA11`, deployed on eth/base/bsc) with
`getEthBalance` + one `balanceOf` per token per address. 5–25 addresses per
call, so expanding a page is a single round trip. It runs as a server function
through the existing `/api/evm/$chain` proxy path, so no key handling changes.
Zero Chill has no Multicall3 — gate the feature to eth/base/bsc and fall back
to per-address `getBalance` calls if we ever want it there.

**Tile UI (`src/routes/wallet.index.tsx`, EVM tile section around lines 700–760
and the `EvmDetail` component near line 1960)**
Add an `EvmAddressList` component (own file under
`src/components/wallet/`), fed by a `useQuery` keyed on
`["evm-derived", chain, xpubFingerprint, pageCount]`. The tile keeps its
current headline; the expanded list is additive. The same component can be
reused inside `WalletDetailSheet`'s EVM section.

**Sweep + fund (new `src/lib/chains/evm-sweep.ts`)**
Reuse `sendEvmTransaction` in `src/lib/chains/evm-send.ts` — it already solves
the nonce-collision problem — with a wallet client built from
`deriveEvmAccountAt(root, index)`. Two functions:
- `sweepNative`: estimate gas, send `balance − gasCost`, refuse if the
  remainder is zero or negative.
- `sweepToken`: ERC-20 `transfer` of the full balance, using the existing
  helpers in `src/lib/chains/erc20.ts`; requires native gas at the source.
`fundGas` is just a normal send from index 0 to the derived address for
~1.5× one sweep's estimated cost. BSC needs legacy (type 0) fee fields — the
reference project's `src/lib/wallet/fees.ts` has the per-chain fee logic worth
copying.

**Gap scanning / how many to show**
Start at 20 scanned addresses (4 pages of 5), and auto-extend by 20 whenever
the last scanned page still shows activity — the same gap-limit idea already
used for TXC in `src/lib/txc/scan.ts`. A "Scan more" control covers people who
used far-out indexes.

## Decisions worth confirming

- Sweep destination: fixed to your main address (index 0), or an editable
  field like the standalone EVM Wallet has?
- Which tokens to scan: the built-in registry only (USDC / USDT / PYUSD), or
  also user-added custom tokens from `token-prefs`?
- iOS: this is a self-custody consolidation feature, not an exchange, so it
  stays visible on iOS. Confirm you agree.

## Notes

- No change to how new receive addresses are handed out; this is purely
  visibility plus recovery of funds already sitting on derived paths.
- No backend/database work, no new secrets.
- The address list is read-only until you press Sweep or Fund; every
  transaction stays a normal user-authorized send you confirm.
