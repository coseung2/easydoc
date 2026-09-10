# Generated HWPX was invisible in the document workspace

- Date: 2026-09-10, Asia/Seoul (UTC+09:00).
- Status: generated-document display and basic edit/save verified locally.
- Symptoms: AI reported creating HWPX, but the right document area remained blank.
- Cause: the HWPX creation host only revealed the saved file in Explorer; the
  Home card did not change that export-only result route.
- Response: open generated HTML in a new Docs editor tab carrying the HWPX path.
  Ctrl+S and Save As use the HWPX exporter for that tab, with atomic file writes.
  The main process binds save targets to the originating editor webContents.
  Remove editor metadata and layout-only markup before exporting edited HTML.
- Verification: real Electron displayed Korean heading, paragraph and table;
  editing the heading and pressing Ctrl+S persisted the new text and table
  values in Contents/section0.xml. Focused HWPX and DOCX E2E tests passed.
  Docs and Shell typechecks and builds passed.
- Scope: generated HWPX uses the existing editor's supported HTML content model.
  This does not establish full HWPX import/round-trip or Hancom layout fidelity.
  Unsupported HWPX constructs still surface export errors instead of being
  silently converted to DOCX.
- Local screenshot: e2e/artifacts/screenshots/hwpx-editor-saved.png.
