import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { EasyDocReceiverSettings, StoredDesktopPairing } from './types.ts'

export interface SecretProtector {
  isAvailable(): boolean
  protect(value: string): string
  unprotect(value: string): string
}

type SecretState = {
  version: 1
  values: Record<string, string>
}

const SECRET_VERSION = 1 as const
const PAIRING_VERSION = 1 as const

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as T
  } catch {
    return null
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function secretKey(kind: 'device-private' | 'pairing-bootstrap', id: string): string {
  return `${kind}:${id}`
}

export class EasyDocStore {
  readonly rootDir: string
  private readonly settingsPath: string
  private readonly pairingsPath: string
  private readonly secretsPath: string
  private readonly protector: SecretProtector
  private loaded = false
  private settings: EasyDocReceiverSettings
  private pairings: StoredDesktopPairing[] = []
  private secrets: SecretState = { version: SECRET_VERSION, values: {} }

  constructor(rootDir: string, defaults: EasyDocReceiverSettings, protector: SecretProtector) {
    this.rootDir = rootDir
    this.protector = protector
    this.settingsPath = path.join(rootDir, 'settings.json')
    this.pairingsPath = path.join(rootDir, 'pairings.json')
    this.secretsPath = path.join(rootDir, 'secrets.json')
    this.settings = { ...defaults }
  }

  async load(): Promise<void> {
    if (this.loaded) return
    await mkdir(this.rootDir, { recursive: true })

    const storedSettings = await readJson<Partial<EasyDocReceiverSettings>>(this.settingsPath)
    if (storedSettings) this.settings = { ...this.settings, ...storedSettings }

    const storedPairings = await readJson<StoredDesktopPairing[]>(this.pairingsPath)
    if (Array.isArray(storedPairings)) {
      this.pairings = storedPairings.filter(
        (pairing) =>
          pairing?.version === PAIRING_VERSION &&
          typeof pairing.deviceId === 'string' &&
          typeof pairing.roomId === 'string' &&
          typeof pairing.publicKey === 'string',
      )
    }

    const storedSecrets = await readJson<SecretState>(this.secretsPath)
    if (storedSecrets?.version === SECRET_VERSION && storedSecrets.values) {
      this.secrets = storedSecrets
    }
    this.loaded = true
  }

  getSettings(): EasyDocReceiverSettings {
    this.assertLoaded()
    return { ...this.settings }
  }

  listPairings(): StoredDesktopPairing[] {
    this.assertLoaded()
    return this.pairings.map((pairing) => ({ ...pairing }))
  }

  async updateSettings(patch: Partial<EasyDocReceiverSettings>): Promise<EasyDocReceiverSettings> {
    this.assertLoaded()
    this.settings = { ...this.settings, ...patch }
    await writeJson(this.settingsPath, this.settings)
    return this.getSettings()
  }

  async addPairing(
    pairing: StoredDesktopPairing,
    secrets: { devicePrivateKey: string; bootstrapSecret: string },
  ): Promise<void> {
    this.assertLoaded()
    this.requireSecureStorage()
    if (this.pairings.some((item) => item.roomId === pairing.roomId)) {
      throw new Error('pairing_invalid')
    }

    this.secrets.values[secretKey('device-private', pairing.deviceId)] = this.protector.protect(
      secrets.devicePrivateKey,
    )
    this.secrets.values[secretKey('pairing-bootstrap', pairing.roomId)] = this.protector.protect(
      secrets.bootstrapSecret,
    )
    this.pairings.push({ ...pairing })
    await Promise.all([
      writeJson(this.pairingsPath, this.pairings),
      writeJson(this.secretsPath, this.secrets),
    ])
  }

  async updatePairing(
    roomId: string,
    patch: Pick<Partial<StoredDesktopPairing>, 'mobileId' | 'desktopAlias'>,
  ): Promise<void> {
    this.assertLoaded()
    const pairing = this.pairings.find((item) => item.roomId === roomId)
    if (!pairing) throw new Error('pairing_not_found')
    Object.assign(pairing, patch)
    await writeJson(this.pairingsPath, this.pairings)
  }

  async removePairing(roomId: string): Promise<void> {
    this.assertLoaded()
    const pairing = this.pairings.find((item) => item.roomId === roomId)
    if (!pairing) throw new Error('pairing_not_found')

    this.pairings = this.pairings.filter((item) => item.roomId !== roomId)
    delete this.secrets.values[secretKey('pairing-bootstrap', roomId)]
    if (!this.pairings.some((item) => item.deviceId === pairing.deviceId)) {
      delete this.secrets.values[secretKey('device-private', pairing.deviceId)]
    }

    await Promise.all([
      writeJson(this.pairingsPath, this.pairings),
      writeJson(this.secretsPath, this.secrets),
    ])
  }

  getDevicePrivateKey(deviceId: string): string {
    return this.readSecret('device-private', deviceId)
  }

  getBootstrapSecret(roomId: string): string {
    return this.readSecret('pairing-bootstrap', roomId)
  }

  async clear(): Promise<void> {
    this.assertLoaded()
    this.pairings = []
    this.secrets = { version: SECRET_VERSION, values: {} }
    await Promise.all([
      rm(this.pairingsPath, { force: true }),
      rm(this.secretsPath, { force: true }),
      rm(this.settingsPath, { force: true }),
    ])
  }

  private readSecret(kind: 'device-private' | 'pairing-bootstrap', id: string): string {
    this.assertLoaded()
    this.requireSecureStorage()
    const protectedValue = this.secrets.values[secretKey(kind, id)]
    if (!protectedValue) throw new Error('pairing_invalid')
    try {
      return this.protector.unprotect(protectedValue)
    } catch {
      throw new Error('pairing_invalid')
    }
  }

  private requireSecureStorage(): void {
    if (!this.protector.isAvailable()) throw new Error('secure_storage_unavailable')
  }

  private assertLoaded(): void {
    if (!this.loaded) throw new Error('receiver_store_not_loaded')
  }
}
