#!/usr/bin/env node
/**
 * Applies the BeeKeeper Wallet-specific tweaks to android/app/src/main/AndroidManifest.xml
 * after `bunx cap add android`. Idempotent — safe to re-run.
 *
 * Adds:
 *   - CAMERA + camera hardware feature (QR scanner)
 *   - USE_BIOMETRIC (unlock)
 *   - ACCESS_NETWORK_STATE (reachability)
 *   - Deep-link intent filters:
 *       nectar://...
 *       https://pay.honest.money/...
 *
 * See ANDROID.md for the source-of-truth list.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const manifestPath = resolve(process.cwd(), "android/app/src/main/AndroidManifest.xml");
if (!existsSync(manifestPath)) {
  console.error(`Manifest not found: ${manifestPath}. Run \`bunx cap add android\` first.`);
  process.exit(1);
}

let xml = readFileSync(manifestPath, "utf8");
const original = xml;

const permissions = [
  '<uses-permission android:name="android.permission.CAMERA" />',
  '<uses-feature android:name="android.hardware.camera" android:required="false" />',
  '<uses-permission android:name="android.permission.USE_BIOMETRIC" />',
  '<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />',
];

for (const line of permissions) {
  if (!xml.includes(line)) {
    xml = xml.replace(/<application\b/, `    ${line}\n\n    <application`);
  }
}

// Deep-link intent filters injected into the main activity (the one Capacitor
// generates with MAIN/LAUNCHER). We look for the closing </activity> of the
// first activity block and insert before it.
const deepLinks = `
            <intent-filter android:autoVerify="true">
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="nectar" />
            </intent-filter>
            <intent-filter android:autoVerify="true">
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="https" android:host="pay.honest.money" />
            </intent-filter>
`;

if (!xml.includes('android:scheme="nectar"')) {
  xml = xml.replace(/(<\/activity>)/, `${deepLinks}        $1`);
}

if (xml === original) {
  console.log("AndroidManifest.xml already patched — no changes.");
} else {
  writeFileSync(manifestPath, xml);
  console.log("Patched AndroidManifest.xml (permissions + deep links).");
}

// App display name (home screen / app switcher). cap sync does not rewrite this.
const stringsPath = resolve(process.cwd(), "android/app/src/main/res/values/strings.xml");
if (existsSync(stringsPath)) {
  let strings = readFileSync(stringsPath, "utf8");
  const next = strings
    .replace(/(<string name="app_name">)[^<]*(<\/string>)/, "$1BeeKeeper Wallet$2")
    .replace(/(<string name="title_activity_main">)[^<]*(<\/string>)/, "$1BeeKeeper Wallet$2");
  if (next !== strings) {
    writeFileSync(stringsPath, next);
    console.log("Set Android app name to BeeKeeper Wallet.");
  }
}
