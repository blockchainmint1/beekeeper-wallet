/**
 * Link this wallet to a TSD Swap account by scanning the QR code shown on
 * the TSD Swap profile page (or pasting the link URL).
 *
 * Shares the watch-only TEXITcoin account key and the base EVM address only.
 * Seed phrase and private keys never leave this device.
 */
import { useEffect, useState } from "react";
import { Link2, Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { QrScanButton } from "@/components/wallet/QrScanButton";
import { useWallet } from "@/lib/txc/wallet-context";
import {
  fetchTsdManifest,
  listTsdLinks,
  parseTsdLinkInput,
  removeTsdLink,
  saveTsdLink,
  submitTsdLink,
  type TsdLinkManifest,
  type TsdLinkRecord,
} from "@/lib/rewards/tsd-link";

export function TsdAccountLinkCard({
  compact,
  initialUrl,
  embedded,
  onDone,
}: {
  compact?: boolean;
  initialUrl?: string;
  embedded?: boolean;
  onDone?: () => void;
}) {
  const { unlocked } = useWallet();
  const seedless = !unlocked || unlocked.mode === "keyonly" || !unlocked.mnemonic;

  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [manifest, setManifest] = useState<TsdLinkManifest | null>(null);
  const [links, setLinks] = useState<TsdLinkRecord[]>([]);

  useEffect(() => {
    setLinks(listTsdLinks());
  }, [unlocked]);

  useEffect(() => {
    if (initialUrl) void onLoad(initialUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialUrl]);

  async function onLoad(raw: string) {
    setError(null);
    setNotice(null);
    setManifest(null);
    const url = parseTsdLinkInput(raw);
    if (!url) {
      setError("That isn't a TSD Swap account link.");
      return;
    }
    if (!unlocked?.mnemonic) return;
    setBusy(true);
    try {
      setManifest(await fetchTsdManifest(url));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read that link.");
    } finally {
      setBusy(false);
    }
  }

  async function onApprove() {
    if (!manifest || !unlocked?.mnemonic) return;
    setBusy(true);
    setError(null);
    try {
      const res = await submitTsdLink({
        manifest,
        mnemonic: unlocked.mnemonic,
        passphrase: unlocked.passphrase ?? "",
      });
      const record: TsdLinkRecord = {
        accountId: res.account_id ?? manifest.account_id ?? manifest.challenge_id,
        accountName: res.account_name ?? manifest.account_name ?? "TSD Swap account",
        identity: manifest.from,
        linkedAt: new Date().toISOString(),
      };
      saveTsdLink(record);
      setLinks(listTsdLinks());
      setManifest(null);
      setInput("");
      setNotice(`Linked to ${record.accountName}.`);
      onDone?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Link failed.");
    } finally {
      setBusy(false);
    }
  }

  const approval = manifest ? (
            <div className="rounded-lg border p-3 space-y-2">
              <div className="text-sm font-medium">
                {manifest!.account_name ?? "TSD Swap account"}
                {manifest!.account_id ? (
                  <span className="text-muted-foreground"> · {manifest!.account_id}</span>
                ) : null}
              </div>
              {manifest!.purpose && (
                <p className="text-xs text-muted-foreground">{manifest!.purpose}</p>
              )}
              <div className="text-xs text-muted-foreground">
                Sharing: watch-only account keys (TEXITcoin, EVM and the other chains). No seed, no
                private keys.
              </div>
              <div className="flex gap-2">
                <Button size="sm" disabled={busy} onClick={() => void onApprove()}>
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Share keys"}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setManifest(null)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : null;

  if (embedded) {
    return (
      <div className="space-y-3">
        {busy && !manifest && <Loader2 className="h-4 w-4 animate-spin" />}
        {manifest && approval}
        {error && <p className="text-xs text-destructive">{error}</p>}
        {notice && <p className="text-xs text-muted-foreground">{notice}</p>}
      </div>
    );
  }

  const body = (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Scan the QR code on your TSD Swap profile page to link this wallet. It shares your
        watch-only TEXITcoin account key and your base EVM address, so TSD Swap can add up your
        TSD across every address for rewards. Public keys only — your seed phrase and private keys
        never leave this device.
      </p>

      {seedless ? (
        <p className="text-xs text-muted-foreground">Only seed-phrase wallets can be linked.</p>
      ) : (
        <>
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
                void onLoad(text);
              }}
            />
            <Button
              type="button"
              variant="outline"
              disabled={busy || !input.trim()}
              onClick={() => void onLoad(input)}
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Read"}
            </Button>
          </div>

          {manifest && approval}

          {error && <p className="text-xs text-destructive">{error}</p>}
          {notice && <p className="text-xs text-muted-foreground">{notice}</p>}

          {links.length > 0 && (
            <div className="space-y-1 pt-1">
              <div className="text-xs font-medium text-muted-foreground">Linked accounts</div>
              {links.map((l) => (
                <div key={l.accountId} className="flex items-center justify-between gap-2 text-xs">
                  <span className="truncate">
                    {l.accountName}
                    <span className="text-muted-foreground">
                      {" "}
                      · {new Date(l.linkedAt).toLocaleDateString()}
                    </span>
                  </span>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7"
                    aria-label={`Forget ${l.accountName}`}
                    onClick={() => {
                      removeTsdLink(l.accountId);
                      setLinks(listTsdLinks());
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );

  if (compact) return body;

  return (
    <Card className="mt-5">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Link2 className="h-4 w-4" /> TSD Swap link
        </CardTitle>
        <CardDescription>Link this wallet to your TSD Swap account.</CardDescription>
      </CardHeader>
      <CardContent>{body}</CardContent>
    </Card>
  );
}
