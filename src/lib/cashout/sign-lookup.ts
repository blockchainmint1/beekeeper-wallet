import type { BIP32Interface } from "bip32";
import { DERIVATION_PATHS as TXC_PATHS } from "@/lib/txc/network";
import { deriveAddress } from "@/lib/txc/wallet";
import { signMessageWithKey } from "@/lib/txc/message-sign";
import { bankLookupMessage, orderOwnerMessage } from "./proof";

/** Sign `build(holder, nonce, at)` with the wallet's holder key (bip44 0/0) and a fresh nonce. */
function signWithHolder(root: BIP32Interface, build: (address: string, nonce: string, at: number) => string) {
  const holder = deriveAddress(root, "bip44", 0, 0);
  const node = root.derivePath(`${TXC_PATHS.bip44}/0/0`);
  if (!node.privateKey) throw new Error("Wallet locked");
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  const nonce = Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
  const message = build(holder.address, nonce, Date.now());
  const { signature } = signMessageWithKey({ privateKey: node.privateKey, kind: "bip44", address: holder.address, message });
  return { address: holder.address, message, signature };
}

/**
 * Prove this wallet owns its VectorPay customer ID before the server asks
 * VectorPay for the bank name and last-4 (round-2 audit 2.4, round-4 N2):
 * signed with the wallet's holder key, naming the exact customer ID, with a
 * fresh single-use nonce.
 */
export async function signBankLookup(root: BIP32Interface, accountRef: string) {
  return signWithHolder(root, (address, nonce, at) => bankLookupMessage({ accountRef, address, nonce, at }));
}

/**
 * Prove this wallet owns its customer ID for one cash-out order (round-7
 * sign-off §2). Sign a fresh one for every call — each nonce works once.
 */
export function signOrderOwner(root: BIP32Interface, accountRef: string, reference: string) {
  return signWithHolder(root, (address, nonce, at) => orderOwnerMessage({ accountRef, reference, address, nonce, at }));
}
