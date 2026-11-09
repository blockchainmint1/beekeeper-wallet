import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const iosDir = resolve(root, "ios");
const infoPlistPath = resolve(root, "ios/App/App/Info.plist");
const iosGitignorePath = resolve(root, "ios/.gitignore");
const pbxprojPath = resolve(root, "ios/App/App.xcodeproj/project.pbxproj");

if (!existsSync(iosDir)) {
  console.log("iOS project not present; skipping native hardening.");
  process.exit(0);
}

const infoPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CAPACITOR_DEBUG</key>
	<string>$(CAPACITOR_DEBUG)</string>
	<key>CFBundleDevelopmentRegion</key>
	<string>en</string>
	<key>CFBundleDisplayName</key>
	<string>BeeKeeper Wallet</string>
	<key>CFBundleExecutable</key>
	<string>$(EXECUTABLE_NAME)</string>
	<key>CFBundleIdentifier</key>
	<string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
	<key>CFBundleInfoDictionaryVersion</key>
	<string>6.0</string>
	<key>CFBundleName</key>
	<string>$(PRODUCT_NAME)</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleShortVersionString</key>
	<string>$(MARKETING_VERSION)</string>
	<key>CFBundleVersion</key>
	<string>$(CURRENT_PROJECT_VERSION)</string>
	<key>CFBundleURLTypes</key>
	<array>
		<dict>
			<key>CFBundleTypeRole</key>
			<string>Editor</string>
			<key>CFBundleURLName</key>
			<string>money.beekeeper.wallet.links</string>
			<key>CFBundleURLSchemes</key>
			<array>
				<string>beekeeper</string>
				<string>nectar</string>
			</array>
		</dict>
	</array>
	<key>ITSAppUsesNonExemptEncryption</key>
	<false/>
	<key>LSRequiresIPhoneOS</key>
	<true/>
	<key>NSCameraUsageDescription</key>
	<string>BeeKeeper Wallet uses the camera to scan wallet address and payment QR codes.</string>
	<key>NSFaceIDUsageDescription</key>
	<string>BeeKeeper Wallet uses Face ID to unlock your wallet.</string>
	<key>UILaunchStoryboardName</key>
	<string>LaunchScreen</string>
	<key>UIMainStoryboardFile</key>
	<string>Main</string>
	<key>UIRequiredDeviceCapabilities</key>
	<array>
		<string>arm64</string>
	</array>
	<key>UIRequiresFullScreen</key>
	<true/>
	<key>UISupportedInterfaceOrientations</key>
	<array>
		<string>UIInterfaceOrientationPortrait</string>
	</array>
	<key>UIViewControllerBasedStatusBarAppearance</key>
	<true/>
</dict>
</plist>
`;

await writeFile(infoPlistPath, infoPlist);

if (existsSync(iosGitignorePath)) {
  const current = await readFile(iosGitignorePath, "utf8");
  const next = current
    .split("\n")
    .filter((line) => line.trim() !== "App/App/capacitor.config.json")
    .join("\n")
    .replace(/\n*$/, "\n");
  await writeFile(iosGitignorePath, next);
}

if (existsSync(pbxprojPath)) {
  const pbx = await readFile(pbxprojPath, "utf8");
  // IDENTITY (audit 2026-11-09 M3): BeeKeeper is its own iOS app. The old
  // money.honest.txcwallet id would ship as an update to the TXC Wallet app.
  const patched = pbx
    .replace(/TARGETED_DEVICE_FAMILY = "1,2";/g, 'TARGETED_DEVICE_FAMILY = "1";')
    .replace(/PRODUCT_BUNDLE_IDENTIFIER = [^;]+;/g, "PRODUCT_BUNDLE_IDENTIFIER = money.beekeeper.wallet;");
  if (patched !== pbx) await writeFile(pbxprojPath, patched);
}

console.log("Hardened iOS native shell for BeeKeeper Wallet.");