# Android setup (Play Store + APK testing)

The sandbox can't run `cap add android` (no Android SDK), so run this on your
Mac / Linux box after pulling the latest `main`:

```bash
bun run android:setup     # installs deps, builds web, adds android/, syncs, patches manifest, opens Android Studio
```

Or the one-shot APK build (no Android Studio needed, just a JDK + Android SDK):

```bash
bun run android:apk       # debug-signed APK at android/app/build/outputs/apk/debug/app-debug.apk
```

## Automated APK builds (GitHub Actions)

Two workflows ship in `.github/workflows/`:

- **`android-apk.yml`** — builds an installable APK
  - push to the `android` branch → debug APK artifact
  - `git tag android-vX.Y.Z && git push --tags` → release APK + GitHub Release
  - manual "Run workflow" → choose `debug` or `release`
  - No secrets? Falls back to debug signing (still sideloadable for testing).

- **`generate-keystore.yml`** — one-time helper. Run manually to generate a
  release keystore + the four `ANDROID_*` secrets you paste into repo settings.
  Download the `.jks` artifact and store it safely (1Password + offline). If
  you lose it you can never update existing installs on the Play Store.

Recommended flow for the first APK on your device:

1. Push a branch called `android` (any commit works).
2. Open the Actions tab → **Android APK** run → download the artifact.
3. Transfer the `.apk` to your phone (Drive / AirDrop / adb) and sideload it.
   You'll need to allow "Install unknown apps" for the source.

## Required `android/app/src/main/AndroidManifest.xml` additions

`bun run android:patch` (and the CI workflow) inject these automatically after
`cap add android`. If you edit the manifest by hand instead, add:

```xml
<!-- Camera (barcode scanner) -->
<uses-permission android:name="android.permission.CAMERA" />
<uses-feature android:name="android.hardware.camera" android:required="false" />

<!-- Biometrics -->
<uses-permission android:name="android.permission.USE_BIOMETRIC" />

<!-- Network reachability -->
<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />

<!-- Nectar tap-to-pay deep links: nectar://... and https://pay.honest.money/... -->
<activity ...>
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
</activity>
```

## Signing / release

- App ID: `money.beekeeper.wallet` (BeeKeeper-only; the retired remix used
  `money.honest.txcwallet`, and reusing it made Android offer BeeKeeper APKs as
  an update to the honest.money app).
- Generate a keystore via the `Generate Android Keystore` workflow (or locally:
  `keytool -genkey -v -keystore hme.jks -alias hme -keyalg RSA -keysize 4096 -validity 10950`).
- Add these repo secrets so `android-apk.yml` produces a signed APK/AAB:
  - `ANDROID_KEYSTORE_BASE64`
  - `ANDROID_STORE_PASSWORD`
  - `ANDROID_KEY_ALIAS`
  - `ANDROID_KEY_PASSWORD`
- For Play Store bundle: locally run `cd android && ./gradlew bundleRelease`
  (output: `android/app/build/outputs/bundle/release/app-release.aab`).

## Splash / icon

`bun run cap:assets` regenerates both iOS and Android assets from
`assets/icon.png` + `assets/splash.png`. Re-run whenever those change.

## Play Console listing

Reuse the App Store screenshots under `/mnt/documents/app-store-screenshots/`
resized to Play's phone requirement (1080 × 1920 or larger, 16:9).
