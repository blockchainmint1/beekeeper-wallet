# Roadmap

- [x] Verify uploaded APK `hme-wallet-0.1.202608300600-release-2.apk` — byte-identical to the already-pinned build (md5 `49523ba1…`), nothing new to pin
- [x] Show real app version in Settings, and show the available new version before installing (UpdateCheckCard)
- [x] Stamp versionName/versionCode into Android builds in CI (APKs currently all ship as 1.0/1, breaking native version checks)
- [x] Fix TXC migration so swept funds and later transaction change stay on the main derivation path; verified tx f23581e5b3fbd3ea91963c1f1d1d8930c121ee41ec5168b6818944922a5170c6 was accepted and has one full-balance output
- [x] Pin TXC Receive to the canonical m/44'/696969'/0' branch and persist it as primary so imported-wallet metadata can never issue another fresh old-path address
- [x] Normalize stale encrypted/session TXC primary-path metadata while loading a seed wallet so Settings always reports m/44'/696969'/0' before Receive is opened
- [x] Add Solana chain support with seed-derived address, balance, activity, send, receive, and chain settings
- [x] Replace first-time wallet choices with BeeKeeper Coin Scan → Rules → Password onboarding
- [x] Add non-destructive import of old BeeKeeper encrypted wallets to onboarding
- [x] Make old BeeKeeper migration visible before activation even when browser storage is unavailable
- [x] Add encrypted old BeeKeeper backup-file import without overwriting legacy data
- [x] Removed NectarPay merchant step from onboarding; kept it as a tile on the balance dashboard
- [x] Split the post-unlock dashboard from the full wallet and restored the detailed wallet experience
- [x] Add dashboard Top up/Cash out controls and secure VectorPay handoff; VectorPay settings configured
