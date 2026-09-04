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

## 3. Build and run the Windows companion

Recommended Windows prerequisites:
- Rust stable toolchain (`rustup`, `cargo`)
- Microsoft C++ Build Tools / MSVC toolchain
- Microsoft Edge WebView2 Runtime
- Node.js 22+ and npm

Install dependencies and build:

```powershell
npm ci
npm --workspace @easydoc/desktop run build
```

For development:

```powershell
npm --workspace @easydoc/desktop run dev
```

In the desktop app:
1. Enter the deployed Cloudflare Worker HTTPS URL in **Relay URL** and apply it.
2. Choose the receive folder if `Documents/EasyDoc` is not desired.
3. Click **휴대폰 연결** to create a short-lived QR code.
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

## 4. Build and run the mobile app

The mobile app uses native scanner/PDF modules, so use an Expo development/native build rather than Expo Go.

Android:

```bash
npm ci
npm --workspace @easydoc/mobile run android
```

iOS on macOS:

```bash
npm ci
npm --workspace @easydoc/mobile run ios
```

In **설정 → Relay**, enter the same Cloudflare Worker HTTPS URL used by the desktop. `EXPO_PUBLIC_RELAY_URL` can be used as an optional initial fallback, but the URL can be changed in-app.

Then:
1. Open **설정 → PC 연결**.
2. Scan the QR shown by the desktop app.
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

Known reader constraint: the current native PDF renderer does not expose text extraction. PDF page jump/thumbnail navigation is implemented through on-demand page-image rendering, while PDF text search remains a backend limitation. HWP/HWPX and high-fidelity Office rendering remain a separate research/implementation track as specified.

## 8. Verification boundaries

The repository-level JavaScript/TypeScript tests, mobile/relay type checks, desktop web build, Worker dry-run, and local transfer harness were verified before handoff.

In the earlier Linux development container, native checks stopped at unavailable platform libraries and cross-target tooling. Those results did not establish a native Windows build.

The current Windows clone has now completed a native Tauri release build with Rust stable, MSVC, and WebView2. It produced both MSI and NSIS installers, and the release executable passed a startup smoke check without opening an HTTP listener. The bundle icon paths are explicit in `tauri.conf.json` and covered by a repository test.

An Android release APK was also built from a clean Expo prebuild and installed on a physical SM-A205S running Android 11. Cold start, home/settings rendering, bottom navigation, safe-area handling, and Android back behavior were verified at 720×1560. A Hermes startup crash caused by `fast-png` requesting unsupported `latin1` decoding was fixed with a compatibility polyfill and regression test.

The current environment still does not provide completed verification for:
- iOS native device execution
- physical document capture and the full scanner/edit/save flow
- the actual school firewall/proxy/network

External file drag-out from Scan Inbox into another desktop/browser application is also not wired in this handoff. Tauri v2 requires an additional native drag-out integration for that behavior; it should be added only with a Windows-native build/test loop rather than as an unverified dependency.

Dependency audit in the current clone: `npm audit --omit=dev` reports 11 moderate findings, 0 high, and 0 critical. The findings are concentrated in the current Expo dependency/tooling chain and include entries without a compatible automatic fix. Do not use a forced major dependency rewrite solely to clear the audit without re-validating the Expo/native-module compatibility matrix.

Those checks and constraints are intentionally explicit rather than being reported as completed validation.
