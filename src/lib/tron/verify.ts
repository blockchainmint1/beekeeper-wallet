/**
 * Verify a TronGrid-built transaction BEFORE signing it (audit 2026-11-09 M2).
 *
 * TronGrid builds Tron transactions server-side and returns
 * `{ txID, raw_data_hex }`. We sign `txID`, so we must prove that:
 *   1. txID === sha256(raw_data_hex)  (we sign exactly these bytes), and
 *   2. raw_data_hex decodes (protobuf) to exactly the transfer/call we asked
 *      for: same owner, recipient/contract, amount, call value, calldata and
 *      a fee limit no higher than requested.
 * The JSON `raw_data` is ignored — only the signed bytes count.
 */
import { sha256 } from "@noble/hashes/sha2.js";

import { bytesToHex, decodeBase58Address, hexToBytes } from "./address";

const TRANSFER_CONTRACT = 1;
const TRIGGER_SMART_CONTRACT = 31;

export type TronIntent =
  | { kind: "transfer"; owner: string; to: string; amountSun: bigint }
  | {
      kind: "trigger";
      owner: string;
      contract: string;
      /** Calldata hex (selector + params), with or without 0x. */
      data: string;
      callValueSun: bigint;
      maxFeeLimitSun: bigint;
    };

interface Field {
  no: number;
  wire: number;
  varint?: bigint;
  bytes?: Uint8Array;
}

function readVarint(buf: Uint8Array, pos: number): [bigint, number] {
  let result = 0n;
  let shift = 0n;
  for (let i = 0; i < 10; i++) {
    if (pos >= buf.length) throw new Error("truncated varint");
    const b = buf[pos++];
    result |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) return [result, pos];
    shift += 7n;
  }
  throw new Error("varint too long");
}

/** Minimal protobuf reader: top-level fields of one message. */
export function readFields(buf: Uint8Array): Field[] {
  const out: Field[] = [];
  let pos = 0;
  while (pos < buf.length) {
    const [tag, p1] = readVarint(buf, pos);
    pos = p1;
    const no = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (wire === 0) {
      const [v, p2] = readVarint(buf, pos);
      pos = p2;
      out.push({ no, wire, varint: v });
    } else if (wire === 2) {
      const [len, p2] = readVarint(buf, pos);
      const end = p2 + Number(len);
      if (end > buf.length) throw new Error("truncated field");
      out.push({ no, wire, bytes: buf.subarray(p2, end) });
      pos = end;
    } else if (wire === 1) {
      pos += 8;
      out.push({ no, wire });
    } else if (wire === 5) {
      pos += 4;
      out.push({ no, wire });
    } else {
      throw new Error(`unsupported wire type ${wire}`);
    }
  }
  if (pos !== buf.length) throw new Error("trailing bytes");
  return out;
}

const one = (fields: Field[], no: number) => fields.filter((f) => f.no === no);

function onlyBytes(fields: Field[], no: number): Uint8Array | undefined {
  const f = one(fields, no);
  if (f.length > 1) throw new Error(`duplicate field ${no}`);
  return f[0]?.bytes;
}
function onlyVarint(fields: Field[], no: number): bigint {
  const f = one(fields, no);
  if (f.length > 1) throw new Error(`duplicate field ${no}`);
  return f[0]?.varint ?? 0n;
}

const eqBytes = (a: Uint8Array | undefined, b: Uint8Array) =>
  !!a && a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Throws with a plain-English reason if the node-built transaction does not
 * match `intent`. Call immediately before signing.
 */
export function assertTronTxMatches(
  tx: { txID: string; raw_data_hex?: string },
  intent: TronIntent,
): void {
  const fail = (why: string): never => {
    throw new Error(`Tron transaction rejected: ${why}. Nothing was signed.`);
  };
  if (!tx.raw_data_hex || !/^[0-9a-fA-F]+$/.test(tx.raw_data_hex)) fail("missing raw data");
  const raw = hexToBytes(tx.raw_data_hex!);
  if (bytesToHex(sha256(raw)) !== tx.txID.toLowerCase()) fail("transaction id does not match its contents");

  let rawFields: Field[];
  try {
    rawFields = readFields(raw);
  } catch {
    return fail("could not decode transaction");
  }
  const contracts = one(rawFields, 11);
  if (contracts.length !== 1 || !contracts[0].bytes) fail("expected exactly one action");
  const contract = readFields(contracts[0].bytes!);
  const type = Number(onlyVarint(contract, 1));
  const any = onlyBytes(contract, 2);
  if (!any) fail("missing action parameters");
  const value = onlyBytes(readFields(any!), 2);
  if (!value) fail("missing action value");
  const params = readFields(value!);

  const owner = decodeBase58Address(intent.owner);
  if (!eqBytes(onlyBytes(params, 1), owner)) fail("sender does not match");

  if (intent.kind === "transfer") {
    if (type !== TRANSFER_CONTRACT) fail("unexpected action type");
    if (!eqBytes(onlyBytes(params, 2), decodeBase58Address(intent.to))) fail("recipient does not match");
    if (onlyVarint(params, 3) !== intent.amountSun) fail("amount does not match");
    return;
  }

  if (type !== TRIGGER_SMART_CONTRACT) fail("unexpected action type");
  if (!eqBytes(onlyBytes(params, 2), decodeBase58Address(intent.contract))) fail("contract does not match");
  if (onlyVarint(params, 3) !== intent.callValueSun) fail("TRX value does not match");
  const wantData = hexToBytes(intent.data.replace(/^0x/, "").toLowerCase());
  if (!eqBytes(onlyBytes(params, 4) ?? new Uint8Array(), wantData)) fail("call data does not match");
  if (onlyVarint(params, 5) !== 0n || onlyVarint(params, 6) !== 0n) fail("unexpected token value attached");
  const feeLimit = onlyVarint(rawFields, 18);
  if (feeLimit > intent.maxFeeLimitSun) fail("fee limit is higher than requested");
}
