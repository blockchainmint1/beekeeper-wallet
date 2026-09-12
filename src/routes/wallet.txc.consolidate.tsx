/**
 * Consolidate an Omni token that's scattered across HD addresses.
 *
 * Omni's "sending address" is whoever owns the first input, so a token split
 * across several derived addresses can't be spent in one transaction. This
 * screen chains one Simple Send per holder address into your main receive
 * address, funding any holder that has no TXC to pay its own fee first.
 */
import { useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { payments } from "bitcoinjs-lib";
import { useServerFn } from "@tanstack/react-start";
import { AlertTriangle, ExternalLink, Layers } from "lucide-react";

import { useWallet } from "@/lib/txc/wallet-context";
import { scanAccount, type AccountUtxo } from "@/lib/txc/scan";
import { buildAndSignTx, type UtxoInput } from "@/lib/txc/wallet";
import {
  DERIVATION_PATHS,
  TXC_NETWORK,
  scriptKindOf,
  type DerivationKind,
} from "@/lib/txc/network";
import { broadcastTx, explorerTxUrl, getFeeEstimates, getTxHex, type FeeEstimates } from "@/lib/txc/mempool";
import { reserveOutpoints } from "@/lib/txc/spent-outpoints";
import { formatTxc } from "@/lib/txc/units";
import { rootFingerprintHex } from "@/lib/txc/fingerprint";
import {
  useEnabledTxcTokens,
  buildSimpleSendPayload,
  formatTokenAmount,
  getOmniDepositAddress,
  type TxcTokenMeta,
  isOmniCompatibleAddress,
} from "@/lib/txc/tokens";
import { useTxcTokenProps } from "@/lib/txc/token-props";
import { getTxcTokenBalancesPerAddress } from "@/lib/txc/tokens.functions";
import { friendlyBroadcastError } from "@/lib/broadcast-error";
import { confirmWithBiometric } from "@/lib/native/biometric";
import { hapticError, hapticSuccess } from "@/lib/native/ui";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const searchSchema = z.object({ token: z.string().optional() });

export const Route = createFileRoute("/wallet/txc/consolidate")({
  head: () => ({
    meta: [
      { title: "Consolidate tokens — BeeKeeper Wallet" },
      {
        name: "description",
        content:
          "Sweep an Omni Layer token scattered across your TEXITcoin HD addresses into a single address.",
      },
      { property: "og:title", content: "Consolidate tokens — BeeKeeper Wallet" },
      {
        property: "og:description",
        content: "Sweep Omni Layer tokens across TEXITcoin HD addresses into one address.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  validateSearch: (raw) => searchSchema.parse(raw),
  component: ConsolidatePage,
});

const OMNI_DUST_SATS = 10_000;
/**
 * TEXITcoin's relay fee makes small change outputs non-standard ("dust"), so a
 * change output is only worth creating when it clears the same threshold we
 * use for the Omni reference output. Anything smaller goes to the miners.
 */
const CHANGE_MIN_SATS = OMNI_DUST_SATS;
const VBYTES = {
  bip84: { input: 68, output: 31, overhead: 11 },
  bip49: { input: 91, output: 32, overhead: 11 },
  bip44: { input: 148, output: 34, overhead: 10 },
} as const;
const OMNI_OP_RETURN_VBYTES = 31;

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
    script === "bip84" ? inner.output : payments.p2sh({ redeem: inner, network: TXC_NETWORK }).output;
  if (!out) return undefined;
  return Array.from(out, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Vsize of a one-input Omni send with `nOut` payment outputs. */
function omniVsize(kind: DerivationKind, nOut: number): number {
  const v = VBYTES[scriptKindOf(kind)];
  return v.overhead + v.input + v.output * nOut + OMNI_OP_RETURN_VBYTES;
}

interface Holder {
  address: string;
  units: bigint;
  change: 0 | 1;
  index: number;
  kind: DerivationKind;
  pubkey: Uint8Array;
  /** Best TXC UTXO already sitting at this address, if any. */
  utxo?: AccountUtxo;
  /** Sats we need to send this address before it can pay its own fee. */
  fundSats: number;
}

type Step = { label: string; txid?: string; error?: string; status: "pending" | "ok" | "failed" };

function ConsolidatePage() {
  const { root, unlocked } = useWallet();
  const qc = useQueryClient();
  const search = Route.useSearch();

  const account = useQuery({
    queryKey: ["account", unlocked?.kind, root ? rootFingerprintHex(root) : null],
    enabled: !!root && !!unlocked,
    queryFn: () => scanAccount(root!, unlocked!.kind),
    staleTime: 30_000,
  });
  const fees = useQuery<FeeEstimates>({
    queryKey: ["fees"],
    queryFn: getFeeEstimates,
    staleTime: 60_000,
  });

  const localTokens = useEnabledTxcTokens();
  const { resolved: tokens } = useTxcTokenProps(localTokens);
  const [tokenId, setTokenId] = useState<number | null>(() => {
    const n = Number(search.token);
    return Number.isInteger(n) && n > 0 ? n : null;
  });
  const token: TxcTokenMeta | null =
    tokens.find((t) => t.id === tokenId) ?? tokens[0] ?? null;

  const addressInfos = useMemo(() => {
    const list = [...(account.data?.external ?? []), ...(account.data?.internal ?? [])];
    return list
      .map((d) => ({ ...d, kind: kindFromPath(d.path) }))
      .filter((d): d is typeof d & { kind: DerivationKind } => d.kind !== null);
  }, [account.data]);

  const fetchPerAddr = useServerFn(getTxcTokenBalancesPerAddress);
  const perAddr = useQuery({
    queryKey: [
      "txc-token-balances-per-addr",
      addressInfos.map((a) => a.address).join(","),
      tokens.map((t) => t.id).join(","),
    ],
    enabled: addressInfos.length > 0 && tokens.length > 0,
    queryFn: () =>
      fetchPerAddr({
        data: {
          addresses: addressInfos.map((a) => a.address),
          propertyIds: tokens.map((t) => t.id),
        },
      }),
    staleTime: 30_000,
  });

  const feeRate = Math.max(fees.data?.halfHourFee ?? 10, Math.max(fees.data?.minimumFee ?? 10, 10));

  // Destination = the canonical Omni deposit address (m/44'/696969'/0'/0/0) —
  // the same pinned address the receive screen hands out for tokens, so a
  // consolidation pools everything where future token deposits land. Without a
  // root key (imported-key wallets) fall back to the first legacy address we
  // own; the Omni layer can't read bech32 (txc1…) outputs, so a segwit target
  // would make every transfer confirm on-chain while never applying.
  const destination = useMemo(() => {
    if (root) return getOmniDepositAddress(root).address;
    if (!unlocked) return null;
    const primary = addressInfos.find(
      (a) => a.kind === unlocked.kind && a.change === 0 && a.index === 0,
    );
    const candidates = [
      primary?.address,
      ...addressInfos.filter((a) => a.change === 0).map((a) => a.address),
      account.data?.nextReceiveAddress,
    ].filter((a): a is string => Boolean(a));
    return candidates.find(isOmniCompatibleAddress) ?? null;
  }, [root, addressInfos, unlocked, account.data]);


  const holders: Holder[] = useMemo(() => {
    if (!token || !perAddr.data || !destination) return [];
    const utxos = account.data?.utxos ?? [];
    return addressInfos
      .map((a) => {
        const units = BigInt(perAddr.data[a.address]?.[token.id] ?? "0");
        const best = utxos
          .filter((u) => u.address === a.address)
          .sort((x, y) => y.value - x.value)[0];
        const need = OMNI_DUST_SATS + Math.ceil(omniVsize(a.kind, 1) * feeRate);
        const usable = best && best.value >= need ? best : undefined;
        return {
          address: a.address,
          units,
          change: a.change,
          index: a.index,
          kind: a.kind,
          pubkey: a.pubkey,
          utxo: usable,
          // Fund with a little headroom so a fee bump between planning and
          // broadcast can't strand the transfer.
          fundSats: usable ? 0 : Math.ceil(need * 1.4),
        } satisfies Holder;
      })
      .filter((h) => h.units > 0n && h.address !== destination);
  }, [addressInfos, perAddr.data, token, destination, account.data, feeRate]);

  const scatteredUnits = holders.reduce((s, h) => s + h.units, 0n);
  const needFunding = holders.filter((h) => h.fundSats > 0);
  const fundingTotal = needFunding.reduce((s, h) => s + h.fundSats, 0);
  const transferCost = holders
    .filter((h) => h.fundSats === 0)
    .reduce((s, h) => s + OMNI_DUST_SATS + Math.ceil(omniVsize(h.kind, 1) * feeRate), 0);

  const [steps, setSteps] = useState<Step[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function run() {
    if (!root || !unlocked || !account.data || !token || !destination) return;
    if (holders.length === 0) return;
    const ok = await confirmWithBiometric(`Consolidate ${token.symbol}`);
    if (!ok) return;

    setBusy(true);
    setError(null);
    setDone(false);
    const log: Step[] = [];
    const push = (s: Step) => {
      log.push(s);
      setSteps([...log]);
    };
    const update = (i: number, patch: Partial<Step>) => {
      log[i] = { ...log[i], ...patch };
      setSteps([...log]);
    };

    try {
      // ---- Step 1: fan out fee money to holders that have no TXC ----
      const fundedInputs = new Map<string, UtxoInput>();
      if (needFunding.length > 0) {
        const fundIdx = log.length;
        push({
          label: `Fund ${needFunding.length} address${needFunding.length > 1 ? "es" : ""} with fee money`,
          status: "pending",
        });
        // Never spend a coin a later transfer is counting on: skip every
        // holder address, plus the exact UTXOs the self-funded holders will
        // use, otherwise the funding tx double-spends them (mempool conflict).
        const holderAddrs = new Set(holders.map((h) => h.address));
        const reserved = new Set(
          holders.filter((h) => h.utxo).map((h) => `${h.utxo!.txid}:${h.utxo!.vout}`),
        );
        const spendable = (account.data.utxos ?? [])
          .filter((u) => !holderAddrs.has(u.address) && !reserved.has(`${u.txid}:${u.vout}`))
          .sort((a, b) => b.value - a.value);
        const outputs = needFunding.map((h) => ({ address: h.address, valueSats: h.fundSats }));
        const targetOut = outputs.reduce((s, o) => s + o.valueSats, 0);
        const primary = scriptKindOf(unlocked.kind);
        const picked: AccountUtxo[] = [];
        let acc = 0;
        let feeSats = 0;
        for (const u of spendable) {
          picked.push(u);
          acc += u.value;
          const vsize =
            VBYTES[primary].overhead +
            picked.reduce((s, p) => s + VBYTES[scriptKindOf(p.kind ?? unlocked.kind)].input, 0) +
            VBYTES[primary].output * (outputs.length + 1);
          feeSats = Math.ceil(vsize * feeRate);
          if (acc >= targetOut + feeSats) break;
        }
        if (acc < targetOut + feeSats) {
          throw new Error(
            `Not enough TXC to fund the transfers. Need ~${formatTxc(targetOut + feeSats)}, have ${formatTxc(acc)}.`,
          );
        }
        // Absorb a dust-sized change output into the fee so the funding tx
        // stays standard.
        if (acc - targetOut - feeSats < CHANGE_MIN_SATS) feeSats = acc - targetOut;
        const built = buildAndSignTx({
          root,
          kind: unlocked.kind,
          inputs: picked,
          outputs,
          changeAddress: account.data.nextChangeAddress,
          changeIndex: account.data.nextChangeIndex,
          feeSats,
        });
        const txid = await broadcastTx(built.hex);
        reserveOutpoints(picked.map((u) => ({ txid: u.txid, vout: u.vout })));
        update(fundIdx, { status: "ok", txid });

        needFunding.forEach((h, i) => {
          fundedInputs.set(h.address, {
            txid,
            vout: i,
            value: h.fundSats,
            change: h.change,
            index: h.index,
            kind: h.kind,
            witnessScriptHex: scriptHexFor(h.pubkey, h.kind),
            // Legacy inputs need the full parent tx — we just built it.
            nonWitnessUtxoHex:
              scriptKindOf(h.kind) === "bip44" ? built.hex : undefined,
          });
        });
      }

      // ---- Step 2: one Omni Simple Send per holder ----
      for (const h of holders) {
        const idx = log.length;
        push({
          label: `Send ${formatTokenAmount(h.units, token.divisible)} ${token.symbol} from ${h.address.slice(0, 10)}…`,
          status: "pending",
        });
        try {
          let input: UtxoInput | undefined = fundedInputs.get(h.address);
          if (!input && h.utxo) {
            const u = h.utxo;
            input = {
              txid: u.txid,
              vout: u.vout,
              value: u.value,
              change: u.change,
              index: u.index,
              kind: u.kind ?? h.kind,
              witnessScriptHex: u.witnessScriptHex ?? scriptHexFor(h.pubkey, h.kind),
              nonWitnessUtxoHex:
                scriptKindOf(h.kind) === "bip44"
                  ? u.nonWitnessUtxoHex ?? (await getTxHex(u.txid))
                  : undefined,
            };
          }
          if (!input) throw new Error("No TXC available at this address to pay the fee.");

          const twoOutVsize = omniVsize(h.kind, 2);
          let feeSats = Math.ceil(twoOutVsize * feeRate);
          let change = input.value - OMNI_DUST_SATS - feeSats;
          if (change < CHANGE_MIN_SATS) {
            // A small change output would be rejected as dust — hand the
            // remainder to the miners instead.
            feeSats = input.value - OMNI_DUST_SATS;
            change = 0;
          }
          if (feeSats <= 0) throw new Error("Not enough TXC at this address to pay the fee.");

          const built = buildAndSignTx({
            root,
            kind: unlocked.kind,
            inputs: [input],
            outputs: [{ address: destination, valueSats: OMNI_DUST_SATS }],
            changeAddress: h.address,
            changeIndex: h.index,
            feeSats,
            opReturnData: buildSimpleSendPayload(token.id, h.units),
          });
          const txid = await broadcastTx(built.hex);
          reserveOutpoints([{ txid: input.txid, vout: input.vout }]);
          update(idx, { status: "ok", txid });
        } catch (err) {
          update(idx, {
            status: "failed",
            error: friendlyBroadcastError(err),
          });
        }
      }

      setDone(true);
      if (log.some((s) => s.status === "failed")) hapticError();
      else hapticSuccess();
      qc.invalidateQueries({ queryKey: ["account"] });
      qc.invalidateQueries({ queryKey: ["txc-token-balances"] });
      qc.invalidateQueries({ queryKey: ["txc-token-balances-per-addr"] });
    } catch (err) {
      hapticError();
      setError(friendlyBroadcastError(err));
    } finally {
      setBusy(false);
    }
  }

  const loading = account.isLoading || perAddr.isLoading;

  return (
    <main className="mx-auto max-w-xl px-4 py-8">
      <Link to="/wallet" className="text-sm text-muted-foreground hover:text-foreground">
        ← Back
      </Link>
      <h1 className="mt-3 flex items-center gap-2 text-2xl font-bold">
        <Layers className="h-6 w-6" /> Consolidate tokens
      </h1>
      <p className="text-sm text-muted-foreground">
        Omni sends the whole amount from a single address. This sweeps a token
        held across your derived addresses into one place so you can spend it.
      </p>

      <Card className="mt-5">
        <CardHeader>
          <CardTitle>Token</CardTitle>
          <CardDescription>Pick which Omni token to consolidate.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Select
            value={token ? String(token.id) : ""}
            onValueChange={(v) => setTokenId(Number(v))}
            disabled={busy}
          >
            <SelectTrigger>
              <SelectValue placeholder="Select a token" />
            </SelectTrigger>
            <SelectContent>
              {tokens.map((t) => (
                <SelectItem key={t.id} value={String(t.id)}>
                  {t.symbol}
                  {t.name ? ` — ${t.name}` : ""} (#{t.id})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {loading && <p className="text-sm text-muted-foreground">Scanning your addresses…</p>}

          {!loading && token && holders.length === 0 && (
            <p className="text-sm text-muted-foreground">
              Nothing to consolidate — all your {token.symbol} is already on your
              main receive address.
            </p>
          )}

          {!loading && token && holders.length > 0 && (
            <div className="space-y-3">
              <div className="rounded-md border border-border/60 p-3 text-sm">
                <p>
                  <span className="font-semibold">
                    {formatTokenAmount(scatteredUnits, token.divisible)} {token.symbol}
                  </span>{" "}
                  across {holders.length} address{holders.length > 1 ? "es" : ""} →{" "}
                  <span className="font-mono text-xs break-all">{destination}</span>
                </p>
              </div>
              <ul className="space-y-1 text-xs text-muted-foreground">
                {holders.map((h) => (
                  <li key={h.address} className="flex justify-between gap-3">
                    <span className="font-mono truncate">{h.address}</span>
                    <span className="shrink-0">
                      {formatTokenAmount(h.units, token.divisible)}
                      {h.fundSats > 0 ? " · needs fee funding" : ""}
                    </span>
                  </li>
                ))}
              </ul>
              <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
                <p className="font-medium">Estimated TXC cost</p>
                <p className="mt-1 text-muted-foreground">
                  {holders.length} transfer{holders.length > 1 ? "s" : ""} ·{" "}
                  {formatTxc(transferCost + fundingTotal)} total
                  {needFunding.length > 0 && (
                    <>
                      {" "}
                      (includes {formatTxc(fundingTotal)} sent to {needFunding.length} address
                      {needFunding.length > 1 ? "es" : ""} so they can pay their own fee)
                    </>
                  )}
                  . Each transfer costs a fee plus {formatTxc(OMNI_DUST_SATS)} dust.
                </p>
              </div>
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2 text-sm text-destructive">
              <AlertTriangle className="mt-0.5 h-4 w-4" /> {error}
            </div>
          )}

          <Button
            className="w-full"
            onClick={run}
            disabled={busy || loading || holders.length === 0}
          >
            {busy ? "Consolidating…" : `Consolidate ${token?.symbol ?? "token"}`}
          </Button>
        </CardContent>
      </Card>

      {steps.length > 0 && (
        <Card className="mt-5">
          <CardHeader>
            <CardTitle>Progress</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {steps.map((s, i) => (
              <div key={i} className="rounded-md border border-border/60 px-3 py-2 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate">{s.label}</span>
                  <span
                    className={
                      s.status === "ok"
                        ? "text-emerald-500 text-xs"
                        : s.status === "failed"
                          ? "text-destructive text-xs"
                          : "text-muted-foreground text-xs"
                    }
                  >
                    {s.status === "ok" ? "sent" : s.status === "failed" ? "failed" : "…"}
                  </span>
                </div>
                {s.txid && (
                  <a
                    href={explorerTxUrl(s.txid)}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-1 inline-flex items-center gap-1 font-mono text-xs text-muted-foreground hover:text-foreground"
                  >
                    {s.txid.slice(0, 20)}… <ExternalLink className="h-3 w-3" />
                  </a>
                )}
                {s.error && <p className="mt-1 text-xs text-destructive">{s.error}</p>}
              </div>
            ))}
            {done && (
              <p className="text-xs text-muted-foreground">
                Balances update once these confirm. Omni transfers spending a
                just-broadcast funding output can take a block to show up.
              </p>
            )}
          </CardContent>
        </Card>
      )}
    </main>
  );
}
