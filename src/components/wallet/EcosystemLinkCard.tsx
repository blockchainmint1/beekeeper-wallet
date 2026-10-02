/**
 * Ecosystem link — one paste/scan box for every honest.money ecosystem app,
 * plus the list of everything this wallet is linked to. The pasted link is
 * routed to the matching protocol handler (NectarPay, TSD Swap, website
 * sign-in). New apps plug in here.
 */
import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { QrScanButton } from "@/components/wallet/QrScanButton";
import { NectarLinkCard } from "@/components/wallet/NectarLinkCard";
import { TsdAccountLinkCard } from "@/components/wallet/TsdAccountLinkCard";
import { WebsiteSignInCard } from "@/components/wallet/WebsiteSignInCard";
import { useWallet } from "@/lib/txc/wallet-context";
import { parseLinkInput } from "@/lib/nectar/link";
import { parseTsdLinkInput } from "@/lib/rewards/tsd-link";
import { looksLikeLoginQr } from "@/lib/nectar/auth";
import {
  listEcosystemLinks,
  removeEcosystemLink,
  type EcosystemLink,
} from "@/lib/ecosystem-links";

type Pending =
  | { kind: "nectar"; url: string; n: number }
  | { kind: "tsd"; url: string; n: number }
  | { kind: "signin"; payload: string; n: number };

export function EcosystemLinkCard() {
  const { unlocked } = useWallet();
  const seedless = !unlocked || unlocked.mode === "keyonly" || !unlocked.mnemonic;
  const [input, setInput] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [links, setLinks] = useState<EcosystemLink[]>([]);

  const refresh = () => setLinks(listEcosystemLinks());
  useEffect(refresh, [unlocked]);

  function read(raw: string) {
    setError(null);
    const n = Date.now();
    const tsd = parseTsdLinkInput(raw);
    if (tsd) return setPending({ kind: "tsd", url: tsd, n });
    const nectar = parseLinkInput(raw);
    if (nectar) return setPending({ kind: "nectar", url: nectar, n });
    if (looksLikeLoginQr(raw)) return setPending({ kind: "signin", payload: raw, n });
    setPending(null);
    setError("That isn't a link from an app BeeKeeper knows yet.");
  }

  const done = () => {
    refresh();
    setInput("");
  };

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Link this wallet to apps in the honest.money ecosystem — NectarPay, TSD Swap, streamTXC,
        Bonfire and more. Paste the link or scan the QR code the app shows you. Only public
        (watch-only) keys or a sign-in signature are shared — your seed phrase and private keys
        never leave this device.
      </p>

      {seedless ? (
        <p className="text-xs text-muted-foreground">Only seed-phrase wallets can be linked.</p>
      ) : (
        <div className="rounded-lg border p-3 space-y-3">
          <div className="flex gap-2">
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Paste link URL"
              className="text-xs"
              autoComplete="off"
              spellCheck={false}
            />
            <QrScanButton
              onScan={(text) => {
                setInput(text);
                read(text);
              }}
            />
            <Button
              type="button"
              variant="outline"
              disabled={!input.trim()}
              onClick={() => read(input)}
            >
              Read
            </Button>
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
          {pending?.kind === "nectar" && (
            <NectarLinkCard key={pending.n} embedded initialUrl={pending.url} onDone={done} />
          )}
          {pending?.kind === "tsd" && (
            <TsdAccountLinkCard key={pending.n} embedded initialUrl={pending.url} onDone={done} />
          )}
          {pending?.kind === "signin" && (
            <WebsiteSignInCard
              key={pending.n}
              embedded
              initialPayload={pending.payload}
              onDone={done}
            />
          )}
        </div>
      )}

      <div className="space-y-1">
        <div className="text-xs font-medium text-muted-foreground">Linked apps</div>
        {links.length === 0 ? (
          <p className="text-xs text-muted-foreground">Nothing linked yet.</p>
        ) : (
          links.map((l) => (
            <div key={l.id} className="flex items-center justify-between gap-2 rounded-md border px-3 py-2">
              <div className="min-w-0">
                <div className="text-sm font-medium">{l.app}</div>
                <div className="truncate text-xs text-muted-foreground">
                  {l.detail ? `${l.detail} · ` : ""}
                  {new Date(l.linkedAt).toLocaleDateString()}
                </div>
              </div>
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7 shrink-0"
                aria-label={`Unlink ${l.app}`}
                onClick={() => {
                  removeEcosystemLink(l.id);
                  refresh();
                }}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))
        )}
        {links.length > 0 && (
          <p className="text-[11px] text-muted-foreground">
            Unlinking only forgets it on this device — the app keeps the public keys it already has.
          </p>
        )}
      </div>
    </div>
  );
}
