# Sheets preload dependency prevented startup

- Date: 2026-09-09, Asia/Seoul (UTC+09:00).
- Status: recovered and verified locally.

## Symptoms and impact

After a successful full build of `0125027`, clicking AI Sheets opened a blank
editor. Docs and the focused home/HWPX acceptance tests passed.

## Evidence and confirmed cause

The actual Electron runtime reported `Unable to load preload script` followed by
`module not found: @genoffice/agent-core`. The renderer then failed while reading
`getAiSettings` and `onLanguageChanged` from an undefined desktop bridge.

The Sheets preload imports `isGeneratedDocumentType` at runtime. Its build
configuration externalized agent-core, but Electron sandbox preloads cannot
require arbitrary workspace packages.

## Response

Added agent-core to the Sheets preload bundle exclusions from dependency
externalization, alongside electron-utils.

## Recovery verification

- Sheets rebuilt successfully; Sheets typecheck passed.
- Real Electron opened Docs, Sheets, Slides, Markdown, and PDF with visible
  editors and AI composers, with no renderer page errors.
- Typed `42` into Sheets A1, saved, and independently checked the XLSX worksheet
  XML for `<v>42</v>`.
- Screenshots: `e2e/artifacts/screenshots/local-*.png` (ignored local artifacts).
- Two Sheets resource-not-found console messages remain, alongside existing
  Carlito font build warnings. These did not prevent startup or saving; their
  exact relationship was not verified.

## Prevention

Validate the built Electron app, including all editor cards, when adding runtime
imports to preload scripts. A successful build or a home-only test cannot detect
this sandbox dependency failure.
