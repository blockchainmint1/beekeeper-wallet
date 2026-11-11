/**
 * Cash out to a bank account, in two parts:
 *
 *   Part 1 (here)      total up every stable balance the merchant wants to cash
 *                      out, then send each one to the cash-out deposit address,
 *                      one authorised transfer at a time.
 *   Part 2 (VectorPay) identity verification, bank linking through Plaid and
 *                      the dollar payout.
 *
 * The order is created with VectorPay before any coins move, then confirmed
 * with the txids for what actually went out — a partial run is still valid.
 *
 * Default is one tap: "Cash out $X" picks everything sendable (biggest first,
 * up to the order maximum), creates the order and sends every line in a row.
 * "Choose what to cash out" opens the step-by-step picker instead.
 *
 * NectarPay merchants pay no service fee; everyone else pays 1%.
 */
import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  ExternalLink,
  Landmark,
  Loader2,
  Send,
  Wallet,
  X,
} from "lucide-react";
import { formatEther, type Address } from "viem";
import type { BIP32Interface } from "bip32";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useExchangeFeaturesAllowed } from "@/lib/native/capabilities";
import { getTxcTokenBalancesForAddresses, getTxcTokenBalancesPerAddress } from "@/lib/txc/tokens.functions";
import { sendOmniToken } from "@/lib/txc/omni-send";
import { explorerTxUrl } from "@/lib/txc/mempool";
import { DERIVATION_PATHS as TXC_PATHS } from "@/lib/txc/network";
import { deriveAddress } from "@/lib/txc/wallet";
import { signMessageWithKey } from "@/lib/txc/message-sign";
import { bankLookupMessage } from "@/lib/cashout/proof";
import { EVM_CHAINS } from "@/lib/chains/evm";
import { useWallet } from "@/lib/txc/wallet-context";
import { listLinks } from "@/lib/nectar/link";
import {
  ensureGas,
  ROUNDUP_CHAINS,
  scanEvmCashable,
  sendCashRow,
  signEvmProof,
  signTsdProof,
  cashoutCustomerId,
  type EvmCashRow,
  type TransferProof,
} from "@/lib/cashout/roundup";
import {
  CASHOUT_DISCLOSURES,
  MERCHANT_FEE_BPS,
  ORDER_FEE_BPS,
  ORDER_MAX_USD,
  ORDER_MIN_USD,
  quoteCashout,
  saveLocalVectorPayOrder,
  openVectorPayCheckout,
  type CashoutChain,
  type CashoutAsset,
} from "@/lib/vectorpay";
import { getVectorPayConfig, startVectorPayCashout } from "@/lib/vectorpay.functions";
import { QrScanButton } from "@/components/wallet/QrScanButton";
import { TopupDialog } from "@/components/wallet/TopupDialog";
import { recordEcosystemLink } from "@/lib/ecosystem-links";
import {
  getVectorPayLink,
  parseVectorPayLinkInput,
  setVectorPayLink,
  type VectorPayLink,
} from "@/lib/vectorpay-link";
import { redeemVectorPayLink, vectorPayLinkStatus } from "@/lib/vectorpay-link.functions";
import { appliedAmount, hasAcceptedCashoutTerms, planOneTap, rememberCashoutTerms } from "@/lib/cashout/one-tap";
import { clearCashoutSession, readCashoutSession, recordCashoutLine, writeCashoutSession } from "@/lib/cashout/session";

const ALL_TERM_IDS = CASHOUT_DISCLOSURES.map((d) => d.id) as string[];

type Step = "intro" | "holdings" | "review" | "transfers" | "done";
const STEPS: Step[] = ["intro", "holdings", "review", "transfers", "done"];

/**
 * Prove this wallet owns its VectorPay customer ID before the server asks
 * VectorPay for the bank name and last-4 (round-2 audit 2.4): the lookup is
 * signed with the wallet's own key and names the exact customer ID.
 */
async function signBankLookup(root: BIP32Interface, accountRef: string) {
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

interface Holding {
  key: string;
  chain: CashoutChain;
  label: string;
  sub: string;
  asset: CashoutAsset;
  coinAmount: number;
  usd: number;
  /** Omni property id, for TSD. */
  propertyId?: number;
  evm?: EvmCashRow;
  /** Can't send: no coin for the network fee anywhere. */
  blocked?: string;
}

/** What was sent on one line — saved so a reload can still confirm the order. */
interface SentLine {
  key: string;
  chain: CashoutChain;
  asset: CashoutAsset;
  label: string;
  sub: string;
  coinAmount: number;
  usd: number;
  propertyId?: number;
  evm?: Pick<EvmCashRow, "key" | "chain" | "index" | "address" | "asset" | "token" | "amount">;
}
type RowStatus = { state: "sending" | "sent" | "failed" | "skipped"; txid?: string; error?: string; line?: SentLine };

function toSentLine(row: Holding): SentLine {
  const { key, chain, asset, label, sub, coinAmount, usd, propertyId, evm } = row;
  return {
    key, chain, asset, label, sub, coinAmount, usd, propertyId,
    evm: evm ? { key: evm.key, chain: evm.chain, index: evm.index, address: evm.address, asset: evm.asset, token: evm.token, amount: evm.amount } : undefined,
  };
}

/** Rebuild a row from what was saved at send time (balances may have changed since). */
function fromSentLine(line: SentLine): Holding {
  return {
    ...line,
    evm: line.evm ? { ...line.evm, raw: 0n, nativeWei: 0n, gasWei: 0n, gas: "ready" } as EvmCashRow : undefined,
  };
}

/** Saved per wallet so txids survive a reload (src/lib/cashout/session.ts). */
interface CashoutSession {
  reference: string;
  step: Step;
  accepted: string[];
  selected: string[];
  /** Per-row manually lowered cash-out amount ("partial cash-out"). */
  amounts: Record<string, string>;
  result?: { orderId: string; checkoutUrl: string | null; detail: string } | null;
  status: Record<string, RowStatus>;
}

function fmt(value: number, digits = 6) {
  return value.toLocaleString(undefined, { maximumFractionDigits: digits });
}

function newReference() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const suffix = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
  return `BK-${Date.now().toString(36).toUpperCase()}-${suffix}`;
}

/** Raw token amount for a partial cash-out row (undefined = send the full balance). */
function partialRaw(row: Holding, amounts: Record<string, string>): bigint | undefined {
  if (!row.evm) return undefined;
  const txt = amounts[row.key];
  if (!txt) return undefined;
  const v = Number(txt);
  if (!Number.isFinite(v) || v <= 0) return undefined;
  const raw = BigInt(Math.round(v * 10 ** row.evm.token.decimals));
  return raw > 0n && raw < row.evm.raw ? raw : undefined;
}

export function CashoutActions({
  txcAddresses,
}: {
  txcAddresses: string[];
  evmAddress?: string | null;
}) {
  const allowed = useExchangeFeaturesAllowed();
  const { root, unlocked } = useWallet();
  const [topupOpen, setTopupOpen] = useState(false);
  const configFn = useServerFn(getVectorPayConfig);
  const startCashout = useServerFn(startVectorPayCashout);
  const fetchTsd = useServerFn(getTxcTokenBalancesForAddresses);
  const fetchTsdPerAddr = useServerFn(getTxcTokenBalancesPerAddress);
  const [tsdProgress, setTsdProgress] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const config = useQuery({
    queryKey: ["vectorpay-config"],
    queryFn: () => configFn(),
    staleTime: 60_000,
    enabled: allowed,
  });
  const destinations = config.data?.destinations ?? { txc: null, base: null, eth: null, bsc: null, tron: null };

  const addressKey = txcAddresses.slice().sort().join(",");
  const tsd = useQuery({
    queryKey: ["cashout-tsd", addressKey],
    enabled: allowed && open && txcAddresses.length > 0,
    queryFn: () => fetchTsd({ data: { addresses: txcAddresses, propertyIds: [39] } }),
    staleTime: 15_000,
  });

  const evmChains = ROUNDUP_CHAINS.filter((c) => destinations[c]);
  const evm = useQuery({
    queryKey: ["cashout-evm-roundup", root ? root.neutered().toBase58().slice(0, 24) : null, evmChains.join(",")],
    enabled: allowed && open && !!root && evmChains.length > 0,
    queryFn: () => scanEvmCashable(root!, evmChains),
    staleTime: 15_000,
  });

  const [step, setStep] = useState<Step>("intro");
  const [accepted, setAccepted] = useState<string[]>([]);
  const [selected, setSelected] = useState<string[] | null>(null);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<Record<string, RowStatus>>({});
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ orderId: string; checkoutUrl: string | null; detail: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [reference, setReference] = useState("");
  // Cash-out terms are agreed once per wallet, then remembered.
  const [termsOk, setTermsOk] = useState(false);
  const [agreeNow, setAgreeNow] = useState(false);
  const [showTerms, setShowTerms] = useState(false);
  const [autoRun, setAutoRun] = useState(false);
  useEffect(() => {
    if (!open) return;
    const ok = hasAcceptedCashoutTerms(ALL_TERM_IDS);
    setTermsOk(ok);
    if (ok) setAccepted((current) => (current.length ? current : ALL_TERM_IDS));
  }, [open]);

  // Restore an in-progress cash-out (e.g. after sending TSD on its own screen).
  useEffect(() => {
    try {
      const saved = readCashoutSession<CashoutSession>();
      const anySent = !!saved && Object.values(saved.status ?? {}).some((st) => st?.state === "sent");
      if (!saved || !saved.reference || !anySent) {
        // Nothing left in flight — start fresh.
        if (saved) clearCashoutSession();
        setReference(newReference());
        return;
      }
      setReference(saved.reference);
      setStep((saved.step as string) === "details" ? "review" : saved.step);
      setAccepted(saved.accepted);
      setSelected(saved.selected);
      setAmounts(saved.amounts ?? {});
      // A send that was mid-flight when the page closed: show it as needing a
      // check — "Try again" first looks for that same transaction on chain.
      const restored: Record<string, RowStatus> = {};
      for (const [k, v] of Object.entries(saved.status ?? {})) {
        restored[k] = v.state === "sending" ? { state: "failed", error: "Interrupted — tap Try again; it checks whether it already went out." } : v;
      }
      setStatus(restored);
      if (saved.result) setResult(saved.result);
      if (saved.step !== "intro") setOpen(true);
    } catch {
      setReference(newReference());
    }
  }, []);
  useEffect(() => {
    if (!reference || step === "intro" || step === "done") return;
    const session: CashoutSession = { reference, step, accepted, selected: selected ?? [], amounts, status, result };
    writeCashoutSession(session);
  }, [reference, step, accepted, selected, amounts, status, result]);

  // NectarPay merchants cash out with no service fee.
  const [merchantId, setMerchantId] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setMerchantId(listLinks()[0]?.merchantId ?? null);
  }, [open]);
  const feeBps = merchantId ? MERCHANT_FEE_BPS : ORDER_FEE_BPS;

  // Cash out requires a linked VectorPay account. Check the local record,
  // then confirm with VectorPay (picks up links made on another device).
  const [vpLink, setVpLink] = useState<VectorPayLink | null>(null);
  const [vpChecking, setVpChecking] = useState(false);
  const [vpCode, setVpCode] = useState("");
  const [vpBusy, setVpBusy] = useState(false);
  const [vpError, setVpError] = useState<string | null>(null);
  useEffect(() => {
    if (!open || !root) return;
    setVpLink(getVectorPayLink());
    setVpChecking(true);
    void (async () => {
      try {
        const accountRef = await cashoutCustomerId(root);
        const reply = await vectorPayLinkStatus({ data: { accountRef, ...(await signBankLookup(root, accountRef)) } });
        if (reply.ok && reply.linked) {
          setVectorPayLink({ firstName: reply.firstName, bank: reply.bank });
          setVpLink(getVectorPayLink());
        }
      } catch {
        /* offline — fall back to the local record */
      } finally {
        setVpChecking(false);
      }
    })();
  }, [open, root]);

  async function onLinkVectorPay(raw: string) {
    if (!root) return;
    const code = parseVectorPayLinkInput(raw);
    if (!code) {
      setVpError("That isn't a VectorPay link code. Copy the code or scan the QR on your VectorPay dashboard.");
      return;
    }
    setVpBusy(true);
    setVpError(null);
    try {
      const accountRef = await cashoutCustomerId(root);
      const reply = await redeemVectorPayLink({ data: { code, accountRef } });
      if (!reply.ok || !reply.linked) {
        setVpError(reply.detail);
        return;
      }
      setVectorPayLink({ firstName: reply.firstName, bank: reply.bank });
      recordEcosystemLink({
        id: "vectorpay",
        app: "VectorPay",
        detail: reply.bank ? `${reply.bank.institution ?? "Bank"} ····${reply.bank.mask}` : "Cash out to your bank",
      });
      setVpLink(getVectorPayLink());
      setVpCode("");
    } catch (e) {
      setVpError(e instanceof Error ? e.message : "Could not link VectorPay.");
    } finally {
      setVpBusy(false);
    }
  }

  /** Everything this wallet holds that a cash-out deposit address can accept. */
  const cashable = useMemo<Holding[]>(() => {
    const list: Holding[] = [];
    const tsdAmount = Number(BigInt(tsd.data?.[39] ?? "0")) / 1e8;
    if (tsdAmount > 0 && destinations.txc) {
      list.push({ key: "t:tsd", chain: "txc", label: "TSD on TEXITcoin", sub: "Sent right here, from your TEXITcoin wallet", asset: "TSD", coinAmount: tsdAmount, usd: tsdAmount, propertyId: 39 });
    }
    for (const row of evm.data ?? []) {
      const chain = EVM_CHAINS[row.chain];
      const fee = `~${Number(formatEther(row.gasWei)).toFixed(6)} ${chain.nativeSymbol} fee`;
      list.push({
        key: row.key,
        chain: row.chain,
        label: `${row.asset} on ${chain.name}`,
        sub: `${row.index === 0 ? "Main address" : `Address #${row.index}`} · ${fee}${row.gas === "fund" ? " (topped up from main)" : ""}`,
        asset: row.asset,
        coinAmount: row.amount,
        usd: row.amount,
        evm: row,
        blocked: row.gas === "nogas" ? `Needs a little ${chain.nativeSymbol} for the network fee` : undefined,
      });
    }
    return list.sort((a, b) => b.usd - a.usd);
  }, [tsd.data, evm.data, destinations.txc]);

  const cashableByKey = useMemo(() => new Map(cashable.map((r) => [r.key, r])), [cashable]);
  // Rows with a manually lowered amount ("cash out only part of this balance").
  const cashableEff = useMemo(() => cashable.map((r) => appliedAmount(r, amounts)), [cashable, amounts]);
  // What the one-tap button will send.
  const oneTap = useMemo(() => planOneTap(cashable, ORDER_MAX_USD), [cashable]);
  const oneTapQuote = quoteCashout(oneTap.total, feeBps);
  const availableUsd = cashable
    .filter((r) => !r.blocked && !(r.chain === "eth" && r.usd < 10))
    .reduce((sum, r) => sum + r.usd, 0);

  // Default: everything sendable, except tiny Ethereum balances the fee would eat.
  useEffect(() => {
    if (selected !== null || step !== "holdings" || tsd.isLoading || evm.isLoading) return;
    setSelected(cashable.filter((r) => !r.blocked && !(r.chain === "eth" && r.usd < 10)).map((r) => r.key));
  }, [selected, step, cashable, tsd.isLoading, evm.isLoading]);

  const picked = selected ?? [];
  const chosen = useMemo(() => {
    // Lines already sent use what was saved at send time: after a reload the
    // fresh balance scan no longer shows the coins that left.
    const fresh = new Map(cashableEff.map((row) => [row.key, row]));
    const out: Holding[] = [];
    for (const key of picked) {
      const st = status[key];
      if (st?.state === "sent" && st.line) out.push(fromSentLine(st.line));
      else if (fresh.has(key)) out.push(fresh.get(key)!);
    }
    return out;
  }, [cashableEff, picked, status]);
  const chosenTotal = chosen.reduce((sum, row) => sum + row.usd, 0);
  const sentRows = chosen.filter((row) => status[row.key]?.state === "sent");
  const sentTotal = sentRows.reduce((sum, row) => sum + row.usd, 0);
  const evmPending = chosen.filter((r) => r.evm && status[r.key]?.state !== "sent");
  const hasUnconfirmedSends = step !== "done" && Object.values(status).some((st) => st?.state === "sent");
  const allResolved = chosen.every((r) => status[r.key]?.state === "sent" || status[r.key]?.state === "skipped");
  // A checked row with a typed amount that isn't a valid partial amount.
  const invalidAmounts = picked.some((key) => {
    const orig = cashableByKey.get(key);
    if (!orig || orig.blocked) return false;
    const txt = amounts[key];
    if (txt === undefined || txt === "") return false;
    const v = Number(txt);
    return !Number.isFinite(v) || v <= 0 || v > orig.usd;
  });

  const quote = quoteCashout(chosenTotal, feeBps);
  const finalQuote = quoteCashout(Math.min(sentTotal, ORDER_MAX_USD), feeBps);
  const allAccepted = accepted.length === CASHOUT_DISCLOSURES.length;
  const totalError =
    chosenTotal < ORDER_MIN_USD
      ? `Select at least $${ORDER_MIN_USD} to cash out.`
      : chosenTotal > ORDER_MAX_USD
        ? `Orders top out at $${ORDER_MAX_USD}. Uncheck a wallet or two.`
        : null;
  const scanning = tsd.isLoading || evm.isLoading || config.isLoading;

  if (!allowed) return null;

  function reset() {
    setStep("intro");
    setAccepted([]);
    setSelected(null);
    setAmounts({});
    setStatus({});
    setError(null);
    setResult(null);
    setReference(newReference());
    clearCashoutSession();
  }

  /** Send one EVM balance to its deposit address (tops up gas first if needed). */
  async function sendEvmRow(row: Holding, pending: Holding[], partial: Record<string, string>): Promise<RowStatus> {
    const e = row.evm;
    const to = e ? (destinations[e.chain] as Address | null) : null;
    if (!root || !e || !to) return { state: "failed", error: "No cash-out address for this chain" };
    setStatus((s) => ({ ...s, [row.key]: { state: "sending" } }));
    let next: RowStatus;
    try {
      const count = pending.filter((r) => r.evm && r.evm.chain === e.chain && r.evm.index === e.index).length || 1;
      await ensureGas(root, e.chain, e.index, count, `${reference}:${e.chain}:${e.index}`);
      const txid = await sendCashRow(root, e, to, partialRaw(row, partial), `${reference}:${row.key}`);
      next = { state: "sent", txid, line: toSentLine(row) };
    } catch (cause) {
      next = { state: "failed", error: cause instanceof Error ? cause.message.split("\n")[0] : "Send failed" };
    }
    recordCashoutLine(row.key, next);
    setStatus((s) => ({ ...s, [row.key]: next }));
    return next;
  }

  /** Send TSD right here — same Omni logic as the Send screen, no page change. */
  async function sendTsd(row: Holding): Promise<RowStatus> {
    const to = destinations.txc;
    if (!root || !unlocked || !row.propertyId || !to) return { state: "failed", error: "Wallet locked or no TSD cash-out address" };
    setStatus((s) => ({ ...s, [row.key]: { state: "sending" } }));
    let next: RowStatus;
    try {
      const txid = await sendOmniToken({
        root,
        kind: unlocked.kind,
        propertyId: row.propertyId,
        amountUnits: BigInt(Math.round(row.coinAmount * 1e8)),
        to,
        fetchPerAddress: (addresses, propertyIds) => fetchTsdPerAddr({ data: { addresses, propertyIds } }),
        onProgress: setTsdProgress,
        tag: `${reference}:${row.key}`,
      });
      next = { state: "sent", txid, line: toSentLine(row) };
    } catch (cause) {
      next = { state: "failed", error: cause instanceof Error ? cause.message.split("\n")[0] : "Send failed" };
    } finally {
      setTsdProgress(null);
    }
    recordCashoutLine(row.key, next);
    setStatus((s) => ({ ...s, [row.key]: next }));
    return next;
  }

  /** Manual "Send" / "Try again" button on one line. */
  async function sendOne(row: Holding) {
    if (running) return;
    setRunning(true);
    setError(null);
    try {
      if (row.evm) await sendEvmRow(row, evmPending, amounts);
      else await sendTsd(row);
    } finally {
      setRunning(false);
    }
  }

  /**
   * Called twice with the same reference: first before any coins move (no
   * txids), then after sending with fresh proofs that carry the txids —
   * VectorPay looks EVM deposits up by txid and dedupes repeats.
   * Returns true when VectorPay accepted the order.
   */
  async function submitOrder(
    final: boolean,
    rows: Holding[],
    st: Record<string, RowStatus>,
    acceptedIds: string[],
  ): Promise<boolean> {
    if (!root || rows.length === 0) return false;
    setSubmitting(true);
    setError(null);
    try {
      const total = rows.reduce((sum, row) => sum + row.usd, 0);
      const q = quoteCashout(Math.min(total, ORDER_MAX_USD), feeBps);
      const proofs: Array<TransferProof & { usd: number }> = [];
      // Order first: proofs sign the sending wallet before any coins move, so
      // VectorPay matches deposits that arrive later from these addresses.
      for (const row of rows) {
        const to = destinations[row.chain] ?? "";
        const txids = final && st[row.key]?.txid ? [st[row.key]!.txid!] : [];
        const amount = String(row.coinAmount);
        const proof = row.evm
          ? await signEvmProof(root, { reference, chain: row.evm.chain, asset: row.asset, index: row.evm.index, to, txids, amount })
          : signTsdProof(root, { reference, to, txids, amount });
        proofs.push({ ...proof, usd: Math.round(row.usd * 100) / 100 });
      }
      const send = async () => startCashout({
        data: {
          reference,
          usd: q.usd,
          customerId: await cashoutCustomerId(root),
          acceptedDisclaimers: acceptedIds,
          ...(merchantId ? { merchantId } : {}),
          transfers: proofs.map((p) => ({
            chain: p.chain as CashoutChain,
            asset: p.asset,
            usd: p.usd,
            from: p.from,
            txids: p.txids,
            amount: p.amount,
            message: p.message,
            signature: p.signature,
          })),
        },
      });
      let response = await send();
      // Sends that are still confirming: wait and ask again (up to ~2 minutes).
      for (let attempt = 0; final && !response.registered && "retryable" in response && response.retryable && attempt < 8; attempt++) {
        setError("Waiting for the network to confirm your sends…");
        await new Promise((r) => setTimeout(r, 15_000));
        response = await send();
      }
      setError(null);
      saveLocalVectorPayOrder({
        id: response.orderId,
        side: "sell",
        createdAt: Date.now(),
        status: response.registered ? "ready" : "registration_failed",
        // The server settles amounts from the blockchain; show its numbers.
        usd: "usd" in response && typeof response.usd === "number" ? response.usd : q.usd,
        feeUsd: response.feeUsd,
        settlementUsd: "usd" in response && typeof response.usd === "number" ? Math.round((response.usd - response.feeUsd) * 100) / 100 : q.settlementUsd,
        assetAmount: q.assetAmount,
        asset: response.asset ?? "TSD",
        chain: response.chain ?? "txc",
        checkoutUrl: response.handoffUrl,
        detail: response.detail,
        transfers: response.transfers.map((p) => ({ chain: p.chain as CashoutChain, asset: p.asset, usd: p.usd })),
      });
      setResult({ orderId: response.orderId, checkoutUrl: response.handoffUrl, detail: response.detail });
      if (!response.registered || !response.handoffUrl) {
        setError(response.detail || "VectorPay couldn't create the order. Nothing was sent.");
        return false;
      }
      if (final) {
        setStep("done");
        clearCashoutSession();
        return true;
      }
      // Already linked at VectorPay — no checkout bounce; go straight to sending.
      setStep("transfers");
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create the order.");
      return false;
    } finally {
      setSubmitting(false);
    }
  }

  /** Step-by-step flow buttons ("Create order…" and "Complete cash-out"). */
  async function placeOrder(final = false) {
    if (!allAccepted || chosen.length === 0) return;
    if (final && sentRows.length === 0) return;
    rememberCashoutTerms(accepted);
    await submitOrder(final, final ? sentRows : chosen, status, accepted);
  }

  /**
   * The one-tap cash-out: pick everything, create the order, send each line
   * in a row, then confirm. If a line fails, stop on the send list so the
   * merchant can try it again or skip it — the order covers only what landed.
   */
  async function runOneTap() {
    if (!root || running || oneTap.total < ORDER_MIN_USD) return;
    if (!termsOk && !agreeNow) return;
    rememberCashoutTerms(ALL_TERM_IDS);
    setTermsOk(true);
    const rows = cashable.filter((r) => oneTap.keys.includes(r.key)).map((r) => appliedAmount(r, oneTap.amounts));
    setAccepted(ALL_TERM_IDS);
    setSelected(oneTap.keys);
    setAmounts(oneTap.amounts);
    setStatus({});
    setError(null);
    setRunning(true);
    setAutoRun(true);
    try {
      if (!(await submitOrder(false, rows, {}, ALL_TERM_IDS))) return;
      const st: Record<string, RowStatus> = {};
      for (const row of rows) {
        const pending = rows.filter((r) => r.evm && !st[r.key]);
        st[row.key] = row.evm ? await sendEvmRow(row, pending, oneTap.amounts) : await sendTsd(row);
      }
      if (rows.every((r) => st[r.key]?.state === "sent")) {
        await submitOrder(true, rows, st, ALL_TERM_IDS);
      }
    } finally {
      setRunning(false);
      setAutoRun(false);
    }
  }

  return (
    <section className="px-4 pt-4">
      <div className="grid grid-cols-2 gap-3">
        <Button variant="outline" size="lg" onClick={() => setTopupOpen(true)}>
          <ArrowDownToLine /> Top up
        </Button>
        <Button size="lg" onClick={() => setOpen(true)}>
          <ArrowUpFromLine /> Cash out
        </Button>
      </div>
      <TopupDialog open={topupOpen} onOpenChange={setTopupOpen} />

      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          // Coins already sent but the order isn't confirmed yet: keep
          // everything so reopening Cash out finishes the same order.
          if (!next && !hasUnconfirmedSends) reset();
        }}
      >
        <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-md">
          <DialogHeader>
            <p className="text-xs font-semibold uppercase text-primary">
              {step === "intro" || autoRun || step === "done" ? "Cash out" : `Cash out · ${STEPS.indexOf(step) + 1} of ${STEPS.length}`}
            </p>
            <DialogTitle>{step === "done" ? "Cash-out sent" : "Cash out to your bank"}</DialogTitle>
            <DialogDescription>Turn your USDC, USDT and TSD into dollars in your bank account.</DialogDescription>
          </DialogHeader>

          {step === "intro" && vpLink?.bank && (
            <div className="space-y-4 text-sm text-muted-foreground">
              <div className="rounded-lg border border-primary/30 bg-primary/5 p-4 text-center">
                <p className="text-xs font-medium uppercase">Ready to cash out</p>
                {scanning ? (
                  <p className="mt-2 flex items-center justify-center gap-2 text-sm">
                    <Loader2 className="h-4 w-4 animate-spin" /> Checking every chain and your first 20 addresses…
                  </p>
                ) : (
                  <>
                    <p className="mt-1 text-4xl font-semibold text-foreground">${fmt(oneTap.total, 2)}</p>
                    <p className="mt-1 text-xs">
                      You get about <span className="font-semibold text-foreground">${oneTapQuote.settlementUsd.toFixed(2)}</span>
                      {" "}in {vpLink.bank.institution ?? "your bank"} ····{vpLink.bank.mask}
                    </p>
                    <p className="mt-1 text-xs">
                      {feeBps === 0 ? "No service fee (NectarPay merchant)" : `1% service fee ($${oneTapQuote.feeUsd.toFixed(2)})`} · 1–3 business days
                    </p>
                  </>
                )}
              </div>

              {!scanning && oneTap.total < ORDER_MIN_USD && (
                <p className="text-center text-sm text-destructive">
                  {cashable.length === 0
                    ? "No USDC, USDT or TSD to cash out yet."
                    : `You need at least $${ORDER_MIN_USD} that can pay its own network fee.`}
                </p>
              )}
              {!scanning && availableUsd > oneTap.total + 0.01 && oneTap.total >= ORDER_MIN_USD && (
                <p className="text-center text-xs">
                  You have ${fmt(availableUsd, 2)}. Orders top out at ${ORDER_MAX_USD}, so this sends the first $
                  {ORDER_MAX_USD} — tap again afterwards for the rest.
                </p>
              )}

              {!termsOk && (
                <div className="space-y-2 rounded-md border border-border/60 p-3">
                  <label className="flex items-start gap-3 text-xs leading-relaxed">
                    <Checkbox checked={agreeNow} onCheckedChange={(v) => setAgreeNow(v === true)} />
                    <span>
                      I agree to the cash-out terms.{" "}
                      <button type="button" className="text-primary underline" onClick={() => setShowTerms((v) => !v)}>
                        {showTerms ? "Hide" : "Read them"}
                      </button>
                    </span>
                  </label>
                  {showTerms && (
                    <ul className="list-disc space-y-1 pl-9 text-xs leading-relaxed">
                      {CASHOUT_DISCLOSURES.map((item) => (
                        <li key={item.id}>
                          {item.text}
                          {item.id === "terms" && (
                            <>
                              {" "}
                              <Link to="/legal/terms" target="_blank" className="text-primary underline">Terms</Link> ·{" "}
                              <Link to="/legal/privacy" target="_blank" className="text-primary underline">Privacy</Link>
                            </>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                  <p className="pl-7 text-[11px]">Asked once — BeeKeeper remembers it for this wallet.</p>
                </div>
              )}

              {error && <p className="text-sm text-destructive">{error}</p>}

              <Button
                size="lg"
                className="h-14 w-full text-base"
                disabled={scanning || running || submitting || oneTap.total < ORDER_MIN_USD || (!termsOk && !agreeNow)}
                onClick={() => void runOneTap()}
              >
                {submitting || running ? (
                  <><Loader2 className="animate-spin" /> Starting…</>
                ) : (
                  <><ArrowUpFromLine /> Cash out ${fmt(oneTap.total, 2)}</>
                )}
              </Button>
              <button
                type="button"
                className="w-full text-center text-xs text-primary underline disabled:opacity-50"
                disabled={scanning || running}
                onClick={() => setStep("holdings")}
              >
                Choose what to cash out instead
              </button>
            </div>
          )}

          {step === "intro" && !vpLink?.bank && (
            <div className="space-y-4 text-sm text-muted-foreground">
              <p>
                BeeKeeper rounds up every USDC, USDT and TSD you hold — on every chain and your first 20 addresses —
                and sends it to VectorPay, who pays your linked bank.
              </p>
              <div className="rounded-md border border-border/60 bg-muted/40 p-3">
                <p className="font-medium text-foreground">
                  {merchantId ? "No service fee · 1–3 business days" : "1% service fee · 1–3 business days"}
                </p>
                <p className="mt-1">
                  {merchantId
                    ? "NectarPay merchant — you cash out free. Any amount up to $1,000 per order."
                    : "Any amount up to $1,000 per order. NectarPay merchants pay no fee."}
                </p>
              </div>
              {vpLink ? (
                <div className="space-y-3">
                  <p className="rounded-md border border-border/60 bg-muted/40 p-3 text-foreground">
                    {vpLink.bank
                      ? `Pays out to ${vpLink.bank.institution ?? "your bank"} ····${vpLink.bank.mask}`
                      : "VectorPay linked — no bank on file yet. Add one in your VectorPay account first."}
                    {vpLink.firstName ? ` · ${vpLink.firstName}` : ""}
                  </p>
                  <Button className="w-full" disabled={!vpLink.bank} onClick={() => setStep("holdings")}>Get started</Button>
                </div>
              ) : (
                <div className="space-y-3 rounded-md border border-border/60 p-3">
                  <p className="font-medium text-foreground">First, link your VectorPay account</p>
                  <p>
                    VectorPay handles identity, your bank and the payout. Sign in at vector-pay.com, open
                    &quot;Connect your wallet&quot;, then paste the code or scan its QR here.
                  </p>
                  <div className="flex gap-2">
                    <Input
                      value={vpCode}
                      onChange={(e) => setVpCode(e.target.value)}
                      placeholder="Link code (e.g. CVMR-ZFYE)"
                      className="text-xs"
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <QrScanButton
                      onScan={(text) => {
                        setVpCode(text);
                        void onLinkVectorPay(text);
                      }}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      disabled={vpBusy || !vpCode.trim()}
                      onClick={() => void onLinkVectorPay(vpCode)}
                    >
                      {vpBusy ? "Linking…" : "Link"}
                    </Button>
                  </div>
                  {vpChecking && <p className="text-xs">Checking for an existing link…</p>}
                  {vpError && <p className="text-xs text-destructive">{vpError}</p>}
                </div>
              )}
            </div>
          )}

          {step === "holdings" && (
            <div className="space-y-4">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-medium">What you can cash out</p>
                  <p className="text-xs text-muted-foreground">
                    Only USDC, USDT and TSD can be cashed out. Everything is selected by default.
                  </p>
                </div>
                <div className="flex shrink-0 gap-1.5">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 px-2.5 text-xs"
                    onClick={() => setSelected(cashable.filter((r) => !r.blocked).map((r) => r.key))}
                  >
                    All
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 px-2.5 text-xs"
                    onClick={() => setSelected([])}
                  >
                    None
                  </Button>
                </div>
              </div>

              {scanning && (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> Checking every chain and your first 20 addresses…
                </p>
              )}

              {cashable.length === 0 && !scanning && (
                <p className="text-sm text-destructive">No USDC, USDT or TSD balances to cash out yet.</p>
              )}

              <div className="space-y-2">
                {cashableEff.map((row) => {
                  const orig = cashableByKey.get(row.key)!;
                  const checked = picked.includes(row.key);
                  const typed = amounts[row.key] ?? "";
                  return (
                    <div
                      key={row.key}
                      className={`rounded-md border border-border/60 bg-muted/30 p-3 ${row.blocked ? "opacity-60" : ""}`}
                    >
                      <div className="flex items-start gap-3">
                        <Checkbox
                          id={`cashout-${row.key}`}
                          className="mt-0.5"
                          checked={checked}
                          disabled={Boolean(row.blocked)}
                          onCheckedChange={(next) =>
                            setSelected((current) => {
                              const list = current ?? [];
                              return next ? [...list, row.key] : list.filter((value) => value !== row.key);
                            })
                          }
                        />
                        <label htmlFor={`cashout-${row.key}`} className="min-w-0 flex-1 cursor-pointer">
                          <span className="flex items-center justify-between gap-2 text-sm font-medium">
                            <span className="flex items-center gap-1.5">
                              <Wallet className="h-3.5 w-3.5 text-primary" /> {row.label}
                            </span>
                            <span>${fmt(row.usd, 2)}</span>
                          </span>
                          <span className={`mt-0.5 block text-xs ${row.blocked ? "text-destructive" : "text-muted-foreground"}`}>
                            {row.blocked ?? row.sub}
                          </span>
                        </label>
                      </div>
                      {checked && !row.blocked && (
                        <div className="mt-2 flex items-center gap-2 pl-7">
                          <span className="shrink-0 text-xs text-muted-foreground">Cash out</span>
                          <Input
                            inputMode="decimal"
                            value={typed}
                            onChange={(e) =>
                              setAmounts((current) => ({ ...current, [row.key]: e.target.value.replace(/[^0-9.]/g, "") }))
                            }
                            placeholder={fmt(orig.usd, 2)}
                            className="h-7 w-24 text-right text-xs"
                            autoComplete="off"
                          />
                          <span className="text-xs text-muted-foreground">
                            {typed ? `of $${fmt(orig.usd, 2)}` : `— blank for all $${fmt(orig.usd, 2)}`}
                          </span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              <div className="space-y-2 rounded-md border border-border/60 bg-muted/40 p-3 text-sm">
                <Row label="Total to cash out" value={`$${fmt(chosenTotal, 2)}`} strong />
                <Row label={feeBps === 0 ? "Service fee (merchant)" : "Service fee (1%)"} value={`$${quote.feeUsd.toFixed(2)}`} />
                <Row label="Estimated to your bank" value={`$${quote.settlementUsd.toFixed(2)}`} strong />
              </div>

              {invalidAmounts && (
                <p className="text-sm text-destructive">
                  Each amount must be more than $0 and no more than that balance. Leave a line blank to send all of it.
                </p>
              )}

              {totalError && <p className="text-sm text-destructive">{totalError}</p>}

              <div className="flex gap-2">
                <Button variant="outline" onClick={() => setStep("intro")}>Back</Button>
                <Button className="flex-1" disabled={Boolean(totalError) || invalidAmounts} onClick={() => setStep("review")}>
                  Continue
                </Button>
              </div>
            </div>
          )}

          {step === "review" && (
            <div className="space-y-4">
              <div className="space-y-2 rounded-md border border-border/60 bg-muted/40 p-3 text-sm">
                <Row label="You send" value={`$${fmt(chosenTotal, 2)} from ${chosen.length} ${chosen.length === 1 ? "wallet" : "wallets"}`} />
                <Row label={feeBps === 0 ? "Service fee (merchant)" : "Service fee (1%)"} value={`$${quote.feeUsd.toFixed(2)}`} />
                <Row label="Estimated to your bank" value={`$${quote.settlementUsd.toFixed(2)}`} strong />
              </div>
              <div className="space-y-3">
                {CASHOUT_DISCLOSURES.map((item) => (
                  <label key={item.id} className="flex items-start gap-3 text-xs leading-relaxed text-muted-foreground">
                    <Checkbox
                      checked={accepted.includes(item.id)}
                      onCheckedChange={(checked) =>
                        setAccepted((current) => (checked ? [...current, item.id] : current.filter((id) => id !== item.id)))
                      }
                    />
                    <span>
                      {item.text}
                      {item.id === "terms" && (
                        <>
                          {" "}
                          <Link to="/legal/terms" target="_blank" className="text-primary underline">Terms</Link> ·{" "}
                          <Link to="/legal/privacy" target="_blank" className="text-primary underline">Privacy</Link>
                        </>
                      )}
                    </span>
                  </label>
                ))}
              </div>
              {error && <p className="text-sm text-destructive">{error}</p>}
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => setStep("holdings")}>Back</Button>
                <Button className="flex-1" disabled={!allAccepted || submitting} onClick={() => void placeOrder()}>
                  {submitting ? <><Loader2 className="animate-spin" /> Creating order</> : "Create cash-out order with VectorPay"}
                </Button>
              </div>
            </div>
          )}

          {step === "transfers" && (
            <div className="space-y-4">
              <div>
                <p className="text-sm font-medium">{autoRun ? "Sending everything now" : "Send each one"}</p>
                <p className="text-xs text-muted-foreground">
                  {autoRun
                    ? `Order ${reference} is open at VectorPay. Keep this window open — each line ticks off as it goes.`
                    : `Your order ${reference} is waiting at VectorPay. Tap Send on each line. If one fails, tap it again or skip it — the order only covers what actually went out.`}
                </p>
              </div>

              <div className="space-y-2">
                {chosen.map((row) => {
                  const st = status[row.key];
                  const to = destinations[row.chain] ?? "";
                  return (
                    <div key={row.key} className="rounded-md border border-border/60 bg-muted/30 p-3">
                      <div className="flex items-center justify-between gap-2 text-sm font-medium">
                        <span className="flex items-center gap-1.5">
                          {st?.state === "sent" ? (
                            <Check className="h-3.5 w-3.5 text-primary" />
                          ) : st?.state === "sending" ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                          ) : st?.state === "failed" ? (
                            <X className="h-3.5 w-3.5 text-destructive" />
                          ) : (
                            <Wallet className="h-3.5 w-3.5 text-primary" />
                          )}
                          {row.label}
                        </span>
                        <span>${fmt(row.usd, 2)}</span>
                      </div>
                      <p className="mt-0.5 text-xs text-muted-foreground">{row.sub}</p>
                      {st?.state === "sent" && st.txid && row.evm && (
                        <a
                          href={EVM_CHAINS[row.evm.chain].explorerTx(st.txid)}
                          target="_blank"
                          rel="noreferrer"
                          className="mt-1 inline-flex items-center gap-1 text-xs text-primary underline"
                        >
                          View transfer <ExternalLink className="h-3 w-3" />
                        </a>
                      )}
                      {st?.state === "failed" && <p className="mt-1 text-xs text-destructive">{st.error}</p>}
                      {row.evm && st?.state !== "sent" && (
                        <div className="mt-2 flex items-center gap-2">
                          <Button
                            type="button"
                            size="sm"
                            className="flex-1"
                            disabled={running || !root || !to}
                            onClick={() => void sendOne(row)}
                          >
                            {st?.state === "sending" ? <><Loader2 className="animate-spin" /> Sending…</> : <><Send /> {st?.state === "failed" ? "Try again" : `Send ${row.asset}`}</>}
                          </Button>
                          {st?.state === "failed" && (
                            <Button type="button" size="sm" variant="outline" disabled={running} onClick={() => setStatus((s) => ({ ...s, [row.key]: { state: "skipped" } }))}>
                              Skip
                            </Button>
                          )}
                        </div>
                      )}
                      {st?.state === "skipped" && <p className="mt-1 text-xs text-muted-foreground">Skipped — not included.</p>}
                      {st?.state === "sent" && st.txid && !row.evm && (
                        <a
                          href={explorerTxUrl(st.txid)}
                          target="_blank"
                          rel="noreferrer"
                          className="mt-1 inline-flex items-center gap-1 text-xs text-primary underline"
                        >
                          View transfer <ExternalLink className="h-3 w-3" />
                        </a>
                      )}
                      {!row.evm && st?.state !== "sent" && st?.state !== "skipped" && (
                        <div className="mt-2 flex items-center gap-2">
                          <Button
                            type="button"
                            size="sm"
                            className="flex-1"
                            disabled={running || !root || !unlocked || !to}
                            onClick={() => void sendOne(row)}
                          >
                            {st?.state === "sending" ? <><Loader2 className="animate-spin" /> {tsdProgress ?? "Sending…"}</> : <><Send /> {st?.state === "failed" ? "Try again" : `Send ${row.asset}`}</>}
                          </Button>
                          {st?.state === "failed" && (
                            <Button type="button" size="sm" variant="outline" disabled={running} onClick={() => setStatus((s) => ({ ...s, [row.key]: { state: "skipped" } }))}>
                              Skip
                            </Button>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              <div className="space-y-2 rounded-md border border-border/60 bg-muted/40 p-3 text-sm">
                <Row label="Sent so far" value={`$${fmt(sentTotal, 2)}`} strong />
                <Row label={feeBps === 0 ? "Service fee (merchant)" : "Service fee (1%)"} value={`$${finalQuote.feeUsd.toFixed(2)}`} />
                <Row label="Estimated to your bank" value={`$${finalQuote.settlementUsd.toFixed(2)}`} strong />
              </div>

              {error && <p className="text-sm text-destructive">{error}</p>}

              <Button
                className="w-full"
                disabled={!allResolved || sentRows.length === 0 || running || submitting}
                onClick={() => void placeOrder(true)}
              >
                {submitting ? <><Loader2 className="animate-spin" /> Confirming</> : "Complete cash-out"}
              </Button>
              {!allResolved && (
                <p className="text-center text-xs text-muted-foreground">Send or skip every line to finish.</p>
              )}
            </div>
          )}

          {step === "done" && result && (
            <div className="space-y-4 text-sm">
              <div className="rounded-md border border-border/60 bg-muted/40 p-4 text-center">
                <Check className="mx-auto mb-2 h-7 w-7 text-primary" />
                <p className="font-semibold">Your cash-out is on its way</p>
                <p className="mt-1 font-mono text-xs text-muted-foreground">{result.orderId}</p>
                <p className="mt-2 text-xs text-muted-foreground">
                  ${fmt(sentTotal, 2)} sent from {sentRows.length} {sentRows.length === 1 ? "wallet" : "wallets"} ·
                  {" "}estimated ${finalQuote.settlementUsd.toFixed(2)} to{" "}
                  {vpLink?.bank ? `${vpLink.bank.institution ?? "your bank"} ····${vpLink.bank.mask}` : "your bank"}
                </p>
              </div>
              <p className="flex items-start gap-2 text-xs text-muted-foreground">
                <Landmark className="mt-0.5 h-4 w-4 shrink-0 text-primary" /> VectorPay checks the coins on the
                blockchain, then pays your linked bank — usually 1–3 business days.
              </p>
              {result.checkoutUrl && (
                <Button className="w-full" onClick={() => void openVectorPayCheckout(result.checkoutUrl ?? "")}>
                  View my cash-out status on VectorPay <ExternalLink />
                </Button>
              )}
              <Button asChild variant="outline" className="w-full">
                <Link to="/wallet/order/$id" params={{ id: result.orderId }} onClick={() => setOpen(false)}>
                  View order in BeeKeeper
                </Link>
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className={strong ? "font-semibold" : ""}>{value}</span>
    </div>
  );
}
