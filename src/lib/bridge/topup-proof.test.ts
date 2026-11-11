import { describe, expect, it } from "vitest";
import { BIP32Factory } from "bip32";
import * as ecc from "@bitcoinerlab/secp256k1";
import { checkTopupProof, topupMessage, type TopupAction } from "./topup-proof";
import { signMessageWithKey } from "@/lib/txc/message-sign";
import { deriveAddress } from "@/lib/txc/wallet";
import { DERIVATION_PATHS } from "@/lib/txc/network";

const bip32 = BIP32Factory(ecc);
const root = bip32.fromSeed(new Uint8Array(32).fill(7));
const other = bip32.fromSeed(new Uint8Array(32).fill(9));
const holder = deriveAddress(root, "bip44", 0, 0).address;
const otherHolder = deriveAddress(other, "bip44", 0, 0).address;
const key = root.derivePath(`${DERIVATION_PATHS.bip44}/0/0`).privateKey!;
const BASE = "0x" + "ab".repeat(20);

function signed(action: TopupAction, at = Date.now(), address = holder) {
  const message = topupMessage({ action, address, base: BASE, nonce: "0123456789abcdef", at });
  const { signature } = signMessageWithKey({ privateKey: key, kind: "bip44", address: holder, message });
  return { address, base: BASE, message, signature };
}

describe("top-up requests must be signed by the wallet", () => {
  it("a fresh request signed by the holder key is accepted", () => {
    expect(checkTopupProof({ action: "status", ...signed("status") })).toBeNull();
  });
  it("a signature for one action can't be used for another", () => {
    expect(checkTopupProof({ action: "simulate-deposit", ...signed("status") })).toBe("message mismatch");
  });
  it("someone else's address can't be claimed with your signature", () => {
    expect(checkTopupProof({ action: "status", ...signed("status", Date.now(), otherHolder) })).toBe("signature does not match wallet");
  });
  it("a request older than 5 minutes is refused", () => {
    expect(checkTopupProof({ action: "status", ...signed("status", Date.now() - 6 * 60_000) })).toBe("request expired — try again");
  });
  it("swapping the Base delivery address breaks the signature", () => {
    const s = signed("status");
    expect(checkTopupProof({ action: "status", ...s, base: "0x" + "cd".repeat(20) })).toBe("message mismatch");
  });
});
