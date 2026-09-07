# GenOffice EasyDoc Receiver Integration Plan

Date: 2026-09-07

## Decision

Integrate only the EasyDoc desktop capabilities that GenOffice actually needs:

1. pair a phone by QR,
2. maintain the paired phone session,
3. receive encrypted EasyDoc transfers,
4. write the completed file to local disk,
5. open the completed file in the existing GenOffice editor tab.

Do not port the current standalone EasyDoc desktop application wholesale. The GenOffice fork should remain a thin fork: EasyDoc-specific code lives in isolated packages and GenOffice shell changes stay limited to narrow lifecycle, IPC, and UI hooks.

The standalone Tauri receiver remains useful as a reference and fallback while the GenOffice integration is being validated, but it is not the target runtime for the integrated product.

## External GenOffice facts checked

As of 2026-09-07, upstream GenOffice is an Electron monorepo. `apps/shell` owns the home screen and tabbed hosting of Docs, Sheets, Slides, PDF, and Markdown. The shell main process already owns file-association routing and opening files into the appropriate editor. GenOffice documents its renderer as sandboxed and routes privileged filesystem/native operations through the Electron main process and validated IPC.

Relevant upstream locations confirmed from the current public repository:

- `apps/shell/src/main/index.ts` — shell lifecycle, single-instance handling, file routing, tab/editor integration
- `apps/shell/src/shared/home-api.ts` — typed shell/home API surface used by main/renderer code
- `apps/shell/src/shared/tabs-api.ts` — tab-related shell contract
- `apps/shell/src/renderer/src/SettingsModal.tsx` — shell settings UI
- existing shell preload bridge — exact upstream path should be bound when the fork checkout is created rather than hard-coded here

Upstream reference:

- https://github.com/genspark-ai/genoffice
- https://github.com/genspark-ai/genoffice/blob/main/apps/shell/src/main/index.ts
- https://github.com/genspark-ai/genoffice/blob/main/README.md

The current public feature list contains Genspark account device-code authentication, but no EasyDoc-style phone pairing and no mobile-to-desktop file receiver. Account device-code auth is unrelated to EasyDoc device pairing.

## Existing EasyDoc implementation inventory

### Reuse essentially unchanged

#### `packages/protocol/src/*`

Files:

- `packages/protocol/src/constants.ts`
- `packages/protocol/src/control.ts`
- `packages/protocol/src/frame.ts`
- `packages/protocol/src/pairing.ts`

Already provides the TypeScript wire contract for:

- pairing payloads,
- transfer start/accept/reject/ack/resume/complete/cancel messages,
- binary chunk framing,
- protocol validation,
- protocol versioning and chunk limits.

These are runtime-independent and are the correct source for the GenOffice receiver protocol.

Target in the GenOffice fork:

```text
packages/easydoc-protocol/
```

The source should initially remain byte-for-byte equivalent to the EasyDoc package. Compatibility tests should guard against divergence.

#### `packages/crypto/src/index.ts`

Already provides a pure TypeScript implementation of the production crypto protocol:

- X25519 device keys,
- ECDH shared secret,
- HKDF-SHA256 transfer-key derivation,
- XChaCha20-Poly1305 chunk encryption/decryption,
- the same nonce/AAD layout used by the existing Rust desktop receiver.

It uses Noble libraries and does not depend on Tauri or React Native.

Target in the GenOffice fork:

```text
packages/easydoc-crypto/
```

There is no reason to rewrite the crypto using Node's built-in crypto primitives. Reusing the existing implementation reduces interoperability risk.

#### `apps/desktop/src/receiver.ts`

This is already a Node-oriented TypeScript disk receiver. It implements:

- direct-to-disk `.part` writes,
- resumable metadata,
- duplicate-chunk idempotency,
- bounded chunk validation,
- free-space checking,
- SHA-256 verification,
- collision-safe final names,
- atomic final rename.

It has existing tests in:

```text
apps/desktop/test/receiver.test.ts
```

Target in the GenOffice fork:

```text
packages/easydoc-receiver/src/incoming-transfer.ts
```

Before moving it, align `safeFilename()` with the stricter Windows-safe rules in the Rust receiver so that the integrated receiver does not accept names that the existing production receiver rejects.

### Rewrite in TypeScript for Electron main process

The following production behavior currently exists inside `apps/desktop/src-tauri/src/lib.rs` and is Tauri/Rust-specific at the orchestration layer:

- secure desktop identity persistence,
- pairing issue request,
- pairing bootstrap-secret persistence,
- session-token refresh,
- pairing revoke,
- WebSocket connection/supervision,
- presence tracking,
- encrypted binary-frame receive loop,
- receiver reconnect loop,
- completion notification,
- Tauri command exposure.

Do not port the Tauri command structure. Re-express these operations as an Electron-main TypeScript service using the existing EasyDoc TypeScript protocol, crypto, and `IncomingTransfer` implementations.

Target package:

```text
packages/easydoc-receiver/
  src/
    index.ts
    client.ts
    incoming-transfer.ts
    pairing.ts
    storage.ts
    types.ts
```

Suggested responsibilities:

### `pairing.ts`

- `issuePairing()` -> `POST /pairing/issue`
- build QR payload including the GenOffice desktop alias
- `getSession()` -> `POST /pairing/session`
- `revokePairing()` -> `POST /pairing/revoke`
- build `wss://.../connect?token=...`

Use the existing relay API unchanged.

### `storage.ts`

Persist non-secret state under the GenOffice `userData` directory, for example:

```text
<GenOffice userData>/easydoc/pairings.json
<GenOffice userData>/easydoc/settings.json
```

Persist secrets encrypted with Electron `safeStorage` rather than exposing them to the renderer:

- desktop private key,
- pairing bootstrap secret.

The renderer must never receive either secret.

The first production target is Windows, where this maps cleanly to OS-backed encryption. Linux fallback behavior must fail clearly when secure storage is unavailable rather than silently storing plaintext secrets.

### `client.ts`

`DesktopRelayClient` owns one logical receiver connection per pairing and provides a small event-driven API:

```ts
start(): Promise<void>
stop(): Promise<void>
createPairing(): Promise<PairingView>
listPairings(): PairingSummary[]
revokePairing(roomId: string): Promise<void>
setReceiveDirectory(path: string): Promise<void>
```

Events:

```ts
state
pairingChanged
transferStarted
transferProgress
fileReceived
error
```

The receive loop should:

1. refresh a desktop session token,
2. connect to `/connect`,
3. parse relay presence/control messages,
4. validate `transfer:start` with `@easydoc/protocol`,
5. derive the transfer key with `@easydoc/crypto`,
6. decode each binary frame with `decodeChunkFrame()`,
7. decrypt it with `decryptChunk()`,
8. write plaintext through `IncomingTransfer`,
9. send cumulative ACKs,
10. on finalization send `transfer:complete`,
11. emit `fileReceived(finalPath)`.

Reconnect with a bounded delay after socket loss. Resume state remains disk-backed, so restarting GenOffice can continue an interrupted transfer.

### Do not port

The following standalone-desktop behavior should not be copied into the GenOffice fork for the first integration:

- Tauri command wrappers,
- Tauri tray lifecycle,
- Tauri single-instance plugin,
- EasyDoc standalone React shell,
- standalone Scan Inbox list,
- open/reveal/rename/print/delete UI,
- EasyDoc-specific window hiding,
- Tauri autostart plumbing.

GenOffice already owns the desktop lifecycle and document UI. Duplicating these features creates fork maintenance cost without adding the requested capability.

## GenOffice fork file-level changes

The exact renderer component hierarchy can change upstream, so only stable shell boundaries should be modified.

### New files: isolated EasyDoc packages

```text
packages/easydoc-protocol/          # copied/synced from EasyDoc packages/protocol
packages/easydoc-crypto/            # copied/synced from EasyDoc packages/crypto
packages/easydoc-receiver/          # Node/Electron receiver orchestration
```

These directories are EasyDoc-owned and should not require merge conflict resolution during normal upstream updates.

### `apps/shell/package.json`

Add workspace dependencies on the EasyDoc packages and the minimum transport/QR dependencies needed by the shell.

Avoid adding EasyDoc dependencies to editor apps. Only the unified shell should know about the receiver.

### `apps/shell/src/main/index.ts`

Keep this patch narrow.

Add three integration hooks:

1. construct/start `DesktopRelayClient` after the shell is ready,
2. register the EasyDoc IPC handlers,
3. handle `fileReceived(path)` by invoking the shell's existing file-open/tab-routing path.

Do not duplicate PDF opening logic. The receiver should emit a local file path and the existing GenOffice file router decides whether it belongs in PDF, Docs, Sheets, Slides, or Markdown.

The initial EasyDoc mobile flow currently produces PDF/image output, but using the general file router avoids coupling the integration to PDF forever.

### `apps/shell/src/shared/home-api.ts`

Add a minimal typed EasyDoc contract such as:

```ts
getEasyDocState()
createEasyDocPairing()
revokeEasyDocPairing(roomId)
chooseEasyDocReceiveDirectory()
setEasyDocAutoOpen(enabled)
```

And push events for:

```text
easydoc:state-changed
easydoc:file-received
```

Inputs must be validated in the main process. No arbitrary filesystem path write primitive should be exposed to the renderer.

### Existing shell preload bridge

Expose only the typed EasyDoc methods/events defined by the shared API. Do not expose Node, filesystem, WebSocket, crypto, or raw IPC access.

This preserves GenOffice's existing privilege-separation model.

### Shell home/settings renderer

First-version UI should be small:

```text
EasyDoc
Phone: Galaxy ...      Connected
Receive folder: ...
[Connect phone] [Manage]
```

`Connect phone` opens a QR dialog. `Manage` shows paired phones and revoke actions.

Optional setting:

```text
[x] Open received documents automatically
```

Do not build a second document inbox in GenOffice initially. GenOffice already has recent-file/document surfaces; after a received file is opened, it naturally enters the existing document workflow.

### QR rendering

QR generation belongs in the renderer from the non-secret short-lived pairing payload returned by main. The payload may be rendered using a small React QR dependency. Private keys and bootstrap secrets remain main-process-only.

## Completion behavior

Recommended default:

```text
EasyDoc Mobile
  -> existing relay
  -> GenOffice DesktopRelayClient
  -> encrypted chunk verification
  -> local atomic file finalize
  -> native notification
  -> GenOffice existing open-file router
  -> PDF/editor tab
```

If auto-open is disabled, finalize and notify without opening a tab.

The file must be opened only after SHA-256 verification and atomic rename succeed.

## What remains unchanged

No first-version changes are required to:

- `apps/mobile` pairing payload format,
- `apps/mobile` transfer sender,
- `apps/relay`,
- Durable Object routing,
- wire protocol,
- crypto format,
- QR deep-link format.

This is important for rollout: a current EasyDoc mobile build should be able to send to either the current Tauri receiver or the GenOffice receiver as long as both speak protocol v1.

## Source-to-target mapping

| EasyDoc source | GenOffice target | Action |
| --- | --- | --- |
| `packages/protocol/src/*` | `packages/easydoc-protocol/src/*` | Reuse/sync |
| `packages/crypto/src/index.ts` | `packages/easydoc-crypto/src/index.ts` | Reuse/sync |
| `apps/desktop/src/receiver.ts` | `packages/easydoc-receiver/src/incoming-transfer.ts` | Move/adapt; harden filename validation |
| `apps/desktop/test/receiver.test.ts` | `packages/easydoc-receiver/test/incoming-transfer.test.ts` | Reuse |
| `apps/desktop/src-tauri/src/lib.rs` pairing/session portions | `packages/easydoc-receiver/src/pairing.ts` | Rewrite in TS |
| `apps/desktop/src-tauri/src/lib.rs` receiver loop/supervisor | `packages/easydoc-receiver/src/client.ts` | Rewrite in TS using shared protocol/crypto |
| Rust `keyring` usage | `packages/easydoc-receiver/src/storage.ts` | Replace with Electron `safeStorage` adapter |
| Tauri notification | GenOffice shell main | Replace with Electron `Notification` |
| Tauri `open_path` | GenOffice existing shell open-file routing | Do not port; hook existing path |
| `apps/desktop/ui/src.tsx` pairing UI | GenOffice shell home/settings renderer | Rebuild using GenOffice UI/tokens |
| EasyDoc tray/single-instance/autostart | none | Do not port |

## Thin-fork constraints

To keep upstream upgrades cheap:

1. never modify GenOffice editor internals for EasyDoc receiving,
2. keep protocol/crypto/receiver logic under new EasyDoc-owned package directories,
3. keep `apps/shell/src/main/index.ts` changes to imports + lifecycle/hooks,
4. keep renderer changes to one EasyDoc card/dialog and one settings section,
5. do not change GenOffice's existing file-open implementation,
6. do not reuse Genspark account authentication for EasyDoc pairing,
7. add automated upstream-sync PRs rather than merging upstream directly into the production branch.

A future upstream shell refactor should therefore require adapting only the shell adapter layer, not the receiver core.

## Verification gates

### Unit

- protocol parser/frame tests unchanged,
- crypto interoperability tests unchanged,
- `IncomingTransfer` tests moved unchanged where possible,
- pairing/session HTTP client tests with a mock relay,
- secure-storage serialization tests,
- receiver control-loop tests for accept/ack/resume/complete,
- destination mismatch and malformed-frame rejection.

### Cross-implementation interoperability

Required before replacing the Tauri receiver:

- EasyDoc mobile -> Tauri receiver,
- EasyDoc mobile -> GenOffice receiver,
- identical transfer key test vectors for Rust and TypeScript,
- 1 MB / 100 MB / 500 MB / 1 GB files,
- Korean filenames,
- duplicate filenames,
- network interruption/resume,
- GenOffice restart/resume,
- checksum mismatch,
- low disk space.

### GenOffice integration

- QR created from shell,
- existing EasyDoc mobile pairs without mobile changes,
- paired phone reconnects after GenOffice restart,
- received PDF opens in a GenOffice PDF tab after integrity verification,
- auto-open off leaves the verified file on disk without opening a tab,
- renderer cannot access private key/bootstrap secret,
- source-build and packaged Windows build both work.

## Implementation sequence

Use small commits so the GenOffice fork remains easy to rebase.

1. `chore(easydoc): add protocol and crypto packages`
2. `feat(easydoc): add node incoming transfer core`
3. `feat(easydoc): add pairing storage and relay receiver client`
4. `feat(shell): bridge EasyDoc receiver into main process`
5. `feat(shell): add phone pairing and receiver UI`
6. `test(easydoc): add mobile-to-genoffice interoperability coverage`
7. `ci: add upstream sync and EasyDoc integration gates`

Do not delete the standalone EasyDoc Tauri receiver until step 6 passes on a packaged Windows build and the real target network.

## Final architecture

```text
EasyDoc Mobile
   |
   | protocol v1 / E2E encrypted WSS
   v
EasyDoc Relay (unchanged)
   |
   v
GenOffice shell main process
   |
   +-- @easydoc/protocol
   +-- @easydoc/crypto
   +-- @easydoc/receiver
   |
   +-- verified local file
          |
          v
   GenOffice existing open-file router
          |
          +-- PDF
          +-- Docs
          +-- Sheets
          +-- Slides
          +-- Markdown
```

This is the preferred integration: the EasyDoc desktop transport becomes a GenOffice shell capability, while GenOffice remains responsible for document editing and presentation.