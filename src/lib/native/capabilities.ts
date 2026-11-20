/**
 * Platform capability gates.
 *
 * App Review Guideline 3.1.5(iii) requires a licence to offer crypto
 * *exchange* services (swaps, bridges) inside an iOS app. We keep those
 * features on Android and the web build, and hard-disable them on iOS.
 *
 * Two independent switches, so a mistake in either direction fails closed:
 *  1. Build-time: `VITE_DISABLE_EXCHANGE=true` (set for App Store builds).
 *  2. Runtime: the Capacitor platform reports `ios`.
 *
 * BeeKeeper is web-only now (no iOS app), so on the web this always allows;
 * it stays as a harmless switch for installs that are already out there.
 */
import { useEffect, useState } from "react";
import { nativePlatform } from "./platform";

const BUILD_DISABLED =
  String(import.meta.env["VITE_DISABLE_EXCHANGE"] ?? "").toLowerCase() === "true";

/** True when swap / bridge features may be shown on this device. */
export function exchangeFeaturesAllowed(): boolean {
  if (BUILD_DISABLED) return false;
  return nativePlatform() !== "ios";
}

/**
 * Hydration-safe version. Starts `false` on the server and on the first
 * client render (so iOS never flashes a swap button), then resolves after
 * mount when the Capacitor platform is known.
 */
export function useExchangeFeaturesAllowed(): boolean {
  const [allowed, setAllowed] = useState(false);
  useEffect(() => {
    setAllowed(exchangeFeaturesAllowed());
  }, []);
  return allowed;
}
