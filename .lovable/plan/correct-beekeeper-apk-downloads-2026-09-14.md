# Correct BeeKeeper APK downloads

## Goal
Make every BeeKeeper download and update control fetch the BeeKeeper Wallet APK from `beekeeper.money`, never the retired HME Wallet endpoint.

## Changes
- Set the shared APK URL and release-feed hosts to BeeKeeper-owned addresses while preserving same-origin behavior in previews.
- Ensure release records cannot bypass the BeeKeeper download endpoint with an old HME or raw asset URL.
- Update the homepage/footer and Settings update flow through their shared download helper.
- Port the reliable Android handoff: real browser first, then safe fallbacks.
- Proxy the current BeeKeeper APK with the Android package type, exact file length, attachment filename, and no unsupported range behavior.
- Port the same-origin build check so the reload notice does not persist forever.

## Verification
- Search the user-facing download/update paths for remaining HME APK references.
- Verify the BeeKeeper endpoint headers and downloaded filename.
- Run the focused checks plus the normal and Android/iOS-safe builds already configured by the project.

## Compatibility
Keep the existing Android package ID, signing identity, webview hostname, wallet storage, and migration behavior unchanged so installed wallets remain upgradeable and intact.
