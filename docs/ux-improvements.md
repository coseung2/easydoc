# UX improvements — September 7, 2026

This implementation follows the eight findings in `ux-review.md`. It improves
interaction feedback and reliability; it is not a visual redesign.

## Implementation and rollout

| Review finding | Implementation | Rollout / remaining boundary |
| --- | --- | --- |
| 1. PC name on already-paired phones | Persisted desktop profile updates, authenticated relay forwarding, mobile secure-store update and live alias display; desktop republishes on peer reconnect | Requires the updated relay and mobile app as well as desktop 0.2.1; production relay was not deployed in this session |
| 2. Desktop action feedback | Busy/saved/error states, synchronous duplicate-action guards, preserved drafts, inline dialog errors and destructive-action confirmation | Desktop build and browser IPC-fixture verification |
| 3. Duplicate mobile sends | Active file/target queue deduplication, enqueue feedback and viewer errors | Mobile code/tests; no physical-device execution claimed |
| 4. Save/transfer coupling and stalls | Local enqueue finishes independently of delivery; transfer timeout, retry and cancellation handling | Mobile code/tests; real-network loss/reconnect acceptance still required |
| 5. Blocking hashing | Bounded file reads, cooperative event-loop yielding, cancellable work and revision-keyed hash reuse | Cryptographic hashing still runs on the JS thread; a true native background hashing worker remains future work |
| 6. Repeated PDF/OCR work | Shared bounded single-flight page and OCR caches keyed by identity/revision/output options; OCR search state reuse and bounded fallback converter metadata | Cache entry/estimated-weight caps are enforced. Generated image files remain backend-owned to avoid deleting pages being displayed; a strict native disk quota and device smoke pass remain |
| 7. Whole-list progress rerenders | Progress subscription separated from the root document list and memoized filtering | Native large-library profiling remains |
| 8. Desktop full-snapshot polling | Per-section change events, independent failures and non-overlapping requests; 15-second fallback and focus refresh | Fallback deliberately retained for missed events/older runtimes |

## Verification scope

- Integrated `npm run verify`: 77 tests passed, mobile/relay TypeScript checks,
  desktop Vite production build, and relay deployment dry-run passed.
- Desktop TypeScript check and Windows Rust library tests (7) passed.
- Windows NSIS 0.2.1 built and installed successfully; uninstall registration,
  executable version, and the running EasyDoc window process report the new build.

The actual React desktop UI was exercised in a browser using Tauri's IPC mock
with fictional files and devices. No user file, pairing, or PC name was modified
by these browser checks. Checked paths include:

- an empty edited PC name survives background settings refresh;
- save immediately disables input/action and reports success only on completion;
- failed rename retains the input and dialog with an inline error;
- an inbox refresh succeeds independently of a failing settings request;
- repeated change events do not overlap requests for the same section;
- layouts inspected at 1280×720 and 900×650.

Local screenshot evidence is in `output/playwright/` (excluded from Git).
`scripts/desktop-ux-browser-setup.js` is a local fixture for the Windows checkout
used in this session, not a native application test.

The Windows Computer Use helper was unavailable (`native pipe` not found).
Consequently these browser checks must not be described as installed-app click
tests. Android/iOS device behavior and production relay interoperability were
not verified by them.

## Operational notes

- Separate Luna workers handled desktop interaction feedback, mobile transfer
  responsiveness, and PDF/OCR cache work. Luna was the available model in the
  requested worker pool; isolated scopes enabled parallel implementation and
  independent review. The primary agent integrated protocol/profile changes,
  queue serialization, race guards, build fixes, and combined verification.

- The Windows build uses the MSVC Rust toolchain installed for this checkout.
- This network requires `CARGO_HTTP_CHECK_REVOKE=false` in the build process;
  no system-wide certificate verification setting was changed.
- Set `EASYDOC_TEST_MANIFEST=1` in the test process when running Windows
  `cargo test --lib --locked` to embed Common Controls v6 for dialog-linked
  tests. Leave it unset for application builds, which already embed a manifest.
- Implementation commits and worktrees are local. No GitHub push or production
  deployment is implied by a passing dry-run build.
