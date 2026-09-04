# EasyDoc Security Model

## Objectives

EasyDoc is intended to move potentially sensitive documents from a mobile device to a paired desktop while minimizing server-side exposure.

Security objectives:
- No plaintext document storage in the default relay path
- No server possession of device private keys
- Explicit device pairing
- Short-lived pairing credentials
- Authenticated encrypted transport
- End-to-end encrypted file payloads
- Integrity verification before finalizing files
- Minimal metadata retention

## Threat model

Protect against:
- Passive network observers
- Accidental relay-side document persistence
- Unauthorized devices attempting to join a room
- Reuse of expired pairing QR codes
- Corruption during interrupted transfers
- A relay operator reading file contents

MVP does not claim to protect a fully compromised mobile or desktop endpoint.

## Transport encryption

All network communication uses TLS:

```text
wss://...:443
```

TLS is mandatory but is not the only confidentiality layer.

## Application-layer E2E encryption

Document bytes are encrypted on the source device and decrypted only on the paired destination.

```text
Mobile plaintext
  → encrypt
  → ciphertext chunks
  → Cloudflare relay
  → ciphertext chunks
  → decrypt
  → Desktop file
```

The relay must not receive file decryption keys.

Do not implement custom cryptographic primitives. Use mature, audited platform/library implementations.

The concrete key-agreement and AEAD construction should be selected during implementation after verifying compatibility across React Native and Rust. Candidate classes include modern X25519-based key agreement and an authenticated encryption primitive such as AES-GCM or ChaCha20-Poly1305, but the exact construction must be documented before production use.

## Device identity

Each installation creates a device identity on first run.

Device record concept:

```ts
interface DeviceIdentity {
  deviceId: string
  publicKey: string
  privateKey: SecureHandle
}
```

Private key material must be stored using platform-appropriate protected storage.

Target storage:
- Android: Android Keystore-backed storage where available
- iOS: Keychain / Secure Enclave where applicable
- Windows: OS-protected credential/secret storage

Private keys are never uploaded to Cloudflare.

## Pairing

Desktop generates a single-use QR pairing payload.

Security requirements:
- Cryptographically random pairing token
- Short expiration target: about 5 minutes
- Single-use consumption
- Bind token to intended desktop/room identity
- Reject replay after successful pairing
- Allow explicit unpair/revoke

Do not encode long-lived private secrets directly in QR payloads.

## Authorization

Every WebSocket session must authenticate the device and requested room.

A valid room ID by itself is not sufficient authorization.

The relay must reject:
- Unknown device identities
- Revoked pairings
- Expired session credentials
- Device attempts to connect to unrelated rooms

## Metadata minimization

Default relay storage should avoid retaining:
- Original PDF bytes
- Page images
- OCR text
- Document body
- Plaintext file contents

Avoid long-term storage of filenames unless necessary. Transfer identifiers, device identifiers, protocol state and coarse operational telemetry may be retained only as required for reliability/abuse prevention.

Logging must never include document bytes or cryptographic secret material.

## Integrity

Each transfer carries a source checksum, initially SHA-256.

Desktop must only rename the temporary file to its final filename after the complete received plaintext matches the expected checksum.

On mismatch:
- Do not finalize the file
- Mark transfer failed
- Preserve diagnostic metadata without document content
- Allow retry

## Temporary files

During receive:

```text
filename.pdf.part
```

is not considered a completed document.

After successful verification, use an atomic rename where supported.

Cancelled or failed stale `.part` files require cleanup policy.

## Optional R2 offline queue

R2 is not required for MVP.

If added later:
- Encrypt the full object before upload
- R2 receives ciphertext only
- Server does not possess the decryption key
- Delete immediately after confirmed desktop receipt
- Add short lifecycle expiration as fallback cleanup
- Never silently enable cloud retention for users who selected direct-only transfer

## Local data

Both clients may store:
- Pairing relationships
- Transfer history
- Local file paths
- Retry state

Sensitive key material must not be stored as plaintext SQLite fields.

## Security validation before v1

Before production release:
- Threat-model review of pairing
- Verify token replay rejection
- Verify unpaired device rejection
- Verify expired credential rejection
- Verify ciphertext-only relay behavior
- Verify key persistence/revocation
- Verify checksum failure path
- Verify logs do not leak names/content/secrets
- Dependency audit
- Test malformed/oversized protocol frames
- Rate limiting / abuse controls on public relay endpoints
