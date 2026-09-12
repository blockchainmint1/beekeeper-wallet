import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { AlertTriangle, Camera, Check, ChevronLeft, KeyRound, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { QrScanDialog } from "@/components/wallet/QrScanButton";
import { enableBiometric, isBiometricAvailable } from "@/lib/native/biometric";
import { assessPassword } from "@/lib/security/password-strength";
import { saveWallet } from "@/lib/txc/storage";
import { normalizeMnemonic, validateMnemonic } from "@/lib/txc/wallet";
import { useWallet } from "@/lib/txc/wallet-context";
import { toast } from "sonner";

const DISCLAIMERS = [
  "I understand my copper coin is my only backup. If I lose it, my wallet is gone forever.",
  "I will keep my copper coin safe. Anyone who finds it has unlimited access to my funds. I will store it in a safe or safe deposit box.",
  "I will never share my copper coin. No support agent, app, or website will ever ask me to scan it elsewhere. It is for me only.",
  "I understand this wallet is self-custodial. Neither honest.money nor BeeKeeper can recover my funds or reverse a transaction.",
] as const;

function looksLikePublicAddressOrKey(value: string): boolean {
  const text = value.trim();
  if (/^(bitcoin|btc|texitcoin|txc|litecoin|ltc|dogecoin|doge|iskandercoin|isk):/i.test(text)) return true;
  if (/^(xpub|ypub|zpub|tpub|upub|vpub)[1-9A-HJ-NP-Za-km-z]{40,}$/i.test(text)) return true;
  if (/^0x[a-fA-F0-9]{40}$/.test(text)) return true;
  return /^(bc1|ltc1|doge|txc1|T|L|M|D|A|9)[a-zA-Z0-9]{20,}$/.test(text);
}

function HoneycombMark() {
  return (
    <div className="mx-auto grid h-20 w-20 place-items-center rounded-lg border border-primary/30 bg-primary/10 text-primary" aria-hidden="true">
      <svg viewBox="0 0 64 64" className="h-14 w-14" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M20 8 30 14v12l-10 6-10-6V14l10-6Zm24 0 10 6v12l-10 6-10-6V14l10-6ZM32 30l10 6v12L32 54l-10-6V36l10-6Z" />
        <path d="M23 22c6-8 13-8 18 0M27 23c-4 7 1 15 5 17 4-2 9-10 5-17M24 29h16" />
      </svg>
    </div>
  );
}

export function BeeKeeperOnboarding() {
  const navigate = useNavigate();
  const { loadFromMemory } = useWallet();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [manualPhrase, setManualPhrase] = useState("");
  const [mnemonic, setMnemonic] = useState("");
  const [acks, setAcks] = useState<boolean[]>(DISCLAIMERS.map(() => false));
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [biometricAvailable, setBiometricAvailable] = useState(false);
  const [useBiometrics, setUseBiometrics] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const passwordVerdict = useMemo(() => assessPassword(password), [password]);

  useEffect(() => {
    void isBiometricAvailable().then((available) => {
      setBiometricAvailable(available);
      setUseBiometrics(available);
    });
  }, []);

  function acceptPhrase(raw: string) {
    setError(null);
    const normalized = normalizeMnemonic(raw);
    if (looksLikePublicAddressOrKey(normalized)) {
      toast.info("That looks like the public address on the outside sticker. Remove the security seal and scan the laser-etched recovery words underneath.", { duration: 10_000 });
      return;
    }
    const words = normalized ? normalized.split(" ") : [];
    if (words.length !== 12 && words.length !== 24) {
      setError("Recovery phrase must be exactly 12 or 24 words.");
      return;
    }
    if (!validateMnemonic(normalized)) {
      setError("Those words are not a valid Copper Coin recovery phrase. Check the order and spelling.");
      return;
    }
    setMnemonic(normalized);
    setManualPhrase("");
    setScannerOpen(false);
    setStep(2);
    toast.success("Copper Coin recognized.");
  }

  async function activate() {
    setError(null);
    if (!passwordVerdict.ok) {
      setError(passwordVerdict.message);
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords don't match.");
      return;
    }
    if (!mnemonic) {
      setStep(1);
      setError("Scan your Copper Coin again.");
      return;
    }
    setBusy(true);
    try {
      const wallet = {
        mnemonic,
        passphrase: "",
        kind: "bip44" as const,
        label: "BeeKeeper wallet",
        mode: "seed" as const,
      };
      await saveWallet(wallet, password);
      if (biometricAvailable && useBiometrics) {
        try {
          await enableBiometric(password);
        } catch {
          toast.info("Your wallet is ready. You can turn on biometric unlock later in Settings.");
        }
      }
      await loadFromMemory(wallet);
      setMnemonic("");
      setPassword("");
      setConfirmPassword("");
      await navigate({ to: "/wallet" });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not activate this wallet.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-xl flex-1 flex-col px-5 pb-10 pt-8">
      <header className="text-center">
        <HoneycombMark />
        <p className="mt-4 text-xs font-semibold uppercase text-muted-foreground">Pollinated money</p>
        <h1 className="mt-1 text-3xl font-bold">Activate your BeeKeeper Wallet</h1>
      </header>

      <ol className="mt-7 grid grid-cols-3 gap-2" aria-label="Activation progress">
        {["Scan", "Rules", "Password"].map((label, index) => {
          const number = index + 1;
          const active = number === step;
          const complete = number < step;
          return (
            <li key={label} className={`flex items-center justify-center gap-1.5 rounded-md border px-2 py-2 text-xs font-medium ${active ? "border-primary bg-primary/10 text-foreground" : "border-border text-muted-foreground"}`} aria-current={active ? "step" : undefined}>
              {complete ? <Check className="h-3.5 w-3.5" /> : <span>{number}</span>}
              {label}
            </li>
          );
        })}
      </ol>

      <section className="mt-8 flex-1">
        {step === 1 && (
          <div>
            <h2 className="text-xl font-semibold">Wake up your wallet</h2>
            <p className="mt-2 text-sm text-muted-foreground">Remove the security seal, then scan the recovery words etched into your Copper Coin.</p>
            <Button className="mt-6 h-14 w-full text-base" onClick={() => setScannerOpen(true)}>
              <Camera className="mr-2 h-5 w-5" /> Scan my copper coin
            </Button>
            <div className="my-5 flex items-center gap-3 text-xs text-muted-foreground"><span className="h-px flex-1 bg-border" />or enter the words<span className="h-px flex-1 bg-border" /></div>
            <Textarea value={manualPhrase} onChange={(event) => setManualPhrase(event.target.value.slice(0, 1000))} rows={4} placeholder="Enter 12 or 24 recovery words" autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} className="font-mono" />
            {error && <ErrorMessage>{error}</ErrorMessage>}
            <Button variant="secondary" className="mt-3 w-full" disabled={!manualPhrase.trim()} onClick={() => acceptPhrase(manualPhrase)}>Continue with these words</Button>
            <div className="mt-8 flex flex-col items-center gap-2 text-sm text-muted-foreground">
              <a href="https://coldstoragecoins.com" target="_blank" rel="noreferrer" className="underline underline-offset-4">Don&apos;t have a Copper Coin yet?</a>
              <a href="https://words.honest.money" target="_blank" rel="noreferrer" className="underline underline-offset-4">Really know what you&apos;re doing? Get some words</a>
            </div>
          </div>
        )}

        {step === 2 && (
          <div>
            <h2 className="text-xl font-semibold">Protect the keys to your hive</h2>
            <p className="mt-2 text-sm text-muted-foreground">Confirm each rule before your wallet can be activated.</p>
            <div className="mt-6 space-y-3">
              {DISCLAIMERS.map((text, index) => (
                <label key={text} className="flex cursor-pointer items-start gap-3 rounded-md border border-border p-4 text-sm leading-relaxed">
                  <Checkbox checked={acks[index]} onCheckedChange={(checked) => setAcks((current) => current.map((value, i) => i === index ? checked === true : value))} className="mt-0.5" />
                  <span>{text}</span>
                </label>
              ))}
            </div>
            <div className="mt-6 grid grid-cols-[auto_1fr] gap-3">
              <Button variant="ghost" onClick={() => setStep(1)}><ChevronLeft className="mr-1 h-4 w-4" />Back</Button>
              <Button disabled={!acks.every(Boolean)} onClick={() => setStep(3)}>I agree — continue</Button>
            </div>
          </div>
        )}

        {step === 3 && (
          <form onSubmit={(event) => { event.preventDefault(); void activate(); }}>
            <h2 className="text-xl font-semibold">Secure this device</h2>
            <p className="mt-2 text-sm text-muted-foreground">Choose a password that encrypts your wallet on this device.</p>
            <div className="mt-6 space-y-4">
              <div><Label htmlFor="onboard-password">Wallet password</Label><Input id="onboard-password" className="mt-1" type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} disabled={busy} /></div>
              {password && <div><div className="mb-1 flex justify-between text-xs text-muted-foreground"><span>Password strength</span><span>{passwordVerdict.label}</span></div><Progress value={passwordVerdict.score * 25} /></div>}
              <div><Label htmlFor="onboard-confirm">Confirm password</Label><Input id="onboard-confirm" className="mt-1" type="password" autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} disabled={busy} /></div>
              {biometricAvailable && (
                <div className="flex items-center justify-between gap-4 rounded-md border border-border p-4">
                  <div><p className="text-sm font-medium">Biometric unlock</p><p className="mt-1 text-xs text-muted-foreground">Keep the password in this device&apos;s secure storage for Face ID or fingerprint unlock.</p></div>
                  <Switch checked={useBiometrics} onCheckedChange={setUseBiometrics} aria-label="Use biometric unlock" />
                </div>
              )}
              <div className="flex items-start gap-2 text-xs text-muted-foreground"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" /><p>Your recovery words are encrypted before they are saved. They never leave this device.</p></div>
              {error && <ErrorMessage>{error}</ErrorMessage>}
              <div className="grid grid-cols-[auto_1fr] gap-3"><Button type="button" variant="ghost" disabled={busy} onClick={() => setStep(2)}><ChevronLeft className="mr-1 h-4 w-4" />Back</Button><Button type="submit" disabled={busy}>{busy ? "Activating…" : <><KeyRound className="mr-2 h-4 w-4" />Activate wallet</>}</Button></div>
            </div>
          </form>
        )}
      </section>

      {scannerOpen && <QrScanDialog title="Scan your Copper Coin" helpUrl="https://blockchainmint.com/redeem" onClose={() => setScannerOpen(false)} onScan={acceptPhrase} />}
    </main>
  );
}

function ErrorMessage({ children }: { children: string }) {
  return <div role="alert" className="mt-3 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><span>{children}</span></div>;
}