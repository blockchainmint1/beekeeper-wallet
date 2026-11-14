import type { BIP32Interface } from "bip32";
import { DERIVATION_PATHS as TXC_PATHS } from "@/lib/txc/network";
import { deriveAddress } from "@/lib/txc/wallet";
import { signMessageWithKey } from "@/lib/txc/message-sign";
import { bankLookupMessage } from "./proof";

/**
 * Prove this wallet owns its VectorPay customer ID before the server asks
 * VectorPay for the bank name and last-4 (round-2 audit 2.4, round-4 N2):
 * signed with the wallet's holder key, naming the exact customer ID, with a
 * fresh single-use nonce.
 */
export async function signBankLookup(root: BIP32Interface, accountRef: string) {
  const holder = deriveAddress(root, "bip44", 0, 0);
  const node = root.derivePath(`${TXC_PATHS.bip44}/0/0`);
  if (!node.privateKey) throw new Error("Wallet locked");
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  const nonce = Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
  const message = bankLookupMessage({ accountRef, address: holder.address, nonce, at: Date.now() });
  const { signature } = signMessageWithKey({ privateKey: node.privateKey, kind: "bip44", address: holder.address, message });
  return { address: holder.address, message, signature };
}
