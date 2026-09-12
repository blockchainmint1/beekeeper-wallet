/**
 * Derivation inspector.
 *
 * Shows, for the seed loaded on this device, the account xpub and the first
 * addresses of every TXC derivation branch we support — plus a lookup box that
 * tells you which branch (and index) any address belongs to. This is the
 * ground truth when a migration notice and a receive address disagree.
 */
import { useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Check, Copy, Search } from "lucide-react";

import { useWallet } from "@/lib/txc/wallet-context";
import { deriveAddress } from "@/lib/txc/wallet";
import {
  ALL_DERIVATION_KINDS,
  DERIVATION_PATHS,
  type DerivationKind,
} from "@/lib/txc/network";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export const Route = createFileRoute("/wallet/txc/paths")({
  component: PathsPage,
  head: () => ({
    meta: [
      { title: "TXC derivation inspector | BeeKeeper Wallet" },
      {
        name: "description",
        content:
          "Check the account xpub and first addresses of every TEXITcoin derivation path for the seed on this device.",
      },
      { property: "og:title", content: "TXC derivation inspector | BeeKeeper Wallet" },
      {
        property: "og:description",
        content:
          "Check the account xpub and first addresses of every TEXITcoin derivation path for the seed on this device.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
});

const LABELS: Record<DerivationKind, string> = {
  bip44: "Legacy T… — canonical (SLIP-0044 696969')",
  bip49: "Wrapped segwit — canonical",
  bip84: "Native segwit txc1… — canonical",
  "bip44-legacy": "Legacy T… — old app (coin type 0')",
  "bip49-legacy": "Wrapped segwit — old app",
  "bip84-legacy": "Native segwit — old app",
};

const LOOKUP_DEPTH = 100;

function CopyBtn({ value }: { value: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-7 w-7 shrink-0"
      onClick={() => {
        void navigator.clipboard.writeText(value);
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
      aria-label="Copy"
    >
      {done ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
    </Button>
  );
}

function PathsPage() {
  const { root, unlocked } = useWallet();
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<string | null>(null);

  const rows = useMemo(() => {
    if (!root) return [];
    return ALL_DERIVATION_KINDS.map((kind) => {
      const accountPath = DERIVATION_PATHS[kind];
      let xpub = "—";
      try {
        xpub = root.derivePath(accountPath).neutered().toBase58();
      } catch {
        /* ignore */
      }
      return {
        kind,
        accountPath,
        xpub,
        receive0: deriveAddress(root, kind, 0, 0).address,
        change0: deriveAddress(root, kind, 1, 0).address,
      };
    });
  }, [root]);

  function lookup() {
    const needle = query.trim();
    if (!root || !needle) return;
    for (const kind of ALL_DERIVATION_KINDS) {
      for (const change of [0, 1] as const) {
        for (let i = 0; i < LOOKUP_DEPTH; i++) {
          const d = deriveAddress(root, kind, change, i);
          if (d.address === needle) {
            setResult(
              `Found: ${LABELS[kind]} — ${d.path} (${change === 1 ? "change" : "receive"} #${i})`,
            );
            return;
          }
        }
      }
    }
    setResult(
      `Not found in the first ${LOOKUP_DEPTH} addresses of any branch for this seed. That address does not belong to this wallet (or sits beyond index ${LOOKUP_DEPTH - 1}).`,
    );
  }

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-6 pb-24">
      <h1 className="text-xl font-semibold">Derivation inspector</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Everything below is derived live from the seed unlocked on this device.
      </p>

      {!root ? (
        <Card className="mt-5">
          <CardContent className="py-6 text-sm text-muted-foreground">
            Unlock your wallet to inspect its derivation paths.{" "}
            <Link className="underline" to="/wallet">
              Go to wallet
            </Link>
          </CardContent>
        </Card>
      ) : (
        <>
          <Card className="mt-5">
            <CardHeader>
              <CardTitle className="text-base">Which branch is this address on?</CardTitle>
              <CardDescription>
                Paste any TXC address — we check the first {LOOKUP_DEPTH} receive and change
                addresses of every branch.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex gap-2">
                <Input
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setResult(null);
                  }}
                  placeholder="T… or txc1…"
                  spellCheck={false}
                />
                <Button onClick={lookup} disabled={!query.trim()}>
                  <Search className="mr-1.5 h-4 w-4" />
                  Check
                </Button>
              </div>
              {result ? <p className="text-sm">{result}</p> : null}
            </CardContent>
          </Card>

          {rows.map((r) => (
            <Card key={r.kind} className="mt-4">
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between gap-2">
                  <CardTitle className="text-sm">{LABELS[r.kind]}</CardTitle>
                  {unlocked?.kind === r.kind ? <Badge>Active</Badge> : null}
                </div>
                <CardDescription>
                  <code>{r.accountPath}</code>
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 text-xs">
                <Field label="Account xpub" value={r.xpub} />
                <Field label={`Receive #0 (${r.accountPath}/0/0)`} value={r.receive0} />
                <Field label={`Change #0 (${r.accountPath}/1/0)`} value={r.change0} />
              </CardContent>
            </Card>
          ))}
        </>
      )}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-muted-foreground">{label}</div>
      <div className="flex items-start gap-1">
        <code className="break-all">{value}</code>
        <CopyBtn value={value} />
      </div>
    </div>
  );
}
