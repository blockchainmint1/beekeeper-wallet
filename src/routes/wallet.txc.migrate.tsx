/**
 * Migrate an imported wallet onto the correct TEXITcoin derivation path.
 *
 * A TXC account can hold coins on six different branches:
 *   - m/44'|49'|84'/696969'  — the correct SLIP-0044 paths (this app)
 *   - m/44'|49'|84'/0'       — Bitcoin's coin type, shipped by the old
 *                              BlueWallet-fork mobile app
 * All six are scanned and spendable, but only a legacy (T…) address on the
 * 696969' path works with everything — including the Omni token layer.
 *
 * This screen sweeps every coin sitting on a secondary branch into that
 * address in one transaction, while keeping the old addresses visible so
 * mining payouts pointed at them keep working (and keep being counted).
 */
import { useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowRightLeft, Check, Copy, ExternalLink, Pickaxe } from "lucide-react";

import { useWallet } from "@/lib/txc/wallet-context";
import { scanAccount, type AccountUtxo } from "@/lib/txc/scan";
import { buildAndSignTx, deriveAddress } from "@/lib/txc/wallet";
import { reserveOutpoints } from "@/lib/txc/spent-outpoints";
import {
  DERIVATION_PATHS,
  scriptKindOf,
  isLegacyCoinTypeKind,
  type DerivationKind,
} from "@/lib/txc/network";
import {
  broadcastTx,
  explorerTxUrl,
  getFeeEstimates,
  type FeeEstimates,
} from "@/lib/txc/mempool";
import { formatTxc } from "@/lib/txc/units";
import { rootFingerprintHex } from "@/lib/txc/fingerprint";
import { friendlyBroadcastError } from "@/lib/broadcast-error";
import { confirmWithBiometric } from "@/lib/native/biometric";
import { hapticError, hapticSuccess } from "@/lib/native/ui";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const Route = createFileRoute("/wallet/txc/migrate")({
  head: () => ({
    meta: [
      { title: "Migrate old TXC addresses — BeeKeeper Wallet" },
      {
        name: "description",
        content:
          "Sweep TEXITcoin held on old wallet derivation paths into your main address, and keep the old addresses for mining payouts.",
      },
      { property: "og:title", content: "Migrate old TXC addresses — BeeKeeper Wallet" },
      {
        property: "og:description",
        content:
          "Move coins from old TXC derivation paths onto the correct one without losing your old addresses.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: MigratePage,
});

const TARGET_KIND = "bip44" as const;
const DUST_SATS = 10_000;
const VBYTES = {
  bip84: { input: 68, output: 31, overhead: 11 },
  bip49: { input: 91, output: 32, overhead: 11 },
  bip44: { input: 148, output: 34, overhead: 10 },
} as const;

const BRANCH_LABEL: Record<DerivationKind, string> = {
  bip84: "Native segwit (txc1…)",
  bip49: "Wrapped segwit (4…)",
  bip44: "Legacy (T…)",
  "bip84-legacy": "Old app — native segwit",
  "bip49-legacy": "Old app — wrapped segwit",
  "bip44-legacy": "Old app — legacy",
};

function CopyAddress({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(address);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard unavailable */
        }
      }}
      className="flex w-full items-center gap-2 text-left font-mono text-xs text-muted-foreground hover:text-foreground transition-colors"
    >
      <span className="truncate">{address}</span>
      {copied ? (
        <Check className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
      ) : (
        <Copy className="h-3.5 w-3.5 shrink-0" />
      )}
    </button>
  );
}

function MigratePage() {
  const { root, unlocked, setKind } = useWallet();
  const qc = useQueryClient();

  // This screen decides whether to spend coins, so it must never trust the
  // persisted (up to 24h old) query cache: a sweep done on another device — or
  // earlier on this one — leaves a stale old-path balance behind and the
  // "coins on an old address" notice returns for money that is already gone.
  const account = useQuery({
    queryKey: ["account", unlocked?.kind, root ? rootFingerprintHex(root) : null],
    enabled: !!root && !!unlocked,
    queryFn: () => scanAccount(root!, unlocked!.kind),
    staleTime: 0,
    refetchOnMount: "always",
  });
  const fees = useQuery<FeeEstimates>({
    queryKey: ["fees"],
    queryFn: getFeeEstimates,
    staleTime: 60_000,
  });
  const feeRate = Math.max(fees.data?.halfHourFee ?? 10, Math.max(fees.data?.minimumFee ?? 10, 10));

  const destination = useMemo(
    () => (root ? deriveAddress(root, TARGET_KIND, 0, 0).address : null),
    [root],
  );

  const branches = account.data?.branches ?? [];
  const oldBranches = branches.filter((b) => b.kind !== TARGET_KIND);

  /** Addresses that currently hold spendable coins, grouped per branch. */
  const fundedByKind = useMemo(() => {
    const map = new Map<DerivationKind, { address: string; value: number }[]>();
    for (const u of account.data?.utxos ?? []) {
      const kind = (u.kind ?? unlocked?.kind ?? TARGET_KIND) as DerivationKind;
      const list = map.get(kind) ?? [];
      const found = list.find((a) => a.address === u.address);
      if (found) found.value += u.value;
      else list.push({ address: u.address, value: u.value });
      map.set(kind, list);
    }
    for (const list of map.values()) list.sort((a, b) => b.value - a.value);
    return map;
  }, [account.data, unlocked]);

  /** Every coin that isn't already on the target branch. */
  const sweepable: AccountUtxo[] = useMemo(
    () => (account.data?.utxos ?? []).filter((u) => (u.kind ?? unlocked?.kind) !== TARGET_KIND),
    [account.data, unlocked],
  );
  const sweepTotal = sweepable.reduce((s, u) => s + u.value, 0);
  const estFee = useMemo(() => {
    if (sweepable.length === 0) return 0;
    const out = VBYTES[TARGET_KIND].output;
    const vsize =
      VBYTES[TARGET_KIND].overhead +
      sweepable.reduce((s, u) => s + VBYTES[scriptKindOf(u.kind ?? TARGET_KIND)].input, 0) +
      out;
    return Math.ceil(vsize * feeRate);
  }, [sweepable, feeRate]);
  const receiveSats = sweepTotal - estFee;
  const canSweep = sweepable.length > 0 && receiveSats > DUST_SATS;

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [txid, setTxid] = useState<string | null>(null);

  async function sweep() {
    if (!root || !unlocked || !destination || !canSweep) return;
    const ok = await confirmWithBiometric("Move coins to your main address");
    if (!ok) return;
    setBusy(true);
    setError(null);
    setTxid(null);
    try {
      // Re-scan immediately before signing: a stale UTXO set is the #1 cause
      // of "input already spent" broadcast failures.
      const fresh = await scanAccount(root, unlocked.kind, { deep: true });
      const inputs = (fresh.utxos ?? []).filter(
        (u) => (u.kind ?? unlocked.kind) !== TARGET_KIND,
      );
      if (inputs.length === 0) throw new Error("Nothing left to move — your coins are already on the main path.");
      const total = inputs.reduce((s, u) => s + u.value, 0);
      const vsize =
        VBYTES[TARGET_KIND].overhead +
        inputs.reduce((s, u) => s + VBYTES[scriptKindOf(u.kind ?? TARGET_KIND)].input, 0) +
        VBYTES[TARGET_KIND].output;
      const feeSats = Math.ceil(vsize * feeRate);
      const value = total - feeSats;
      if (value <= DUST_SATS) throw new Error("The amount left after fees is too small to move.");
      const built = buildAndSignTx({
        root,
        kind: unlocked.kind,
        inputs,
        outputs: [{ address: destination, valueSats: value }],
        // No change output: this is a full sweep of the old branches.
        changeAddress: destination,
        changeIndex: 0,
        feeSats,
      });
      const id = await broadcastTx(built.hex);
      reserveOutpoints(inputs.map((u) => ({ txid: u.txid, vout: u.vout })));
      // The sweep used to move the current UTXOs but leave an imported
      // wallet's primary branch unchanged. The next ordinary send would then
      // create change on that old branch and make the migration notice return.
      // Persist the destination branch as primary only after the node accepts
      // the sweep; every historical branch remains scanned and spendable.
      setKind(TARGET_KIND);
      setTxid(id);
      hapticSuccess();
      await qc.invalidateQueries({ queryKey: ["account"] });
      await qc.invalidateQueries({ queryKey: ["txc-token-balances"] });
    } catch (e) {
      hapticError();
      setError(friendlyBroadcastError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-md px-4 pb-24 pt-4">
      <div className="mb-4 flex items-center gap-2">
        <Link to="/wallet" className="rounded-full p-2 hover:bg-muted transition-colors">
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <h1 className="text-xl font-semibold">Migrate old addresses</h1>
      </div>

      <Card className="mb-4">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ArrowRightLeft className="h-4 w-4" /> Move to your main address
          </CardTitle>
          <CardDescription>
            Your wallet already scans and spends every old derivation path, so nothing is lost. Moving
            the coins onto the legacy <span className="font-mono">T…</span> path makes tokens (TSD and
            other Omni assets) work on the same address.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {destination && (
            <div>
              <p className="text-[10px] uppercase tracking-widest text-muted-foreground">Destination</p>
              <CopyAddress address={destination} />
            </div>
          )}
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">On old paths</span>
            <span className="font-medium">{formatTxc(sweepTotal)}</span>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Network fee (est.)</span>
            <span className="font-medium">{formatTxc(estFee)}</span>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">You'll receive</span>
            <span className="font-semibold">{formatTxc(Math.max(0, receiveSats))}</span>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
          {txid && (
            <a
              href={explorerTxUrl(txid)}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1.5 text-sm text-emerald-400 hover:underline"
            >
              Sent — view transaction <ExternalLink className="h-3.5 w-3.5" />
            </a>
          )}

          <Button
            className="w-full"
            disabled={!canSweep || busy || account.isLoading}
            onClick={sweep}
          >
            {busy ? "Moving…" : account.isLoading ? "Scanning…" : "Move coins"}
          </Button>
          {!canSweep && !account.isLoading && !txid && (
            <p className="text-xs text-muted-foreground">
              {sweepable.length === 0
                ? "Nothing to move — all your TXC is already on the main path."
                : "The balance on old paths is too small to cover the network fee."}
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Pickaxe className="h-4 w-4" /> Your old addresses
          </CardTitle>
          <CardDescription>
            Keep using these for mining payouts or anything already pointed at them. They stay part of
            this wallet, their balances are always included, and you can sweep again any time.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {branches.length === 0 && (
            <p className="text-sm text-muted-foreground">
              {account.isLoading ? "Scanning your addresses…" : "No activity found yet."}
            </p>
          )}
          {branches.map((b) => {
            // Show the addresses that actually hold coins on this branch, not
            // just index 0 — looking up an empty index-0 address made the
            // balance look imaginary.
            const funded = fundedByKind.get(b.kind) ?? [];
            const shown =
              funded.length > 0
                ? funded
                : root
                  ? [{ address: deriveAddress(root, b.kind, 0, 0).address, value: 0 }]
                  : [];
            return (
              <div key={b.kind} className="rounded-lg border border-border/60 bg-card/40 p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">
                      {BRANCH_LABEL[b.kind]}
                      {b.kind === TARGET_KIND && (
                        <span className="ml-2 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-400">
                          Main
                        </span>
                      )}
                      {isLegacyCoinTypeKind(b.kind) && (
                        <span className="ml-2 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-300">
                          Old app
                        </span>
                      )}
                    </p>
                    <p className="font-mono text-[10px] text-muted-foreground">
                      {DERIVATION_PATHS[b.kind]}
                    </p>
                  </div>
                  <p className="shrink-0 text-sm font-semibold">{formatTxc(b.balanceSats)}</p>
                </div>
                <div className="mt-2 space-y-1.5">
                  {shown.map((a) => (
                    <div key={a.address}>
                      <CopyAddress address={a.address} />
                      {a.value > 0 && (
                        <p className="text-[10px] text-muted-foreground">
                          holds {formatTxc(a.value)}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
          {oldBranches.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Note: only legacy <span className="font-mono">T…</span> addresses can receive Omni tokens
              such as TSD.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
