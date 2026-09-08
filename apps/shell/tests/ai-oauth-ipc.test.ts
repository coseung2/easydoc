import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AI_OAUTH_CHANNELS } from '../src/shared/home-api'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  quit: undefined as (() => void) | undefined,
  available: vi.fn(() => true),
  openExternal: vi.fn(async () => {}),
  resolver: vi.fn(),
  client: {
    getStatus: vi.fn(),
    startLogin: vi.fn(),
    cancelLogin: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    getCredentials: vi.fn(async () => ({ accessToken: 'private-test-token' })),
  },
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => 'unused-test-data',
    once: (_event: string, callback: () => void) => {
      mocks.quit = callback
    },
  },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      mocks.handlers.set(channel, handler),
  },
  net: { fetch: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: mocks.available,
    getSelectedStorageBackend: () => 'test-keyring',
  },
  shell: { openExternal: mocks.openExternal },
}))
vi.mock('@genoffice/ai-provider', () => ({ setOAuthCredentialResolver: mocks.resolver }))
vi.mock('@genoffice/ai-provider/oauth', () => ({
  ChatGptOAuthClient: class {
    constructor() {
      return mocks.client
    }
  },
}))

import { registerAiOAuth } from '../src/main/ai-oauth'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.handlers.clear()
  mocks.available.mockReturnValue(true)
  mocks.client.getStatus.mockResolvedValue({ state: 'disconnected' })
  registerAiOAuth()
})

function invoke(channel: string, ...args: unknown[]) {
  return mocks.handlers.get(channel)!({}, ...args)
}

describe('OAuth main-process boundary', () => {
  it('returns only public status while credentials stay in the main resolver', async () => {
    const internal = {
      state: 'pending',
      authorizationUrl: 'https://auth.openai.com/oauth/authorize?state=private-test-state',
      accessToken: 'private-test-token',
      refreshToken: 'private-test-refresh',
      accountId: 'private-test-account',
    }
    mocks.client.getStatus.mockResolvedValue(internal)
    mocks.client.startLogin.mockResolvedValue(internal)
    expect(await invoke(AI_OAUTH_CHANNELS.status)).toEqual({ state: 'pending' })
    expect(await invoke(AI_OAUTH_CHANNELS.start)).toEqual({ state: 'pending' })
    expect(mocks.openExternal).toHaveBeenCalledWith(internal.authorizationUrl)
    const resolver = mocks.resolver.mock.calls[0][0]
    expect(await resolver()).toEqual({ accessToken: 'private-test-token' })
  })

  it('opens only the internally owned OpenAI URL and rejects a different origin', async () => {
    mocks.client.getStatus.mockResolvedValue({
      state: 'pending',
      authorizationUrl: 'https://example.test/oauth/authorize',
    })
    await expect(
      invoke(AI_OAUTH_CHANNELS.open, 'https://auth.openai.com/oauth/authorize'),
    ).rejects.toThrow('oauth_invalid_authorization_url')
    expect(mocks.openExternal).not.toHaveBeenCalled()
    mocks.client.getStatus.mockResolvedValue({
      state: 'pending',
      authorizationUrl: 'https://auth.openai.com/oauth/authorize?state=test',
    })
    await invoke(AI_OAUTH_CHANNELS.open, 'https://example.test/')
    expect(mocks.openExternal).toHaveBeenCalledWith(
      'https://auth.openai.com/oauth/authorize?state=test',
    )
  })

  it('does not start login without secure OS storage', async () => {
    mocks.available.mockReturnValue(false)
    await expect(invoke(AI_OAUTH_CHANNELS.start)).rejects.toThrow(
      'oauth_secure_storage_unavailable',
    )
    expect(mocks.client.startLogin).not.toHaveBeenCalled()
  })

  it('releases the credential resolver and pending callback on exit', () => {
    mocks.quit!()
    expect(mocks.resolver).toHaveBeenLastCalledWith(null)
    expect(mocks.client.cancelLogin).toHaveBeenCalledOnce()
  })
})
