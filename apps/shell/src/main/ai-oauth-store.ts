import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { OAuthTokens, OAuthTokenStore } from '@genoffice/ai-provider/oauth'

export interface OAuthProtector {
  available(): boolean
  encrypt(value: string): string
  decrypt(value: string): string
}

/** The only on-disk representation is ciphertext encrypted by the OS. */
export class EncryptedOAuthTokenStore implements OAuthTokenStore {
  constructor(
    private readonly filePath: string,
    private readonly protector: OAuthProtector,
  ) {}

  private requireEncryption(): void {
    if (!this.protector.available()) throw new Error('oauth_secure_storage_unavailable')
  }

  async load(): Promise<OAuthTokens | null> {
    let text: string
    try {
      text = await readFile(this.filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      // eslint-disable-next-line preserve-caught-error -- Keep private storage paths out of IPC errors.
      throw new Error('oauth_storage_error')
    }
    this.requireEncryption()
    try {
      const envelope = JSON.parse(text)
      if (envelope.version !== 1 || typeof envelope.ciphertext !== 'string') throw new Error()
      const value = JSON.parse(this.protector.decrypt(envelope.ciphertext))
      if (
        typeof value.accessToken !== 'string' ||
        !value.accessToken ||
        typeof value.refreshToken !== 'string' ||
        !value.refreshToken ||
        typeof value.expiresAt !== 'number' ||
        !Number.isFinite(value.expiresAt) ||
        (value.accountId !== undefined && typeof value.accountId !== 'string')
      )
        throw new Error()
      return {
        accessToken: value.accessToken,
        refreshToken: value.refreshToken,
        expiresAt: value.expiresAt,
        ...(value.accountId ? { accountId: value.accountId } : {}),
      }
    } catch {
      throw new Error('oauth_storage_error')
    }
  }

  async save(tokens: OAuthTokens): Promise<void> {
    this.requireEncryption()
    const temporary = `${this.filePath}.${randomUUID()}.tmp`
    try {
      const ciphertext = this.protector.encrypt(JSON.stringify(tokens))
      await mkdir(dirname(this.filePath), { recursive: true })
      await writeFile(temporary, JSON.stringify({ version: 1, ciphertext }), {
        mode: 0o600,
        flag: 'wx',
      })
      await rename(temporary, this.filePath)
    } catch {
      throw new Error('oauth_storage_error')
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined)
    }
  }

  async clear(): Promise<void> {
    await rm(this.filePath, { force: true })
  }
}
