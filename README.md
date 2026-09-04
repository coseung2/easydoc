# EasyDoc

EasyDoc is a mobile-first document workflow for scanning, viewing, transferring, and presenting documents without the usual "scan on phone → send to messenger → download on PC" loop.

## Product goal

The primary workflow is:

```text
Phone scan
  → automatic crop / correction
  → PDF generation
  → encrypted transfer through Cloudflare
  → automatic save on the paired Windows PC
  → open / attach / drag-and-drop
```

The relay is designed to **forward document bytes without permanently storing the document** during the normal online transfer path.

## Planned applications

```text
apps/
  mobile/   React Native + Expo
  desktop/  Tauri + React + Rust
  relay/    Cloudflare Workers + Durable Objects

packages/
  protocol/ shared transfer protocol
  crypto/   end-to-end encryption helpers
  types/    shared domain types
```

## Core features

### Mobile
- Document scanning with edge detection, crop, perspective correction, rotation, filters, and multi-page capture
- PDF generation and local document library
- PDF/image viewing
- HWP/HWPX and Office document viewing in later milestones
- Presentation mode for PDF/PPT-style documents
- Automatic transfer to a paired desktop

### Desktop
- Background receiver and system tray app
- Scan Inbox
- Configurable auto-save folder
- Windows notifications
- Open / reveal in folder / rename / print / delete
- Drag-and-drop received files into browsers and other desktop apps

### Transfer
- QR-based device pairing
- Outbound WSS connections from both mobile and desktop
- Cloudflare Worker + Durable Object relay
- Chunked binary streaming
- Backpressure / acknowledgement window
- Reconnect and resume
- SHA-256 integrity verification
- Application-layer E2E encryption in addition to TLS
- Mobile-local queue while the desktop is offline
- Optional encrypted R2 temporary queue in a later milestone

## Architecture

```text
┌──────────────────────┐
│ React Native / Expo  │
│ Mobile               │
└──────────┬───────────┘
           │ WSS :443
           │ encrypted chunks
           ▼
┌──────────────────────┐
│ Cloudflare Worker    │
│ + Durable Object     │
│ routing / presence   │
│ streaming relay      │
└──────────┬───────────┘
           │ WSS :443
           ▼
┌──────────────────────┐
│ Tauri / Rust         │
│ Desktop Companion    │
└──────────┬───────────┘
           ▼
      Local filesystem
```

No Supabase dependency is planned for the MVP.

## Milestone 0 — transfer PoC

Before building the scanner UI, prove the highest-risk path in a real school network:

1. Install a minimal Tauri receiver on a Windows school PC.
2. Keep an outbound secure WebSocket connection to the Cloudflare relay.
3. Send test files from a phone on a different network through the relay.
4. Successfully transfer files from small documents up to a 1 GB test file.
5. Write chunks directly to a `.part` file on disk.
6. Verify SHA-256 before the atomic rename to the final filename.
7. Interrupt networking mid-transfer and confirm reconnect/resume works.
8. Validate behavior behind the actual school firewall/proxy.

Only after this path is reliable do we integrate the document scanner and final UI.

## Design

Current mobile UI concept:

https://www.figma.com/design/5MfLOkXkbNevPnnwD0gQe4

## Status

Planning / architecture phase.
