# Hancom preview automation stalls on the per-file access prompt

- Date: 2026-09-10, Asia/Seoul (UTC+09:00).
- Status: unattended rendering is blocked on the current profile. One
  exploratory reuse run exported a PDF; the final ownership-guarded helper has
  no verified successful PDF export.
- Impact: development only. No user-facing release depends on this yet, and the
  editor keeps working when the preview is unavailable.

## Symptoms

An exploratory reuse run exported a PDF from a generated HWPX in 72.5s. This
was not a verified success of the final ownership-guarded helper. Every
later run left `hwp.exe` alive with a modal open and produced no PDF, so the
helper hit its caller's timeout at `Open`. The modal names the exact file and
offers 접근 허용 / 모두 허용 / 허용 안 함 / 모두 안 함.

## Timeline

- 22:56 first spike run succeeds; two orphaned `hwp.exe -Automation` servers
  from the preceding ProgID probe were alive and no new process was created.
- 23:00 orphans terminated by pid plus start-time proof.
- 23:06 second run with no pre-existing instance stalls; a window capture shows
  the file-access prompt.
- 23:29-23:41 the prompt is answered through UI Automation `InvokePattern`
  (7 successful invokes) and then `ALT+Y` on the focused window (1 send). The
  dialog stays up, `Open` never returns, and the helper is killed at ~180s.
- 23:44-23:52 four controlled variants (plain, `forceopen`, orphan reuse,
  `SetMessageBoxMode(0x20000)`) all reach the prompt and produce no PDF.

## Evidence

- Successful export: 17,544-byte PDF, source SHA-256 `27659BAF...4AC03D5`
  identical before and after, extracted text covers the heading, table headers,
  and both paragraphs of a multi-paragraph cell.
- Prompt tree: window class `MessageBoxImpl`, four `DialogButtonImpl` buttons,
  each advertising `InvokePatternIdentifiers.Pattern`.
- The coordinator rendered `probe1.pdf`: one page with a visually readable
  Korean title and table-cell text. Full font and image fidelity were not verified.
- Variant matrix and the `pypdfium2` text extraction are recorded in
  `docs/hwpx-preview-verification.md`.

## Cause

Hancom's file-access protection prompts per file for automation clients, and
`Open` blocks on it. Answering it programmatically did not release the call in
any attempt, so the dialog is not the whole story: the automation client stays
blocked even after the modal is dismissed. Why the very first run avoided the
prompt entirely is not established. It reused an orphaned server, but a
deliberately reproduced orphan-reuse variant still prompted, so orphan reuse
alone does not explain it. This remains an open hypothesis, not a finding.

## Response

- `scripts/hwpx/hwpx-to-pdf.ps1` opens read-only with `lock:false` and no
  prompt-suppressing options, so a document that only opens through repair fails
  instead of yielding a misleading PDF.
- Ownership is proven by resolving the automation window handle to its process
  and requiring that the pid did not exist before creation. Without that proof
  the helper opens nothing, skips `Clear`/`Quit`, releases the COM reference, and
  reports an error.
- `scripts/hwpx/stop-owned-hwp.ps1` terminates only a recorded pid that is still
  an `hwp.exe` with the recorded start time, and reports the rest as skipped.
- `apps/shell/src/main/hwpx-preview.ts` serializes renders, times out at 90s,
  runs the ownership cleanup after any failed render, and reports the stall as a
  possible Hancom dialog.

## Recovery verification

Helper killed mid-prompt, then the cleanup helper reported
`{"stopped":[28644],"dialog":false,"skipped":[]}`; zero `hwp.exe` remained, the
ownership file was removed, and the fixture hash was unchanged. The user's own
Hancom windows were never closed, and no security module or registry value was
created, removed, or edited.

## Follow-up

- Treat preview availability as best-effort in the UI and never block saving on
  it.
- Module registration and distribution requirements, including those for
  `FilePathCheckerModuleExample_sm`, were not validated in this task. No module
  or registry value was changed; no licensing determination is made here.
- Clean-profile behaviour is untested; do not claim unattended operation.
