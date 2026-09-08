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
```

## Supported subset

Paragraphs and H1–H6 named heading styles; bold, italic, underline and strike;
font family/size, hex text color, alignment and percentage line spacing; line
breaks; simple lists with editable text markers; rectangular unmerged tables with
rich cell paragraphs; PNG/JPEG data-URI images scaled to the content area;
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

Run `npm run test -w @genoffice/hwpx-engine` and
`npm run typecheck -w @genoffice/hwpx-engine`. See
`docs/hwpx-compatibility.md` for the required external acceptance gate.
