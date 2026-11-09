/**
 * TronGrid REST client, routed through our same-origin /api/tron proxy.
 */
import {
  TRON_API,
  TRC20_FEE_LIMIT_SUN,
  type Trc20Token,
} from "./network";
import {
  fromHexAddress,
  padAddressParam,
  padUintParam,
  toHexAddress,
} from "./address";
import { signTxId } from "./sign";

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${TRON_API}/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`tron ${path}: ${res.status} ${text.slice(0, 300)}`);
  return JSON.parse(text || "{}") as T;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${TRON_API}/${path}`, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`tron ${path}: ${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

/** Native TRX balance in sun. Unactivated accounts return 0. */
export async function getTrxBalance(address: string): Promise<number> {
  const data = await post<{ balance?: number }>("wallet/getaccount", {
    address,
    visible: true,
  });
  return typeof data.balance === "number" ? data.balance : 0;
}

/** TRC-20 balanceOf via a constant (free, read-only) contract call. */
export async function getTrc20Balance(token: Trc20Token, owner: string): Promise<bigint> {
  const data = await post<{ constant_result?: string[] }>("wallet/triggerconstantcontract", {
    owner_address: owner,
    contract_address: token.contract,
    function_selector: "balanceOf(address)",
    parameter: padAddressParam(owner),
    visible: true,
  });
  const hex = data.constant_result?.[0];
  if (!hex) return 0n;
  return BigInt(`0x${hex}`);
}

export interface TronTransfer {
  txid: string;
  timestamp: number;
  from: string;
  to: string;
  /** Raw base-unit amount. */
  value: bigint;
  symbol: string;
  decimals: number;
  kind: "trx" | "trc20";
  confirmed: boolean;
}

interface Trc20Row {
  transaction_id: string;
  block_timestamp: number;
  from: string;
  to: string;
  value: string;
  token_info?: { symbol?: string; decimals?: number };
}

/** Recent TRC-20 transfers for an address. */
export async function getTrc20Transfers(address: string, limit = 25): Promise<TronTransfer[]> {
  const data = await get<{ data?: Trc20Row[] }>(
    `v1/accounts/${address}/transactions/trc20?limit=${limit}&order_by=block_timestamp,desc`,
  );
  return (data.data ?? []).map((r) => ({
    txid: r.transaction_id,
    timestamp: r.block_timestamp,
    from: r.from,
    to: r.to,
    value: BigInt(r.value ?? "0"),
    symbol: r.token_info?.symbol ?? "TRC20",
    decimals: r.token_info?.decimals ?? 6,
    kind: "trc20" as const,
    confirmed: true,
  }));
}

interface TxRow {
  txID: string;
  block_timestamp: number;
  ret?: { contractRet?: string }[];
  raw_data?: {
    contract?: {
      type?: string;
      parameter?: { value?: { amount?: number; owner_address?: string; to_address?: string } };
    }[];
  };
}

/** Recent native TRX transfers for an address. */
export async function getTrxTransfers(address: string, limit = 25): Promise<TronTransfer[]> {
  const data = await get<{ data?: TxRow[] }>(
    `v1/accounts/${address}/transactions?limit=${limit}&order_by=block_timestamp,desc`,
  );
  const out: TronTransfer[] = [];
  for (const row of data.data ?? []) {
    const c = row.raw_data?.contract?.[0];
    if (c?.type !== "TransferContract") continue;
    const v = c.parameter?.value;
    if (!v?.owner_address || !v.to_address) continue;
    out.push({
      txid: row.txID,
      timestamp: row.block_timestamp,
      from: fromHexAddress(v.owner_address),
      to: fromHexAddress(v.to_address),
      value: BigInt(v.amount ?? 0),
      symbol: "TRX",
      decimals: 6,
      kind: "trx",
      confirmed: row.ret?.[0]?.contractRet === "SUCCESS",
    });
  }
  return out;
}

export async function getTronHistory(address: string): Promise<TronTransfer[]> {
  const [trx, trc20] = await Promise.all([
    getTrxTransfers(address).catch(() => [] as TronTransfer[]),
    getTrc20Transfers(address).catch(() => [] as TronTransfer[]),
  ]);
  // TronGrid emits one row per Transfer event, so a contract call that emits
  // several (bridges, routers, fee splits) shows up multiple times for the
  // same txid. Collapse to one row per txid + direction + asset.
  const seen = new Set<string>();
  const merged: TronTransfer[] = [];
  for (const t of [...trx, ...trc20]) {
    const direction = t.to === address ? "in" : t.from === address ? "out" : "other";
    const key = `${t.txid}:${direction}:${t.symbol}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(t);
  }
  return merged.sort((a, b) => b.timestamp - a.timestamp);
}


/** Chain resources — tells us whether a TRC-20 send will burn TRX for energy. */
export async function getAccountResources(address: string): Promise<{
  energyAvailable: number;
  bandwidthAvailable: number;
}> {
  try {
    const r = await post<{
      EnergyLimit?: number;
      EnergyUsed?: number;
      freeNetLimit?: number;
      freeNetUsed?: number;
      NetLimit?: number;
      NetUsed?: number;
    }>("wallet/getaccountresource", { address, visible: true });
    const energy = (r.EnergyLimit ?? 0) - (r.EnergyUsed ?? 0);
    const bandwidth =
      (r.freeNetLimit ?? 0) - (r.freeNetUsed ?? 0) + ((r.NetLimit ?? 0) - (r.NetUsed ?? 0));
    return { energyAvailable: Math.max(0, energy), bandwidthAvailable: Math.max(0, bandwidth) };
  } catch {
    return { energyAvailable: 0, bandwidthAvailable: 0 };
  }
}

interface UnsignedTx {
  txID: string;
  raw_data: unknown;
  raw_data_hex: string;
  visible?: boolean;
  signature?: string[];
  Error?: string;
  result?: { result?: boolean; message?: string; code?: string };
}

function decodeNodeMessage(msg?: string): string | undefined {
  if (!msg) return undefined;
  try {
    // Node errors come back hex-encoded on triggersmartcontract.
    if (/^[0-9a-fA-F]+$/.test(msg) && msg.length % 2 === 0) {
      const bytes = msg.match(/.{2}/g)!.map((h) => parseInt(h, 16));
      return new TextDecoder().decode(new Uint8Array(bytes));
    }
  } catch {
    /* fall through */
  }
  return msg;
}

async function buildTrxTransfer(from: string, to: string, amountSun: number): Promise<UnsignedTx> {
  const tx = await post<UnsignedTx>("wallet/createtransaction", {
    owner_address: from,
    to_address: to,
    amount: amountSun,
    visible: true,
  });
  if (!tx.txID) throw new Error(decodeNodeMessage(tx.Error) ?? "Tron node rejected the transfer");
  return tx;
}

async function buildTrc20Transfer(
  token: Trc20Token,
  from: string,
  to: string,
  amount: bigint,
): Promise<UnsignedTx> {
  const res = await post<{ transaction?: UnsignedTx; result?: { message?: string } }>(
    "wallet/triggersmartcontract",
    {
      owner_address: from,
      contract_address: token.contract,
      function_selector: "transfer(address,uint256)",
      parameter: padAddressParam(to) + padUintParam(amount),
      fee_limit: TRC20_FEE_LIMIT_SUN,
      call_value: 0,
      visible: true,
    },
  );
  const tx = res.transaction;
  if (!tx?.txID) {
    throw new Error(
      decodeNodeMessage(res.result?.message) ?? "Tron node rejected the token transfer",
    );
  }
  return tx;
}

async function broadcast(tx: UnsignedTx, signature: string): Promise<string> {
  const res = await post<{
    result?: boolean;
    txid?: string;
    code?: string;
    message?: string;
  }>("wallet/broadcasttransaction", { ...tx, signature: [signature] });
  if (res.result !== true) {
    throw new Error(decodeNodeMessage(res.message) ?? res.code ?? "Broadcast failed");
  }
  return res.txid ?? tx.txID;
}

/** Build, sign and broadcast a native TRX transfer. Returns the txid. */
export async function sendTrx(
  privateKey: Uint8Array,
  from: string,
  to: string,
  amountSun: number,
): Promise<string> {
  const tx = await buildTrxTransfer(from, to, amountSun);
  assertTronTxMatches(tx, { kind: "transfer", owner: from, to, amountSun: BigInt(amountSun) });
  return broadcast(tx, signTxId(tx.txID, privateKey));
}

/** Build, sign and broadcast a TRC-20 transfer. Returns the txid. */
export async function sendTrc20(
  privateKey: Uint8Array,
  token: Trc20Token,
  from: string,
  to: string,
  amount: bigint,
): Promise<string> {
  const tx = await buildTrc20Transfer(token, from, to, amount);
  assertTronTxMatches(tx, {
    kind: "trigger",
    owner: from,
    contract: token.contract,
    // transfer(address,uint256) selector + ABI params, exactly what we asked TronGrid to encode.
    data: TRC20_TRANSFER_SELECTOR + padAddressParam(to) + padUintParam(amount),
    callValueSun: 0n,
    maxFeeLimitSun: BigInt(TRC20_FEE_LIMIT_SUN),
  });
  return broadcast(tx, signTxId(tx.txID, privateKey));
}

/**
 * ERC-20 style allowance read, used by the bridge to skip a redundant
 * approval (each approval burns Tron energy, so it's worth checking).
 */
export async function getTrc20Allowance(
  contract: string,
  owner: string,
  spender: string,
): Promise<bigint> {
  const data = await post<{ constant_result?: string[] }>("wallet/triggerconstantcontract", {
    owner_address: owner,
    contract_address: contract,
    function_selector: "allowance(address,address)",
    parameter: padAddressParam(owner) + padAddressParam(spender),
    visible: true,
  });
  const hex = data.constant_result?.[0];
  if (!hex) return 0n;
  return BigInt(`0x${hex}`);
}

/**
 * Build, sign and broadcast an arbitrary contract call from pre-encoded
 * calldata (what Relay hands us for the bridge steps). Returns the txid.
 */
export async function sendRawContractCall(
  privateKey: Uint8Array,
  from: string,
  contract: string,
  data: string,
  opts: { feeLimitSun?: number; callValue?: number } = {},
): Promise<string> {
  const contractBase58 = contract.startsWith("41") ? fromHexAddress(contract) : contract;
  const res = await post<{ transaction?: UnsignedTx; result?: { message?: string } }>(
    "wallet/triggersmartcontract",
    {
      owner_address: from,
      contract_address: contractBase58,
      data: data.startsWith("0x") ? data.slice(2) : data,
      fee_limit: opts.feeLimitSun ?? TRC20_FEE_LIMIT_SUN,
      call_value: opts.callValue ?? 0,
      visible: true,
    },
  );
  const tx = res.transaction;
  if (!tx?.txID) {
    throw new Error(decodeNodeMessage(res.result?.message) ?? "Tron node rejected the call");
  }
  assertTronTxMatches(tx, {
    kind: "trigger",
    owner: from,
    contract: contractBase58,
    data,
    callValueSun: BigInt(opts.callValue ?? 0),
    maxFeeLimitSun: BigInt(opts.feeLimitSun ?? TRC20_FEE_LIMIT_SUN),
  });
  return broadcast(tx, signTxId(tx.txID, privateKey));
}

/** Poll until a Tron tx is included in a block. Throws if it reverted. */
export async function waitForTronTx(txid: string, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const info = await post<{
        id?: string;
        receipt?: { result?: string };
        resMessage?: string;
      }>("wallet/gettransactioninfobyid", { value: txid });
      if (info.id) {
        const result = info.receipt?.result;
        if (result && result !== "SUCCESS") {
          throw new Error(decodeNodeMessage(info.resMessage) ?? `Transaction ${result}`);
        }
        return;
      }
    } catch (err) {
      if (err instanceof Error && /Transaction |revert/i.test(err.message)) throw err;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error("Timed out waiting for Tron confirmation");
}

/** Exposed for callers that need the hex form (debugging / explorers). */
export { toHexAddress };

