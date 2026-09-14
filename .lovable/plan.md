# Rename and publish the BeeKeeper Wallet Android release

## What will change
- Rename the Android home-screen label, generated APK filename, GitHub artifact, and GitHub release title to **BeeKeeper Wallet**.
- Keep the Android package ID, signing key, webview hostname, and encrypted-wallet origin unchanged so existing installs and wallets remain compatible.
- Upload the provided signed APK as the current Android release and add version `0.1.202609141037` to the app's update list.
- Point the stable download endpoint at this release so existing Android users are offered it during the automatic update check.

## Validation
- Confirm the update feed returns the new Android version and download URL.
- Confirm the download endpoint serves the BeeKeeper Wallet filename.
- Run the focused type check and verify the app build is clean.

## Important behavior
Android will detect and offer the update automatically, but the operating system will still require the user to approve installation. The APK's internal app label cannot be changed after signing; this uploaded APK remains labeled `honest.money`, while every newly built APK will be labeled **BeeKeeper Wallet**.
