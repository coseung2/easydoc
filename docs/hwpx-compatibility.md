# HWPX compatibility and release gate

Status: **experimental, structural checks only**. No Hancom GUI acceptance has
been performed in this development environment. Do not equate a passing SDK
read-back or XML parser with a valid submission to a public institution.

## Produce the manual corpus

Linux/macOS shell:

```sh
HWPX_CORPUS_DIR=/tmp/easydoc-hwpx-corpus npm run fixtures -w @genoffice/hwpx-engine
```

Windows PowerShell:

```powershell
$env:HWPX_CORPUS_DIR = "$env:TEMP\easydoc-hwpx-corpus"
npm run fixtures -w @genoffice/hwpx-engine
```

The corpus contains three `.hwpx` files and their source HTML: Korean/Latin text
and styles; a rectangular table with multiple paragraphs plus an embedded PNG;
and a long document exercising page flow. The generator does not invoke Hancom.

## Acceptance record

| Environment                                         | Opens without repair/error | Text/tables/images preserved | Pagination/font review | Save and reopen | Status  |
| --------------------------------------------------- | -------------------------- | ---------------------------- | ---------------------- | --------------- | ------- |
| Windows + Hancom 2022 (record exact build)          | Not tested                 | Not tested                   | Not tested             | Not tested      | Pending |
| Windows + Hancom 2024 (record exact build)          | Not tested                 | Not tested                   | Not tested             | Not tested      | Pending |
| Other supported Hancom version (record exact build) | Not tested                 | Not tested                   | Not tested             | Not tested      | Pending |

For each run record OS/build, Hancom exact version, file SHA-256, installed fonts,
opening errors/repair prompts, page count, missing text, table split behavior,
image visibility, and a screenshot/PDF exported by Hancom if permitted. Save a
copy and reopen it. Keep the original corpus unchanged for regression comparison.
An installed font substitution is not proof that the exporter embedded that font.

The release gate is actual opening plus content/visual review in the intended
Hancom environment. A failed case blocks a compatibility claim. Until then the
tool must always expose the structural-only warning and must not say the output
is submission-ready. Complex tables, objects, native page numbering, HWP5 and
round-trip HWPX editing remain outside this implementation track.

## Source distinction

The uploaded HWPX SDK investigation dated 2026-09-08 recommends `ownhwpx`, a
separate quality gate, and a later independent viewer. Its published Hancom test
counts refer to other projects, not EasyDoc output. Our `ownhwpx@0.2.16` adapter
and tests are independent measurements described in
`packages/hwpx-engine/README.md`. HanDoc/rhwp/Python were not silently substituted
as production dependencies.
