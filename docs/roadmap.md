# EasyDoc Roadmap

## Milestone 0 — Network transfer PoC

Goal: prove the highest-risk path on the actual school network before building the full scanner product.

Deliverables:
- Cloudflare Worker + Durable Object relay skeleton
- Minimal Tauri Windows receiver
- Minimal mobile/test sender
- Secure outbound WebSocket connections over 443
- Chunked binary streaming
- Direct-to-disk `.part` writes
- SHA-256 verification
- Reconnect/resume
- Basic QR pairing

Acceptance tests:
- Different mobile and PC networks
- School PC on wired network
- No inbound port configuration
- 1 MB, 100 MB, 500 MB and 1 GB files
- Mid-transfer disconnect and resume
- Korean filename round-trip
- Duplicate filename handling
- Low disk-space failure

## Milestone 1 — Scanner MVP

Mobile:
- Document camera
- Edge detection
- Perspective correction
- Crop/rotate
- Color, grayscale, B&W
- Multi-page capture
- Page reorder/delete/retake
- PDF generation
- Local document storage
- Pairing destination UI
- Send-to-PC flow

Desktop:
- Background startup
- System tray
- Configurable save folder
- Native completion notification
- Minimal Scan Inbox

## Milestone 2 — Reliable daily workflow

Transfer:
- E2E encryption hardening and interoperability review
- Robust resume across app restarts
- Multiple paired PCs
- Auto-send default destination
- Better error recovery and diagnostics

Desktop:
- Rich Scan Inbox
- Rename/delete/print
- Reveal in folder
- Drag-and-drop to other applications/browser upload controls
- Folder profiles

Mobile:
- Recent transfers
- Transfer queue management
- Destination presence
- Automatic retry when desktop returns online

## Milestone 3 — PDF tools

- Merge PDFs
- Split PDFs
- Images → PDF
- PDF → images
- Reorder/delete/rotate pages
- Compression
- Searchable-PDF authoring
- Signature
- Watermark
- Password protection

## Milestone 4 — Document workspace

Read-first support for:
- HWP/HWPX
- DOC/DOCX
- XLS/XLSX
- PPT/PPTX

This milestone requires separate format-rendering research and fidelity/licensing decisions. It must not block scanner/transfer delivery.

## Milestone 5 — Presentation mode

- Full-screen presentation
- Slide/page navigation
- Thumbnail strip
- Laser pointer
- Pen
- Presenter notes
- Timer

## Milestone 6 — Optional offline cloud queue

Add only if users need to send while the desktop is offline.

- Mobile-side encryption
- Temporary encrypted R2 object
- Desktop download when online
- Immediate delete after receipt
- Short lifecycle expiration fallback
- User-visible retention setting

## Milestone 7 — Desktop-initiated scan request

Desktop action:

```text
Scan with phone
```

Flow:
- Desktop creates a scan request
- Mobile receives the request
- User opens scanner
- Completed scan automatically routes back to requesting desktop/folder

## Product principle

Optimize for this recurring outcome:

```text
Take the photo on the phone → the usable document is already on the PC.
```

Avoid adding heavy Office-style editing until the transfer/scanner workflow is demonstrably reliable and useful.
