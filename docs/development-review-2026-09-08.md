# Development review: 2026-09-08

Reviewed on Windows with Node 24.18.0 and npm 11.18.0.

## Git baseline

The local checkout now follows `origin/main` at `5982035`, the GenOffice-based
EasyDoc fork. The previous EasyDoc history has no common merge base with this
branch and is preserved at `archive/easydoc-local-20260908` locally and
`origin/archive/easydoc-pre-genoffice` remotely (`a387cb0`). Old untracked mobile
and Tauri build artifacts were moved into `.task/legacy-easydoc-builds-20260908/`;
they were not deleted or added to the new application.

## Implemented

- **Native ChatGPT OAuth:** select OpenAI, then ChatGPT (OAuth), in the shell's
  AI Model settings. Sign in through the browser and save the provider selection.
  The shell owns PKCE login, the loopback callback on port 1455, cancellation,
  account disconnection, token refresh, and encrypted OS-backed persistence.
  OpenCodex on port 10100 is not a runtime dependency. Tokens and account IDs stay
  in the main process; public settings contain only the auth mode and model.
  Login controls are translated across all 19 shell locales.
- **OAuth model execution:** the shared AI provider sends ChatGPT requests through
  the Codex Responses endpoint, including streaming text, reasoning, images,
  tool calls, and tool results. It ignores renderer-supplied credentials and
  endpoints, rejects redirects, preserves cancellation, and requires a completed
  response before executing tool calls. HTTP/SSE/network errors cannot reflect
  private credentials through returned errors or fallback logs. Unsupported
  API output-token controls are hidden in OAuth mode.
- **Receiver collision safety:** reserve partial files with exclusive creation,
  allowing concurrent same-name transfers and preserving orphaned partial files.
  Publish verified contents with an atomic, non-overwriting hard link and choose
  a numbered name if another file appeared during reception. Cleanup after
  publication cannot turn a completed transfer into a rejection.
- **Home filesystem work:** recent-file requests filter and paginate stored paths
  before reading filesystem metadata. Count-only queries make no `statSync`
  calls; a page only stats its displayed files. Missing entries remain in counts
  and retain their positions. Starred files share the spreadsheet extension
  filter, so `.xlsm` remains visible under Sheets; populated starred pages retain
  modification-time sorting.
- **Windows development commands:** run npm and Prettier JavaScript entry points
  through Node instead of directly spawning Windows command shims. The suite
  launcher passes renderer URLs as process environment values, avoiding POSIX
  inline environment assignments. Optional WebSocket native accelerators remain
  external so missing packages do not crash the development shell.
- **Windows file handling:** PDF output names are sanitized consistently before
  Windows can interpret a colon as a drive prefix. Authentication persistence
  tests verify the requested secure mode on Windows and the actual POSIX mode
  on platforms that support it.
- **Verification coverage:** root test/typecheck commands now include all three
  EasyDoc packages. A focused Windows CI job checks receiver behavior, common
  file handling, OAuth, and shell controls. File-dialog tests use native paths;
  permission fallback coverage injects `EACCES` instead of relying on POSIX chmod.

## OAuth validation boundaries

Login requires an available OS encryption backend and a free loopback port 1455.
The application fails closed when safe storage is unavailable. API-key mode
remains available. The native login owner is the unified shell; standalone editor
executables do not register their own OAuth service.

Tests use synthetic tokens and local HTTP servers. No existing OpenCodex or Codex
credentials were imported, and no real account login or paid model request was
performed. The final manual check is browser sign-in followed by the settings
connection test and an editor tool request with an entitled ChatGPT account.
Available models and account quotas are enforced by the provider. The connection
test sends a model request when run by the user.

## Filesystem support

Receiver publication is verified on local Windows NTFS. It requires hard-link
support in the receive directory. FAT/exFAT and network shares have not been
validated; unsupported destinations fail without overwriting an existing file.
After successful publication, a failed cleanup can leave `.part` or metadata
files behind while the final document remains valid. A portable publication
strategy and cleanup recovery need separate filesystem-specific validation.

## Checks

- Dependency installation using the committed lockfile passed.
- Repository-wide TypeScript checking passed, including the new EasyDoc checks.
- Repository lint passed with 12 existing warnings and no errors.
- License allowlist, English-comment, and theme-color checks passed.
- EasyDoc protocol, crypto, and receiver tests passed, including encrypted
  transfer through the mocked relay and collision regression coverage.
- AI provider suite: 249 tests passed, covering PKCE/state validation, loopback
  ownership, cancellation, token rotation races, redirect rejection, streaming
  tool calls, incomplete responses, and credential reflection failures.
  Independent re-review closed all three OAuth findings and reran 55 focused
  auth/transport regressions successfully.
- Shell suite: 251 tests passed, including encrypted persistence, IPC privacy,
  and OAuth controls. Recent/starred subset: 21 tests passed.
- Sheets AI settings schema: 6 tests passed.
- Electron utility suite: 123 tests passed after the Windows fixture corrections.
- AI-search suite: 47 tests passed after the Windows permission assertion fix.
- Slides suite: 699 tests passed, 12 skipped. PDF suite: 685 tests passed.
- Docs default suite after the Windows worker bound: 197 files and 1,848 tests
  passed. Docs typecheck and focused lint also passed.
- Docs and shell production JavaScript builds passed.
- Electron OAuth settings E2E exercises selection, pending login, cancellation,
  and saved public settings through the real preload with synthetic OAuth IPC.
  The combined OAuth/home E2E run passed all 3 tests. The OAuth scratch profile
  dismisses the unrelated upgrade star prompt before launch.
- Existing Electron home E2E: 2 tests passed (home cards and localized UI).
- The broad root test run passed all shared packages and reached Docs. A repeated
  Docs protection-dialog failure was traced to a 10-second polling deadline around
  100,000 real WebCrypto rounds; its fixture now awaits the actual operation while
  retaining real cryptographic verification and reliable cleanup. Unbounded
  Windows jsdom workers could still exhaust the test's 20-second budget, so Docs
  now limits Windows parallelism to four workers. Other platforms retain their
  existing worker policy.
- Follow-up recovery built all editor JavaScript/preloads and the native Sheets
  engine using a checksum-verified local vendor source. Native tests: 168 passed.
  Real Electron card checks passed for all five editors, including a Sheets cell
  edit/save confirmed in the XLSX XML. Standard Cargo online downloads still
  report `CRYPT_E_NO_REVOCATION_CHECK`; TLS verification was not disabled.
  See [the editor startup incident](incidents/2026-09-08-missing-editor-builds.md)
  for the cause, recovery commands, and remaining packaging boundary.

## Next development priorities

1. **Validate the real receiver path before rollout.** Use the existing mobile
   build and relay with a packaged Windows application: QR pairing, reconnect,
   restart/resume, 1 MB through 1 GB transfers, checksum failures, duplicate names,
   receive-folder filesystem support, auto-open off/on, and opening a received
   PDF. Mocked-relay tests and a working home screen do not establish this gate.
2. **Restore the complete Windows verification path.** Resolve Cargo certificate
   revocation access in the development environment and run the Sheets
   compatibility and packaged MSVC gates. Local GNU engine build/tests now pass
   using verified vendored dependencies.
3. **Guard EasyDoc UI snapshots against stale responses.** In
   `EasyDocQuickCard.tsx`, a pending initial `state()` response can replace a more
   recent pushed state. Cover this ordering with a deferred-response test before
   adding revision guards to initial and mutation responses.
4. **Reduce remaining upstream warnings in focused changes.** Review the 12 lint
   warnings with behavior-specific tests. Avoid broad editor rewrites merely to
   clear warning output.

The added Windows CI job has been checked locally through its component
commands; it has not yet run on GitHub Actions.
