import { describe, expect, it } from "vitest";

import fixtures from "./__fixtures__/trongrid-unsigned.json";
import { assertTronTxMatches } from "./verify";

// Real unsigned transactions built by TronGrid (never signed or broadcast).
const OWNER = "TV6MuMXfmLbBqPZvBHdwFsDnQeVfnmiuSi";
const TRX_TO = "TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8";
const USDT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const TRC20_DATA =
  "a9059cbb00000000000000000000000089cbcb2372e1c2fbc00f24895a406a0c722c89f300000000000000000000000000000000000000000000000000000000000f4240";

const trxIntent = { kind: "transfer" as const, owner: OWNER, to: TRX_TO, amountSun: 1234567n };
const trcIntent = {
  kind: "trigger" as const,
  owner: OWNER,
  contract: USDT,
  data: TRC20_DATA,
  callValueSun: 0n,
  maxFeeLimitSun: 100_000_000n,
};

describe("Tron pre-sign verification", () => {
  it("accepts a TRX transfer that matches the request", () => {
    expect(() => assertTronTxMatches(fixtures.trx, trxIntent)).not.toThrow();
  });

  it("rejects a TRX transfer to a different recipient", () => {
    expect(() => assertTronTxMatches(fixtures.trx, { ...trxIntent, to: OWNER })).toThrow(/recipient/);
  });

  it("rejects a TRX transfer with a different amount", () => {
    expect(() => assertTronTxMatches(fixtures.trx, { ...trxIntent, amountSun: 1234568n })).toThrow(/amount/);
  });

  it("rejects a txID that is not the hash of the raw bytes", () => {
    const forged = { ...fixtures.trx, txID: fixtures.trc20.txID };
    expect(() => assertTronTxMatches(forged, trxIntent)).toThrow(/transaction id/);
  });

  it("accepts a USDT transfer that matches the request", () => {
    expect(() => assertTronTxMatches(fixtures.trc20, trcIntent)).not.toThrow();
  });

  it("rejects a USDT transfer whose calldata pays someone else", () => {
    const other = TRC20_DATA.replace("89cbcb23", "00000000");
    expect(() => assertTronTxMatches(fixtures.trc20, { ...trcIntent, data: other })).toThrow(/call data/);
  });

  it("rejects a fee limit above the one we asked for", () => {
    expect(() => assertTronTxMatches(fixtures.trc20, { ...trcIntent, maxFeeLimitSun: 99_999_999n })).toThrow(/fee limit/);
  });

  it("rejects a contract call on the wrong token contract", () => {
    expect(() =>
      assertTronTxMatches(fixtures.trc20, { ...trcIntent, contract: "TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8" }),
    ).toThrow(/contract/);
  });
});
