# UX Review — Interaction Feedback, Persistence, and Caching

Date: 2026-09-07 (Asia/Seoul)

This is a source-backed review of desktop and mobile interaction feedback. It
does not claim live device timing measurements. Native Windows and Android
behavior still requires a separate install/smoke pass after the listed work is
implemented.

Recommended implementation order:

1. Desktop save/button/dialog feedback
2. Mobile send-queue duplication, save/transfer split, and stall recovery
3. Desktop alias synchronization to already-paired phones
4. Shared PDF page-image and OCR result caching
5. Document-list and polling refresh optimization

## Findings

### 1. Desktop alias save does not update already-paired phones

The desktop save path writes the local settings file and pairing records. The
mobile app stores the alias received during QR claim and has no later update
path. The desktop helper copy “휴대폰에서 표시할 이름” therefore overpromises.

- Desktop write: `apps/desktop/src-tauri/src/lib.rs` (`set_desktop_alias`)
- Mobile snapshot: `apps/mobile/src/pairing/client.ts` (`claimPairing`)

Fix: push alias changes to connected phones, and refresh the stored name on
reconnect when the phone was offline.

### 2. Desktop actions lack in-progress, success, and duplicate-click protection

PC name save has no success state. Connect and add-phone remain clickable while
a request is in flight. Clearing the name field can be overwritten by the
3-second refresh. Rename/delete dialogs close before the command finishes, so
failures drop the typed value and show only a generic banner.

- Polling and save handlers: `apps/desktop/ui/src.tsx`
- Dialog submit: `apps/desktop/ui/src.tsx` (dialog form)

Fix: show `저장 중` / `저장됨`, disable unchanged or in-flight saves, keep the
dialog open until success, and display field-level errors inside the dialog.

### 3. Mobile send can enqueue the same file more than once

Send buttons have no enqueueing state. Each tap creates a new transfer ID. The
existing in-flight lock only prevents two simultaneous socket sends; it does
not collapse duplicate queue rows for the same file and PC. The document viewer
does not receive transfer errors, so a failed send can be invisible on the
current screen.

- Queue insert: `apps/mobile/src/transfer/queue.ts` (`enqueueTransfer`)
- Viewer wiring: `apps/mobile/App.tsx`

Fix: show `전송 대기` immediately, ignore or coalesce duplicate file+PC
enqueues while one is waiting/transferring, and surface viewer send results.

### 4. Local save waits for PC transfer completion

Scan save callbacks enqueue and then wait for `flushQueue()`. A large file to
an online PC can remain on “저장 중” after the document is already stored on
the phone. Transfer start/ack also has no idle timeout, so a live socket with
no receiver response can stall the queue.

- Enqueue + flush: `apps/mobile/App.tsx` (`enqueueForTarget`, scan `onSaved`)
- Send wait: `apps/mobile/src/transfer/client.ts` (`sendFile`)

Fix: finish local save independently, transfer in the background, and add
no-response detection, retry, and cancel states.

### 5. File hashing blocks the UI before transfer status appears

`sha256File()` reads the whole file synchronously before the transfer banner
starts. Large files can look frozen after Send is tapped.

- `apps/mobile/src/transfer/expo-file-source.ts`

Fix: show a preparing/queued state first and move hashing off the UI thread.
Unchanged files can reuse a stored hash.

### 6. PDF page images and OCR results are rebuilt per screen

Page picker, presentation mode, and OCR each convert the PDF independently.
Leaving a screen discards the images. Reopening the viewer also drops OCR
search results.

- Viewer reset and conversion: `apps/mobile/src/ui/document-viewer.tsx`
- OCR conversion: `apps/mobile/src/ocr/client.ts`

Fix: cache page images and OCR text by document ID, revision, and resolution,
with a size cap. Prefer on-demand pages over converting every page up front.

### 7. Transfer progress re-renders the whole document list

Relay progress updates the root `App`, and the documents screen remaps/filters
the full array on every render through `ScrollView + map`.

- State updates: `apps/mobile/App.tsx`
- List filtering/render: `Documents` in `apps/mobile/App.tsx`

Fix: isolate transfer subscription, memoize filter results, then virtualize
the list if document counts grow.

### 8. Desktop polls the full snapshot every 3 seconds even when nothing changed

Settings, inbox, and pairings are fetched together. A slow request can overlap
the next tick, and one failed request withholds the other two results.

- `apps/desktop/ui/src.tsx` (`refresh` interval)

Fix: prefer change events, keep polling as a fallback, prevent overlapping
refreshes, and isolate per-section failures.

## Optimistic-update policy

| Action | Feedback |
|---|---|
| Default PC selection, folder move | Update the screen immediately; roll back on failure |
| Name save | Show in-progress immediately; mark complete only after persistence |
| Send | Show queued immediately; never mark complete before receiver acknowledgement |
| File delete, unpair | Confirm, then show in-progress; do not remove first without a recovery path |

OCR and PDF tools already have busy-state and duplicate-action guards. The gap
is uneven completion across screens, not a missing pattern in the whole app.

## Verification recorded with this review

- Desktop JS tests: 6 passed
- Mobile JS tests: 17 passed
- No code was changed for this review
- No emulator or installed-app interaction pass was performed for these UX
  findings

Related incident: [`docs/incidents/2026-09-06-desktop-alias-save.md`](incidents/2026-09-06-desktop-alias-save.md)
records the duplicate-window investigation that preceded this review.
Duplicate-launch reuse is implemented separately and does not close finding 1.
