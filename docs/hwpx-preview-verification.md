# Hancom saved-file preview: what was actually verified

Status: **unattended rendering is blocked on the current profile.** One
exploratory reuse run exported a PDF from a generated HWPX. This was not a
verified success of the final ownership-guarded helper. Subsequent attempts
stopped at Hancom's per-file access prompt; preview failure must remain explicit.

## Environment

| Item              | Value                                                                                                                                                                      |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hancom            | HWP 2022, `hwp.exe` 12.0.0.3146 (`C:\Program Files (x86)\HNC\Office 2022\HOffice120\bin\hwp.exe`)                                                                          |
| Automation object | `HWPFrame.HwpObject` to CLSID `{2291CF00-64A1-4877-A9B4-68CFE89612D6}`, registered under `WOW6432Node`; `LocalServer32` is the path above with `-Automation`, **unquoted** |
| Host              | Windows, `powershell.exe` 5.1 with `-STA`                                                                                                                                  |
| Fixtures          | `packages/hwpx-engine` corpus written to `.task/hwpx-preview-spike` (synthetic Korean text, a table, a 1x1 PNG)                                                            |

Object creation succeeds from both the 64-bit and the 32-bit PowerShell host
(`x64 apartment=STA created=yes version=12, 0, 0, 3146`, same for x86), so no
bitness-specific helper is needed. `HKCU\SOFTWARE\HNC\HwpAutomation\Modules`
exists but holds no values: no security module is registered for this user, and
none was registered, unregistered, or edited during this work.

## The one successful export

`02-table-and-image.hwpx` to PDF, 17,544 bytes, 72.5s wall time.

- source SHA-256 before and after: `27659BAF...4AC03D5`, unchanged;
- text extracted from the PDF with `pypdfium2`: `표와 그림 | 항목 확인 사항 |
내용 | 추가 문단 | 병합 없는 | 표` - the heading, both table header cells,
  both paragraphs of the multi-paragraph cell, and the second column survived;
  the page carries 12 drawn objects;
- reported version: `12.0.0.3146`.

The coordinator rendered `probe1.pdf` and visually confirmed one page with a
readable Korean title and table-cell text. Full font and image fidelity were
not verified.

This was an exploratory reuse run, not a verified successful export by the
final ownership-guarded helper. It happened while
two orphaned `hwp.exe -Automation -Embedding` servers from an earlier ProgID
probe were still alive, and it created no new process of its own, so it drove a
leftover instance. Both leftovers were terminated afterwards by pid plus
start-time proof.

## Why every later attempt failed

Hancom raises a modal for each file an automation client touches:

```
C:\...\.task\hwpx-preview-spike\01-korean-styles.hwpx
한글을 이용하여 위 파일에 접근하려는 시도(파일의 손상 또는 유출의 위험 등)가 있습니다.
정상적인 작업 과정에만 접근을 허용하십시오.
[접근 허용 : ALT+Y] [모두 허용 : ALT+N] [허용 안 함 : ALT+A] [모두 안 함 : ALT+C]
```

`Open` blocks until it is answered. UI Automation sees the window
(`MessageBoxImpl`) and its four `DialogButtonImpl` buttons, all reporting
`InvokePattern`. Invoking `접근 허용 : ALT+Y` returned success seven times, and
sending `ALT+Y` to the focused window returned success once; the dialog stayed
up and the helper never got past `Open` in about 180s.

Four controlled variants, 40-46s cap each, all reached the prompt and produced
no PDF:

| Variant                                                    | New process | Prompt | PDF  |
| ---------------------------------------------------------- | ----------- | ------ | ---- |
| fresh instance, `lock:false`                               | yes         | yes    | none |
| fresh instance, `forceopen:true;versionwarning:false`      | yes         | yes    | none |
| orphan server left alive, then export from a second client | yes         | yes    | none |
| fresh instance, `SetMessageBoxMode(0x20000)`               | yes         | yes    | none |

So the successful run is not reproducible on demand, prompt-suppressing `Open`
options do not help (they were removed from the helper because they would hide
repair-level problems), and the tested `SetMessageBoxMode` setting did not
resolve the observed prompt. Module registration and distribution requirements,
including those for `FilePathCheckerModuleExample_sm`, were not validated in
this task. No module or registry value was changed. Unattended rendering remains
blocked on the current profile; no licensing determination is made here.

## Timeout recovery, verified for real

Killing the helper mid-prompt (what the service does on timeout) and then
running `scripts/hwpx/stop-owned-hwp.ps1` against the ownership file it had
written produced `{"stopped":[28644],"dialog":false,"skipped":[]}`, left zero
`hwp.exe` processes, removed the ownership file, and left the fixture hash
unchanged. `dialog:false` is a known gap in that observation: the message box had
already been dismissed by the earlier UIA attempts, so the read-only dialog
check found nothing. Termination is limited to a pid that is still an `hwp.exe`
started at exactly the recorded instant; a pid failing that check is reported as
`skipped` and left running, which is what happened when a stale record was
replayed against a process whose recorded start time no longer matched.

## Residual risks and what is not proven

- **Startup gap.** A process created between `New-Object` and the ownership
  write cannot be attributed if ownership resolution itself fails. The helper
  then refuses to open anything and reports an ownership error instead of
  guessing at candidate pids: a candidate-set kill could hit a Hancom instance
  the user launched at the same moment.
- **Clean profile.** Nothing here shows how a machine without this user's
  Hancom state behaves. Module registration and its effect on rendering were
  not validated in this task.
- **Fidelity.** One PDF with correct text and a table is not a fidelity
  measurement. Pagination, fonts, and complex objects remain unverified, and
  `docs/hwpx-compatibility.md` still governs compatibility claims.
- **Latency.** The single success took 72.5s end to end, mostly Hancom start-up.
  The service default timeout is 90s for that reason, and a stall is reported as
  a possible Hancom dialog rather than retried.

## Reproducing

Write the corpus, then run the helper directly:

```powershell
$env:HWPX_CORPUS_DIR = "$PWD\.task\hwpx-preview-spike"
npm run fixtures -w @genoffice/hwpx-engine
& "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -STA `
  -ExecutionPolicy Bypass -File scripts\hwpx\hwpx-to-pdf.ps1 `
  -Source "$PWD\.task\hwpx-preview-spike\02-table-and-image.hwpx" `
  -Output "$env:TEMP\hwpx-preview-probe.pdf" `
  -OwnershipFile "$env:TEMP\hwpx-preview-probe.owned.json"
```

Expect either one JSON success line or a stall at the access prompt. If it
stalls, stop the PowerShell child, then run `scripts/hwpx/stop-owned-hwp.ps1`
with the same ownership file. Do not answer `모두 허용`.
