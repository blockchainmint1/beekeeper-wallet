/**
 * Headless Omni token send (e.g. TSD) — the same coin selection, holder
 * funding and broadcast logic as the Send screen, callable from anywhere
 * (the cash-out screen sends TSD inline with it).
 */
import type { BIP32Interface } from "bip32";
import { payments } from "bitcoinjs-lib";
import { scanAccount } from "@/lib/txc/scan";
import { buildAndSignTx, DUST_SATS, type UtxoInput } from "@/lib/txc/wallet";
import { filterReserved, reserveOutpoints } from "@/lib/txc/spent-outpoints";
import { scriptKindOf, DERIVATION_PATHS, TXC_NETWORK, type DerivationKind } from "@/lib/txc/network";
import { broadcastTx, getFeeEstimates, getOutspend } from "@/lib/txc/mempool";
import { buildSimpleSendPayload, isOmniCompatibleAddress } from "@/lib/txc/tokens";

const VBYTES = {
  bip84: { input: 68, output: 31, overhead: 11 },
  bip49: { input: 91, output: 32, overhead: 11 },
  bip44: { input: 148, output: 34, overhead: 10 },
} as const;
const OMNI_OP_RETURN_VBYTES = 31;
const DUST = DUST_SATS;

function kindFromPath(path: string): DerivationKind | null {
  for (const [kind, prefix] of Object.entries(DERIVATION_PATHS)) {
    if (path.startsWith(prefix + "/")) return kind as DerivationKind;
  }
  return null;
}

function scriptHexFor(pubkey: Uint8Array, kind: DerivationKind): string | undefined {
  const script = scriptKindOf(kind);
  if (script === "bip44") return undefined;
  const inner = payments.p2wpkh({ pubkey, network: TXC_NETWORK });
  const out = script === "bip84" ? inner.output : payments.p2sh({ redeem: inner, network: TXC_NETWORK }).output;
  if (!out) return undefined;
  return Array.from(out, (b) => b.toString(16).padStart(2, "0")).join("");
}

function vsizeFor(primary: DerivationKind, inputs: { kind?: DerivationKind }[], nOut: number, omni: boolean) {
  const base = VBYTES[scriptKindOf(primary)];
  const ins = inputs.reduce((s, u) => s + VBYTES[scriptKindOf(u.kind ?? primary)].input, 0);
  return base.overhead + ins + base.output * nOut + (omni ? OMNI_OP_RETURN_VBYTES : 0);
}

function omniVsize(kind: DerivationKind) {
  const v = VBYTES[scriptKindOf(kind)];
  return v.overhead + v.input + v.output + OMNI_OP_RETURN_VBYTES;
}

export type PerAddressTokenBalances = Record<string, Record<string, string>>;

export async function sendOmniToken(opts: {
  root: BIP32Interface;
  kind: DerivationKind;
  propertyId: number;
  amountUnits: bigint;
  to: string;
  fetchPerAddress: (addresses: string[], propertyIds: number[]) => Promise<PerAddressTokenBalances>;
  onProgress?: (msg: string) => void;
}): Promise<string> {
  const { root, kind, propertyId, amountUnits, onProgress } = opts;
  const to = opts.to.trim();
  if (!isOmniCompatibleAddress(to)) throw new Error("The cash-out address can't receive tokens.");
  if (amountUnits <= 0n) throw new Error("Nothing to send.");

  onProgress?.("Checking coins…");
  const [account, fees] = await Promise.all([scanAccount(root, kind), getFeeEstimates().catch(() => null)]);
  const feeRate = Math.max(fees?.halfHourFee ?? 10, fees?.minimumFee ?? 10, 10);
  const infos = [...account.external, ...account.internal]
    .map((d) => ({ ...d, kind: kindFromPath(d.path) }))
    .filter((d): d is typeof d & { kind: DerivationKind } => d.kind !== null);
  const own = infos.map((a) => a.address);
  const perAddr = await opts.fetchPerAddress(own, [propertyId]);
  const holders = own
    .map((a) => ({ addr: a, bal: BigInt(perAddr[a]?.[String(propertyId)] ?? "0") }))
    .filter((h) => h.bal >= amountUnits)
    .sort((a, b) => (b.bal > a.bal ? 1 : b.bal < a.bal ? -1 : 0));
  if (holders.length === 0) {
    throw new Error("No single address holds that much — try a smaller amount.");
  }
  const sender = holders[0].addr;
  const sorted = [...filterReserved(account.utxos)].sort((a, b) => b.value - a.value);
  const senderUtxos = sorted.filter((u) => u.address === sender);
  const otherUtxos = sorted.filter((u) => u.address !== sender);

  async function assertUnspent(list: { txid: string; vout: number }[]) {
    const spent = await Promise.all(
      list.map((u) => getOutspend(u.txid, u.vout).then((r) => r.spent).catch(() => false)),
    );
    if (spent.some(Boolean)) {
      reserveOutpoints(list.filter((_, i) => spent[i]));
      throw new Error("Some coins were just used elsewhere — tap Try again.");
    }
  }

  let inputs: UtxoInput[];
  let feeSats: number;

  if (senderUtxos.length === 0) {
    // Holder has no TXC for the fee: fund it first, then chain the transfer.
    const info = infos.find((a) => a.address === sender);
    if (!info) throw new Error("Couldn't locate the sending address key.");
    feeSats = Math.ceil(omniVsize(info.kind) * feeRate);
    const fundSats = Math.ceil((DUST + feeSats) * 1.4);
    const picked: typeof sorted = [];
    let acc = 0;
    let fundFee = 0;
    for (const u of otherUtxos) {
      picked.push(u);
      acc += u.value;
      fundFee = Math.ceil(vsizeFor(kind, picked, 2, false) * feeRate);
      if (acc >= fundSats + fundFee) break;
    }
    if (acc < fundSats + fundFee) throw new Error("Not enough TXC to pay the network fee.");
    await assertUnspent(picked);
    if (acc - fundSats - fundFee < DUST) fundFee = acc - fundSats;
    onProgress?.("Funding address…");
    const fundTx = buildAndSignTx({
      root,
      kind,
      inputs: picked,
      outputs: [{ address: sender, valueSats: fundSats }],
      changeAddress: account.nextChangeAddress,
      changeIndex: account.nextChangeIndex,
      feeSats: fundFee,
    });
    const fundTxid = await broadcastTx(fundTx.hex);
    reserveOutpoints(picked.map((u) => ({ txid: u.txid, vout: u.vout })));
    inputs = [
      {
        txid: fundTxid,
        vout: 0,
        value: fundSats,
        change: info.change,
        index: info.index,
        kind: info.kind,
        witnessScriptHex: scriptHexFor(info.pubkey, info.kind),
        nonWitnessUtxoHex: scriptKindOf(info.kind) === "bip44" ? fundTx.hex : undefined,
      },
    ];
    feeSats = fundSats - DUST;
  } else {
    const ordered = [...senderUtxos, ...otherUtxos];
    const picked: typeof sorted = [];
    let acc = 0;
    feeSats = 0;
    for (const u of ordered) {
      picked.push(u);
      acc += u.value;
      feeSats = Math.ceil(vsizeFor(kind, picked, 2, true) * feeRate);
      if (acc >= DUST + feeSats + DUST) break;
    }
    if (acc < DUST + feeSats) throw new Error("Not enough TXC to pay the network fee.");
    await assertUnspent(picked);
    inputs = picked;
  }

  onProgress?.("Sending…");
  const built = buildAndSignTx({
    root,
    kind,
    inputs,
    outputs: [{ address: to, valueSats: DUST }],
    changeAddress: sender,
    changeIndex: account.nextChangeIndex,
    feeSats,
    opReturnData: buildSimpleSendPayload(propertyId, amountUnits),
  });
  const txid = await broadcastTx(built.hex);
  reserveOutpoints(inputs.map((u) => ({ txid: u.txid, vout: u.vout })));
  return txid;
}
