import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { friendlyBroadcastError } from "@/lib/broadcast-error";
import { useMemo, useState } from "react";
import { z } from "zod";
import { useWallet } from "@/lib/txc/wallet-context";
import { scanAccount } from "@/lib/txc/scan";
import { buildAndSignTx, DUST_SATS, type UtxoInput } from "@/lib/txc/wallet";
import { filterReserved, reserveOutpoints } from "@/lib/txc/spent-outpoints";
import { scriptKindOf, DERIVATION_PATHS, type DerivationKind } from "@/lib/txc/network";
import {
  broadcastTx,
  explorerTxUrl,
  getFeeEstimates,
  getOutspend,
  type FeeEstimates,
} from "@/lib/txc/mempool";
import { formatTxc, txcToSats } from "@/lib/txc/units";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { AlertTriangle, ArrowDownUp, ExternalLink, Loader2 } from "lucide-react";
import { TXC_NETWORK } from "@/lib/txc/network";
import { address as addrLib, payments } from "bitcoinjs-lib";
import { QrScanButton, parseWalletUri } from "@/components/wallet/QrScanButton";
import { AddressBookButton } from "@/components/wallet/AddressBookButton";
import { hapticSuccess, hapticError } from "@/lib/native/ui";
import { confirmWithBiometric } from "@/lib/native/biometric";
import { rootFingerprintHex } from "@/lib/txc/fingerprint";
import { useServerFn } from "@tanstack/react-start";
import {
  useEnabledTxcTokens,
  buildSimpleSendPayload,
  parseTokenAmount,
  formatTokenAmount,
  type TxcTokenMeta,
  isOmniCompatibleAddress,
} from "@/lib/txc/tokens";
import { useTxcTokenProps } from "@/lib/txc/token-props";
import { useExchangeFeaturesAllowed } from "@/lib/native/capabilities";
import { TsdCashoutPanel, type CashoutPlan } from "@/components/wallet/TsdCashoutPanel";
import { useCashoutApiKey } from "@/lib/cashout/api-key";
import { TSD_PROPERTY_ID, formatUsd, payoutFor } from "@/lib/cashout/tsd";


import {
  getTxcTokenBalancesForAddresses,
  getTxcTokenBalancesPerAddress,
} from "@/lib/txc/tokens.functions";

const searchSchema = z.object({
  to: z.string().optional(),
  amount: z.string().optional(),
  /** Optional Omni property id to preselect the token picker. */
  token: z.string().optional(),
});

export const Route = createFileRoute("/wallet/send")({
  head: () => ({ meta: [{ title: "Send — BeeKeeper Wallet" }] }),
  validateSearch: (raw) => searchSchema.parse(raw),
  component: SendPage,
});

function isValidTxcAddress(addr: string): boolean {
  try {
    addrLib.toOutputScript(addr.trim(), TXC_NETWORK);
    return true;
  } catch {
    return false;
  }
}

// Rough vbytes per input/output by address type. Used for fee estimation.
const VBYTES = {
  bip84: { input: 68, output: 31, overhead: 11 },
  bip49: { input: 91, output: 32, overhead: 11 },
  bip44: { input: 148, output: 34, overhead: 10 },
} as const;

// OP_RETURN with Omni payload (20 bytes data) ≈ 30 vbytes on the wire.
const OMNI_OP_RETURN_VBYTES = 31;
// TXC dust threshold used for the Omni reference output. Matches CryptoPOP.
const OMNI_DUST_SATS = DUST_SATS;

/**
 * Inputs can come from different derivation branches (SLIP-0044 696969' and
 * the legacy 0' paths), and those branches can have different script types,
 * so size each input by its own kind and only fall back to the wallet's
 * primary kind when an input doesn't carry one.
 */
function estimateVsizeFor(
  primaryKind: DerivationKind,
  inputs: { kind?: DerivationKind }[],
  nOut: number,
  withOmni = false,
): number {
  const base = VBYTES[scriptKindOf(primaryKind)];
  const inputBytes = inputs.reduce(
    (sum, u) => sum + VBYTES[scriptKindOf(u.kind ?? primaryKind)].input,
    0,
  );
  return base.overhead + inputBytes + base.output * nOut + (withOmni ? OMNI_OP_RETURN_VBYTES : 0);
}

/** Change smaller than the dust threshold is non-standard on TXC — burn it to fee. */
const CHANGE_MIN_SATS = OMNI_DUST_SATS;

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
  const out =
    script === "bip84"
      ? inner.output
      : payments.p2sh({ redeem: inner, network: TXC_NETWORK }).output;
  if (!out) return undefined;
  return Array.from(out, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Vsize of a one-input, one-output Omni send. */
function omniVsize(kind: DerivationKind): number {
  const v = VBYTES[scriptKindOf(kind)];
  return v.overhead + v.input + v.output + OMNI_OP_RETURN_VBYTES;
}

type Stage =
  | { kind: "form" }
  | {
      kind: "review";
      vsize: number;
      feeSats: number;
      selected: number;
      /** Omni sender address (first input's address). Only set for token sends. */
      senderAddress?: string;
      /**
       * Set when the token holder address has no TXC of its own: we first
       * broadcast a small funding transaction to it, then chain the Omni
       * transfer onto that output.
       */
      fund?: { sats: number; feeSats: number; inputs: number };
    }
  | { kind: "sent"; txid: string };

// "txc" or an Omni property id encoded as string.
type Asset = "txc" | number;

function SendPage() {
  const navigate = useNavigate();
  const { root, unlocked } = useWallet();
  const qc = useQueryClient();
  const account = useQuery({
    queryKey: ["account", unlocked?.kind, root ? rootFingerprintHex(root) : null],
    enabled: !!root && !!unlocked,
    queryFn: () => scanAccount(root!, unlocked!.kind),
    staleTime: 30_000,
    // Warm the coin set while the user is still typing the amount, so the tap
    // on Send only has to verify, sign and broadcast.
    refetchOnMount: "always",
  });

  const fees = useQuery<FeeEstimates>({
    queryKey: ["fees"],
    queryFn: getFeeEstimates,
    staleTime: 60_000,
  });

  const localTokens = useEnabledTxcTokens();
  const { resolved: tokens } = useTxcTokenProps(localTokens);

  const search = Route.useSearch();
  const initialAsset: Asset = useMemo(() => {
    const t = search.token;
    if (!t) return "txc";
    const n = Number(t);
    return Number.isInteger(n) && n > 0 ? n : "txc";
  }, [search.token]);

  const [asset, setAsset] = useState<Asset>(initialAsset);
  const [to, setTo] = useState(search.to ?? "");
  const [amount, setAmount] = useState(search.amount ?? "");
  const [sendAll, setSendAll] = useState(false);
  const [feeTier, setFeeTier] = useState<"fastestFee" | "halfHourFee" | "hourFee">("halfHourFee");
  const [stage, setStage] = useState<Stage>({ kind: "form" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Human-readable step shown on the send button while a payment is in flight. */
  const [progress, setProgress] = useState<string | null>(null);
  /**
   * Set once the user has created a TSD → USDC cash-out order. The recipient
   * and amount are then locked to the order's inbox so the payment can't drift
   * away from what the bridge is waiting for.
   */
  const [cashout, setCashout] = useState<CashoutPlan | null>(null);
  const exchangeAllowed = useExchangeFeaturesAllowed();

  const activeToken: TxcTokenMeta | null =
    typeof asset === "number" ? (tokens.find((t) => t.id === asset) ?? null) : null;
  const isTokenSend = activeToken !== null;
  const [cashoutApiKey] = useCashoutApiKey();
  // The off-ramp only exists once the user has linked their TSD Swap account.
  const canCashOut =
    exchangeAllowed && !!cashoutApiKey && activeToken?.id === TSD_PROPERTY_ID;

  function applyUri(raw: string) {
    const { address, amount: amt, tokenId } = parseWalletUri(raw);
    setTo(address);
    if (tokenId) setAsset(tokenId);
    if (amt) {
      setAmount(amt);
      setSendAll(false);
    }
  }

  // Never offer coins that a transaction this device already broadcast is
  // spending (an earlier payment, or the background token-holder top-up) —
  // picking them again is what the node rejects as `txn-mempool-conflict`.
  const utxos = useMemo(() => filterReserved(account.data?.utxos ?? []), [account.data]);
  const totalAvailable = utxos.reduce((s, u) => s + u.value, 0);
  const amountSats = useMemo(() => txcToSats(amount || "0"), [amount]);

  // Token balance across the whole HD account.
  const fetchTokenBalances = useServerFn(getTxcTokenBalancesForAddresses);
  const ownAddresses = useMemo(
    () => [
      ...(account.data?.external.map((a) => a.address) ?? []),
      ...(account.data?.internal.map((a) => a.address) ?? []),
    ],
    [account.data],
  );
  /** Derived address metadata (key index + script kind), keyed by address. */
  const addressInfos = useMemo(() => {
    const list = [...(account.data?.external ?? []), ...(account.data?.internal ?? [])];
    return list
      .map((d) => ({ ...d, kind: kindFromPath(d.path) }))
      .filter((d): d is typeof d & { kind: DerivationKind } => d.kind !== null);
  }, [account.data]);

  const tokenBalances = useQuery({
    queryKey: ["txc-token-balances", ownAddresses.join(","), tokens.map((t) => t.id).join(",")],
    enabled: ownAddresses.length > 0 && tokens.length > 0,
    queryFn: () =>
      fetchTokenBalances({
        data: {
          addresses: ownAddresses,
          propertyIds: tokens.map((t) => t.id),
        },
      }),
    staleTime: 30_000,
  });

  // Per-address balances — needed so Omni sends can pick UTXOs from the
  // specific HD address that actually holds the token (Omni "sending address"
  // is derived from the first input's script).
  const fetchTokenBalancesPerAddr = useServerFn(getTxcTokenBalancesPerAddress);
  const perAddrTokenBalances = useQuery({
    queryKey: [
      "txc-token-balances-per-addr",
      ownAddresses.join(","),
      tokens.map((t) => t.id).join(","),
    ],
    enabled: ownAddresses.length > 0 && tokens.length > 0,
    queryFn: () =>
      fetchTokenBalancesPerAddr({
        data: {
          addresses: ownAddresses,
          propertyIds: tokens.map((t) => t.id),
        },
      }),
    staleTime: 30_000,
  });

  const activeTokenBalanceUnits: bigint | null = activeToken
    ? BigInt(tokenBalances.data?.[activeToken.id] ?? "0")
    : null;

  // TXC's min relay fee sits well above Bitcoin's 1 sat/vB — floor every tier
  // at the node's reported `minimumFee` (and never below 10) so a stale/low
  // estimate can't produce a "min relay fee not met" broadcast rejection.
  const rawFeeRate = fees.data?.[feeTier] ?? 10;
  const minFloor = Math.max(fees.data?.minimumFee ?? 10, 10);
  const feeRate = Math.max(rawFeeRate, minFloor);

  function review(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const cleanTo = to.trim();
    if (!isValidTxcAddress(cleanTo)) {
      setError("That's not a valid TEXITcoin address.");
      return;
    }
    if (!unlocked) return;

    const sorted = [...utxos].sort((a, b) => b.value - a.value);

    // ---- Omni token send ----
    if (isTokenSend && activeToken) {
      if (!isOmniCompatibleAddress(cleanTo)) {
        setError(
          `${activeToken.symbol} can't be sent to a txc1… (segwit) address — the token layer only reads legacy addresses, so the coins would be lost in transit. Ask the recipient for their T… address.`,
        );
        return;
      }
      let amountUnits: bigint;

      try {
        amountUnits = parseTokenAmount(amount, activeToken.divisible);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Invalid amount");
        return;
      }
      if (activeTokenBalanceUnits != null && amountUnits > activeTokenBalanceUnits) {
        setError(
          `Not enough ${activeToken.symbol}. Available ${formatTokenAmount(
            activeTokenBalanceUnits,
            activeToken.divisible,
          )}.`,
        );
        return;
      }

      // Omni sender = address that owns the FIRST input. So we must select a
      // holder address whose token balance covers the amount, and put one of
      // its TXC UTXOs at the front of the input list.
      const perAddr = perAddrTokenBalances.data;
      if (!perAddr) {
        setError("Still loading token balances — try again in a moment.");
        return;
      }
      const holders = ownAddresses
        .map((a) => ({ addr: a, bal: BigInt(perAddr[a]?.[activeToken.id] ?? "0") }))
        .filter((h) => h.bal >= amountUnits)
        .sort((a, b) => (b.bal > a.bal ? 1 : b.bal < a.bal ? -1 : 0));
      if (holders.length === 0) {
        setError(
          `No single address holds ${amount} ${activeToken.symbol}. Omni sends the whole amount from one address — try a smaller amount, or consolidate first.`,
        );
        return;
      }
      const senderAddress = holders[0].addr;
      const senderUtxos = sorted.filter((u) => u.address === senderAddress);
      const otherUtxos = sorted.filter((u) => u.address !== senderAddress);
      if (senderUtxos.length === 0) {
        // The holder address has no TXC of its own. Omni takes the sender from
        // the first input, so we can't just pay the fee from another address —
        // instead we fund this one first and chain the transfer onto it.
        const info = addressInfos.find((a) => a.address === senderAddress);
        if (!info) {
          setError(
            `Your ${activeToken.symbol} is at ${senderAddress}, but that address has no TXC to pay the network fee. Send a small amount of TXC to it first, then retry.`,
          );
          return;
        }
        const need = OMNI_DUST_SATS + Math.ceil(omniVsize(info.kind) * feeRate);
        // Headroom so a fee bump between planning and broadcast can't strand it.
        const fundSats = Math.ceil(need * 1.4);
        const picked: typeof sorted = [];
        let acc = 0;
        let fundFee = 0;
        for (const u of otherUtxos) {
          picked.push(u);
          acc += u.value;
          fundFee = Math.ceil(estimateVsizeFor(unlocked.kind, picked, 2) * feeRate);
          if (acc >= fundSats + fundFee) break;
        }
        if (acc < fundSats + fundFee) {
          setError(
            `Not enough TXC to cover the network fee. Need ~${formatTxc(fundSats + fundFee)}, have ${formatTxc(acc)}.`,
          );
          return;
        }
        setStage({
          kind: "review",
          vsize: omniVsize(info.kind),
          feeSats: fundSats - OMNI_DUST_SATS,
          selected: picked.length,
          senderAddress,
          fund: { sats: fundSats, feeSats: fundFee, inputs: picked.length },
        });
        return;
      }

      // Sender-owned UTXOs first (largest first), then top up from other own
      // addresses if needed for fee. Change goes back to the sender address so
      // future token sends have TXC to work with.
      const ordered = [...senderUtxos, ...otherUtxos];
      const picked: typeof sorted = [];
      let acc = 0;
      let vsize = 0;
      let feeSats = 0;
      for (const u of ordered) {
        picked.push(u);
        acc += u.value;
        vsize = estimateVsizeFor(unlocked.kind, picked, 2, true);
        feeSats = Math.ceil(vsize * feeRate);
        if (acc >= OMNI_DUST_SATS + feeSats + OMNI_DUST_SATS) break;
      }
      if (acc < OMNI_DUST_SATS + feeSats) {
        setError(
          `Not enough TXC for fee + dust. Need ~${formatTxc(OMNI_DUST_SATS + feeSats)}, have ${formatTxc(acc)}.`,
        );
        return;
      }
      setStage({
        kind: "review",
        vsize,
        feeSats,
        selected: picked.length,
        senderAddress,
      });
      return;
    }

    // ---- Native TXC send ----
    if (sendAll) {
      const nIn = sorted.length;
      if (nIn === 0) {
        setError("No funds available.");
        return;
      }
      const vsize = estimateVsizeFor(unlocked.kind, sorted, 1);
      const feeSats = Math.ceil(vsize * feeRate);
      const outSats = totalAvailable - feeSats;
      if (outSats <= DUST_SATS) {
        setError("Not enough to cover the network fee.");
        return;
      }
      setStage({ kind: "review", vsize, feeSats, selected: nIn });
      return;
    }

    if (amountSats <= DUST_SATS) {
      setError(
        `Amount is below TEXITcoin's dust limit (${formatTxc(DUST_SATS)}). Send a bit more.`,
      );
      return;
    }

    const picked: typeof sorted = [];
    let acc = 0;
    let vsize = 0;
    let feeSats = 0;
    for (const u of sorted) {
      picked.push(u);
      acc += u.value;
      vsize = estimateVsizeFor(unlocked.kind, picked, 2);
      feeSats = Math.ceil(vsize * feeRate);
      if (acc >= amountSats + feeSats) break;
    }
    if (acc < amountSats + feeSats) {
      setError(
        `Not enough funds. Available ${formatTxc(totalAvailable)}, needed ${formatTxc(amountSats + feeSats)}.`,
      );
      return;
    }
    setStage({ kind: "review", vsize, feeSats, selected: picked.length });
  }

  async function send() {
    if (!root || !unlocked || !account.data) return;
    if (stage.kind !== "review") return;
    const ok = await confirmWithBiometric(
      isTokenSend && activeToken ? `Confirm sending ${activeToken.symbol}` : "Confirm sending TXC",
    );
    if (!ok) return;
    setBusy(true);
    setError(null);
    /** Coins this attempt touched — reserved if the node rejects a conflict. */
    let attemptedInputs: { txid: string; vout: number }[] = [];
    try {
      // A cached UTXO set can contain outputs that were already spent (another
      // device, an earlier send, a mempool tx), which the node rejects with
      // `inputs-missingorspent` / `txn-mempool-conflict`.
      //
      // We used to re-scan the whole account here, which cost dozens of
      // sequential HTTP calls and made in-person payments painfully slow. All
      // we actually need to know is whether the handful of coins we're about
      // to spend are still unspent — so ask exactly that, concurrently.
      setProgress("Checking coins…");
      const sorted = [...utxos].sort((a, b) => b.value - a.value);

      // For token sends, reproduce the exact ordering used at review time so
      // the first input's address is the Omni sender.
      const ordered =
        isTokenSend && stage.senderAddress
          ? [
              ...sorted.filter((u) => u.address === stage.senderAddress),
              ...sorted.filter((u) => u.address !== stage.senderAddress),
            ]
          : sorted;

      const willSpend =
        isTokenSend && stage.fund && stage.senderAddress
          ? sorted.filter((u) => u.address !== stage.senderAddress).slice(0, stage.fund.inputs)
          : ordered.slice(0, stage.selected);

      attemptedInputs = willSpend.map((u) => ({ txid: u.txid, vout: u.vout }));

      const spendStates = await Promise.all(
        willSpend.map(async (u) => {
          try {
            return (await getOutspend(u.txid, u.vout)).spent;
          } catch {
            // Explorer hiccup — don't block the payment on it; the node is the
            // final authority and a genuine double-spend still gets rejected.
            return false;
          }
        }),
      );
      if (spendStates.some(Boolean)) {
        reserveOutpoints(
          willSpend.filter((_, i) => spendStates[i]).map((u) => ({ txid: u.txid, vout: u.vout })),
        );
        void account.refetch();
        setStage({ kind: "form" });
        setError(
          "Some of the coins you were spending were just used elsewhere — the amounts have been refreshed, please review and send again.",
        );
        setBusy(false);
        setProgress(null);
        return;
      }

      // Holder address has no TXC: broadcast a small funding tx to it first,
      // then chain the Omni transfer onto that fresh output so the token
      // layer still sees the holder as the sender. The background top-up keeps
      // this off the critical path in normal use — it's the first-send fallback.
      let chainedInput: UtxoInput | null = null;
      if (isTokenSend && stage.fund && stage.senderAddress) {
        setProgress("Funding address…");
        const info = addressInfos.find((a) => a.address === stage.senderAddress);
        if (!info) throw new Error("Couldn't locate the sending address key.");
        const fundInputs = sorted
          .filter((u) => u.address !== stage.senderAddress)
          .slice(0, stage.fund.inputs);
        const acc = fundInputs.reduce((s, u) => s + u.value, 0);
        let fundFee = stage.fund.feeSats;
        // A dust-sized change output would be non-standard — absorb it.
        if (acc - stage.fund.sats - fundFee < CHANGE_MIN_SATS) fundFee = acc - stage.fund.sats;
        if (fundFee <= 0) throw new Error("Not enough TXC to cover the network fee.");
        const fundTx = buildAndSignTx({
          root,
          kind: unlocked.kind,
          inputs: fundInputs,
          outputs: [{ address: stage.senderAddress, valueSats: stage.fund.sats }],
          changeAddress: account.data.nextChangeAddress,
          changeIndex: account.data.nextChangeIndex,
          feeSats: fundFee,
        });
        const fundTxid = await broadcastTx(fundTx.hex);
        reserveOutpoints(fundInputs.map((u) => ({ txid: u.txid, vout: u.vout })));
        chainedInput = {
          txid: fundTxid,
          vout: 0,
          value: stage.fund.sats,
          change: info.change,
          index: info.index,
          kind: info.kind,
          witnessScriptHex: scriptHexFor(info.pubkey, info.kind),
          nonWitnessUtxoHex: scriptKindOf(info.kind) === "bip44" ? fundTx.hex : undefined,
        };
      }

      const picked = chainedInput ? [chainedInput] : ordered.slice(0, stage.selected);

      let built;
      if (isTokenSend && activeToken) {
        const amountUnits = parseTokenAmount(amount, activeToken.divisible);
        const payload = buildSimpleSendPayload(activeToken.id, amountUnits);
        built = buildAndSignTx({
          root,
          kind: unlocked.kind,
          inputs: picked,
          outputs: [{ address: to.trim(), valueSats: OMNI_DUST_SATS }],
          // Return TXC change to the sending address so the holder always has
          // TXC on hand for the next token transfer.
          changeAddress: stage.senderAddress ?? account.data.nextChangeAddress,
          changeIndex: account.data.nextChangeIndex,
          feeSats: stage.feeSats,
          opReturnData: payload,
        });
      } else {
        const outValue = sendAll ? totalAvailable - stage.feeSats : amountSats;
        built = buildAndSignTx({
          root,
          kind: unlocked.kind,
          inputs: picked,
          outputs: [{ address: to.trim(), valueSats: outValue }],
          changeAddress: account.data.nextChangeAddress,
          changeIndex: account.data.nextChangeIndex,
          feeSats: stage.feeSats,
        });
      }

      setProgress(isTokenSend && activeToken ? `Sending ${activeToken.symbol}…` : "Sending TXC…");
      const txid = await broadcastTx(built.hex);
      reserveOutpoints(picked.map((u) => ({ txid: u.txid, vout: u.vout })));
      hapticSuccess();
      void qc.invalidateQueries({ queryKey: ["account"] });
      void qc.invalidateQueries({ queryKey: ["txs"] });
      setStage({ kind: "sent", txid });
    } catch (err) {
      hapticError();
      const msg = String((err as Error)?.message ?? err).toLowerCase();
      if (msg.includes("missingorspent") || msg.includes("mempool-conflict")) {
        // The node is authoritative: these coins are unusable right now. Set
        // them aside so the next attempt builds from a different set instead
        // of hitting the exact same rejection over and over.
        reserveOutpoints(attemptedInputs);
        void account.refetch();
        void qc.invalidateQueries({ queryKey: ["txs"] });
        setStage({ kind: "form" });
      }
      setError(friendlyBroadcastError(err));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  const reviewedOutSats =
    stage.kind === "review"
      ? isTokenSend
        ? OMNI_DUST_SATS
        : sendAll
          ? totalAvailable - stage.feeSats
          : amountSats
      : 0;

  const reviewedAmountLabel =
    isTokenSend && activeToken ? `${amount} ${activeToken.symbol}` : formatTxc(reviewedOutSats);

  if (stage.kind === "sent") {
    return (
      <main className="mx-auto max-w-xl px-4 py-10 text-center">
        <div className="w-16 h-16 rounded-full bg-emerald-500/15 text-emerald-400 mx-auto flex items-center justify-center text-2xl">
          ✓
        </div>
        <h1 className="mt-4 text-2xl font-bold">Sent</h1>
        <p className="mt-2 text-muted-foreground">Your transaction was broadcast to the network.</p>

        {cashout && (
          <div className="mx-auto mt-4 max-w-sm rounded-lg border border-primary/40 bg-primary/5 p-4 text-left text-sm">
            <div className="flex items-center gap-2 font-medium">
              <ArrowDownUp className="h-4 w-4 text-primary" /> Cashing out to USDC
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground">
              {cashout.amount} TSD → {formatUsd(payoutFor(cashout.amount, cashout.feeBps))} USDC to{" "}
              <span className="font-mono break-all">{cashout.payoutAddress}</span>
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              TSD Swap pays out once the TSD transfer confirms — usually a few minutes. You can
              close the app; it keeps running on their side.
            </p>
          </div>
        )}

        {isTokenSend && activeToken && !cashout && (
          <p className="mx-auto mt-3 max-w-sm rounded-lg border border-border/60 bg-card/40 p-3 text-sm text-muted-foreground">
            Token transfers are only applied once the transaction confirms — usually a few minutes
            on TEXITcoin. Your {activeToken.symbol} balance and the recipient's will update then, so
            check back shortly rather than sending again.
          </p>
        )}

        <a
          href={explorerTxUrl(stage.txid)}
          target="_blank"
          rel="noreferrer"
          className="mt-3 inline-flex items-center gap-1 text-sm underline"
        >
          View on explorer <ExternalLink className="h-3.5 w-3.5" />
        </a>
        <div className="mt-8 flex justify-center gap-2">
          <Button onClick={() => navigate({ to: "/wallet" })}>Back to wallet</Button>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-xl px-4 py-8">
      <Link to="/wallet" className="text-sm text-muted-foreground hover:text-foreground">
        ← Back
      </Link>
      <h1 className="mt-3 text-2xl font-bold">
        Send {isTokenSend && activeToken ? activeToken.symbol : "TXC"}
      </h1>
      <p className="text-sm text-muted-foreground">
        {isTokenSend && activeToken ? (
          <>
            Available:{" "}
            {tokenBalances.isLoading || !tokenBalances.data
              ? "…"
              : `${formatTokenAmount(
                  activeTokenBalanceUnits ?? 0n,
                  activeToken.divisible,
                )} ${activeToken.symbol}`}
            <span className="ml-2 text-xs">(TXC for fee: {formatTxc(totalAvailable)})</span>
          </>
        ) : (
          <>Available: {account.isLoading ? "…" : formatTxc(totalAvailable)}</>
        )}
      </p>

      {stage.kind === "form" && (
        <Card className="mt-5">
          <CardHeader>
            <CardTitle>Recipient</CardTitle>
            <CardDescription>
              Double-check the address — TXC sends are irreversible.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={review} className="space-y-4">
              {tokens.length > 0 && (
                <div>
                  <Label htmlFor="asset">Asset</Label>
                  <Select
                    value={asset === "txc" ? "txc" : String(asset)}
                    onValueChange={(v) => {
                      setAsset(v === "txc" ? "txc" : Number(v));
                      setAmount("");
                      setSendAll(false);
                    }}
                  >
                    <SelectTrigger id="asset" className="mt-1">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="txc">TXC — TEXITcoin</SelectItem>
                      {tokens.map((t) => (
                        <SelectItem key={t.id} value={String(t.id)}>
                          {t.symbol}
                          {t.name ? ` — ${t.name}` : ""} (#{t.id})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              <div>
                <Label htmlFor="to">TEXITcoin address</Label>
                <div className="mt-1 flex gap-2">
                  <Input
                    id="to"
                    value={to}
                    onChange={(e) => setTo(e.target.value)}
                    placeholder={isTokenSend ? "T... (legacy address)" : "txc1... or T..."}
                    className="font-mono flex-1"
                    autoComplete="off"
                    spellCheck={false}
                    disabled={!!cashout}
                  />
                  <QrScanButton onScan={applyUri} />
                  <AddressBookButton chain="txc" onPick={(a) => setTo(a)} />
                </div>
                {isTokenSend && (
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    {activeToken?.symbol} rides the Omni layer, which can't read segwit — the
                    recipient must be a legacy <span className="font-mono">T…</span> address, never{" "}
                    <span className="font-mono">txc1…</span>.
                  </p>
                )}
                {isTokenSend && /^txc1/i.test(to.trim()) && (
                  <p className="mt-1.5 text-xs text-destructive">
                    That's a segwit (txc1…) address — sending {activeToken?.symbol} to it would
                    strand the tokens. Ask the recipient for their legacy T… address.
                  </p>
                )}
              </div>
              <div>
                <div className="flex items-center justify-between">
                  <Label htmlFor="amount">
                    Amount {isTokenSend && activeToken ? `(${activeToken.symbol})` : "(TXC)"}
                  </Label>
                  {!isTokenSend && (
                    <label className="text-xs text-muted-foreground flex items-center gap-1.5 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={sendAll}
                        onChange={(e) => setSendAll(e.target.checked)}
                        className="h-3.5 w-3.5"
                      />
                      Send all
                    </label>
                  )}
                </div>
                <Input
                  id="amount"
                  type="number"
                  inputMode="decimal"
                  step={isTokenSend && activeToken && !activeToken.divisible ? "1" : "0.00000001"}
                  min="0"
                  value={sendAll ? "" : amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder={sendAll ? "All available (minus fee)" : "0.0"}
                  className="mt-1"
                  disabled={sendAll || !!cashout}
                />
                {isTokenSend && activeToken && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Uses ~{formatTxc(OMNI_DUST_SATS)} + fee in TXC for the on-chain transfer.
                  </p>
                )}
              </div>

              {/* TSD → USDC off-ramp. Hidden on iOS (exchange feature gate). */}
              {canCashOut && !cashout && (
                <TsdCashoutPanel
                  amount={amount}
                  apiKey={cashoutApiKey!}
                  onReady={(plan) => {
                    setCashout(plan);
                    setTo(plan.depositAddress);
                    setAmount(String(plan.amount));
                    setSendAll(false);
                    setError(null);
                  }}
                />
              )}

              {cashout && (
                <div className="rounded-lg border border-primary/40 bg-primary/5 p-3 text-sm">
                  <div className="flex items-start gap-2">
                    <ArrowDownUp className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                    <div className="flex-1">
                      <p className="font-medium">Cashing out to USDC on Ethereum</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {cashout.amount} TSD →{" "}
                        {formatUsd(payoutFor(cashout.amount, cashout.feeBps))} USDC to{" "}
                        <span className="font-mono break-all">{cashout.payoutAddress}</span>
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        The recipient above is your TSD Swap deposit address. Refunds return to your
                        wallet automatically.
                      </p>
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="mt-2 h-auto px-2 py-1 text-xs"
                    onClick={() => {
                      setCashout(null);
                      setTo("");
                    }}
                  >
                    Cancel cash-out
                  </Button>
                </div>
              )}

              <div>
                <Label>Fee speed</Label>
                <div className="mt-2 grid grid-cols-3 gap-2 text-sm">
                  {(["hourFee", "halfHourFee", "fastestFee"] as const).map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setFeeTier(t)}
                      className={`rounded-md border px-2 py-2 text-center transition-colors ${
                        feeTier === t
                          ? "border-primary bg-primary/10"
                          : "border-border hover:bg-accent"
                      }`}
                    >
                      <div className="font-medium">
                        {t === "fastestFee" ? "Fast" : t === "halfHourFee" ? "Medium" : "Slow"}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {fees.data ? Math.max(fees.data[t], minFloor) : "—"} sat/vB
                      </div>
                    </button>
                  ))}
                </div>
              </div>
              {error && (
                <div className="space-y-1">
                  <div className="flex items-start gap-2 text-sm text-destructive">
                    <AlertTriangle className="h-4 w-4 mt-0.5" /> {error}
                  </div>
                  {/^No single address holds/.test(error) && activeToken && (
                    <Link
                      to="/wallet/txc/consolidate"
                      search={{ token: String(activeToken.id) }}
                      className="inline-block text-sm font-medium underline underline-offset-4"
                    >
                      Consolidate {activeToken.symbol} into one address
                    </Link>
                  )}
                </div>
              )}

              <Button
                type="submit"
                className="w-full"
                disabled={!to || (!sendAll && !amount) || account.isLoading}
              >
                Review
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      {stage.kind === "review" && (
        <Card className="mt-5">
          <CardHeader>
            <CardTitle>Review and send</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <Row label="To">
              <code className="font-mono break-all">{to.trim()}</code>
            </Row>
            {isTokenSend && stage.senderAddress && (
              <Row label="From">
                <code className="font-mono break-all text-xs">{stage.senderAddress}</code>
              </Row>
            )}
            <Row label="Amount">
              {reviewedAmountLabel}
              {sendAll && !isTokenSend && (
                <span className="text-muted-foreground text-xs ml-1">(all)</span>
              )}
            </Row>
            {isTokenSend && (
              <Row label="Reference output">
                {formatTxc(OMNI_DUST_SATS)}{" "}
                <span className="text-muted-foreground text-xs">(dust to recipient)</span>
              </Row>
            )}
            <Row label="Network fee">
              {formatTxc(stage.feeSats)}{" "}
              <span className="text-muted-foreground text-xs">
                ({stage.vsize} vB × {feeRate} sat/vB)
              </span>
            </Row>
            {stage.fund && (
              <div className="rounded-md border border-border/60 bg-muted/40 p-3 text-xs text-muted-foreground">
                That address holds your tokens but no TXC, so this sends two transactions: first{" "}
                {formatTxc(stage.fund.sats)} (+ {formatTxc(stage.fund.feeSats)} fee) from your other
                coins to <span className="font-mono break-all">{stage.senderAddress}</span>, then
                the token transfer itself. Both are automatic.
              </div>
            )}

            {!isTokenSend && <Row label="Total">{formatTxc(reviewedOutSats + stage.feeSats)}</Row>}
            {error && (
              <div className="flex items-start gap-2 text-sm text-destructive">
                <AlertTriangle className="h-4 w-4 mt-0.5" /> {error}
              </div>
            )}
            <div className="flex gap-2 pt-2">
              <Button variant="ghost" onClick={() => setStage({ kind: "form" })} disabled={busy}>
                Edit
              </Button>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button className="flex-1" disabled={busy}>
                    {busy
                      ? (progress ?? "Sending…")
                      : `Send ${isTokenSend && activeToken ? activeToken.symbol : "TXC"}`}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Confirm transaction</AlertDialogTitle>
                    <AlertDialogDescription asChild>
                      <div className="space-y-2 text-sm">
                        <div>
                          Send <strong>{reviewedAmountLabel}</strong> to
                        </div>
                        <code className="block font-mono break-all text-xs bg-muted rounded p-2">
                          {to.trim()}
                        </code>
                        <div className="text-muted-foreground">
                          {isTokenSend ? (
                            <>
                              Reference {formatTxc(OMNI_DUST_SATS)} + network fee{" "}
                              {formatTxc(stage.feeSats)}
                            </>
                          ) : (
                            <>
                              Network fee {formatTxc(stage.feeSats)} · Total{" "}
                              {formatTxc(reviewedOutSats + stage.feeSats)}
                            </>
                          )}
                        </div>
                        <div className="text-destructive text-xs pt-1">
                          TXC transactions are irreversible.
                        </div>
                      </div>
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={send} disabled={busy}>
                      Confirm & send
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </CardContent>
        </Card>
      )}
    </main>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3 border-b border-border/40 pb-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right">{children}</span>
    </div>
  );
}
