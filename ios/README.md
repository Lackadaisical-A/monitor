# Catalyst Watch iPhone client

The SwiftUI client displays the server's evidence record and registers a real APNs device token. It targets iOS 17 or later.

## Build

1. On a Mac, install Xcode 16+ and [XcodeGen](https://github.com/yonaskolb/XcodeGen).
2. Change `PRODUCT_BUNDLE_IDENTIFIER` in `project.yml` to a bundle ID owned by your Apple Developer team.
3. From this directory, run `xcodegen generate`, then open `BiotechSignal.xcodeproj`.
4. Select your team under Signing & Capabilities and confirm **Push Notifications** plus **Background Modes → Remote notifications** are present.
5. Build to a physical iPhone. The simulator does not issue the same production device token workflow.
6. In the app, enter the HTTPS server URL and `DEVICE_PAIRING_TOKEN`, enable notifications, and send a local test.

Debug builds register as APNs `sandbox`; archived Release builds register as `production`. The server routes each token to the matching APNs environment.

## Critical Alerts

The default target uses `BiotechSignal.entitlements` and requests Time Sensitive alerts. It does **not** claim Apple's Critical Alerts entitlement.

Only after Apple approves that entitlement for this exact app:

1. Set `CriticalAlertsEnabled` to `true` in `Info.plist`.
2. Change the target's entitlements path to `BiotechSignal.Critical.entitlements`.
3. Regenerate the project, refresh provisioning profiles, and make a signed device build.
4. Set `APNS_ALLOW_CRITICAL=true` on the server only after the app reports Critical Alert authorization.

Without all four pieces, the server falls back to Time Sensitive or ordinary notification delivery.
