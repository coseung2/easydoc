# PDF rasterization benchmark

## Status

Decision: **repeat on physical Android and iOS devices before promotion**.

The legacy `react-native-pdf-to-image` backend remains the production default. The page-level candidate is available only when `EXPO_PUBLIC_PDF_RASTERIZER_BACKEND=page` is set in a native development build.

## Candidate

- package: `@dariyd/react-native-pdf-page-image`
- evaluated version: `2.0.0`
- license: MIT
- React Native requirement: 0.76+ with New Architecture
- iOS requirement: 15.0+
- Android requirement: API 24+
- iOS renderer: PDFKit
- Android renderer: Android `PdfRenderer`
- Android manifest permissions added by the package: none
- JavaScript package dependencies: none

The candidate API directly matches the EasyDoc `PdfPageRasterizer` boundary:

- `open(uri)` provides page count without rasterizing every page
- `generate(uri, page, ...)` renders one 0-based page
- `maxDimension` allows bounded thumbnail output
- `close(uri)` releases the document and deletes temporary output

## EasyDoc integration

The viewer no longer consumes a full `outputFiles[]` array.

Thumbnail mode uses a virtualized horizontal list. Only mounted/nearby thumbnail items request a rasterized page.

Presentation mode requests:

- previous page
- current page
- next page
- one additional next page

Thumbnail requests cap their long edge (220–240 px) and use reduced JPEG quality. Presentation/jump pages request the normal render size.

The current fallback still wraps `react-native-pdf-to-image`, so it may internally rasterize the complete document. That behavior is isolated inside the fallback adapter and is no longer assumed by UI code.

## Build validation in the current workspace

- mobile TypeScript check: pass
- mobile rasterizer unit tests: pass
- Expo dependency compatibility check: pass
- Expo Android/iOS prebuild generation: pass
- physical device benchmark: not available in the current workspace
- Android assemble on this DevSpace host: not a usable validation signal because the host is `aarch64` while the installed Android build-tools/NDK host binaries are `x86-64`
- iOS native build: requires macOS/Xcode and cannot run on this Linux workspace

No production default has changed while the device gates remain open.

## Benchmark matrix

Use non-sensitive generated/test PDFs.

| Document | Required checks |
|---|---|
| 10 pages | first thumbnail, first presentation page, navigation latency |
| 50 pages | same + memory after scrolling |
| 100 pages | same + active-window memory scaling |
| 300 pages | navigation stability, OOM/crash, temp-file growth |

Include both normal vector/text PDFs and image-heavy scanned PDFs.

## Procedure

Run the same native build with each backend:

1. `EXPO_PUBLIC_PDF_RASTERIZER_BACKEND=legacy`
2. `EXPO_PUBLIC_PDF_RASTERIZER_BACKEND=page`

For each document size, record:

- device model
- OS version
- app build type
- Expo / React Native version
- backend and candidate package version
- page count and approximate file size
- time to first thumbnail
- time to first presentation page
- page navigation latency
- memory after initial render
- memory after scrolling through many thumbnails
- memory after repeated presentation navigation
- temporary file growth
- cleanup after document close
- crash/OOM/watchdog events
- binary-size delta

Repeat each timing enough times to report a median.

## Acceptance gate

For a 100-page document:

- first thumbnail must not depend on rendering all pages
- first presentation page must not depend on rendering all pages
- memory should track the active cache/window rather than total page count
- leaving the document must release native resources and temporary images

For a 300-page document:

- no OOM/crash during normal thumbnail navigation
- no mandatory whole-document rasterization before navigation

Promote the page-level backend only after both Android and iOS satisfy these gates. Until then, keep the legacy backend as the default.
