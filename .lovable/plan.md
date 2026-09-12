# Make old BeeKeeper migration reliable

## What is wrong
The existing importer only appears when old encrypted data is found in the current website's browser storage. If the old wallet was used under another address, browser profile, installed app, or storage was cleared, the new site cannot read it. The current screen hides migration completely in that case, which incorrectly makes activation look like the only option.

## Changes
- Keep automatic discovery for wallets saved on the same `beekeeper.money` browser origin.
- Harden compatibility with every encrypted vault version and multi-wallet registry used by the retired BeeKeeper project.
- Always show a clearly labeled **Import old BeeKeeper wallet** choice before activation.
- When local data is available, import it directly using its old password and protect the migrated wallet with one new password.
- When local data is not available, allow selecting the encrypted BeeKeeper backup file; recovery words remain the final fallback.
- Never overwrite or delete the old encrypted records, and never replace an existing wallet when importing after login.

## Verification
- Test automatic same-origin migration with both a single old vault and a multi-wallet registry.
- Test encrypted backup-file migration.
- Test wrong-password and malformed-backup errors.
- Confirm ordinary first-time activation and existing wallet unlock still behave unchanged.
