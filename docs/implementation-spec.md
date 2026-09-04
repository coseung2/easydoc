# EasyDoc Implementation Specification

## 1. Product definition

EasyDoc is a mobile-first document workflow that connects document scanning, document viewing and desktop handoff.

Primary UX target:

```text
Scan on phone
  → correct/crop
  → generate PDF
  → transfer automatically
  → file appears on paired Windows PC
```

The application should eliminate messenger/email/USB handoff for routine scanning workflows.

## 2. MVP scope

### Mobile
- Document capture
- Edge detection / crop
- Perspective correction
- Rotate
- Color / grayscale / B&W
- Multi-page capture
- Reorder / delete / retake pages
- Generate PDF
- Local save
- Pair to one desktop via QR
- Transfer queue and progress

### Desktop
- Tauri app
- Background receiver
- System tray
- Configurable receive folder
- `.part` streaming write
- SHA-256 verification
- Atomic final rename
- Native notification
- Minimal Scan Inbox

### Relay
- Cloudflare Worker
- Durable Object room
- WebSocket connections over 443
- Presence
- Control messages
- Binary stream relay
- Chunk acknowledgements
- Reconnect support

## 3. Mobile navigation

Bottom navigation:

- Home
- Documents
- Scan
- Tools
- Settings

Home quick actions:

- Document Scan
- Open File
- Presentation
- PDF Tools

Current design reference:
https://www.figma.com/design/5MfLOkXkbNevPnnwD0gQe4

## 4. Scanner data model

```ts
export interface ScannedDocument {
  id: string
  title: string
  pages: ScannedPage[]
  createdAt: number
}

export interface ScannedPage {
  id: string
  imageUri: string
  width: number
  height: number
  rotation: number
  filter: "color" | "gray" | "bw"
}
```

Suggested local layout:

```text
app-data/
  scans/
    {documentId}/
      page_001.jpg
      page_002.jpg
      document.pdf
```

A successful desktop transfer does not automatically delete the local source.

## 5. Document viewer scope

Initial viewer work should be read-oriented.

Target formats:
- PDF
- Images
- TXT
- HWP/HWPX
- DOC/DOCX
- XLS/XLSX
- PPT/PPTX

PDF v1:
- Page scrolling
- Zoom
- Thumbnail navigation
- Page jump
- Text search when supported
- Share
- Transfer to desktop

Later:
- Pen
- Highlight
- Notes
- Signature
- Bookmarks

HWP/HWPX and Office fidelity must be treated as a separate implementation/research track rather than blocking the scanner-transfer MVP.

## 6. PDF tools

MVP/early v1:
- Merge
- Split
- Images to PDF
- PDF to images
- Rotate pages
- Delete pages
- Reorder pages
- Compress

Later:
- OCR
- Searchable PDF
- Signature
- Watermark
- Password protection

## 7. Presentation

Initial:
- Full screen
- Previous/next page or slide
- Thumbnail strip
- Current/total indicator

Later:
- Laser pointer
- Pen
- Presenter notes
- Timer

## 8. Desktop application

The desktop app is primarily a background companion.

Startup path:

```text
Windows login
  → EasyDoc starts
  → tray icon
  → relay WebSocket connects
```

Default receive directory:

```text
Documents/EasyDoc
```

The user may configure another directory, including school-work folders.

Filename collision policy defaults to numbered copies:

```text
scan.pdf
scan (1).pdf
scan (2).pdf
```

Settings should eventually allow:
- Auto-number
- Replace
- Ask each time

## 9. Desktop Scan Inbox

Each entry should expose:
- Filename
- Size
- Arrival time
- Transfer status
- Open
- Reveal in folder
- Rename
- Print
- Delete

A received file should also be draggable from the app into compatible desktop/browser file targets.

## 10. Pairing

MVP is accountless.

Desktop creates a QR code. Mobile scans it once and stores the paired destination securely.

Conceptual QR payload:

```ts
interface PairingPayload {
  version: 1
  desktopId: string
  roomId: string
  publicKey: string
  pairingToken: string
  expiresAt: number
}
```

Requirements:
- Short expiration, target ~5 minutes
- Pairing token is single-use
- Private keys remain device-local
- Pairing can be revoked from both endpoints

## 11. Presence

Mobile destination UI must be able to display:

```text
School PC  ● Online
Home PC    ○ Offline
```

For MVP, presence is derived from active Durable Object WebSocket connections.

## 12. Transfer status model

```ts
export type TransferStatus =
  | "waiting"
  | "connecting"
  | "transferring"
  | "verifying"
  | "completed"
  | "failed"
  | "cancelled"

export interface Transfer {
  id: string
  sourceDeviceId: string
  destinationDeviceId: string
  filename: string
  mimeType: string
  totalBytes: number
  transferredBytes: number
  checksum: string
  status: TransferStatus
  createdAt: number
  completedAt?: number
}
```

## 13. Offline behavior

MVP:

```text
Desktop offline
  → transfer remains queued on mobile
  → mobile observes destination return online
  → transfer retries automatically
```

Do not require R2 for MVP.

Optional later behavior:
- Encrypt locally
- Upload encrypted temporary object to R2
- Desktop downloads when online
- Delete immediately after successful receipt
- TTL cleanup as fallback

## 14. Recommended development order

1. Shared protocol package
2. Cloudflare relay
3. Tauri receiver
4. Mobile dummy-file sender
5. QR pairing
6. Large-file test
7. Reconnect/resume
8. Scanner integration
9. PDF generation
10. Final UI integration

This order intentionally validates network transport before scanner polish.

## 15. Milestone 0 acceptance criteria

The transport PoC is complete when all of the following pass on the actual school PC/network:

- Phone and PC are on different networks
- PC requires no inbound port opening
- Secure outbound connection succeeds
- 1 MB transfer succeeds
- 100 MB transfer succeeds
- 500 MB transfer succeeds
- 1 GB test transfer succeeds
- File is streamed to disk, not buffered fully in memory
- Mid-transfer network interruption can recover
- Final SHA-256 matches source
- Korean/Unicode filenames survive round-trip
- Duplicate filenames are handled safely
- Low disk space produces a clear failure
- PC restart/reconnect behavior is understood and documented
