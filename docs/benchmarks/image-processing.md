# Image-processing backend benchmark

## Status

Decision: **repeat on physical Android and iOS devices before promotion**.

The JavaScript backend remains the default. The OpenCV candidate is available only when `EXPO_PUBLIC_SCAN_IMAGE_BACKEND=opencv` is set in a native development build.

## Candidate

- package: `react-native-fast-opencv`
- evaluated version: `1.0.1`
- license: MIT
- React Native requirement: New Architecture, tested by upstream on React Native 0.85+
- EasyDoc baseline: React Native 0.86.3 with `newArchEnabled: true`
- Android native dependency: OpenCV 4.12.0
- Android minimum SDK declared by the package: 24
- Android manifest permissions added by the package: none
- iOS native dependency: `FastOpenCV-iOS` 1.0.4

## Integration notes

The candidate implements the same `ScanImageProcessor` interface as the current JavaScript backend.

Candidate operations:

- rotation through OpenCV `rotate`
- grayscale through `cvtColor`
- B&W through 3x3 Gaussian blur plus Otsu binary threshold
- native output encoding through `Mat.saveToFile`

The current v1 API does not expose a file-URI-to-Mat constructor. EasyDoc therefore has to read the compressed source as base64 with Expo FileSystem and pass it to `Mat.createFromBase64`. This still avoids the current JavaScript RGBA decode/filter/encode path, but it means the candidate is not a completely JS-buffer-free file pipeline. This must be included in the memory comparison.

## Build validation in the current workspace

- mobile TypeScript check: pass
- Expo dependency compatibility check: pass
- Expo Android/iOS prebuild generation: pass
- full repository `npm run verify`: pass
- physical device benchmark: not available in the current workspace
- Android assemble on this DevSpace host: not a usable validation signal because the host is `aarch64` while the installed Android build-tools/NDK host binaries are `x86-64`
- iOS native build: requires macOS/Xcode and cannot run on this Linux workspace

No production default has changed while these native gates remain open.

## Benchmark corpus

Use non-sensitive synthetic/test documents only.

| Input | Pages | Filters |
|---|---:|---|
| ~5 MP scan | 1 | gray, B&W |
| ~12 MP scan | 1 | gray, B&W |
| ~12 MP scan | 10 | gray, B&W |
| ~12 MP scan | 30 | gray, B&W |
| highest practical supported camera resolution | 5 | gray, B&W |

Include at least:

- white paper on dark background
- low-contrast text
- shadows
- colored handwriting
- printed text
- photo mixed with text
- Korean text

## Procedure

Run the same release/development-client build twice on each device:

1. `EXPO_PUBLIC_SCAN_IMAGE_BACKEND=js`
2. `EXPO_PUBLIC_SCAN_IMAGE_BACKEND=opencv`

For each case, run enough iterations to report a median rather than a single timing. Restart the app between backend runs when collecting peak-memory figures.

Record:

- device model
- OS version
- build type
- Expo / React Native version
- backend and package version
- image dimensions and compressed input size
- run count
- median time per page
- total batch time
- peak JS heap where measurable
- native/process memory where measurable
- output size
- crash/OOM/watchdog events
- UI responsiveness
- binary-size delta

## Acceptance gate

Promote OpenCV only when all of these hold:

- no meaningful readability regression
- no repeatable crash/OOM in the matrix
- clear reduction in JS memory pressure or processing time
- sufficiently consistent Android/iOS output
- acceptable binary-size increase
- scanner flow remains stable

Useful target: at least 30% lower median processing time for 12 MP images or at least 40% lower JS-side peak memory.

Until those measurements are recorded, the candidate remains opt-in and the JavaScript backend remains the production default.
