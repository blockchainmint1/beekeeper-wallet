/**
 * Cash-out round-up: find every cashable stable on the EVM chains (first 20
 * derived addresses each), send them straight to VectorPay's per-chain
 * deposit address, and sign a proof that ties each send to the order.
 *
 * Attribution model (see docs/vectorpay-cashout-proof.md): VectorPay only
 * credits a deposit when the order carries its txid AND a signature from the
 * sending address over the proof message. Matching amounts never matter.
 */
import { createWalletClient, http, type Address } from "viem";
import type { BIP32Interface } from "bip32";
import { deriveEvmAccountAt, deriveEvmAddresses, evmClient, EVM_CHAINS, type StableEvmChainId } from "@/lib/chains/evm";
import { scanEvmAddresses } from "@/lib/chains/evm-scan";
import { encodeTransfer, USDC_BY_CHAIN, USDT_BY_CHAIN, type Erc20TokenMeta } from "@/lib/chains/erc20";
import { effectiveGasPrice } from "@/lib/chains/evm-sweep";
import { sendEvmTransaction } from "@/lib/chains/evm-send";
import { signMessageWithKey } from "@/lib/txc/message-sign";
import { DERIVATION_PATHS as TXC_PATHS } from "@/lib/txc/network";
import { deriveAddress } from "@/lib/txc/wallet";
import type { CashoutAsset } from "@/lib/vectorpay";

export const ROUNDUP_CHAINS: StableEvmChainId[] = ["eth", "base", "bsc"];
export const ROUNDUP_ADDRESS_COUNT = 20;
const TOKEN_GAS = 90_000n;
const NATIVE_GAS = 21_000n;

export interface EvmCashRow {
  key: string;
  chain: StableEvmChainId;
  index: number;
  address: Address;
  asset: CashoutAsset;
  token: Erc20TokenMeta;
  raw: bigint;
  amount: number;
  /** Native coin already at this address. */
  nativeWei: bigint;
  /** Estimated gas for the token transfer, in native wei. */
  gasWei: bigint;
  /** "ready": can pay its own fee. "fund": main address will top it up first. "nogas": nothing can pay. */
  gas: "ready" | "fund" | "nogas";
}

function tokensFor(chain: StableEvmChainId): { asset: CashoutAsset; meta: Erc20TokenMeta }[] {
  return [
    { asset: "USDC", meta: USDC_BY_CHAIN[chain] },
    { asset: "USDT", meta: USDT_BY_CHAIN[chain] },
  ];
}

/** Scan USDC/USDT on the first 20 addresses of every chain with a destination. */
export async function scanEvmCashable(
  root: BIP32Interface,
  chains: StableEvmChainId[],
): Promise<EvmCashRow[]> {
  const addrs = deriveEvmAddresses(root, ROUNDUP_ADDRESS_COUNT, 0);
  const perChain = await Promise.all(
    chains.map(async (chain) => {
      const tokens = tokensFor(chain);
      const [rows, perGas] = await Promise.all([
        scanEvmAddresses(chain, addrs, tokens.map((t) => t.meta)),
        effectiveGasPrice(chain).catch(() => 0n),
      ]);
      const gasWei = perGas * TOKEN_GAS;
      const out: EvmCashRow[] = [];
      for (const r of rows) {
        for (const t of tokens) {
          const raw = r.tokens[t.meta.symbol] ?? 0n;
          if (raw <= 0n) continue;
          out.push({
            key: `e:${chain}:${r.index}:${t.asset}`,
            chain,
            index: r.index,
            address: r.address,
            asset: t.asset,
            token: t.meta,
            raw,
            amount: Number(raw) / 10 ** t.meta.decimals,
            nativeWei: r.native,
            gasWei,
            gas: "ready",
          });
        }
      }
      // Decide who pays gas. Each address pays for its own sends when it can;
      // otherwise the main address (#0) tops it up, if it has enough left.
      const main = rows.find((r) => r.index === 0);
      let mainSpare = main?.native ?? 0n;
      const mainOwn = out.filter((x) => x.index === 0).length;
      mainSpare -= gasWei * BigInt(mainOwn);
      const byIndex = new Map<number, EvmCashRow[]>();
      for (const row of out) byIndex.set(row.index, [...(byIndex.get(row.index) ?? []), row]);
      for (const [index, list] of byIndex) {
        const need = gasWei * BigInt(list.length);
        if (index === 0) {
          const ok = (main?.native ?? 0n) >= need;
          list.forEach((x) => (x.gas = ok ? "ready" : "nogas"));
          continue;
        }
        if (list[0]!.nativeWei >= need) continue;
        // Top-up = 1.5× the shortfall plus the funding tx's own gas.
        const topUp = ((need - list[0]!.nativeWei) * 3n) / 2n + perGas * NATIVE_GAS;
        if (mainSpare >= topUp) {
          mainSpare -= topUp;
          list.forEach((x) => (x.gas = "fund"));
        } else list.forEach((x) => (x.gas = "nogas"));
      }
      return out;
    }),
  );
  return perChain.flat().sort((a, b) => b.amount - a.amount);
}

function walletFor(chain: StableEvmChainId, index: number, root: BIP32Interface) {
  const account = deriveEvmAccountAt(root, index);
  return {
    account,
    client: createWalletClient({ account, chain: EVM_CHAINS[chain].viemChain, transport: http(`/api/evm/${chain}`) }),
  };
}

/** Make sure `index` can pay for `count` token sends; funds it from #0 if needed. */
export async function ensureGas(root: BIP32Interface, chain: StableEvmChainId, index: number, count: number) {
  if (index === 0) return;
  const pub = evmClient(chain);
  const { account } = walletFor(chain, index, root);
  const perGas = await effectiveGasPrice(chain);
  const need = perGas * TOKEN_GAS * BigInt(count);
  const have = await pub.getBalance({ address: account.address });
  if (have >= need) return;
  const top = ((need - have) * 3n) / 2n;
  const main = walletFor(chain, 0, root);
  const hash = await sendEvmTransaction(chain, main.client, { to: account.address, value: top });
  await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
}

/** Send one token balance straight to the cash-out deposit address. */
export async function sendCashRow(root: BIP32Interface, row: EvmCashRow, to: Address): Promise<`0x${string}`> {
  const { client } = walletFor(row.chain, row.index, root);
  return sendEvmTransaction(row.chain, client, { to: row.token.address, data: encodeTransfer(to, row.raw), value: 0n });
}

/* ------------------------------------------------------------------ */
/* Proofs                                                              */
/* ------------------------------------------------------------------ */

export interface TransferProof {
  chain: string;
  asset: CashoutAsset;
  from: string;
  to: string;
  txids: string[];
  /** Decimal token amount the wallet sent (VectorPay re-reads the chain). */
  amount: string;
  message: string;
  signature: string;
}

/** Exact text that gets signed. VectorPay must rebuild it byte-for-byte. */
export function proofMessage(p: { reference: string; chain: string; asset: string; from: string; to: string; txids: string[] }) {
  return [
    "BeeKeeper cash-out proof",
    `order: ${p.reference}`,
    `chain: ${p.chain}`,
    `asset: ${p.asset}`,
    `from: ${p.from}`,
    `to: ${p.to}`,
    `txids: ${p.txids.join(",")}`,
  ].join("\n");
}

/** EIP-191 personal_sign from the derived sending address. */
export async function signEvmProof(
  root: BIP32Interface,
  args: { reference: string; chain: StableEvmChainId; asset: CashoutAsset; index: number; to: string; txids: string[]; amount: string },
): Promise<TransferProof> {
  const account = deriveEvmAccountAt(root, args.index);
  const message = proofMessage({ ...args, from: account.address });
  const signature = await account.signMessage({ message });
  return { chain: args.chain, asset: args.asset, from: account.address, to: args.to, txids: args.txids, amount: args.amount, message, signature };
}

/** TSD lives on the Omni holder address m/44'/696969'/0'/0/0; sign with that key. */
export function signTsdProof(
  root: BIP32Interface,
  args: { reference: string; to: string; txids: string[]; amount: string },
): TransferProof {
  const holder = deriveAddress(root, "bip44", 0, 0);
  const node = root.derivePath(`${TXC_PATHS.bip44}/0/0`);
  if (!node.privateKey) throw new Error("Wallet locked");
  const message = proofMessage({ reference: args.reference, chain: "txc", asset: "TSD", from: holder.address, to: args.to, txids: args.txids });
  const signed = signMessageWithKey({ privateKey: node.privateKey, kind: "bip44", address: holder.address, message });
  return { chain: "txc", asset: "TSD", from: holder.address, to: args.to, txids: args.txids, amount: args.amount, message, signature: signed.signature };
}
