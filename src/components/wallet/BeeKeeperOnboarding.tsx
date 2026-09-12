import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { AlertTriangle, Camera, Check, ChevronLeft, KeyRound, ShieldCheck, Upload, WalletCards } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { QrScanDialog } from "@/components/wallet/QrScanButton";
import { NectarLinkCard } from "@/components/wallet/NectarLinkCard";
import { enableBiometric, isBiometricAvailable } from "@/lib/native/biometric";
import { assessPassword } from "@/lib/security/password-strength";
import { hasWallet, saveWallet, saveWalletToNewProfile } from "@/lib/txc/storage";
import { DEFAULT_PROFILE_ID, setActiveProfileId } from "@/lib/profiles";
import {
  isSupportedLegacyBackupFile,
  listLegacyBeeKeeperWallets,
  parseLegacyBeeKeeperBackup,
  unlockLegacyBeeKeeperWallet,
  type LegacyBeeKeeperWallet,
} from "@/lib/legacy-beekeeper";
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
    <div className="relative mx-auto flex h-20 w-20 items-center justify-center" aria-hidden="true">
      <div className="absolute inset-0 rounded-full opacity-60 blur-xl" style={{ background: "radial-gradient(circle, oklch(0.769 0.188 70.08) 0%, transparent 70%)" }} />
      <svg viewBox="0 0 64 64" className="relative h-20 w-20">
        <defs>
          <linearGradient id="combFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="oklch(0.88 0.16 88)" />
            <stop offset="100%" stopColor="oklch(0.62 0.17 60)" />
          </linearGradient>
        </defs>
        {[[32, 14], [20, 21], [44, 21], [32, 28], [20, 35], [44, 35], [32, 42]].map(([cx, cy], i) => (
          <polygon key={i} points={hexPoints(cx, cy, 6.5)} fill="url(#combFill)" stroke="oklch(0.4 0.08 70)" strokeWidth="0.8" opacity={0.95} />
        ))}
        <g transform="translate(40 46) rotate(20)">
          <ellipse cx="0" cy="0" rx="7" ry="4.5" fill="oklch(0.88 0.18 92)" stroke="oklch(0.2 0.02 80)" strokeWidth="0.9" />
          <rect x="-4" y="-4.5" width="2" height="9" fill="oklch(0.2 0.02 80)" />
          <rect x="0" y="-4.5" width="2" height="9" fill="oklch(0.2 0.02 80)" />
          <ellipse cx="-3" cy="-3" rx="4" ry="2.2" fill="#ffffff" opacity="0.85" transform="rotate(-25 -3 -3)" />
          <ellipse cx="3" cy="-3" rx="4" ry="2.2" fill="#ffffff" opacity="0.85" transform="rotate(25 3 -3)" />
        </g>
      </svg>
    </div>
  );
}

function hexPoints(cx: number, cy: number, r: number): string {
  const pts: string[] = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i - Math.PI / 2;
    pts.push(`${(cx + r * Math.cos(a)).toFixed(2)},${(cy + r * Math.sin(a)).toFixed(2)}`);
  }
  return pts.join(" ");
}

export function BeeKeeperOnboarding() {
  const navigate = useNavigate();
  const { loadFromMemory } = useWallet();
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [legacyMode, setLegacyMode] = useState(false);
  const [legacyWallets, setLegacyWallets] = useState<LegacyBeeKeeperWallet[]>([]);
  const [legacyPasswords, setLegacyPasswords] = useState<Record<string, string>>({});
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
    setLegacyWallets(listLegacyBeeKeeperWallets());
    void isBiometricAvailable().then((available) => {
      setBiometricAvailable(available);
      setUseBiometrics(available);
    });
  }, []);

  async function importLegacyWallets() {
    setError(null);
    if (!passwordVerdict.ok) {
      setError(passwordVerdict.message);
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords don't match.");
      return;
    }
    const missing = legacyWallets.find((wallet) => !legacyPasswords[wallet.id]);
    if (missing) {
      setError(`Enter the old password for “${missing.label}”.`);
      return;
    }
    setBusy(true);
    try {
      const unlockedWallets = await Promise.all(legacyWallets.map(async (legacy) => ({
        legacy,
        mnemonic: await unlockLegacyBeeKeeperWallet(legacy, legacyPasswords[legacy.id] ?? ""),
      })));
      if (!unlockedWallets.length) throw new Error("No old BeeKeeper wallets were found.");

      const alreadyHasWallet = hasWallet();
      const first = unlockedWallets[0];
      const primary = { mnemonic: first.mnemonic, passphrase: "", kind: "bip44" as const, label: first.legacy.label, mode: "seed" as const };
      if (alreadyHasWallet) {
        const profileIds: string[] = [];
        for (const item of unlockedWallets) {
          const id = await saveWalletToNewProfile({ mnemonic: item.mnemonic, passphrase: "", kind: "bip44", label: item.legacy.label, mode: "seed" }, password);
          profileIds.push(id);
        }
        setActiveProfileId(profileIds[0] ?? DEFAULT_PROFILE_ID);
      } else {
        setActiveProfileId(DEFAULT_PROFILE_ID);
        await saveWallet(primary, password);
        for (const item of unlockedWallets.slice(1)) {
          await saveWalletToNewProfile({ mnemonic: item.mnemonic, passphrase: "", kind: "bip44", label: item.legacy.label, mode: "seed" }, password);
        }
        setActiveProfileId(DEFAULT_PROFILE_ID);
      }
      if (biometricAvailable && useBiometrics) {
        try { await enableBiometric(password); } catch { toast.info("Your wallets are imported. You can turn on biometric unlock later in Settings."); }
      }
      await loadFromMemory(primary);
      setLegacyPasswords({});
      setPassword("");
      setConfirmPassword("");
      toast.success(`${unlockedWallets.length} BeeKeeper wallet${unlockedWallets.length === 1 ? "" : "s"} imported.`);
      setLegacyMode(false);
      setStep(4);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not import the old BeeKeeper wallet.");
    } finally {
      setBusy(false);
    }
  }

  async function loadLegacyBackup(file: File | undefined) {
    setError(null);
    if (!file) return;
    if (!isSupportedLegacyBackupFile(file)) {
      setError("Choose the encrypted JSON backup downloaded from the old BeeKeeper wallet.");
      return;
    }
    try {
      const imported = parseLegacyBeeKeeperBackup(await file.text(), file.name);
      setLegacyWallets(imported);
      setLegacyPasswords({});
      toast.success(`${imported.length} encrypted BeeKeeper wallet${imported.length === 1 ? "" : "s"} found in the backup.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not read that BeeKeeper backup.");
    }
  }

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
      if (hasWallet()) {
        await saveWalletToNewProfile(wallet, password);
      } else {
        await saveWallet(wallet, password);
      }
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
      setStep(4);
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
        <p className="mt-4 text-sm font-semibold uppercase tracking-[0.32em] text-primary/90">Pollinated money</p>
        <h1 className="mt-1 text-3xl font-bold tracking-tight">Activate your BeeKeeper</h1>
        <p className="mt-2 text-muted-foreground">Scan your Cold Storage Coin and the hive comes to life — Bitcoin, TEXITcoin, and EVM wallets, all from one queen seed.</p>
      </header>

      <ol className="mt-7 flex items-center gap-1.5 text-[10px]" aria-label="Activation progress">
        {["Scan", "Rules", "Password", "Merchant"].map((label, index) => {
          const number = index + 1;
          const active = number === step;
          const complete = number < step;
          return (
            <li key={label} className={`flex flex-1 items-center justify-center gap-1 rounded-full px-2 py-1.5 text-center font-medium uppercase tracking-wider transition-colors ${complete ? "bg-primary/30 text-primary" : active ? "bg-primary/20 text-primary" : "bg-muted text-muted-foreground"}`} aria-current={active ? "step" : undefined}>
              {complete && <Check className="h-3 w-3" />}
              {number}. {label}
            </li>
          );
        })}
      </ol>

      <section className="mt-8 flex-1">
        {legacyMode ? (
          <form onSubmit={(event) => { event.preventDefault(); void importLegacyWallets(); }}>
            <Button type="button" variant="ghost" className="mb-4 px-0" disabled={busy} onClick={() => { setLegacyMode(false); setError(null); }}><ChevronLeft className="mr-1 h-4 w-4" />Back to activation</Button>
            <h2 className="text-xl font-semibold">Import your old BeeKeeper wallet</h2>
            {legacyWallets.length > 0 ? (
              <>
                <p className="mt-2 text-sm text-muted-foreground">We found your encrypted wallet data. Unlock each wallet with its old password. The old copy will remain untouched.</p>
                <div className="mt-6 space-y-3">
                  {legacyWallets.map((wallet) => (
                    <div key={wallet.id} className="rounded-md border border-border p-4">
                      <Label htmlFor={`legacy-${wallet.id}`}>{wallet.label} old password</Label>
                      <Input id={`legacy-${wallet.id}`} className="mt-2" type="password" autoComplete="current-password" value={legacyPasswords[wallet.id] ?? ""} onChange={(event) => setLegacyPasswords((current) => ({ ...current, [wallet.id]: event.target.value }))} disabled={busy} />
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div className="mt-5 rounded-md border border-border p-4">
                <p className="text-sm font-medium">The old saved wallet is not available to this page</p>
                <p className="mt-1 text-sm text-muted-foreground">This happens when it was used in another browser, app, or website address. Choose its encrypted backup file, or go back and enter the recovery words.</p>
                <Label htmlFor="legacy-backup-file" className="mt-4 inline-flex cursor-pointer items-center justify-center gap-2 rounded-md border border-input bg-background px-4 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground">
                  <Upload className="h-4 w-4" /> Choose encrypted backup
                </Label>
                <Input id="legacy-backup-file" type="file" accept=".json,application/json,text/plain" className="sr-only" onChange={(event) => void loadLegacyBackup(event.target.files?.[0])} />
              </div>
            )}
            {legacyWallets.length > 0 && <><div className="my-6 h-px bg-border" />
            <p className="text-sm font-medium">Choose one new password</p>
            <p className="mt-1 text-xs text-muted-foreground">This new password will unlock all imported wallets on this device.</p>
            <div className="mt-4 space-y-4">
              <div><Label htmlFor="legacy-new-password">New wallet password</Label><Input id="legacy-new-password" className="mt-1" type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} disabled={busy} /></div>
              {password && <div><div className="mb-1 flex justify-between text-xs text-muted-foreground"><span>Password strength</span><span>{passwordVerdict.label}</span></div><Progress value={passwordVerdict.score * 25} /></div>}
              <div><Label htmlFor="legacy-confirm-password">Confirm new password</Label><Input id="legacy-confirm-password" className="mt-1" type="password" autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} disabled={busy} /></div>
              {biometricAvailable && <div className="flex items-center justify-between gap-4 rounded-md border border-border p-4"><div><p className="text-sm font-medium">Biometric unlock</p><p className="mt-1 text-xs text-muted-foreground">Use Face ID or fingerprint after import.</p></div><Switch checked={useBiometrics} onCheckedChange={setUseBiometrics} aria-label="Use biometric unlock" /></div>}
              {error && <ErrorMessage>{error}</ErrorMessage>}
              <Button type="submit" className="w-full" disabled={busy}>{busy ? "Importing…" : `Import ${legacyWallets.length} wallet${legacyWallets.length === 1 ? "" : "s"}`}</Button>
            </div></>}
            {error && legacyWallets.length === 0 && <ErrorMessage>{error}</ErrorMessage>}
          </form>
        ) : step === 1 && (
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
            <div className="mt-6 rounded-md border border-border bg-muted/30 p-4">
                <div className="flex items-start gap-3">
                  <WalletCards className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
                  <div className="min-w-0 flex-1">
                    <h3 className="font-semibold">Already used the old BeeKeeper wallet?</h3>
                    <p className="mt-1 text-sm text-muted-foreground">{legacyWallets.length > 0 ? `We found ${legacyWallets.length} encrypted wallet${legacyWallets.length === 1 ? "" : "s"} on this device.` : "Use the old saved wallet, an encrypted backup file, or your recovery words."}</p>
                    <Button type="button" variant="outline" className="mt-3 w-full" onClick={() => { setLegacyMode(true); setError(null); }}>Import old BeeKeeper wallet{legacyWallets.length === 1 ? "" : "s"}</Button>
                  </div>
                </div>
              </div>
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

        {step === 4 && (
          <div>
            <div className="flex items-start gap-3 rounded-md border border-primary/30 bg-primary/10 p-4">
              <Check className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
              <p className="text-sm">Your wallet is active and encrypted on this device.</p>
            </div>
            <h2 className="mt-6 text-xl font-semibold">Link a merchant (optional)</h2>
            <p className="mt-2 text-sm text-muted-foreground">Shopping with a Nectar Pay store? Scan or paste their link QR and this wallet can receive their invoices. You can always do this later in Settings.</p>
            <div className="mt-5 rounded-md border border-border p-4">
              <NectarLinkCard compact />
            </div>
            <Button className="mt-6 w-full" onClick={() => void navigate({ to: "/wallet" })}>
              <WalletCards className="mr-2 h-4 w-4" /> Go to my wallet
            </Button>
          </div>
        )}
      </section>

      {scannerOpen && <QrScanDialog title="Scan your Copper Coin" helpUrl="https://blockchainmint.com/redeem" onClose={() => setScannerOpen(false)} onScan={acceptPhrase} />}
    </main>
  );
}

function ErrorMessage({ children }: { children: string }) {
  return <div role="alert" className="mt-3 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><span>{children}</span></div>;
}