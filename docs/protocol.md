# EasyDoc Transfer Protocol

## Goals

The transfer protocol must support:
- Large files without whole-file buffering
- Mobile → desktop delivery through Cloudflare over outbound WSS connections
- Resume after temporary network interruption
- Backpressure
- Integrity verification
- End-to-end encrypted payloads
- Multiple simultaneous logical transfers in the future

## Transport

MVP transport:

```text
Mobile WebSocket
  → Cloudflare Worker / Durable Object
  → Desktop WebSocket
```

Both endpoints connect using secure WebSockets over port 443.

The relay forwards control messages and encrypted binary frames. It must not interpret plaintext document content.

## Message classes

Two message classes are used:

1. JSON control messages
2. Binary data frames

## Transfer start

Mobile sends:

```json
{
  "type": "transfer:start",
  "transferId": "uuid",
  "destinationDeviceId": "device-id",
  "name": "document.pdf",
  "size": 18827231,
  "mime": "application/pdf",
  "sha256": "hex-digest",
  "chunkSize": 1048576
}
```

Desktop may respond with:

```json
{
  "type": "transfer:accept",
  "transferId": "uuid",
  "resumeFromChunk": 0
}
```

or:

```json
{
  "type": "transfer:reject",
  "transferId": "uuid",
  "reason": "insufficient_space"
}
```

## Chunking

Initial target chunk size:

```text
1 MiB
```

The exact value is configuration, not protocol identity. It may be tuned after real school-network tests.

A binary frame conceptually contains:

```text
protocol version
message type
transfer id
chunk index
payload length
encrypted payload
```

The concrete binary encoding should use fixed-width fields where practical and avoid JSON/base64 for document bytes.

## Flow control

Do not continuously enqueue an entire file into WebSocket buffers.

Use a bounded in-flight window.

Initial target:

```text
8–16 MiB in flight
```

Desktop periodically returns a cumulative acknowledgement:

```json
{
  "type": "transfer:ack",
  "transferId": "uuid",
  "receivedThroughChunk": 15
}
```

Mobile only advances the send window after acknowledgement.

The implementation must additionally observe transport-level buffered amount / writable readiness where available.

## Desktop write strategy

The destination writes to:

```text
filename.pdf.part
```

as chunks arrive.

Requirements:
- Stream bytes directly to disk
- Do not hold the full document in RAM
- Persist enough transfer metadata to determine resumable progress
- Flush at sensible checkpoints
- Only expose the final filename after integrity verification

Completion path:

```text
receive final chunk
  → flush/close .part
  → calculate/finish SHA-256
  → compare expected digest
  → atomic rename
  → send transfer:complete
```

## Resume

If a connection disappears, the transfer enters an interrupted state rather than immediately failing.

After reconnection, desktop reports its durable receive position:

```json
{
  "type": "transfer:resume",
  "transferId": "uuid",
  "receivedThroughChunk": 134
}
```

Mobile resumes at chunk 135.

The implementation must be safe when an acknowledgement was lost. Duplicate chunks must not corrupt the destination file.

A simple MVP rule is to only accept the next expected chunk index and acknowledge the highest contiguous chunk written.

## Completion

Desktop sends:

```json
{
  "type": "transfer:complete",
  "transferId": "uuid",
  "bytes": 18827231,
  "sha256": "hex-digest"
}
```

Mobile only marks the transfer completed after receiving this message.

## Cancellation

Either endpoint may send:

```json
{
  "type": "transfer:cancel",
  "transferId": "uuid"
}
```

Desktop may retain or remove a `.part` file according to resumability policy. User-initiated permanent cancellation should remove temporary partial data.

## Errors

Control errors use stable machine-readable codes. Initial set:

- `destination_offline`
- `pairing_invalid`
- `transfer_not_found`
- `insufficient_space`
- `write_failed`
- `checksum_mismatch`
- `unsupported_protocol`
- `cancelled`
- `relay_unavailable`

Human-readable localized strings belong in the client applications, not the wire protocol.

## Compatibility

Every connection and pairing payload carries a protocol version.

Breaking wire-format changes increment the major protocol version. Clients should fail clearly rather than silently misinterpreting frames.

## Milestone 0 test matrix

Test at minimum:
- 1 MB
- 100 MB
- 500 MB
- 1 GB
- phone network change during transfer
- desktop network interruption
- relay reconnection
- duplicate chunk attempt
- dropped acknowledgement
- checksum mismatch
- Korean filenames
- long filenames
- low disk space
- destination restart
