/**
 * QR scan button. Uses an in-app <video> + getUserMedia dialog on every
 * platform (browser and native WKWebView), decoding frames with either the
 * built-in BarcodeDetector or jsQR as a fallback.
 *
 * We used to route native builds through @capacitor-community/barcode-scanner,
 * which draws the camera behind a transparent webview. That approach breaks
 * when the app loads from a remote URL (our current setup — server.url =
 * https://mobile.honest.money) because the community plugin can't reliably
 * make a remotely-hosted webview transparent. Result: tapping the QR icon
 * did nothing / showed a black screen. The getUserMedia path works
 * identically inside WKWebView as long as NSCameraUsageDescription is set
 * (it is) and the page is HTTPS (it is).
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Camera, ImagePlus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

type BarcodeDetectorLike = {
  detect: (source: CanvasImageSource) => Promise<Array<{ rawValue: string }>>;
};

declare global {
  interface Window {
    BarcodeDetector?: new (opts?: { formats?: string[] }) => BarcodeDetectorLike;
  }
}

export function QrScanButton({ onScan }: { onScan: (text: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="icon"
        onClick={() => setOpen(true)}
        title="Scan QR"
        aria-label="Scan QR"
      >
        <Camera className="h-4 w-4" />
      </Button>
      {open && (
        <QrScanDialog
          onClose={() => setOpen(false)}
          onScan={(text) => {
            setOpen(false);
            onScan(text);
          }}
        />
      )}
    </>
  );
}

export function QrScanDialog({
  onClose,
  onScan,
  title = "Scan QR",
  helpUrl,
}: {
  onClose: () => void;
  onScan: (t: string) => void;
  title?: string;
  helpUrl?: string;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [manual, setManual] = useState("");

  useEffect(() => {
    let stream: MediaStream | null = null;
    let raf = 0;
    let cancelled = false;
    let detector: BarcodeDetectorLike | null = null;
    let jsQR: typeof import("jsqr").default | null = null;

    async function start() {
      if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
        setError("Camera not supported on this device.");
        return;
      }
      if (typeof window !== "undefined" && window.BarcodeDetector) {
        try {
          detector = new window.BarcodeDetector({ formats: ["qr_code"] });
        } catch {
          detector = null;
        }
      }
      if (!detector) {
        try {
          const mod = await import("jsqr");
          jsQR = mod.default;
        } catch {
          setError("QR decoder failed to load.");
          return;
        }
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" } },
          audio: false,
        });
      } catch (e) {
        setError(
          e instanceof Error && e.name === "NotAllowedError"
            ? "Camera access denied. Enable it in Settings → HME Wallet."
            : e instanceof Error
              ? e.message
              : "Camera unavailable",
        );
        return;
      }
      if (cancelled) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      const video = videoRef.current;
      if (!video) return;
      video.srcObject = stream;
      video.setAttribute("playsinline", "true");
      try {
        await video.play();
      } catch {
        /* autoplay retries below on tick */
      }
      setReady(true);

      const canvas = canvasRef.current ?? document.createElement("canvas");
      canvasRef.current = canvas;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });

      const tick = async () => {
        if (cancelled || !video) return;
        if (video.readyState >= 2 && video.videoWidth > 0) {
          try {
            if (detector) {
              const codes = await detector.detect(video);
              if (codes.length > 0 && codes[0].rawValue) {
                onScan(codes[0].rawValue);
                return;
              }
            } else if (jsQR && ctx) {
              const w = video.videoWidth;
              const h = video.videoHeight;
              canvas.width = w;
              canvas.height = h;
              ctx.drawImage(video, 0, 0, w, h);
              const img = ctx.getImageData(0, 0, w, h);
              const code = jsQR(img.data, w, h, { inversionAttempts: "attemptBoth" });
              if (code && code.data) {
                onScan(code.data);
                return;
              }
            }
          } catch {
            // ignore per-frame errors
          }
        }
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    }

    start();
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      if (stream) stream.getTracks().forEach((t) => t.stop());
    };
  }, [onScan]);

  async function scanPhoto(file: File) {
    setError(null);
    try {
      const bitmap = await createImageBitmap(file);
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) throw new Error("Could not read that image.");
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const { default: jsQR } = await import("jsqr");
      const result = jsQR(image.data, image.width, image.height, { inversionAttempts: "attemptBoth" });
      if (!result?.data) throw new Error("No QR code was found in that photo.");
      onScan(result.data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not scan that photo.");
    }
  }

  if (typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-end justify-center bg-background/95 sm:items-center" role="dialog" aria-modal="true" aria-labelledby="qr-scan-title">
      <div className="flex max-h-[100dvh] w-full max-w-md flex-col overflow-y-auto bg-background sm:max-h-[92dvh] sm:rounded-lg sm:border sm:border-border">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 id="qr-scan-title" className="font-semibold">{title}</h2>
          <Button type="button" variant="ghost" size="icon" onClick={onClose} aria-label="Close scanner">
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="relative aspect-square shrink-0 bg-foreground">
          <video
            ref={videoRef}
            className="absolute inset-0 w-full h-full object-cover"
            playsInline
            muted
            autoPlay
          />
          <div className="pointer-events-none absolute inset-8 rounded-lg border-2 border-background/70" />
        </div>
        <div className="space-y-3 p-4">
          <p className={error ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>
            {error ? error : ready ? "Hold the QR code inside the frame." : "Starting camera…"}
          </p>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void scanPhoto(file);
              event.currentTarget.value = "";
            }}
          />
          <Button type="button" variant="outline" className="w-full" onClick={() => fileRef.current?.click()}>
            <ImagePlus className="mr-2 h-4 w-4" /> Scan from a photo
          </Button>
          <div className="space-y-2">
            <Textarea
              value={manual}
              onChange={(event) => setManual(event.target.value.slice(0, 1000))}
              rows={2}
              placeholder="Or paste the QR contents"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
            <Button type="button" variant="secondary" className="w-full" disabled={!manual.trim()} onClick={() => onScan(manual.trim())}>
              Use pasted text
            </Button>
          </div>
          {helpUrl && (
            <a href={helpUrl} target="_blank" rel="noreferrer" className="block text-center text-xs text-muted-foreground underline underline-offset-4">
              How to remove the security seal and clean your coin
            </a>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * Parse a wallet URI like `texitcoin:txc1...?amount=1.23` or a plain address.
 * Returns { address, amount?, tokenId? } where amount is a decimal string and
 * tokenId is an Omni property id (`?omni=39`) when the URI requests a token.
 */
export function parseWalletUri(input: string): { address: string; amount?: string; tokenId?: number } {
  const trimmed = input.trim();
  const schemeMatch = trimmed.match(/^(texitcoin|txc|bitcoin|btc|iskandercoin|isk|litecoin|ltc|dogecoin|doge):([^?]+)(\?(.*))?$/i);
  if (schemeMatch) {
    const address = schemeMatch[2];
    const params = new URLSearchParams(schemeMatch[4] ?? "");
    const amount = params.get("amount") ?? undefined;
    const rawId =
      params.get("omni") ??
      params.get("propertyid") ??
      params.get("property") ??
      params.get("token") ??
      "";
    const n = Number(rawId.trim());
    const tokenId = Number.isInteger(n) && n > 0 ? n : undefined;
    return { address, amount, tokenId };
  }
  return { address: trimmed };
}
