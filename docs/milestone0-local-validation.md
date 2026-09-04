# Milestone 0 local transfer validation

Date: 2026-09-04

This document records local validation of the EasyDoc transfer core. It is not a substitute for the required real-school-network test over deployed WSS/Cloudflare infrastructure and a Windows receiver.

## Scope exercised

The harness uses the same core components as the current PoC:

```text
file-backed mobile ChunkSource
  -> bounded TransferSender window
  -> RelayRoom binary forwarding
  -> desktop IncomingTransfer
  -> .part streaming write
  -> SHA-256 verification
  -> atomic final rename
```

The source file is read in chunks through `FileHandle.read()`. The receiver writes chunks directly to disk. The configured sender window is 8 MiB and the default transfer chunk size is 1 MiB.

## Command

```bash
npm run milestone0:file -- --size all
```

Individual cases are also available:

```bash
npm run milestone0:file -- --size 1mb
npm run milestone0:file -- --size 100mb
npm run milestone0:file -- --size 500mb
npm run milestone0:file -- --size 1gb
```

The harness labels use binary-sized payloads: 1 MiB, 100 MiB, 500 MiB, and 1 GiB.

## Results

| Payload | Chunks | Peak in-flight | SHA-256 | Result |
| --- | ---: | ---: | --- | --- |
| 1 MiB | 1 | 1 MiB | `631b84027d6b9e52b539c4e8373622d23032dfadc64d60af87339c9037e4f769` | Pass |
| 100 MiB | 100 | 8 MiB | `998fa39fe735dc4be63f55bf6ec3db8b64fe3d8fcd3fe759d1b88d27992c0b75` | Pass |
| 500 MiB | 500 | 8 MiB | `938244c786988f4b58f11be8f3a0199b2208d8447fed2c3c36f6401606c6705b` | Pass |
| 1 GiB | 1024 | 8 MiB | `e18e3f358b46eae9266ac36a5ff6347f6bf09711dff389597f237d5fe83111d8` | Pass |

All four runs completed with the destination checksum matching the source checksum.

## Automated coverage

`npm test` additionally covers:

- binary frame encoding/decoding and protocol-version rejection
- Korean/Unicode filenames
- invalid control messages
- session credential tamper/expiry rejection
- offline destination rejection
- QR pairing expiry, single-use semantics, tamper rejection, authorization and revoke
- bounded sender backpressure and cumulative acknowledgements
- explicit receiver interruption and durable resume
- duplicate chunk idempotency
- numbered filename collision handling
- low-disk rejection
- checksum mismatch without exposing a final file
- end-to-end interruption -> resume -> final checksum match
- file-backed chunk reads

## Still required on real infrastructure

The following Milestone 0 acceptance items remain external/integration work:

- deploy the Worker/Durable Object and exercise real `wss://` connections over port 443
- run the receiver inside an actual Tauri/Rust Windows application
- test phone and school PC on different networks
- validate the real school firewall/proxy behavior
- validate reconnect across an actual network interruption and process restart
- measure throughput and stability on the target machines
- finalize and verify the application-layer E2E encryption construction across React Native and Rust

These items must not be inferred as passing from the local harness results above.
