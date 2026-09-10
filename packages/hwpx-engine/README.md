# Experimental HWPX generation

Generation-only TypeScript adapter around **ownhwpx 0.2.16**, pinned deliberately.
The original DOCX editor model and round-trip save path are not replaced.

```ts
import { exportHwpx } from '@genoffice/hwpx-engine'

const result = exportHwpx('<h1>보고서</h1><p>확인된 내용</p>', {
  title: '보고서',
  createdAt: new Date(),
})
// The host saves result.bytes with exclusive creation and displays result.warnings.
// result.verification is always 'structural-only', never 'Hancom verified'.
// result.editorHtml is the written document normalized back into this HTML subset.
```

## Normalized editor HTML

`exportHwpx` also returns `editorHtml`: the parsed document serialized back into
the same restricted subset by `documentToHtml`, so an editor shows what the file
actually contains instead of the upstream HTML. Exporting `editorHtml` again
without edits reproduces byte-identical output for the same `createdAt`.

Each paragraph carries `text-align` and `line-height`, plus `margin-left` in whole
14 pt indent levels (at most 8; deeper input is flattened with a warning). Every
run is a `<span>` with all six supported text properties written explicitly, `<br>`
for line breaks, literal whitespace inside `<pre>`, and images as base64 data URIs
with explicit `width`/`height`.

Lists are flattened at parse time into indented paragraphs whose marker (`1. `,
`• `) is ordinary text, so `<ul>`/`<ol>`, `start` and nesting depth are not
recoverable. Re-exporting keeps those markers as text instead of numbering them a
second time. `<div>`/`<blockquote>` grouping is likewise not recoverable; only its
indentation is.

## Table column widths

A table may declare explicit widths in one leading `<colgroup>`:
`<col style="width:25%">`, `<col style="width:120px">`, `<col style="width:90pt">`,
or `<col width="120">` (pixels; a `style` width wins over the attribute), and
`span="n"` repeats a width. Per table the forms must not mix `%` with lengths,
every column must be declared exactly once (`span` included), the `<colgroup>` must
carry no attributes, and `<col>` accepts only `style`/`width`/`span`. Anything else
is rejected instead of being ignored.

Widths are stored proportionally (ten-thousandths of the table width, minimum 2%
per column) and applied to both the written table and `editorHtml`, so the editor
and the file always show the same grid. The table itself always spans the text
width; absolute page-relative table widths are not supported.

## Supported subset

Paragraphs and H1–H6 named heading styles; bold, italic, underline and strike;
font family/size, hex text color, alignment and percentage line spacing; line
breaks; simple lists with editable text markers; rectangular unmerged tables with
rich cell paragraphs and optional explicit column widths; level-based paragraph
indentation via `margin-left`; PNG/JPEG data-URI images scaled to the content area;
A4 portrait with 20 mm margins and a text preview. Font names are references;
font files are never bundled. The target machine can substitute missing fonts.

No HWP5 export, HWPX import/editing, DOCX conversion, native numbering, automatic
TOC/page numbering, headers/footers, charts, equations, merged/nested tables,
external image downloads, SVG, arbitrary CSS, or exact pagination. Unsupported
semantic input is rejected rather than silently flattened. For the full HTML
subset see `src/html.ts`; limits are centralized in `src/model.ts`. The app's
IPC additionally caps newly authored content at 2,000,000 characters.

## SDK boundary and provenance

Published artifact: npm `ownhwpx@0.2.16`, Apache-2.0, repository
`https://gitlab.com/ownsoftware1/ownhwpx.git`. Its package contains the Apache
license and identifies itself as a TypeScript port of hwpxlib. The report's
maintainer relationship/compatibility claims are not independently established.
Actual published dependencies are `fflate` and `saxes`; no native runtime is
needed. No upstream source or Hancom font binary has been copied into this repo.

The adapter uses the SDK's blank model and public APIs, but explicitly sets page
dimensions, removes unused legacy styles/numbering, creates only used styles,
supplies table cell addresses/spans/subLists, and discards blank line-layout
caches. SDK-specific imports and these behaviors are isolated in
`src/ownhwpx-adapter.ts`; package version changes require rerunning the corpus.

## What validation proves

`inspectGeneratedHwpx` checks ZIP limits, first STORED MIME entry, required parts,
well-formed namespace-aware XML, style references, resource references, and page
dimensions. It does **not** run the OWPML XSD or Hancom. Unit tests also read the
file with the SDK and compare extracted Korean text/table/image resources.
Identical input and creation time produce byte-identical output; this is a
regression property, not a visual fidelity guarantee.
Round-trip tests re-export `editorHtml` and compare bytes, extracted text and
written column widths; they prove the model is stable, not Hancom fidelity.

Run `npm run test -w @genoffice/hwpx-engine` and
`npm run typecheck -w @genoffice/hwpx-engine`. See
`docs/hwpx-compatibility.md` for the required external acceptance gate.
