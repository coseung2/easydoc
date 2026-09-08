# Missing editor builds in the desktop shortcut

- Date: 2026-09-08, Asia/Seoul (UTC+09:00).
- Status: local editor startup recovered and verified.

## Symptoms and impact

The desktop shortcut opened the GenOffice home window, but PDF and Slides cards
led to empty editor tabs. Markdown and Sheets also lacked renderer build output.
No user documents or credentials were modified during recovery verification.

## Confirmed cause

Only Docs and Shell had `out/renderer/index.html`. The shell loads each editor
from its own `apps/<editor>/out` directory; a successful shell build does not
build these sibling modules. The prior verification covered the home and OAuth
settings, but did not exercise editor cards before the shortcut was provided.

The earlier full suite build had stopped at Sheets native dependencies because
Cargo's bundled Schannel client reported `CRYPT_E_NO_REVOCATION_CHECK`. The local
`xlsx-sidecar.exe` was therefore also missing. Building the Sheets UI alone exposed
the missing executable as a workbook-open error.

## Recovery

1. Built PDF, Slides, and Markdown with their normal workspace build commands.
2. Built Sheets JavaScript and preload using `electron-vite build` in its workspace.
3. Downloaded the 144 registry packages pinned by the existing Sheets `Cargo.lock`
   using Windows `curl.exe`, with HTTPS and certificate validation enabled.
4. Verified every archive's SHA-256 against the lockfile before extraction, then
   generated a local Cargo vendor source with file checksums in `.task/xlsx-vendor`.
   Cargo's network certificate checks were not disabled and global configuration
   was not changed.
5. Built and tested the native engine with the temporary source replacement:

```text
cargo build --release --locked --offline --manifest-path apps/sheets/native/xlsx-engine/Cargo.toml --config apps/sheets/native/xlsx-engine/.cargo/config.toml --config .task/xlsx-vendor.toml
cargo test --release --locked --offline --manifest-path apps/sheets/native/xlsx-engine/Cargo.toml --config apps/sheets/native/xlsx-engine/.cargo/config.toml --config .task/xlsx-vendor.toml
```

The local toolchain is Windows GNU. This recovery verifies the development
shortcut; it does not establish the packaged MSVC distribution gate.

## Recovery checks

- Real Electron smoke run with an isolated profile and temporary save directory:
  clicked AI Slides, AI PDF, AI Markdown, AI Sheets, and AI Docs.
- All five editor DOMs loaded with toolbars and document surfaces. Each active
  WebContentsView was visible and occupied the content area below the tab bar.
- No renderer page errors or missing-engine messages in the final run.
- Sheets: entered `42` in A1, saved, and independently inspected the generated
  XLSX worksheet XML to confirm `<v>42</v>` on disk.
- Native engine tests: 162 library tests and 6 executable tests passed.
- Local screenshot artifacts: `e2e/artifacts/screenshots/editor-card-*.png`.
  Capture the editor page itself: shell `BrowserWindow.capturePage()` omits
  embedded WebContentsView pixels and can misleadingly show a blank area.

## Follow-up

- Before providing a development shortcut, verify all five renderer/preload
  outputs and the native sidecar, then click the editor cards in the real app.
- A shell-only build is sufficient for shell changes only when sibling editor
  artifacts already exist. Do not treat it as a complete suite build.
- Standard Cargo online downloads still need their Schannel failure resolved;
  the verified local vendor source is a recovery path, not a global TLS change.
- Restart the app to replace tabs whose previous navigation failed before the
  missing files were built. User sessions were not force-closed.
