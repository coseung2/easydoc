import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { deriveTransferKey, encryptChunk, generateDeviceKeyPair } from '@easydoc/crypto'
import { encodeChunkFrame, type TransferStartMessage } from '@easydoc/protocol'
import {
  DesktopRelayClient,
  type ReceiverSocket,
  type ReceiverSocketFactory,
} from '../src/client.ts'
import { EasyDocStore, type SecretProtector } from '../src/storage.ts'
import type { FetchLike } from '../src/pairing.ts'
import type { FileReceivedEvent } from '../src/types.ts'

class TestProtector implements SecretProtector {
  isAvailable(): boolean {
    return true
  }
  protect(value: string): string {
    return Buffer.from(value, 'utf8').toString('base64')
  }
  unprotect(value: string): string {
    return Buffer.from(value, 'base64').toString('utf8')
  }
}

class FakeSocket extends EventEmitter implements ReceiverSocket {
  readyState = 0
  readonly sent: string[] = []

  constructor() {
    super()
    queueMicrotask(() => {
      this.readyState = 1
      this.emit('open')
    })
  }

  send(data: string | Uint8Array): void {
    this.sent.push(typeof data === 'string' ? data : Buffer.from(data).toString('hex'))
  }

  close(): void {
    if (this.readyState === 3) return
    this.readyState = 3
    queueMicrotask(() => this.emit('close'))
  }

  receiveJson(value: unknown): void {
    this.emit('message', JSON.stringify(value), false)
  }

  receiveBinary(value: Uint8Array): void {
    this.emit('message', Buffer.from(value), true)
  }
}

const jsonResponse = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('wait_timeout')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function withTempDir(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'easydoc-client-'))
  try {
    await run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('pairs a phone and receives an encrypted transfer through the Node receiver stack', () =>
  withTempDir(async (directory) => {
    const mobileIdentity = generateDeviceKeyPair()
    let desktopPublicKey = ''
    const fetchImpl: FetchLike = async (url, init) => {
      if (url.endsWith('/pairing/issue')) {
        const body = JSON.parse(String(init?.body)) as { desktopId: string; publicKey: string }
        desktopPublicKey = body.publicKey
        return jsonResponse({
          pairing: {
            version: 1,
            desktopId: body.desktopId,
            roomId: 'room-1',
            publicKey: body.publicKey,
            pairingToken: 'pair-token',
            expiresAt: Date.now() + 60_000,
          },
          desktopSecret: 'desktop-secret',
        })
      }
      if (url.endsWith('/pairing/session')) {
        return jsonResponse({
          token: 'session-token',
          peerPublicKey: mobileIdentity.publicKey,
          peerDeviceId: 'phone-1',
        })
      }
      if (url.endsWith('/pairing/revoke')) return jsonResponse({ ok: true })
      return jsonResponse({ error: 'not_found' }, 404)
    }

    let socket: FakeSocket | undefined
    const socketFactory: ReceiverSocketFactory = () => {
      socket = new FakeSocket()
      return socket
    }
    const receiveDir = path.join(directory, 'received')
    const store = new EasyDocStore(
      path.join(directory, 'state'),
      {
        relayBaseUrl: 'https://relay.example',
        receiveDir,
        desktopAlias: 'GenOffice PC',
        autoOpen: true,
      },
      new TestProtector(),
    )
    const client = new DesktopRelayClient({
      store,
      fetchImpl,
      socketFactory,
      reconnectDelayMs: 5,
      connectTimeoutMs: 500,
    })
    const faults: Error[] = []
    client.onError((error) => faults.push(error))
    let received: FileReceivedEvent | undefined
    client.onFileReceived((event) => {
      received = event
    })

    await client.start()
    const pairing = await client.createPairing()
    assert.match(pairing.qrPayload, /^easydoc:\/\/pair\?payload=/u)
    await waitFor(() => Boolean(socket && client.snapshot().pairings[0]?.connected))

    const desktop = client.snapshot().pairings[0]!
    assert.equal(desktop.mobileId, 'phone-1')
    assert.ok(desktopPublicKey)

    const bytes = new TextEncoder().encode('encrypted scan payload')
    const transferId = '123e4567-e89b-42d3-a456-426614174000'
    const meta: TransferStartMessage = {
      type: 'transfer:start',
      transferId,
      destinationDeviceId: desktop.deviceId,
      name: '스캔 문서.pdf',
      size: bytes.byteLength,
      mime: 'application/pdf',
      sha256: createHash('sha256').update(bytes).digest('hex'),
      chunkSize: bytes.byteLength,
    }
    socket!.receiveJson(meta)
    await waitFor(() => socket!.sent.some((message) => message.includes('transfer:accept')))

    const key = deriveTransferKey(mobileIdentity.secretKey, desktopPublicKey, transferId)
    const encrypted = encryptChunk(key, transferId, 0, bytes)
    socket!.receiveBinary(encodeChunkFrame({ transferId, chunkIndex: 0, payload: encrypted }))

    await waitFor(() => Boolean(received))
    assert.equal(received?.filename, '스캔 문서.pdf')
    assert.deepEqual(await readFile(received!.path), Buffer.from(bytes))
    assert.ok(socket!.sent.some((message) => message.includes('transfer:ack')))
    assert.ok(socket!.sent.some((message) => message.includes('transfer:complete')))
    assert.deepEqual(faults, [])

    await client.stop()
  }))
