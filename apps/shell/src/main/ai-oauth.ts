import { join } from 'node:path'
import { app, ipcMain, net, safeStorage, shell } from 'electron'
import { setOAuthCredentialResolver } from '@genoffice/ai-provider'
import type { AiOAuthStatus } from '@genoffice/ai-provider'
import { ChatGptOAuthClient } from '@genoffice/ai-provider/oauth'
import { AI_OAUTH_CHANNELS } from '../shared/home-api'
import { EncryptedOAuthTokenStore } from './ai-oauth-store'

function publicStatus(status: AiOAuthStatus): AiOAuthStatus {
  return {
    state: status.state,
    ...(status.expiresAt !== undefined ? { expiresAt: status.expiresAt } : {}),
    ...(status.error ? { error: status.error } : {}),
  }
}

export function registerAiOAuth(): void {
  const protector = {
    available: () =>
      safeStorage.isEncryptionAvailable() &&
      (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'),
    encrypt: (text: string) => safeStorage.encryptString(text).toString('base64'),
    decrypt: (text: string) => safeStorage.decryptString(Buffer.from(text, 'base64')),
  }
  const client = new ChatGptOAuthClient({
    store: new EncryptedOAuthTokenStore(
      join(app.getPath('userData'), 'ai-oauth', 'chatgpt.json'),
      protector,
    ),
    fetch: (input, init) => net.fetch(input instanceof URL ? input.href : input, init),
  })
  setOAuthCredentialResolver(() => client.getCredentials())

  async function openPendingLogin(): Promise<void> {
    const status = await client.getStatus()
    if (status.state !== 'pending' || !status.authorizationUrl) return
    const url = new URL(status.authorizationUrl)
    if (url.origin !== 'https://auth.openai.com' || url.pathname !== '/oauth/authorize') {
      throw new Error('oauth_invalid_authorization_url')
    }
    await shell.openExternal(url.href)
  }

  ipcMain.handle(AI_OAUTH_CHANNELS.status, async () => publicStatus(await client.getStatus()))
  ipcMain.handle(AI_OAUTH_CHANNELS.start, async () => {
    if (!protector.available()) throw new Error('oauth_secure_storage_unavailable')
    const status = await client.startLogin()
    // A blocked browser launch leaves the pending login available to reopen.
    await openPendingLogin().catch(() => undefined)
    return publicStatus(status)
  })
  ipcMain.handle(AI_OAUTH_CHANNELS.open, openPendingLogin)
  ipcMain.handle(AI_OAUTH_CHANNELS.cancel, () => client.cancelLogin())
  ipcMain.handle(AI_OAUTH_CHANNELS.disconnect, () => client.disconnect())
  app.once('before-quit', () => {
    setOAuthCredentialResolver(null)
    void client.cancelLogin()
  })
}
