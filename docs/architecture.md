# EasyDoc Architecture

## Overview

EasyDoc is split into three runtime applications and shared packages.

```text
apps/
  mobile/   React Native + Expo
  desktop/  Tauri + React + Rust
  relay/    Cloudflare Workers + Durable Objects

packages/
  protocol/
  crypto/
  types/
  utils/
```

The design goal is to remove the common workflow of scanning on a phone, sending the file through a messenger, downloading it again on a desktop, and then attaching it to another system.

The default online transfer path is streaming-only: the relay forwards encrypted bytes from the phone to the paired desktop without permanently storing the document.

## Runtime topology

```text
Mobile App
  │
  │ WSS :443
  │ application-layer encrypted chunks
  ▼
Cloudflare Worker
  │
  ▼
Durable Object room
  │
  │ WSS :443
  ▼
Desktop Companion
  │
  ▼
Local filesystem
```

Both endpoints create outbound connections. This avoids requiring the school PC to accept inbound connections, open ports, or share the phone's network.

## Mobile application

Technology:
- React Native
- Expo development build / EAS
- SQLite for local documents and transfer state
- Secure device key storage through platform APIs

Responsibilities:
- Scan and process pages
- Generate PDF output
- Store documents locally
- Pair with one or more desktop devices
- Queue transfers
- Stream encrypted chunks
- Resume interrupted transfers
- Show destination presence and transfer progress

## Desktop application

Technology:
- Tauri
- Rust core
- React + TypeScript UI
- SQLite for device and transfer state

Responsibilities:
- Start with Windows and remain available through the system tray
- Maintain an outbound WebSocket to the relay
- Receive and decrypt transfers
- Stream chunks directly to a `.part` file
- Verify checksum before finalizing
- Atomically rename the completed file
- Maintain the Scan Inbox
- Show native notifications
- Support open, reveal, rename, print, delete and drag-and-drop workflows

## Cloudflare relay

Technology:
- Cloudflare Workers
- Durable Objects
- Optional R2 in a later milestone

### Worker responsibilities
- Route requests to the correct Durable Object room
- Validate pairing/session credentials
- Upgrade WebSocket connections
- Expose minimal health and pairing endpoints

### Durable Object responsibilities
- Maintain a room for paired devices
- Track connected mobile/desktop sockets
- Expose presence state
- Relay JSON control messages
- Relay binary transfer chunks
- Apply flow control and disconnect handling

The Durable Object must not persist original PDFs, page images, OCR text, or plaintext document content during normal live transfer.

## Storage policy

### Default path
- Mobile keeps the source document locally.
- Relay stores no document body.
- Desktop writes directly to local disk.

### Desktop offline
For MVP, the mobile keeps the transfer queued locally until the desktop returns online.

### Optional later path
R2 may be used for temporary encrypted objects when the user explicitly enables offline cloud queueing.

Requirements for that mode:
- Encrypt on the mobile before upload.
- Cloudflare must not receive the decryption key.
- Delete after successful desktop download.
- Configure a short retention policy / TTL as a second safety net.

## Pairing model

The MVP does not require an account system.

Each device creates a local identity and asymmetric key material on first launch.

Desktop displays a short-lived QR code containing data conceptually equivalent to:

```json
{
  "version": 1,
  "desktopId": "device_xxx",
  "roomId": "room_xxx",
  "publicKey": "...",
  "pairingToken": "...",
  "expiresAt": 0
}
```

The pairing token must be single-use and short-lived.

Private keys never leave their originating device.

## Transfer lifecycle

```text
CREATED
  ↓
WAITING_FOR_PC
  ↓
CONNECTING
  ↓
NEGOTIATING
  ↓
TRANSFERRING
  ↓
VERIFYING
  ↓
COMPLETED
```

Interruption path:

```text
TRANSFERRING
  ↓
INTERRUPTED
  ↓
RECONNECTING
  ↓
TRANSFERRING
```

Terminal alternatives:
- FAILED
- CANCELLED

## Highest-risk assumption

The first engineering milestone must validate this path in the actual school network:

```text
Phone on LTE/5G
  → Cloudflare
  → Windows school PC on wired network
```

The PoC is successful only if large transfers remain stable, interruption/resume works, and the school firewall/proxy permits the required outbound secure WebSocket traffic.
