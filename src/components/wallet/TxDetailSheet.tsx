/**
 * In-page transaction detail sheet. Handles both TXC (mempool) and EVM
 * (Alchemy transfer) transactions. The link out to the block explorer is
 * an action inside the sheet, not the default row click.
 */
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { ArrowDown, ArrowUp, Check, Copy, ExternalLink } from "lucide-react";
import { useState } from "react";
import { formatTxc } from "@/lib/txc/units";
import { explorerTxUrl, type MempoolTx } from "@/lib/txc/mempool";
import type { EvmTransfer } from "@/lib/chains/history.functions";
import { EVM_CHAINS, type EvmChainId } from "@/lib/chains/evm";
import { copyToClipboard } from "@/lib/clipboard";

export type TxDetail =
  | { kind: "txc"; tx: MempoolTx; net: number; incoming: boolean }
  | {
      /** Other UTXO chains (BTC, LTC, DOGE, ISK) — same Esplora tx shape. */
      kind: "utxo";
      tx: MempoolTx;
      net: number;
      incoming: boolean;
      formatAmount: (sats: number) => string;
      explorerTxUrl: (txid: string) => string;
      explorerName: string;
    }
  | { kind: "evm"; chain: EvmChainId; transfer: EvmTransfer };

export function TxDetailSheet({
  detail,
  onClose,
}: {
  detail: TxDetail | null;
  onClose: () => void;
}) {
  const open = detail !== null;
  return (
    <Drawer open={open} onOpenChange={(o) => !o && onClose()}>
      <DrawerContent className="max-h-[85vh]">
        <DrawerHeader className="text-left">
          <DrawerTitle>Transaction</DrawerTitle>
        </DrawerHeader>
        <div className="px-4 pb-6 overflow-y-auto">
          {detail?.kind === "txc" && <TxcDetail detail={detail} />}
          {detail?.kind === "utxo" && <UtxoDetail detail={detail} />}
          {detail?.kind === "evm" && <EvmDetail detail={detail} />}
        </div>
      </DrawerContent>
    </Drawer>
  );
}

function TxcDetail({ detail }: { detail: Extract<TxDetail, { kind: "txc" }> }) {
  return (
    <UtxoDetailBody
      tx={detail.tx}
      net={detail.net}
      incoming={detail.incoming}
      formatAmount={(sats) => `${formatTxc(sats)} TXC`}
      explorerUrl={explorerTxUrl(detail.tx.txid)}
      explorerName="mempool.texitcoin.org"
    />
  );
}

function UtxoDetail({ detail }: { detail: Extract<TxDetail, { kind: "utxo" }> }) {
  return (
    <UtxoDetailBody
      tx={detail.tx}
      net={detail.net}
      incoming={detail.incoming}
      formatAmount={detail.formatAmount}
      explorerUrl={detail.explorerTxUrl(detail.tx.txid)}
      explorerName={detail.explorerName}
    />
  );
}

function UtxoDetailBody({
  tx,
  net,
  incoming,
  formatAmount,
  explorerUrl,
  explorerName,
}: {
  tx: MempoolTx;
  net: number;
  incoming: boolean;
  formatAmount: (sats: number) => string;
  explorerUrl: string;
  explorerName: string;
}) {
  return (
    <div className="space-y-4">
      <Header
        incoming={incoming}
        title={incoming ? "Received" : "Sent"}
        amount={`${incoming ? "+" : "−"}${formatAmount(Math.abs(net))}`}
        subtitle={
          tx.status.confirmed
            ? new Date((tx.status.block_time ?? 0) * 1000).toLocaleString()
            : "Pending"
        }
      />
      <Field label="Status" value={tx.status.confirmed ? `Confirmed · block ${tx.status.block_height}` : "Unconfirmed"} />
      <Field label="Network fee" value={formatAmount(tx.fee)} />
      <Field label="Transaction ID" value={tx.txid} mono copy />
      <Button asChild variant="outline" className="w-full">
        <a href={explorerUrl} target="_blank" rel="noreferrer">
          <ExternalLink className="h-4 w-4 mr-2" /> View on {explorerName}
        </a>
      </Button>
    </div>
  );
}

function EvmDetail({ detail }: { detail: Extract<TxDetail, { kind: "evm" }> }) {
  const { chain, transfer: t } = detail;
  const meta = EVM_CHAINS[chain];
  return (
    <div className="space-y-4">
      <Header
        incoming={!t.outgoing}
        title={t.outgoing ? "Sent" : "Received"}
        amount={`${t.outgoing ? "−" : "+"}${Number(t.value).toLocaleString(undefined, {
          maximumFractionDigits: 8,
        })} ${t.asset}`}
        subtitle={t.timestamp ? new Date(t.timestamp).toLocaleString() : `Block ${t.blockNum}`}
      />
      <Field label="Network" value={meta.name} />
      <Field label="Type" value={t.category} />
      <Field label="From" value={t.from} mono copy />
      {t.to && <Field label="To" value={t.to} mono copy />}
      <Field label="Transaction hash" value={t.hash} mono copy />
      {meta.explorerTx(t.hash) && (
        <Button asChild variant="outline" className="w-full">
          <a href={meta.explorerTx(t.hash)} target="_blank" rel="noreferrer">
            <ExternalLink className="h-4 w-4 mr-2" /> View on {meta.shortName} explorer
          </a>
        </Button>
      )}
    </div>
  );
}

function Header({
  incoming,
  title,
  amount,
  subtitle,
}: {
  incoming: boolean;
  title: string;
  amount: string;
  subtitle: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <div
        className={`w-11 h-11 rounded-full flex items-center justify-center ${
          incoming ? "bg-emerald-500/15 text-emerald-500" : "bg-rose-500/15 text-rose-500"
        }`}
      >
        {incoming ? <ArrowDown className="h-5 w-5" /> : <ArrowUp className="h-5 w-5" />}
      </div>
      <div className="flex-1 min-w-0">
        <p className="font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">{subtitle}</p>
      </div>
      <p className={`text-right font-semibold ${incoming ? "text-emerald-500" : ""}`}>{amount}</p>
    </div>
  );
}

function Field({
  label,
  value,
  mono,
  copy,
}: {
  label: string;
  value: string;
  mono?: boolean;
  copy?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="rounded-lg border border-border/60 bg-card/40 px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
        {copy && (
          <button
            className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
            onClick={async () => {
              await copyToClipboard(value);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
            {copied ? "Copied" : "Copy"}
          </button>
        )}
      </div>
      <p className={`mt-1 text-sm break-all ${mono ? "font-mono" : ""}`}>{value}</p>
    </div>
  );
}
