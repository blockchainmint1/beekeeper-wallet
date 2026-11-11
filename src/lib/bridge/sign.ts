/**
 * Wallet side of the top-up signature: signs with the TEXITcoin holder key
 * (the same T… address that receives TSD) and names the main Base address.
 */
import type { BIP32Interface } from "bip32";
import { DERIVATION_PATHS as TXC_PATHS } from "@/lib/txc/network";
import { deriveAddress } from "@/lib/txc/wallet";
import { signMessageWithKey } from "@/lib/txc/message-sign";
import { deriveEvmAccount } from "@/lib/chains/evm";
import { topupMessage, type TopupAction } from "./topup-proof";

export function topupWalletAddresses(root: BIP32Interface) {
  return { address: deriveAddress(root, "bip44", 0, 0).address, base: deriveEvmAccount(root).address };
}

export function signTopup(root: BIP32Interface, action: TopupAction) {
  const { address, base } = topupWalletAddresses(root);
  const node = root.derivePath(`${TXC_PATHS.bip44}/0/0`);
  if (!node.privateKey) throw new Error("Wallet locked");
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  const nonce = Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
  const message = topupMessage({ action, address, base, nonce, at: Date.now() });
  const { signature } = signMessageWithKey({ privateKey: node.privateKey, kind: "bip44", address, message });
  return { address, base, message, signature };
}
