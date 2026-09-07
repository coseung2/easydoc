import { hostname } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, Notification, safeStorage } from 'electron'
import type { OpenDialogOptions } from 'electron'
import {
  DesktopRelayClient,
  EasyDocStore,
  type FileReceivedEvent,
  type ReceiverSnapshot,
  type SecretProtector,
} from '@easydoc/receiver'
import type { EasyDocFileReceivedEvent, EasyDocState } from '../shared/home-api'
import { EASYDOC_CHANNELS } from '../shared/home-api'

const DEFAULT_RELAY_URL = 'https://easydoc-relay.mdownloader.workers.dev'

function secureStorageAvailable(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false
  if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') {
    return false
  }
  return true
}

const electronSecretProtector: SecretProtector = {
  isAvailable: secureStorageAvailable,
  protect(value) {
    if (!secureStorageAvailable()) throw new Error('secure_storage_unavailable')
    return safeStorage.encryptString(value).toString('base64')
  },
  unprotect(value) {
    if (!secureStorageAvailable()) throw new Error('secure_storage_unavailable')
    return safeStorage.decryptString(Buffer.from(value, 'base64'))
  },
}

function publicState(snapshot: ReceiverSnapshot): EasyDocState {
  return {
    desktopAlias: snapshot.settings.desktopAlias,
    receiveDir: snapshot.settings.receiveDir,
    autoOpen: snapshot.settings.autoOpen,
    pairings: snapshot.pairings.map((pairing) => ({ ...pairing })),
  }
}

function publicFileReceived(event: FileReceivedEvent): EasyDocFileReceivedEvent {
  return {
    path: event.path,
    filename: event.filename,
    size: event.size,
    mime: event.mime,
  }
}

function broadcast(channel: string, value: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, value)
  }
}

export class EasyDocShellIntegration {
  private readonly client: DesktopRelayClient
  private registered = false

  constructor(private readonly openDocumentPath: (filePath: string) => boolean) {
    const desktopAlias = hostname().trim() || 'GenOffice PC'
    const store = new EasyDocStore(
      join(app.getPath('userData'), 'easydoc'),
      {
        relayBaseUrl: process.env.EASYDOC_RELAY_URL?.trim() || DEFAULT_RELAY_URL,
        receiveDir: join(app.getPath('documents'), 'EasyDoc'),
        desktopAlias,
        autoOpen: true,
      },
      electronSecretProtector,
    )
    this.client = new DesktopRelayClient({ store })

    this.client.onState((snapshot) => {
      broadcast(EASYDOC_CHANNELS.stateChanged, publicState(snapshot))
    })
    this.client.onFileReceived((event) => {
      const payload = publicFileReceived(event)
      broadcast(EASYDOC_CHANNELS.fileReceived, payload)
      if (Notification.isSupported()) {
        new Notification({ title: 'EasyDoc', body: event.filename }).show()
      }
      if (this.client.snapshot().settings.autoOpen) this.openDocumentPath(event.path)
    })
    this.client.onError((error) => {
      console.warn('[easydoc] receiver error:', error.message)
    })
  }

  registerIpc(): void {
    if (this.registered) return
    this.registered = true

    ipcMain.handle(EASYDOC_CHANNELS.state, () => publicState(this.client.snapshot()))
    ipcMain.handle(EASYDOC_CHANNELS.createPairing, () => this.client.createPairing())
    ipcMain.handle(EASYDOC_CHANNELS.revokePairing, async (_event, roomId: unknown) => {
      if (typeof roomId !== 'string' || !roomId || roomId.length > 256) {
        throw new Error('pairing_invalid')
      }
      await this.client.revokePairing(roomId)
    })
    ipcMain.handle(EASYDOC_CHANNELS.chooseReceiveDirectory, async (event) => {
      const current = this.client.snapshot().settings.receiveDir
      const owner = BrowserWindow.fromWebContents(event.sender)
      const options: OpenDialogOptions = {
        title: 'EasyDoc',
        defaultPath: current,
        properties: ['openDirectory'],
      }
      const result = owner
        ? await dialog.showOpenDialog(owner, options)
        : await dialog.showOpenDialog(options)
      const selected = result.canceled ? undefined : result.filePaths[0]
      if (!selected) return null
      await this.client.setReceiveDirectory(selected)
      return selected
    })
    ipcMain.handle(EASYDOC_CHANNELS.setAutoOpen, async (_event, enabled: unknown) => {
      if (typeof enabled !== 'boolean') throw new Error('invalid_auto_open')
      return publicState(await this.client.setAutoOpen(enabled))
    })
  }

  async start(): Promise<void> {
    await this.client.start()
  }

  async stop(): Promise<void> {
    await this.client.stop()
  }
}
