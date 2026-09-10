import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { QrScanButton } from "@/components/wallet/QrScanButton";
import { fetchLoginMessage, parseLoginInput, signInToNectar, type NectarLoginRequest } from "@/lib/nectar/auth";
import { loginSiteName } from "@/lib/web-login-hosts";
import { useWallet } from "@/lib/txc/wallet-context";

/**
 * "Sign in to a website" flow: scan a partner site's sign-in QR (NectarPay,
 * streamTXC, …), review the exact login message, approve, and the signature
 * goes back to the site. No payment is authorized.
 */
export function WebsiteSignInCard({ initialPayload }: { initialPayload?: string }) {
  const { unlocked } = useWallet();
  const seedless = !unlocked || unlocked.mode === "keyonly" || !unlocked.mnemonic;

  const [loginRequest, setLoginRequest] = useState<(NectarLoginRequest & { message: string }) | null>(null);
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginDone, setLoginDone] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const handledInitial = useRef(false);

  async function onScan(text: string) {
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

  // A sign-in QR scanned from the main camera arrives as initialPayload.
  useEffect(() => {
    if (handledInitial.current || !initialPayload) return;
    handledInitial.current = true;
    void onScan(initialPayload);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPayload]);

  async function onApprove() {
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

  if (seedless) {
    return (
      <p className="text-sm text-muted-foreground">
        Website sign-in needs a seed-based wallet. Key-only wallets can&apos;t sign in here yet.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium">Sign in to a website</p>
          <p className="text-xs text-muted-foreground">
            Scan a sign-in QR from a partner site like NectarPay or streamTXC. We sign you in with your
            wallet — no payment is authorized.
          </p>
        </div>
        <QrScanButton onScan={onScan} />
      </div>
      {loginRequest && (
        <div className="space-y-3 rounded-md border border-border/60 p-3">
          <p className="text-xs text-muted-foreground">
            <span className="font-medium text-foreground">{loginSiteName(loginRequest.origin)}</span>{" "}
            (<span className="font-medium text-foreground">{loginRequest.origin}</span>) is asking this
            wallet to sign a temporary login message.
          </p>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-2 text-xs">{loginRequest.message}</pre>
          <Button onClick={onApprove} disabled={loginBusy || loginDone} size="sm">
            {loginDone ? "Signed in" : loginBusy ? "Signing…" : `Approve sign-in to ${loginSiteName(loginRequest.origin)}`}
          </Button>
        </div>
      )}
      {loginError && <p className="text-sm text-destructive">{loginError}</p>}
      {loginDone && (
        <p className="text-sm text-emerald-500">
          The site accepted the signature. You can return to the sign-in window.
        </p>
      )}
    </div>
  );
}
