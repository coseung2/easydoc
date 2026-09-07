# EasyDoc Dependency Modernization Plan

## 1. Purpose

This document turns the SDK/library audit into an implementation plan.

The goal is not to replace the current stack broadly. The goal is to improve the parts with the highest expected payoff while preserving the current stable transfer, crypto, storage, and desktop architecture.

Primary decision:

```text
1. Normalize Expo / React Native / TypeScript versions.
2. Isolate the PDF engine and migrate pdf-lib to @cantoo/pdf-lib.
3. Introduce an image-processing adapter and benchmark a native OpenCV backend.
4. Introduce a page-level PDF rasterizer abstraction and benchmark on-demand rendering.
5. Keep scanner, viewer, crypto, Expo storage, Tauri, Tokio, and relay stacks unless new evidence appears.
```

## 2. Current baseline

At the time this plan was written, the repository baseline is green:

- 44 / 44 automated tests passing
- mobile TypeScript check passing
- relay TypeScript check passing
- desktop Vite production build passing
- Cloudflare Worker / Durable Object dry-run passing

The mobile dependency compatibility check also reported that the installed Expo SDK expects:

- React Native `0.86.3` instead of the currently declared `0.86.0`
- TypeScript `~6.0.3` instead of the currently installed `5.9.x`

All modernization work must preserve or improve this baseline.

## 3. Scope

### In scope

- Expo / React Native / TypeScript dependency normalization
- PDF engine isolation
- `pdf-lib` to `@cantoo/pdf-lib` migration
- image-processing backend abstraction
- `react-native-fast-opencv` proof of concept
- PDF page rasterizer abstraction
- page-at-a-time PDF rendering proof of concept
- performance and memory measurements on representative documents
- rollback paths for every engine-level change

### Out of scope

The following remain unchanged unless a later benchmark, bug, or security issue creates a concrete reason to revisit them:

- `react-native-document-scanner-plugin`
- `@kishannareshpal/expo-pdf`
- Noble crypto libraries
- RustCrypto primitives used by the desktop receiver
- Expo FileSystem
- Expo SQLite
- Expo SecureStore
- Tauri
- Tokio
- `tokio-tungstenite`
- Cloudflare Worker / Durable Object relay architecture

This plan also does not add OCR, searchable PDF, HWP/HWPX rendering, Office rendering, watermarking, signatures, or password protection.

## 4. Engineering principles

### 4.1 Adapter before replacement

Do not make UI or business logic depend directly on a new native engine.

The target architecture is:

```text
UI / document workflow
        |
        v
EasyDoc-owned interface
        |
        +---- current implementation
        |
        +---- candidate implementation
```

This keeps rollback cheap and makes side-by-side validation possible.

### 4.2 Behavioral compatibility first

A replacement is accepted only if existing behavior remains compatible before performance benefits are considered.

### 4.3 Native modules require real-device validation

JavaScript/unit tests are necessary but insufficient for OpenCV and PDF rasterizer changes.

The final acceptance gate for those phases requires Android and iOS device testing.

### 4.4 No simultaneous high-risk engine swaps

Do not migrate image processing and PDF rasterization in the same change set.

Each engine change must be independently measurable and independently reversible.

## 5. Phase 0 — dependency normalization

### Goal

Move the mobile project onto the dependency versions expected by the installed Expo SDK before introducing any new native module.

### Target files

- `apps/mobile/package.json`
- `package-lock.json`

### Work

1. Run the Expo dependency compatibility check.
2. Align React Native to the Expo-recommended patch version.
3. Align TypeScript to the Expo-recommended version.
4. Allow Expo tooling to normalize other SDK-managed package versions if required.
5. Do not combine this phase with PDF or image engine changes.

At the time this plan was written, the compatibility check recommended:

```text
react-native 0.86.3
typescript ~6.0.3
```

The command output at implementation time is the source of truth if those values change.

### Acceptance criteria

- `npm install` / lockfile resolution succeeds
- `npm run verify` passes
- Expo dependency compatibility check reports no actionable mismatch
- Android native project generation/build succeeds
- iOS native project generation/build succeeds where the build environment is available
- scanner, document viewer, pairing, and transfer startup smoke tests pass

### Rollback

Revert only the dependency and lockfile change.

### Decision gate

No later phase starts until Phase 0 is green.

## 6. Phase 1 — PDF engine isolation and migration

### Goal

Remove direct dependency on a specific PDF implementation from application code, then replace the dormant upstream `pdf-lib` package with the actively maintained `@cantoo/pdf-lib` fork.

### Current hotspots

- `packages/pdf-tools/src/index.ts`
- `apps/mobile/src/documents/store.ts`
- `apps/mobile/src/ui/pdf-tools-screen.tsx`

The main architectural issue is not only the package choice. `apps/mobile/src/documents/store.ts` directly imports `PDFDocument`, which bypasses the existing `@easydoc/pdf-tools` boundary.

### Target architecture

```text
apps/mobile
    |
    v
@easydoc/pdf-tools
    |
    v
PDF engine implementation
```

Application code must not import `pdf-lib` or `@cantoo/pdf-lib` directly after this phase.

### Work

#### 6.1 Complete the `@easydoc/pdf-tools` boundary

Move scanned-image-to-PDF generation behind `packages/pdf-tools`.

The package should own operations such as:

```ts
pageCount()
mergePdfs()
splitPdf()
rotatePdf()
reorderAndDeletePdf()
imagesToPdf()
optimizePdf()
```

Add any API required by `documents/store.ts` rather than importing the engine in the mobile app.

#### 6.2 Add regression fixtures

Create small deterministic fixtures for:

- one-page PDF
- multipage PDF
- rotated page
- JPEG-based scanned PDF
- PNG-based scanned PDF
- reordered/deleted pages

Tests should verify behavior rather than byte-for-byte equality because PDF serializers may produce different valid byte layouts.

Verify:

- page count
- page dimensions where relevant
- page order
- valid reload after save
- expected rotation metadata
- image-based PDFs remain readable

#### 6.3 Migrate the engine

Replace the internal package dependency from:

```text
pdf-lib
```

to:

```text
@cantoo/pdf-lib
```

Keep the public `@easydoc/pdf-tools` API stable unless a change is required for correctness.

### Acceptance criteria

- no application-level direct import of `pdf-lib` or `@cantoo/pdf-lib`
- existing PDF tests pass
- new regression fixtures pass
- generated scanned PDFs open in the current mobile viewer
- merge / split / rotate / reorder / delete / images-to-PDF work on device
- `npm run verify` passes

### Performance checks

Record before/after for representative inputs:

- 10-page image PDF
- 50-page normal PDF
- 100-page normal PDF

Measure:

- operation elapsed time
- output size
- peak process memory when measurable

The migration does not need to outperform the old package. Maintenance and isolation are the primary goals. It must not introduce a material regression.

### Rollback

Because application code depends only on `@easydoc/pdf-tools`, rollback is limited to the package implementation and dependency.

### Decision gate

Accept if behavior is preserved and no material performance or compatibility regression appears.

## 7. Phase 2 — image-processing backend abstraction

### Goal

Stop treating the current JavaScript raster implementation as a permanent architecture and create a backend boundary that can support native processing.

### Current hotspots

- `packages/image-processing/src/index.ts`
- `apps/mobile/src/scanner/process-page.ts`

Current non-color filter flow is conceptually:

```text
image file
  -> full file bytes in JS
  -> JPEG/PNG decode
  -> RGBA buffer
  -> JS grayscale/Otsu loop
  -> JPEG/PNG encode
  -> file write
```

This is expected to become increasingly expensive with high-resolution, multi-page scans.

### 7.1 Define the backend interface

Introduce an EasyDoc-owned interface. The exact naming may vary, but it should express file-oriented processing rather than require the caller to manage RGBA arrays.

Example:

```ts
type ScanFilter = "color" | "gray" | "bw";

type ScanProcessRequest = {
  inputUri: string;
  outputUri: string;
  filter: ScanFilter;
  rotation?: 0 | 90 | 180 | 270;
  jpegQuality?: number;
};

interface ScanImageProcessor {
  process(request: ScanProcessRequest): Promise<void>;
}
```

The interface should be designed to avoid bringing large image buffers into JavaScript when the backend can operate directly on native files.

### 7.2 Keep the existing implementation as fallback

Wrap the current `fast-png` + `jpeg-js` implementation as the reference/fallback backend.

Do not delete it during the PoC.

### 7.3 Add OpenCV candidate backend

Evaluate `react-native-fast-opencv` behind the same interface.

Initial operations:

- grayscale
- B&W thresholding
- optional Gaussian blur before threshold
- rotation if it reduces duplicate decode/encode passes

Do not expand scope to edge detection/perspective correction in this phase unless the simple filters are already stable.

### 7.4 Golden-image validation

Use a fixed test corpus containing:

- white paper on dark background
- low contrast text
- shadows
- colored handwriting
- printed text
- photo mixed with text
- Korean text
- high-resolution camera image

Compare:

- visual readability
- threshold quality
- dimensions/orientation
- alpha handling when applicable
- output file validity

Pixel-perfect output is not required. Document readability is the acceptance target.

### Benchmark matrix

Run at minimum:

| Input | Pages |
|---|---:|
| ~5 MP scan | 1 |
| ~12 MP scan | 1 |
| ~12 MP scan | 10 |
| ~12 MP scan | 30 |
| highest practical supported camera resolution | 5 |

Measure independently for grayscale and B&W.

Record:

- median processing time per page
- total batch time
- peak JS heap where available
- native/process memory where available
- output file size
- crashes / OOM / watchdog events
- UI responsiveness during processing

### Acceptance target

Promote the native backend only if all of the following hold:

- no meaningful visual regression
- no repeatable crash/OOM in the benchmark matrix
- clear reduction in JS memory pressure or processing time
- Android and iOS behavior is sufficiently consistent
- application binary-size increase is considered acceptable
- current scanner flow remains stable

A useful target, not a hard requirement, is at least one of:

- >= 30% lower median processing time for 12 MP images
- >= 40% lower JS-side peak memory during processing

If neither is achieved, retain the current implementation and remove the candidate dependency.

### Rollback

Switch the backend selection to the existing JS implementation and remove the native package if required.

### Decision gate

OpenCV becomes the default only after real-device benchmark evidence supports it.

## 8. Phase 3 — PDF page rasterizer abstraction

### Goal

Remove the UI assumption that a whole PDF must be rasterized before thumbnails or presentation pages can be used.

### Current hotspots

- `apps/mobile/src/ui/document-viewer.tsx`
- `apps/mobile/src/ui/pdf-tools-screen.tsx`

The current viewer/presentation flow calls `react-native-pdf-to-image` and retains the returned page images. This scales poorly for large PDFs.

### Target architecture

```text
Document Viewer / Presentation / PDF Tools
                  |
                  v
          PdfPageRasterizer
                  |
          +-------+-------+
          |               |
     current backend   candidate backend
```

### Proposed interface

Conceptually:

```ts
type RenderPdfPageRequest = {
  uri: string;
  pageIndex: number;
  maxDimension?: number;
  quality?: number;
};

interface PdfPageRasterizer {
  getPageCount(uri: string): Promise<number>;
  renderPage(request: RenderPdfPageRequest): Promise<string>;
  release?(uri: string): Promise<void>;
}
```

### Viewer behavior change

Thumbnail mode should request only pages near the visible range.

Presentation mode should prefetch a small window, for example:

```text
previous page
current page
next one or two pages
```

It must not require rendering every page before the first page can be presented.

### Candidate backend

Evaluate `@dariyd/react-native-pdf-page-image` or another page-addressable native renderer behind the interface.

The package is not accepted solely because its API is a better fit. It must pass the benchmark and reliability gates below.

### Benchmark matrix

Test at minimum:

- 10 pages
- 50 pages
- 100 pages
- 300 pages

Measure:

- time to first thumbnail
- time to first presentation page
- memory after initial render
- memory after scrolling through many pages
- cache cleanup after leaving the document
- temporary file growth
- page navigation latency

### Acceptance targets

For a 100-page document:

- first useful thumbnail should not depend on rasterizing all 100 pages
- first presentation page should not depend on rasterizing all 100 pages
- memory should grow with the active cache window rather than total page count
- leaving the document should release or clean temporary resources

For a 300-page document:

- no OOM/crash during normal thumbnail navigation
- no mandatory full-document rasterization step

### `PDF -> images` tool exception

The explicit PDF-to-images export feature is allowed to render every requested page because producing all images is the user's requested operation.

Viewer and presentation flows are not allowed to use that full-export behavior as their navigation implementation.

### Rollback

Keep the existing `react-native-pdf-to-image` implementation available behind the same rasterizer boundary until the candidate passes acceptance.

### Decision gate

Promote the candidate only after real-device tests demonstrate better scaling for large PDFs.

## 9. Dependency retention decisions

### Keep `react-native-document-scanner-plugin`

Reason:

- already integrated
- covers the required capture/crop flow
- replacing it would introduce native risk without a demonstrated product benefit

Revisit only if:

- compatibility with the selected Expo/RN version becomes a problem
- scanning quality has a reproducible blocker
- maintenance stops and a concrete replacement is proven

### Keep `@kishannareshpal/expo-pdf`

Reason:

- current viewer requirements are met
- page rasterization and PDF text search are separate concerns

Do not replace the viewer solely to solve thumbnail generation or text indexing.

### Keep Noble / RustCrypto stack

Reason:

- protocol behavior is already tested across mobile and desktop implementations
- replacement increases cryptographic interoperability risk
- no concrete current deficiency justifies migration

Any future crypto change requires a separate security design review and protocol versioning plan.

### Keep Expo storage stack

Continue using:

- Expo FileSystem
- Expo SQLite
- Expo SecureStore

No additional database abstraction or state-management dependency should be introduced as part of this modernization track.

### Keep Tauri / Tokio / Cloudflare relay stack

The transfer path is already a core proven part of the product. This modernization track must not destabilize it.

## 10. Change-set / PR structure

Keep work split so each stage can be reviewed and reverted independently.

Recommended order:

### Change set A — dependency normalization

- Expo/RN/TS alignment only
- no architecture changes

### Change set B — PDF abstraction

- remove direct mobile PDF-engine imports
- strengthen `@easydoc/pdf-tools`
- add regression fixtures

### Change set C — PDF engine migration

- swap internal implementation to `@cantoo/pdf-lib`
- no UI behavior changes

### Change set D — image processor abstraction

- introduce backend interface
- wrap existing implementation
- behavior should remain unchanged

### Change set E — OpenCV PoC

- add candidate backend
- benchmarks and device notes
- default backend changes only if the gate passes

### Change set F — PDF rasterizer abstraction

- refactor viewer/presentation call sites
- preserve current backend initially

### Change set G — page-level rasterizer PoC

- add candidate backend
- benchmark large PDFs
- promote only if the gate passes

## 11. Test strategy

### Required on every change set

```bash
npm run verify
```

### PDF-specific

- merge preserves all pages
- split creates expected documents
- reorder/delete preserves requested page order
- rotation affects only selected pages
- images-to-PDF accepts JPEG and PNG
- saved output can be loaded again
- Korean filenames remain unaffected at the workflow level

### Scanner-specific

- color path remains unchanged when no processing is required
- grayscale remains readable
- B&W remains readable
- rotation + filter combination produces correct orientation
- multi-page scan completes without losing pages

### Viewer/rasterizer-specific

- PDF loads
- page count is correct
- thumbnail page selection maps to the correct PDF page
- presentation next/previous navigation remains correct
- resource cleanup occurs after document close

### End-to-end regression

At minimum after Phases 1, 2, and 3:

```text
scan/import
  -> PDF generation or open
  -> save locally
  -> enqueue transfer
  -> encrypted transfer
  -> desktop receive
  -> checksum/finalization
```

The modernization must not alter the transfer protocol.

## 12. Benchmark artifacts

Store benchmark methodology and results in the repository rather than relying on informal observations.

Suggested location:

```text
docs/benchmarks/
  image-processing.md
  pdf-rasterization.md
```

Each benchmark result should record:

- device model
- OS version
- app build type
- Expo / React Native version
- candidate package version
- input characteristics
- number of runs
- timing summary
- memory observations
- binary-size delta where relevant
- decision: accept / reject / repeat

Do not commit sensitive or copyrighted user documents as benchmark fixtures.

## 13. Rollback policy

Every new engine must remain behind an EasyDoc-owned boundary.

Rollback must not require changes to UI screens, transfer code, or persisted document metadata.

A candidate is rejected when it causes any of the following and no straightforward fix exists:

- data corruption
- invalid PDFs/images
- repeatable crash or OOM
- major platform inconsistency
- significant startup/build regression
- unacceptable binary-size increase
- dependency compatibility instability
- no measurable benefit over the current implementation

## 14. Security and privacy constraints

Modernization must preserve the existing local-first document behavior.

- image/PDF processing remains on device
- document bytes are not uploaded to third-party processing APIs
- E2E transfer crypto remains unchanged
- private keys remain device-local
- no analytics SDK is introduced by this work

Native packages added during the PoC must be reviewed for:

- license
- transitive native dependencies
- network behavior
- permissions
- maintenance activity
- platform minimum-version changes

## 15. Definition of done

This modernization track is complete when:

1. Expo/RN/TS dependencies are aligned and verified.
2. Mobile code no longer imports a PDF engine directly.
3. `@easydoc/pdf-tools` owns the PDF engine boundary.
4. `@cantoo/pdf-lib` is accepted or explicitly rejected with recorded evidence.
5. scanner image processing is behind an EasyDoc-owned backend interface.
6. OpenCV is either promoted based on benchmark evidence or removed cleanly.
7. viewer/presentation PDF rasterization is behind a page-oriented abstraction.
8. large PDFs no longer require whole-document rasterization for basic navigation if the candidate passes validation.
9. all accepted engine changes have documented rollback paths.
10. `npm run verify` remains green.
11. Android and iOS device validation results are recorded for all accepted native-module changes.

## 16. Execution priority

Final execution order:

```text
P0  Expo / RN / TypeScript normalization
 |
 v
P1  PDF boundary completion
 |
 v
P1  @cantoo/pdf-lib migration
 |
 v
P1  image-processing backend abstraction
 |
 v
P1  react-native-fast-opencv benchmark PoC
 |
 v
P2  PDF page-rasterizer abstraction
 |
 v
P2  page-level native rasterizer benchmark PoC
```

Do not proceed to the next high-risk native-engine change while the previous one has unresolved regressions.
