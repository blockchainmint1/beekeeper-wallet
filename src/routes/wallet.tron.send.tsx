/**
 * Tron send — TRX or a TRC-20 token (USDT / USDC).
 *
 * Tron fees are paid in bandwidth/energy, burned as TRX when you have none
 * staked. We surface an estimate up front so a token send doesn't silently
 * fail with "account does not have enough TRX".
 */
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Loader2, Send as SendIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { QrScanButton } from "@/components/wallet/QrScanButton";
import { AddressBookButton } from "@/components/wallet/AddressBookButton";
import { useWallet } from "@/lib/txc/wallet-context";
import { deriveTronAccount, isValidTronAddress } from "@/lib/tron/address";
import { TRC20_TOKENS, explorerTxUrl } from "@/lib/tron/network";
import {
  formatTokenAmount,
  formatTrx,
  parseTokenAmount,
  trxToSun,
} from "@/lib/tron/units";
import {
  getAccountResources,
  getTrc20Balance,
  getTrxBalance,
  sendTrc20,
  sendTrx,
} from "@/lib/tron/api";

export const Route = createFileRoute("/wallet/tron/send")({
  head: () => ({
    meta: [
      { title: "Send TRX & USDT — BeeKeeper Wallet" },
      {
        name: "description",
        content: "Send TRX or USDT-TRC20 from your self-custodial BeeKeeper wallet.",
      },
      { property: "og:title", content: "Send TRX & USDT — BeeKeeper Wallet" },
      {
        property: "og:description",
        content: "Send TRX or USDT-TRC20 from your self-custodial BeeKeeper wallet.",
      },
    ],
  }),
  component: TronSend,
});

const ASSETS = [{ key: "TRX", label: "TRX (native)" }].concat(
  TRC20_TOKENS.map((t) => ({ key: t.symbol, label: `${t.name} (${t.symbol})` })),
);

function TronSend() {
  const { root } = useWallet();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const account = useMemo(() => (root ? deriveTronAccount(root) : null), [root]);
  const address = account?.address ?? null;

  const [asset, setAsset] = useState("TRX");
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [sending, setSending] = useState(false);
  const [txid, setTxid] = useState<string | null>(null);

  const token = TRC20_TOKENS.find((t) => t.symbol === asset) ?? null;

  const trxBalance = useQuery({
    queryKey: ["tron-balance", address],
    enabled: !!address,
    queryFn: () => getTrxBalance(address!),
  });

  const tokenBalance = useQuery({
    queryKey: ["tron-trc20", token?.contract, address],
    enabled: !!address && !!token,
    queryFn: () => getTrc20Balance(token!, address!),
  });

  const resources = useQuery({
    queryKey: ["tron-resources", address],
    enabled: !!address,
    queryFn: () => getAccountResources(address!),
    staleTime: 60_000,
  });

  const trxSun = trxBalance.data ?? 0;
  const needsEnergy = !!token && (resources.data?.energyAvailable ?? 0) < 65_000;
  const lowTrxForFees = needsEnergy && trxSun < 30_000_000; // ~30 TRX burn

  const validTo = isValidTronAddress(to);
  const parsedAmount = token
    ? parseTokenAmount(amount, token.decimals)
    : BigInt(trxToSun(amount));
  const hasAmount = parsedAmount > 0n;
  const overBalance = token
    ? parsedAmount > (tokenBalance.data ?? 0n)
    : parsedAmount > BigInt(trxSun);

  async function submit() {
    if (!account || !validTo || !hasAmount || overBalance) return;
    setSending(true);
    try {
      const id = token
        ? await sendTrc20(account.privateKey, token, account.address, to.trim(), parsedAmount)
        : await sendTrx(account.privateKey, account.address, to.trim(), Number(parsedAmount));
      setTxid(id);
      toast.success(`Sent ${amount} ${asset}`);
      // Balances change immediately — drop the cached values.
      await qc.invalidateQueries({ queryKey: ["tron-balance", address] });
      await qc.invalidateQueries({ queryKey: ["tron-history", address] });
      if (token) await qc.invalidateQueries({ queryKey: ["tron-trc20", token.contract, address] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Send failed");
    } finally {
      setSending(false);
    }
  }

  if (txid) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-6">
        <h1 className="text-2xl font-semibold mb-4">Sent</h1>
        <Card>
          <CardContent className="pt-6 space-y-3">
            <p className="text-sm">
              {amount} {asset} is on its way. Tron usually confirms in about 3 seconds.
            </p>
            <p className="font-mono text-xs break-all">{txid}</p>
            <div className="flex gap-2">
              <Button asChild variant="secondary" className="flex-1">
                <a href={explorerTxUrl(txid)} target="_blank" rel="noreferrer">
                  View on Tronscan
                </a>
              </Button>
              <Button className="flex-1" onClick={() => navigate({ to: "/wallet" })}>
                Done
              </Button>
            </div>
          </CardContent>
        </Card>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-3xl px-4 py-6">
      <Link
        to="/wallet"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-4"
      >
        <ArrowLeft className="h-4 w-4" /> Back
      </Link>
      <h1 className="text-2xl font-semibold mb-6">Send on Tron</h1>

      <Card>
        <CardContent className="pt-6 space-y-4">
          <div className="space-y-2">
            <Label>Asset</Label>
            <Select value={asset} onValueChange={setAsset}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ASSETS.map((a) => (
                  <SelectItem key={a.key} value={a.key}>
                    {a.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Available:{" "}
              {token
                ? `${formatTokenAmount(tokenBalance.data ?? 0n, token.decimals)} ${token.symbol}`
                : formatTrx(trxSun)}
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="tron-to">Recipient address</Label>
            <div className="flex gap-2">
              <Input
                id="tron-to"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                placeholder="T..."
                className="font-mono text-sm"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
              <QrScanButton onScan={(raw) => setTo(raw.trim())} />
              <AddressBookButton chain="tron" onPick={(a) => setTo(a)} />
            </div>
            {to && !validTo && (
              <p className="text-xs text-destructive">
                That isn't a valid Tron address. Tron addresses start with "T" and are 34
                characters long.
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="tron-amount">Amount</Label>
            <Input
              id="tron-amount"
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
              inputMode="decimal"
              placeholder="0.00"
            />
            {overBalance && <p className="text-xs text-destructive">More than your balance.</p>}
          </div>

          {token && (
            <div className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              {needsEnergy ? (
                <>
                  You have no staked energy, so this transfer burns roughly 27–65 TRX in fees.
                  Your TRX balance is {formatTrx(trxSun)}.
                </>
              ) : (
                <>Your staked energy should cover this transfer with little or no TRX burned.</>
              )}
            </div>
          )}
          {lowTrxForFees && (
            <p className="text-xs text-amber-500">
              You may not have enough TRX to pay the energy fee. Send about 30 TRX to this
              wallet first.
            </p>
          )}

          <Button
            className="w-full"
            size="lg"
            disabled={!account || !validTo || !hasAmount || overBalance || sending}
            onClick={submit}
          >
            {sending ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <SendIcon className="h-4 w-4 mr-2" />
            )}
            Send {asset}
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}
