# Catalyst Watch iPhone client

The SwiftUI client displays the server's evidence record, registers a real APNs device token, and offers Catalyst Watch Pro through StoreKit 2. It targets iOS 17 or later.

Free access shows up to 30 recent signals after a 30-minute delay and supports 10 followed companies. Pro unlocks the real-time full-universe feed, filtered Time Sensitive alerts, and manual scans. A private developer credential can activate the same Pro feature set for the developer's installation without embedding a bypass in the binary.

## Build

1. On a Mac, install Xcode 26+ and [XcodeGen](https://github.com/yonaskolb/XcodeGen). Xcode 26 requires macOS 15.6 or later.
2. From this directory, run `xcodegen generate`, then open `BiotechSignal.xcodeproj`.
3. Confirm the `com.yingcui.CatalystWatch` bundle ID and Apple Developer team are selected under Signing & Capabilities.
4. Confirm **Push Notifications**, **Time Sensitive Notifications**, and **Near Field Communication Tag Reading** are enabled for the App ID and provisioning profile. Refresh the distribution profile after enabling NFC.
5. Build to a physical iPhone. The simulator does not issue the same production device token workflow.
6. The production server URL is compiled from `CatalystWatchServerURL`. For local Debug runs, set `CATALYST_WATCH_SERVER_URL` in the scheme environment.
7. To activate developer access, expand **Settings > Plan > Developer access** and enter the private key. Debug builds can alternatively set `CATALYST_WATCH_DEVELOPER_TOKEN` in the scheme environment.
8. Enable notifications, confirm Sound and Time Sensitive delivery are enabled in iPhone Settings, and test both bundled alert sounds before enabling live APNs on the server.

## Developer club check-in

After developer access is active, open **Settings > Developer tools > Club check-in**. Create an event before scanning. The first supported card scan opens a registration form for name, age, phone number or Instagram handle, grade, and consent; later scans record attendance for the active event. Member detail includes permanent profile and attendance deletion.

Core NFC tag reading works only on a signed physical iPhone. The simulator can validate the UI but cannot scan a card. Card technologies differ, and some protected cards do not expose a stable identifier, so test the intended Rutgers ID cards before operational use. This tool does not write to a card and must not be presented as Rutgers identity verification or access control.

The backend requires `CLUB_DATA_KEY` with at least 32 random characters. It persists only a keyed fingerprint of the NFC identifier and encrypts the member profile at rest. Treat that key as durable backup material: changing or losing it prevents existing records from being matched or decrypted. The privacy manifest and public privacy policy declare the collected profile and card-derived data; update App Store Connect privacy answers before submitting a build containing this feature for public review.

For deterministic App Store review screenshots, launch a Debug build with
`CATALYST_WATCH_SCREENSHOT_MODE=1`. This opens the paywall with the configured
monthly and annual plan metadata. Set `CATALYST_WATCH_INITIAL_TAB` to `signals`,
`watchlist`, or `settings` to select a starting tab. Release builds ignore both variables.

Debug builds register as APNs `sandbox`; archived Release builds register as `production`. The server routes each token to the matching APNs environment.

The app creates a random installation ID and a 256-bit client credential. The client credential is stored in Keychain, never uses the dashboard bearer token, and is rotated once if a stale server record rejects it. The private developer key is sent only during activation, cleared from the form immediately, and never stored by the app. StoreKit purchases, current entitlements, restores, and transaction updates are synchronized to the server using Apple's signed JWS representation.

`CatalystWatch.storekit` defines local monthly and annual products for Debug testing. The App Store build uses the same product IDs from App Store Connect:

- `com.yingcui.CatalystWatch.pro.monthly`
- `com.yingcui.CatalystWatch.pro.yearly`

## App Store archive

The Release configuration uses the `Catalyst Watch App Store` distribution profile. Build and export with:

```bash
xcodebuild -project BiotechSignal.xcodeproj -scheme BiotechSignal -configuration Release \
  -destination 'generic/platform=iOS' -archivePath DerivedData/CatalystWatch.xcarchive \
  -allowProvisioningUpdates clean archive
xcodebuild -exportArchive -archivePath DerivedData/CatalystWatch.xcarchive \
  -exportOptionsPlist UploadOptions.plist -allowProvisioningUpdates
```

`ExportOptions.plist` creates a local IPA; `UploadOptions.plist` validates and uploads the archive to App Store Connect.

When the local Xcode version does not satisfy Apple's current upload requirement, `.github/workflows/app-store.yml` can perform a manual release on GitHub's `macos-26` runner. It requires these encrypted repository secrets: `BUILD_CERTIFICATE_BASE64`, `P12_PASSWORD`, `BUILD_PROVISION_PROFILE_BASE64`, `ASC_KEY_ID`, `ASC_ISSUER_ID`, and `ASC_PRIVATE_KEY`. The workflow only runs when manually dispatched and increments the build number from the GitHub run number.

## Critical Alerts

The default target uses `BiotechSignal.entitlements` and requests Time Sensitive alerts. It does **not** claim Apple's Critical Alerts entitlement.

Only after Apple approves that entitlement for this exact app:

1. Set `CriticalAlertsEnabled` to `true` in `Info.plist`.
2. Change the target's entitlements path to `BiotechSignal.Critical.entitlements`.
3. Regenerate the project, refresh provisioning profiles, and make a signed device build.
4. Set `APNS_ALLOW_CRITICAL=true` on the server only after the app reports Critical Alert authorization.

Without all four pieces, the server falls back to Time Sensitive or ordinary notification delivery.

The standard App Store build uses `CatalystHigh.caf` for high alerts and the longer `CatalystUrgent.caf` for urgent alerts. Both remain subject to the iPhone's notification-sound and Ring/Silent settings. The client advertises bundled-sound support during APNs registration, so existing builds continue receiving the default Apple sound until upgraded.
