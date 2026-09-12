# BeeKeeper-first wallet onboarding

## Goal
Replace the current empty-wallet choices with the BeeKeeper three-step activation flow. Existing users continue directly to the current unlock screen, and existing encrypted wallets are never migrated, replaced, or deleted.

## User experience
1. **Scan** — Show BeeKeeper branding and a prominent “Scan my copper coin” action. Accept a valid 12- or 24-word phrase from the camera, an uploaded QR image, or manual paste. Detect likely public addresses/keys and explain that the outside sticker was scanned instead of the protected recovery words.
2. **Rules** — Require all four custody acknowledgements before continuing, with language adapted to BeeKeeper and honest.money.
3. **Password** — Require the wallet’s existing password policy and confirmation. On supported mobile devices, offer biometric unlock enabled by default and treat setup failure as non-blocking.
4. **Finish** — Save through the current HME encrypted profile format, load the wallet into memory, and open the wallet. The seed remains memory-only until encrypted storage succeeds.

## Compatibility safeguards
- Reuse the current HME vault format, one-million-round encryption, profile scoping, canonical TEXITcoin derivation, and session handling rather than copying BeeKeeper’s retired storage format.
- Preserve the current unlock experience whenever a wallet already exists.
- Preserve `/import` for adding another profile and advanced recovery, but remove the first-screen “Create new wallet” path for devices without a wallet.
- Keep current multi-chain derivation behavior; one scanned seed continues to derive TXC, BTC, EVM, and other supported accounts.
- Do not change or clear legacy BeeKeeper browser keys. A separate importer can be added after the remix without risking either wallet.

## Technical changes
- Add a focused BeeKeeper onboarding component using existing form, checkbox, progress, password-strength, toast, and biometric primitives.
- Refactor the QR scanner into a reusable dialog that renders at document level and supports live camera, image upload, and manual paste; retain the existing compact scan button everywhere else.
- Add strict BIP39 checksum validation and the outside-sticker detection ladder before accepting a phrase.
- Route first-time users through onboarding from `/`; leave existing-wallet unlock behavior unchanged.
- Add complete page metadata for the updated first screen and verify desktop/mobile layouts, camera fallback states, validation, storage, unlock, and a clean app build.
