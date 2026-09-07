import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import WebSocket from 'ws'
import { decryptChunk, deriveTransferKey, generateDeviceKeyPair } from '@easydoc/crypto'
import {
  decodeChunkFrame,
  parseTransferControlMessage,
  type TransferErrorCode,
  type TransferStartMessage,
} from '@easydoc/protocol'
import { IncomingTransfer } from './incoming-transfer.ts'
import {
  buildRelayWebSocketUrl,
  getDesktopSession,
  issuePairing,
  revokeRemotePairing,
  type FetchLike,
} from './pairing.ts'
import { EasyDocStore } from './storage.ts'
import type {
  FileReceivedEvent,
  PairingSummary,
  PairingView,
  ReceiverSnapshot,
  StoredDesktopPairing,
  TransferProgressEvent,
} from './types.ts'

export interface ReceiverSocket {
  readonly readyState: number
  on(event: 'open', listener: () => void): this
  on(event: 'close', listener: () => void): this
  on(event: 'error', listener: (error: Error) => void): this
  on(event: 'message', listener: (data: unknown, isBinary: boolean) => void): this
  send(data: string | Uint8Array): void
  close(): void
}

export type ReceiverSocketFactory = (url: string) => ReceiverSocket

type ReceiverStatus = {
  authorized: boolean
  connected: boolean
  error?: string
}

type ActiveTransfer = {
  meta: TransferStartMessage
  key: Uint8Array
  receiver: IncomingTransfer
}

type PairingTask = {
  roomId: string
  stopped: boolean
  socket?: ReceiverSocket
  wake?: () => void
  promise?: Promise<void>
}

export type DesktopRelayClientOptions = {
  store: EasyDocStore
  fetchImpl?: FetchLike
  socketFactory?: ReceiverSocketFactory
  reconnectDelayMs?: number
  connectTimeoutMs?: number
}

const DEFAULT_RECONNECT_DELAY_MS = 3_000
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000

function errorCode(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function transferError(error: unknown): TransferErrorCode {
  const code = errorCode(error)
  switch (code) {
    case 'destination_offline':
    case 'pairing_invalid':
    case 'transfer_not_found':
    case 'insufficient_space':
    case 'write_failed':
    case 'checksum_mismatch':
    case 'unsupported_protocol':
    case 'cancelled':
    case 'relay_unavailable':
      return code
    default:
      return 'write_failed'
  }
}

function rawText(data: unknown): string {
  if (typeof data === 'string') return data
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8')
  }
  if (Array.isArray(data))
    return Buffer.concat(data.map((part) => Buffer.from(part))).toString('utf8')
  return String(data)
}

function rawBytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  if (Array.isArray(data)) return Buffer.concat(data.map((part) => Buffer.from(part)))
  throw new Error('invalid_payload_length')
}

function defaultSocketFactory(url: string): ReceiverSocket {
  return new WebSocket(url) as unknown as ReceiverSocket
}

export class DesktopRelayClient {
  private readonly events = new EventEmitter()
  private readonly fetchImpl: FetchLike
  private readonly socketFactory: ReceiverSocketFactory
  private readonly reconnectDelayMs: number
  private readonly connectTimeoutMs: number
  private readonly tasks = new Map<string, PairingTask>()
  private readonly statuses = new Map<string, ReceiverStatus>()
  private readonly options: DesktopRelayClientOptions
  private running = false

  constructor(options: DesktopRelayClientOptions) {
    this.options = options
    this.fetchImpl = options.fetchImpl ?? fetch
    this.socketFactory = options.socketFactory ?? defaultSocketFactory
    this.reconnectDelayMs = options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
  }

  async start(): Promise<void> {
    if (this.running) return
    await this.options.store.load()
    this.running = true
    for (const pairing of this.options.store.listPairings()) this.ensureSupervisor(pairing.roomId)
    this.emitState()
  }

  async stop(): Promise<void> {
    if (!this.running && this.tasks.size === 0) return
    this.running = false
    const tasks = [...this.tasks.values()]
    for (const task of tasks) {
      task.stopped = true
      task.wake?.()
      try {
        task.socket?.close()
      } catch {
        // The connection loop will finish through its normal close/error path.
      }
    }
    await Promise.allSettled(tasks.map((task) => task.promise).filter(Boolean) as Promise<void>[])
    this.tasks.clear()
    for (const status of this.statuses.values()) status.connected = false
    this.emitState()
  }

  snapshot(): ReceiverSnapshot {
    const settings = this.options.store.getSettings()
    const pairings = this.options.store.listPairings().map((pairing) => this.summary(pairing))
    return { settings, pairings }
  }

  onState(listener: (snapshot: ReceiverSnapshot) => void): () => void {
    this.events.on('state', listener)
    return () => this.events.off('state', listener)
  }

  onFileReceived(listener: (event: FileReceivedEvent) => void): () => void {
    this.events.on('fileReceived', listener)
    return () => this.events.off('fileReceived', listener)
  }

  onTransferProgress(listener: (event: TransferProgressEvent) => void): () => void {
    this.events.on('transferProgress', listener)
    return () => this.events.off('transferProgress', listener)
  }

  onError(listener: (error: Error) => void): () => void {
    this.events.on('fault', listener)
    return () => this.events.off('fault', listener)
  }

  async createPairing(): Promise<PairingView> {
    await this.options.store.load()
    const settings = this.options.store.getSettings()
    const alias = settings.desktopAlias.trim()
    if (!alias || alias.length > 80) throw new Error('invalid_desktop_alias')

    const deviceId = `desktop_${randomUUID()}`
    const identity = generateDeviceKeyPair()
    const issued = await issuePairing(
      settings.relayBaseUrl,
      { desktopId: deviceId, publicKey: identity.publicKey, desktopAlias: alias },
      this.fetchImpl,
    )

    await this.options.store.addPairing(
      {
        version: 1,
        deviceId,
        roomId: issued.pairing.roomId,
        publicKey: identity.publicKey,
        desktopAlias: alias,
      },
      { devicePrivateKey: identity.secretKey, bootstrapSecret: issued.desktopSecret },
    )
    this.statuses.set(issued.pairing.roomId, { authorized: false, connected: false })
    if (this.running) this.ensureSupervisor(issued.pairing.roomId)
    this.emitState()

    const serialized = JSON.stringify(issued.pairing)
    return {
      qrPayload: `easydoc://pair?payload=${encodeURIComponent(serialized)}`,
      expiresAt: issued.pairing.expiresAt,
      roomId: issued.pairing.roomId,
    }
  }

  async revokePairing(roomId: string): Promise<void> {
    await this.options.store.load()
    const pairing = this.options.store.listPairings().find((item) => item.roomId === roomId)
    if (!pairing) throw new Error('pairing_not_found')

    const settings = this.options.store.getSettings()
    try {
      const session = await getDesktopSession(
        settings.relayBaseUrl,
        {
          roomId: pairing.roomId,
          deviceId: pairing.deviceId,
          bootstrapSecret: this.options.store.getBootstrapSecret(pairing.roomId),
        },
        this.fetchImpl,
      )
      await revokeRemotePairing(settings.relayBaseUrl, session.token, this.fetchImpl)
    } catch (error) {
      if (errorCode(error) !== 'pairing_invalid') throw error
    }

    await this.stopSupervisor(roomId)
    await this.options.store.removePairing(roomId)
    this.statuses.delete(roomId)
    this.emitState()
  }

  async setReceiveDirectory(receiveDir: string): Promise<ReceiverSnapshot> {
    await this.options.store.load()
    if (!receiveDir.trim() || !path.isAbsolute(receiveDir))
      throw new Error('invalid_receive_directory')
    await this.options.store.updateSettings({ receiveDir: path.normalize(receiveDir) })
    this.emitState()
    return this.snapshot()
  }

  async setAutoOpen(autoOpen: boolean): Promise<ReceiverSnapshot> {
    await this.options.store.load()
    await this.options.store.updateSettings({ autoOpen })
    this.emitState()
    return this.snapshot()
  }

  private summary(pairing: StoredDesktopPairing): PairingSummary {
    const status = this.statuses.get(pairing.roomId)
    return {
      roomId: pairing.roomId,
      deviceId: pairing.deviceId,
      mobileId: pairing.mobileId,
      authorized: status?.authorized ?? Boolean(pairing.mobileId),
      connected: status?.connected ?? false,
      error: status?.error,
    }
  }

  private emitState(): void {
    if (!this.running && this.options.store.listPairings().length === 0) {
      // snapshot() still works before start because createPairing/load initialize the store.
    }
    this.events.emit('state', this.snapshot())
  }

  private emitFault(error: unknown): void {
    this.events.emit('fault', error instanceof Error ? error : new Error(String(error)))
  }

  private ensureSupervisor(roomId: string): void {
    if (this.tasks.has(roomId)) return
    const task: PairingTask = { roomId, stopped: false }
    task.promise = this.runSupervisor(task).finally(() => {
      if (this.tasks.get(roomId) === task) this.tasks.delete(roomId)
    })
    this.tasks.set(roomId, task)
  }

  private async stopSupervisor(roomId: string): Promise<void> {
    const task = this.tasks.get(roomId)
    if (!task) return
    task.stopped = true
    task.wake?.()
    try {
      task.socket?.close()
    } catch {
      // Nothing else is required; the loop observes task.stopped.
    }
    await task.promise
    this.tasks.delete(roomId)
  }

  private async runSupervisor(task: PairingTask): Promise<void> {
    while (this.running && !task.stopped) {
      const pairing = this.options.store.listPairings().find((item) => item.roomId === task.roomId)
      if (!pairing) break
      try {
        await this.connectOnce(pairing, task)
      } catch (error) {
        const code = errorCode(error)
        this.setStatus(task.roomId, {
          authorized: code === 'pairing_invalid' ? false : undefined,
          connected: false,
          error: code === 'pairing_invalid' ? undefined : code,
        })
        if (code !== 'pairing_invalid' && code !== 'connection_cancelled') this.emitFault(error)
      }
      if (!this.running || task.stopped) break
      await this.delay(task, this.reconnectDelayMs)
    }
  }

  private async connectOnce(pairing: StoredDesktopPairing, task: PairingTask): Promise<void> {
    const settings = this.options.store.getSettings()
    const session = await getDesktopSession(
      settings.relayBaseUrl,
      {
        roomId: pairing.roomId,
        deviceId: pairing.deviceId,
        bootstrapSecret: this.options.store.getBootstrapSecret(pairing.roomId),
      },
      this.fetchImpl,
    )

    if (session.peerDeviceId && session.peerDeviceId !== pairing.mobileId) {
      await this.options.store.updatePairing(pairing.roomId, { mobileId: session.peerDeviceId })
      pairing = { ...pairing, mobileId: session.peerDeviceId }
    }
    this.setStatus(pairing.roomId, { authorized: true, connected: false, error: undefined })

    const socket = this.socketFactory(buildRelayWebSocketUrl(settings.relayBaseUrl, session.token))
    task.socket = socket
    let active: ActiveTransfer | undefined
    let opened = false
    let settled = false
    let messageChain = Promise.resolve()

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        void finish(new Error('relay_unavailable'))
      }, this.connectTimeoutMs)

      const finish = async (error?: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        task.socket = undefined
        if (active) {
          try {
            await active.receiver.interrupt()
          } catch {
            // Keep the original connection error as the actionable failure.
          }
          active = undefined
        }
        this.setStatus(pairing.roomId, { connected: false, error: error?.message })
        if (error) reject(error)
        else resolve()
      }

      socket.on('open', () => {
        if (settled || task.stopped || !this.running) {
          socket.close()
          return
        }
        opened = true
        clearTimeout(timeout)
        this.setStatus(pairing.roomId, { authorized: true, connected: true, error: undefined })
      })

      socket.on('error', (error) => {
        if (!opened) void finish(error instanceof Error ? error : new Error('relay_unavailable'))
        else {
          this.setStatus(pairing.roomId, { connected: false, error: 'relay_unavailable' })
          try {
            socket.close()
          } catch {
            void finish(new Error('relay_unavailable'))
          }
        }
      })

      socket.on('close', () => {
        messageChain = messageChain.finally(() => finish())
      })

      socket.on('message', (data, isBinary) => {
        messageChain = messageChain
          .then(async () => {
            if (settled) return
            if (isBinary) {
              active = await this.handleBinary(pairing, socket, active, rawBytes(data))
            } else {
              active = await this.handleText(
                pairing,
                socket,
                session.peerPublicKey,
                active,
                rawText(data),
              )
            }
          })
          .catch((error) => {
            void finish(error instanceof Error ? error : new Error(String(error)))
          })
      })
    })
  }

  private async handleText(
    pairing: StoredDesktopPairing,
    socket: ReceiverSocket,
    peerPublicKey: string,
    active: ActiveTransfer | undefined,
    raw: string,
  ): Promise<ActiveTransfer | undefined> {
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch {
      return active
    }

    if (value && typeof value === 'object') {
      const candidate = value as {
        type?: unknown
        role?: unknown
        deviceId?: unknown
        online?: unknown
        code?: unknown
      }
      if (candidate.type === 'presence:update') {
        if (
          candidate.role === 'mobile' &&
          candidate.online === true &&
          typeof candidate.deviceId === 'string' &&
          candidate.deviceId !== pairing.mobileId
        ) {
          await this.options.store.updatePairing(pairing.roomId, { mobileId: candidate.deviceId })
          this.emitState()
        }
        return active
      }
      if (candidate.type === 'relay:error') {
        throw new Error(typeof candidate.code === 'string' ? candidate.code : 'relay_unavailable')
      }
    }

    const message = parseTransferControlMessage(value)
    if (message.type === 'transfer:cancel') {
      if (active?.meta.transferId === message.transferId) {
        await active.receiver.cancel(true)
        return undefined
      }
      return active
    }
    if (message.type !== 'transfer:start') return active

    if (message.destinationDeviceId !== pairing.deviceId) {
      this.sendJson(socket, {
        type: 'transfer:reject',
        transferId: message.transferId,
        reason: 'destination_offline',
      })
      return active
    }

    if (active) {
      if (active.meta.transferId === message.transferId) {
        this.sendJson(socket, {
          type: 'transfer:accept',
          transferId: message.transferId,
          resumeFromChunk: active.receiver.resumeFromChunk,
        })
      } else {
        this.sendJson(socket, {
          type: 'transfer:reject',
          transferId: message.transferId,
          reason: 'write_failed',
        })
      }
      return active
    }

    try {
      const key = deriveTransferKey(
        this.options.store.getDevicePrivateKey(pairing.deviceId),
        peerPublicKey,
        message.transferId,
      )
      const receiver = await IncomingTransfer.create(
        message,
        this.options.store.getSettings().receiveDir,
      )
      const next = { meta: message, key, receiver }
      this.sendJson(socket, {
        type: 'transfer:accept',
        transferId: message.transferId,
        resumeFromChunk: receiver.resumeFromChunk,
      })
      return next
    } catch (error) {
      this.sendJson(socket, {
        type: 'transfer:reject',
        transferId: message.transferId,
        reason: transferError(error),
      })
      this.emitFault(error)
      return undefined
    }
  }

  private async handleBinary(
    pairing: StoredDesktopPairing,
    socket: ReceiverSocket,
    active: ActiveTransfer | undefined,
    bytes: Uint8Array,
  ): Promise<ActiveTransfer | undefined> {
    if (!active) return undefined
    const frame = decodeChunkFrame(bytes)
    if (frame.transferId !== active.meta.transferId) return active

    try {
      const plaintext = decryptChunk(active.key, frame.transferId, frame.chunkIndex, frame.payload)
      const progress = await active.receiver.writeChunk(frame.chunkIndex, plaintext)
      this.sendJson(socket, {
        type: 'transfer:ack',
        transferId: active.meta.transferId,
        receivedThroughChunk: progress.receivedThroughChunk,
      })
      this.events.emit('transferProgress', {
        roomId: pairing.roomId,
        transferId: active.meta.transferId,
        filename: active.meta.name,
        receivedBytes: progress.bytesWritten,
        totalBytes: active.meta.size,
      } satisfies TransferProgressEvent)

      if (!progress.complete || !progress.finalPath) return active
      this.sendJson(socket, {
        type: 'transfer:complete',
        transferId: active.meta.transferId,
        bytes: active.meta.size,
        sha256: active.meta.sha256,
      })
      this.events.emit('fileReceived', {
        roomId: pairing.roomId,
        path: progress.finalPath,
        filename: path.basename(progress.finalPath),
        size: active.meta.size,
        mime: active.meta.mime,
      } satisfies FileReceivedEvent)
      return undefined
    } catch (error) {
      const reason = transferError(error)
      this.sendJson(socket, {
        type: 'transfer:reject',
        transferId: active.meta.transferId,
        reason,
      })
      try {
        if (reason === 'checksum_mismatch') await active.receiver.cancel(true)
        else await active.receiver.interrupt()
      } catch {
        // Preserve the transfer failure as the primary error.
      }
      this.emitFault(error)
      return undefined
    }
  }

  private sendJson(socket: ReceiverSocket, value: unknown): void {
    socket.send(JSON.stringify(value))
  }

  private setStatus(
    roomId: string,
    patch: {
      authorized?: boolean
      connected?: boolean
      error?: string
    },
  ): void {
    const current = this.statuses.get(roomId) ?? { authorized: false, connected: false }
    if (patch.authorized !== undefined) current.authorized = patch.authorized
    if (patch.connected !== undefined) current.connected = patch.connected
    if ('error' in patch) current.error = patch.error
    this.statuses.set(roomId, current)
    this.emitState()
  }

  private delay(task: PairingTask, milliseconds: number): Promise<void> {
    return new Promise((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        task.wake = undefined
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(finish, milliseconds)
      task.wake = finish
    })
  }
}
