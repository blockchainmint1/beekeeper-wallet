import { useState } from "react";
import { Check, Copy, PenLine } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { QrScanButton } from "@/components/wallet/QrScanButton";
import { useCopyFeedback } from "@/hooks/use-copy-feedback";
import { fetchLoginMessage, parseLoginInput, signInToNectar, type NectarLoginRequest } from "@/lib/nectar/auth";
import { loginSiteName } from "@/lib/web-login-hosts";
import { useWallet } from "@/lib/txc/wallet-context";
import { signMessageWithSeed, verifyMessage, type SignedMessage } from "@/lib/txc/message-sign";

export function SignMessageCard({ compact }: { compact?: boolean }) {
  const { unlocked } = useWallet();
  const seedless = !unlocked || unlocked.mode === "keyonly" || !unlocked.mnemonic;

  const [tab, setTab] = useState<"sign" | "verify">("sign");
  const [message, setMessage] = useState("");
  const [index, setIndex] = useState("0");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SignedMessage | null>(null);
  const { copied, copy } = useCopyFeedback();
  const [loginRequest, setLoginRequest] = useState<(NectarLoginRequest & { message: string }) | null>(null);
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginDone, setLoginDone] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [vAddress, setVAddress] = useState("");
  const [vMessage, setVMessage] = useState("");
  const [vSignature, setVSignature] = useState("");
  const [vResult, setVResult] = useState<boolean | null>(null);

  async function onNectarScan(text: string) {
    setLoginError(null);
    setLoginDone(false);
    setLoginRequest(null);
    try {
      const request = parseLoginInput(text);
      setLoginRequest(await fetchLoginMessage(request));
    } catch (e) {
      setLoginError(e instanceof Error ? e.message : "Could not read this sign-in request.");
    }
  }

  async function onNectarSign() {
    if (!unlocked?.mnemonic || !loginRequest) return;
    setLoginBusy(true);
    setLoginError(null);
    try {
      await signInToNectar({
        request: loginRequest,
        mnemonic: unlocked.mnemonic,
        passphrase: unlocked.passphrase,
      });
      setLoginDone(true);
    } catch (e) {
      setLoginError(e instanceof Error ? e.message : "Could not complete sign-in.");
    } finally {
      setLoginBusy(false);
    }
  }

  async function onSign() {
    if (!unlocked) return;
    setError(null);
    setResult(null);
    setBusy(true);
    try {
      const i = Math.max(0, Math.min(1000, Number.parseInt(index || "0", 10) || 0));
      const signed = await signMessageWithSeed({
        mnemonic: unlocked.mnemonic,
        passphrase: unlocked.passphrase,
        kind: unlocked.kind,
        change: 0,
        index: i,
        message,
      });
      setResult(signed);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not sign this message.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      className={compact ? "rounded-none border-0 bg-transparent shadow-none" : "mt-5"}
    >
      {!compact && (
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <PenLine className="h-5 w-5" /> Sign &amp; verify message
          </CardTitle>
          <CardDescription>
            Prove you control a TEXITcoin address by signing a message with its key. Signing costs
            nothing, never touches the blockchain, and never moves funds.
          </CardDescription>
        </CardHeader>
      )}
      <CardContent className={compact ? "space-y-4 p-0" : "space-y-4"}>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant={tab === "sign" ? "default" : "outline"}
            onClick={() => setTab("sign")}
          >
            Sign
          </Button>
          <Button
            size="sm"
            variant={tab === "verify" ? "default" : "outline"}
            onClick={() => setTab("verify")}
          >
            Verify
          </Button>
        </div>

        {tab === "sign" ? (
          seedless ? (
            <p className="text-sm text-muted-foreground">
              Message signing needs a seed-based wallet. Key-only wallets can&apos;t sign here yet.
            </p>
          ) : (
            <div className="space-y-3">
              <div className="space-y-1">
                <Label htmlFor="sign-msg">Message</Label>
                <Textarea
                  id="sign-msg"
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder="I control this address."
                  rows={3}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="sign-index">Address index</Label>
                <Input
                  id="sign-index"
                  inputMode="numeric"
                  value={index}
                  onChange={(e) => setIndex(e.target.value.replace(/\D/g, ""))}
                  className="w-28"
                />
                <p className="text-xs text-muted-foreground">
                  0 is your first receive address on {unlocked?.kind ?? "this"} derivation.
                </p>
              </div>
              <Button onClick={onSign} disabled={busy || !message.trim()}>
                {busy ? "Signing..." : "Sign message"}
              </Button>
              {error && <p className="text-sm text-destructive">{error}</p>}
              {result && (
                <div className="space-y-2 rounded-md border border-border/60 p-3 text-sm">
                  <Field k="Address" v={result.address} onCopy={() => copy(result.address)} />
                  <Field k="Path" v={result.path} />
                  <Field k="Signature" v={result.signature} onCopy={() => copy(result.signature)} />
                  <p className="text-xs text-muted-foreground">
                    Signing into a site? Paste the address and the signature on their own — the
                    full block below is only for humans and files.
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      copy(
                        `-----BEGIN SIGNED MESSAGE-----\n${result.message}\n-----BEGIN SIGNATURE-----\n${result.address}\n${result.signature}\n-----END SIGNED MESSAGE-----`,
                      )
                    }
                  >
                    {copied ? (
                      <>
                        <Check className="mr-1 h-4 w-4" /> Copied
                      </>
                    ) : (
                      <>
                        <Copy className="mr-1 h-4 w-4" /> Copy signed message
                      </>
                    )}
                  </Button>
                </div>
              )}

              <div className="border-t border-border/60 pt-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium">Sign in to a website</p>
                    <p className="text-xs text-muted-foreground">
                      Scan a sign-in QR from a partner site like NectarPay or streamTXC. We sign you in with your
                      wallet — no payment is authorized.
                    </p>
                  </div>
                  <QrScanButton onScan={onNectarScan} />
                </div>
                {loginRequest && (
                  <div className="mt-3 space-y-3 rounded-md border border-border/60 p-3">
                    <p className="text-xs text-muted-foreground">
                      <span className="font-medium text-foreground">{loginSiteName(loginRequest.origin)}</span>{" "}
                      (<span className="font-medium text-foreground">{loginRequest.origin}</span>) is asking this
                      wallet to sign a temporary login message.
                    </p>
                    <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-2 text-xs">{loginRequest.message}</pre>
                    <Button onClick={onNectarSign} disabled={loginBusy || loginDone} size="sm">
                      {loginDone ? "Signed in" : loginBusy ? "Signing…" : `Approve sign-in to ${loginSiteName(loginRequest.origin)}`}
                    </Button>
                  </div>
                )}
                {loginError && <p className="mt-2 text-sm text-destructive">{loginError}</p>}
                {loginDone && <p className="mt-2 text-sm text-emerald-500">The site accepted the signature. You can return to the sign-in window.</p>}
              </div>
            </div>
          )
        ) : (
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="v-addr">Address</Label>
              <Input
                id="v-addr"
                value={vAddress}
                onChange={(e) => setVAddress(e.target.value)}
                placeholder="T… or txc1…"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="v-msg">Message</Label>
              <Textarea
                id="v-msg"
                rows={3}
                value={vMessage}
                onChange={(e) => setVMessage(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="v-sig">Signature</Label>
              <Textarea
                id="v-sig"
                rows={2}
                value={vSignature}
                onChange={(e) => setVSignature(e.target.value)}
                placeholder="base64 signature"
              />
            </div>
            <Button
              variant="outline"
              disabled={!vAddress.trim() || !vSignature.trim()}
              onClick={() => setVResult(verifyMessage(vAddress, vMessage, vSignature))}
            >
              Verify signature
            </Button>
            {vResult !== null && (
              <p className={`text-sm ${vResult ? "text-emerald-500" : "text-destructive"}`}>
                {vResult
                  ? "Valid — this address signed that exact message."
                  : "Invalid — address, message or signature doesn't match."}
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Field({ k, v, onCopy }: { k: string; v: string; onCopy?: () => void }) {
  if (!v) return null;
  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs text-muted-foreground">{k}</div>
        {onCopy && (
          <Button size="sm" variant="ghost" className="h-6 px-2" onClick={onCopy}>
            <Copy className="mr-1 h-3 w-3" /> Copy
          </Button>
        )}
      </div>
      <div className="break-all font-mono text-xs">{v}</div>
    </div>
  );
}
