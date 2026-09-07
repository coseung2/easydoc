# EasyDoc clone and real-environment verification

This guide is the handoff checklist for testing the current EasyDoc MVP on a real Android/iOS device and a Windows PC.

## 1. Repository verification

Prerequisites:
- Node.js 22+
- npm 10+

From the repository root:

```bash
npm ci
npm run verify
```

`npm run verify` runs:
- all protocol, crypto, image-processing, PDF-tool, relay, desktop-core, mobile-transfer, and integration tests
- mobile TypeScript checking
- relay TypeScript checking
- desktop React/Vite production build
- Cloudflare Worker dry-run bundling
- production dependency audit using the scoped, expiring exception policy

The native Tauri/Rust binary is not part of this command because it requires a platform Rust toolchain and native build dependencies.

## 2. Deploy the Cloudflare relay

Prerequisites:
- Cloudflare account
- Wrangler authentication (`npx wrangler login`)

Create a strong signing secret and store it as a Worker secret:

```bash
npx wrangler secret put SESSION_SIGNING_SECRET --config apps/relay/wrangler.toml
```

Deploy:

```bash
npx wrangler deploy --config apps/relay/wrangler.toml
```

Record the resulting HTTPS Worker URL. Both the mobile app and Windows companion must use the same URL.

The relay stores pairing/session state in Durable Objects and forwards encrypted transfer frames. The normal transfer path does not persist document bodies.

## 3. Remote-build and run the Windows companion

Recommended Windows prerequisites:
- Rust stable toolchain (`rustup`, `cargo`)
- Microsoft C++ Build Tools / MSVC toolchain
- Microsoft Edge WebView2 Runtime
- Node.js 22+ and npm

Native Windows builds are performed through the remote Windows build workflow.
The resulting artifact is downloaded to the laptop and installed on the laptop
itself; no local Tauri build is required.

The build commands executed by the remote Windows job are:

```powershell
npm ci
npm --workspace @easydoc/desktop run build
```

In the desktop app:
1. Choose the receive folder if `Documents/EasyDoc` is not desired.
2. Click **휴대폰 연결** to create a short-lived QR code.
4. Keep the app running; closing the window hides it to the system tray.

Expected desktop behavior:
- starts receiver in the background
- supports startup registration
- writes incoming files to `.part`
- persists resume state
- verifies SHA-256 before final rename
- numbers filename collisions
- shows completion notification
- exposes Open / Reveal / Rename / Print / Delete actions in Scan Inbox

## 4. Remote-build and run the mobile app

The mobile app uses native scanner/PDF modules, so use an Expo development/native build rather than Expo Go.

Android:

Use the remote Android build workflow to produce the APK, then download it to
the laptop and install it on the phone attached to the laptop. Alternatively,
with JDK 17 and Android SDK/NDK installed, build a standalone test APK locally:

```powershell
# From apps/mobile; set ANDROID_HOME to the installed Android SDK first.
$env:CI = "1"
$env:NODE_ENV = "production"
npx expo prebuild --platform android --no-install
Set-Location android
.\gradlew.bat :app:assembleRelease "-PreactNativeArchitectures=arm64-v8a,x86_64" --init-script "../../../scripts/android-repositories.gradle" --max-workers=2 --console=plain
```

The Expo-generated release variant includes the JS bundle but uses the template
debug signing key unless production signing is explicitly configured. Treat it
as a **test APK**, not a Play Store production release. The output is
`apps/mobile/android/app/build/outputs/apk/release/app-release.apk`.
An existing installation signed with a different key cannot be upgraded in
place; do not uninstall it without first protecting its local documents.

On this Windows network, Java's default trust store rejects the Scanbot Maven
certificate. Adding `"-Djavax.net.ssl.trustStoreType=Windows-ROOT"` and
`"-Djavax.net.ssl.trustStore=NONE"` to the Gradle command uses Windows' existing
trusted certificates for that process, without disabling TLS verification or
changing machine/user-wide settings. The repository filter limits Scanbot Maven
queries to `io.scanbot` instead of querying it for every AndroidX/Kotlin artifact.

Set `EXPO_PUBLIC_SCANBOT_LICENSE_KEY` before bundling for licensed use. Without
a key, Scanbot documents a 60-second evaluation per app session, including its
camera UI. The APK can build without the key, but is not suitable for ongoing use.

### Local test APK verified on September 7, 2026

- `EasyDoc-0.2.1-v3-camera-test.apk`: package `app.easydoc.mobile`, version code 3,
  Android API 24+, arm64-v8a and x86_64; 281,852,879 bytes.
- Standalone JS bundle is embedded; Android debug certificate/v2 signature verified.
- SHA-256: `39e3bccf60ef69c7b2e1948059bf9920181e662e329620c3a69acc27e473f78f`.
- Copied to the user's designated OneDrive inbox without replacing existing files;
  source and destination hashes match. Cloud synchronization completion was not
  independently verified.
- Gradle `assembleRelease` including vital lint passed. Android JS export and all
  83 repository tests/type/build/audit checks passed. No phone was attached, so
  physical-camera operation and end-to-end phone/PC presence are not claimed.
- Scanbot key was unset: the 60-second per-session evaluation restriction applies.
- A Luna worker independently checked SDK/Java/device/license readiness while the
  primary agent fixed Windows credentials and integrated/verified both builds.
  Luna was selected for the bounded environment check from the available pool.

iOS is outside the current build workflow. No iOS device or OCR execution is
claimed as tested here.

Configure the mobile app with the same Cloudflare Worker HTTPS URL used by the desktop. `EXPO_PUBLIC_RELAY_URL` can be used as an initial fallback.

Then:
1. Open **설정 → PC 연결**.
2. Scan the QR shown by the desktop app with the phone's default camera flow.
3. Confirm the destination changes to online when the PC receiver is connected.
4. Scan a document or import a local file.
5. Send it to the paired PC.

## 5. Scanner checks

Verify on a physical phone:
- automatic document edge detection/crop/perspective correction from the native scanner
- multi-page capture
- reorder pages
- delete a page
- retake a selected page
- rotate selected page
- Color / Grayscale / B&W processing
- PDF generation
- source document remains in the local library after desktop transfer

## 6. Transfer acceptance matrix

Run the following with the phone and PC on different networks, ideally phone LTE/5G and the target school PC on its real wired/Wi-Fi network.

| Case | Expected result |
| --- | --- |
| 1 MiB | completes and SHA-256 matches |
| 100 MiB | completes without whole-file RAM buffering |
| 500 MiB | completes without whole-file RAM buffering |
| 1 GiB | completes without whole-file RAM buffering |
| Korean filename | exact filename survives transfer |
| Duplicate filename | numbered copy is created |
| Desktop offline | mobile transfer stays queued |
| Desktop returns online | queued transfer retries automatically |
| Network interruption mid-transfer | receiver resumes from durable chunk position |
| Lost/repeated chunk acknowledgement | destination file remains uncorrupted |
| Low disk space | transfer fails clearly before exposing a final file |
| PC restart/reconnect | receiver reconnect behavior is observed and recorded |

For a local file-backed transport stress test without Cloudflare:

```bash
npm run milestone0:file -- --size all
```

The local harness supports `1mb`, `100mb`, `500mb`, `1gb`, or `all`.

## 7. Viewer and PDF-tool checks

Verify:
- PDF scrolling and pinch/double-tap zoom
- image preview
- TXT preview and text search count
- Share
- Send to PC from the viewer
- PDF presentation mode with previous/next controls and thumbnail strip
- PDF merge
- PDF split
- page rotation
- page reorder/delete
- images → PDF
- PDF → images
- PDF optimization rewrite
- OCR from photos and PDF pages; edit/copy/save recognized text
- OCR-backed PDF search and matching-page navigation

Known reader constraint: the current native PDF renderer does not expose text extraction. PDF page jump/thumbnail navigation is implemented through on-demand page-image rendering, while PDF text search remains a backend limitation. HWP/HWPX and high-fidelity Office rendering remain a separate research/implementation track as specified.

## 8. Verification boundaries

The repository-level JavaScript/TypeScript tests and local transfer harness are
separate from native validation. Native Windows and Android builds are remote;
their artifacts are installed on the laptop and its attached phone. iOS native
validation is not claimed.

In the earlier Linux development container, native checks stopped at unavailable platform libraries and cross-target tooling. Those results did not establish a native Windows build.

The current environment still does not provide completed verification for:
- physical document capture and the full scanner/edit/save flow
- iOS native execution and OCR
- the actual school firewall/proxy/network

External file drag-out from Scan Inbox into another desktop/browser application is also not wired in this handoff. Tauri v2 requires an additional native drag-out integration for that behavior; it should be added only with a Windows-native build/test loop rather than as an unverified dependency.

Dependency audit in the current clone: `npm audit --omit=dev` reports 5 moderate findings, 1 high, and 0 critical after adding `react-native-scanbot-sdk@9.0.2`. The HIGH finding is confined to Scanbot's Expo config-plugin build-time `xmldom` path and is governed by the exact, expiring policy in `docs/dependency-audit-policy.md`; `npm run audit:prod` fails on any unrelated HIGH/CRITICAL finding or any drift in the approved path/advisory set. Do not use a forced dependency rewrite solely to clear the audit without re-validating the Expo/native-module compatibility matrix.

Those checks and constraints are intentionally explicit rather than being reported as completed validation.
