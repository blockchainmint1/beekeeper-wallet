import { describe, expect, it } from "vitest";
import { BIP32Factory } from "bip32";
import * as ecc from "@bitcoinerlab/secp256k1";
import { bankLookupMessage, checkBankLookup } from "./proof";
import { signMessageWithKey } from "@/lib/txc/message-sign";
import { deriveAddress } from "@/lib/txc/wallet";
import { DERIVATION_PATHS } from "@/lib/txc/network";

const bip32 = BIP32Factory(ecc);
const root = bip32.fromSeed(new Uint8Array(32).fill(7));
const other = bip32.fromSeed(new Uint8Array(32).fill(9));
const holder = deriveAddress(root, "bip44", 0, 0);
const key = root.derivePath(`${DERIVATION_PATHS.bip44}/0/0`).privateKey!;
const otherKey = other.derivePath(`${DERIVATION_PATHS.bip44}/0/0`).privateKey!;

const REF = "bk_" + "0".repeat(40);
const OTHER_REF = "bk_" + "1".repeat(40);

function signedLookup(accountRef: string, at: number, signer: Uint8Array = key) {
  const message = bankLookupMessage({ accountRef, address: holder.address, nonce: "abc123", at });
  const { signature } = signMessageWithKey({ privateKey: signer, kind: "bip44", address: holder.address, message });
  return { accountRef, address: holder.address, message, signature };
}

describe("a bank-name lookup has to prove the wallet (round-2 audit 2.4)", () => {
  it("a fresh lookup signed by the wallet is accepted", () => {
    expect(checkBankLookup(signedLookup(REF, Date.now()))).toBeNull();
  });

  it("a lookup signed for one customer ID can't be replayed for another", () => {
    const signed = signedLookup(REF, Date.now());
    expect(checkBankLookup({ ...signed, accountRef: OTHER_REF })).toBe("lookup message mismatch");
  });

  it("a lookup older than a few minutes is refused", () => {
    const stale = Date.now() - 10 * 60_000;
    expect(checkBankLookup(signedLookup(REF, stale))).toBe("lookup expired — try again");
  });

  it("a signature from a different key is refused", () => {
    expect(checkBankLookup(signedLookup(REF, Date.now(), otherKey))).toBe("signature does not match wallet");
  });

  it("a lookup with no signature at all is refused", () => {
    expect(checkBankLookup({ accountRef: REF })).toBe("missing wallet signature");
    expect(checkBankLookup({ accountRef: REF, address: holder.address })).toBe("missing wallet signature");
  });

  it("a hand-written message that isn't the lookup text is refused", () => {
    expect(
      checkBankLookup({
        accountRef: REF,
        address: holder.address,
        message: `BeeKeeper bank lookup\naccount: ${REF}\naddress: ${holder.address}\nnonce: \ntime: ${Date.now()}`,
        signature: "x".repeat(88),
      }),
    ).toBe("lookup message mismatch");
  });
});
