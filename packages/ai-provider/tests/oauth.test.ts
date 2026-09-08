import { createHash } from 'node:crypto'
import { createServer as createHttpServer } from 'node:http'
import { createServer } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatGptOAuthClient, type OAuthTokens, type OAuthTokenStore } from '../src/oauth'
import { isLoopbackAddress } from '../src/oauth/callback'

const NOW = 1_800_000_000_000
const tokenResponse = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
const jwt = (accountId: string) =>
  `header.${Buffer.from(
    JSON.stringify({
      'https://api.openai.com/auth': { chatgpt_account_id: accountId },
    }),
  ).toString('base64url')}.signature`
const originalTokens = (): OAuthTokens => ({
  accessToken: 'old-access-secret',
  refreshToken: 'old-refresh-secret',
  expiresAt: NOW + 10_000,
  accountId: 'account-1',
})
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

class MemoryStore implements OAuthTokenStore {
  tokens: OAuthTokens | null
  saves: OAuthTokens[] = []
  clears = 0
  constructor(tokens: OAuthTokens | null = null) {
    this.tokens = tokens
  }
  async load() {
    return this.tokens ? { ...this.tokens } : null
  }
  async save(tokens: OAuthTokens) {
    this.tokens = { ...tokens }
    this.saves.push({ ...tokens })
  }
  async clear() {
    this.tokens = null
    this.clears += 1
  }
}

const clients: ChatGptOAuthClient[] = []
function clientFor(
  store = new MemoryStore(),
  fetchImpl = vi.fn<typeof fetch>(),
  options: { timeoutMs?: number; callbackPort?: number } = {},
) {
  const client = new ChatGptOAuthClient({
    store,
    fetch: fetchImpl,
    callbackPort: 0,
    now: () => NOW,
    ...options,
  })
  clients.push(client)
  return { client, store, fetchImpl }
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.disconnect()))
})

async function begin(client: ChatGptOAuthClient) {
  const status = await client.startLogin()
  expect(status.state).toBe('pending')
  const authorization = new URL(status.authorizationUrl!)
  const callback = new URL(authorization.searchParams.get('redirect_uri')!)
  callback.hostname = '127.0.0.1'
  callback.searchParams.set('state', authorization.searchParams.get('state')!)
  callback.searchParams.set('code', 'authorization-code')
  return { authorization, callback }
}

async function waitForState(client: ChatGptOAuthClient, state: string) {
  await vi.waitFor(async () => expect((await client.getStatus()).state).toBe(state))
}

describe('native ChatGPT OAuth login', () => {
  it('uses a state-bound S256 challenge, exchanges the callback, and never exposes credentials in status', async () => {
    const { client, store, fetchImpl } = clientFor()
    fetchImpl.mockResolvedValue(
      tokenResponse({
        access_token: 'private-access-token',
        refresh_token: 'private-refresh-token',
        expires_in: 3600,
        id_token: jwt('chatgpt-account'),
      }),
    )
    const { authorization, callback } = await begin(client)
    expect(authorization.origin).toBe('https://auth.openai.com')
    expect(authorization.pathname).toBe('/oauth/authorize')
    expect(authorization.searchParams.get('client_id')).toBe('app_EMoamEEZ73f0CkXaXp7hrann')
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256')
    expect(authorization.searchParams.get('state')!.length).toBeGreaterThanOrEqual(32)
    expect(authorization.searchParams.get('redirect_uri')).toMatch(
      /^http:\/\/localhost:\d+\/auth\/callback$/u,
    )
    expect(authorization.searchParams.get('scope')).toContain('offline_access')
    expect(authorization.searchParams.has('code_verifier')).toBe(false)
    expect((await fetch(callback)).status).toBe(200)
    await waitForState(client, 'connected')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [endpoint, request] = fetchImpl.mock.calls[0]
    expect(endpoint).toBe('https://auth.openai.com/oauth/token')
    expect(request?.method).toBe('POST')
    expect(request?.redirect).toBe('error')
    expect(new Headers(request?.headers).get('Content-Type')).toBe(
      'application/x-www-form-urlencoded',
    )
    const form = new URLSearchParams(request?.body as URLSearchParams)
    expect(form.get('grant_type')).toBe('authorization_code')
    expect(form.get('code')).toBe('authorization-code')
    expect(form.get('redirect_uri')).toBe(authorization.searchParams.get('redirect_uri'))
    expect(createHash('sha256').update(form.get('code_verifier')!).digest('base64url')).toBe(
      authorization.searchParams.get('code_challenge'),
    )
    expect(store.tokens).toEqual({
      accessToken: 'private-access-token',
      refreshToken: 'private-refresh-token',
      expiresAt: NOW + 3_600_000,
      accountId: 'chatgpt-account',
    })
    expect(await client.getStatus()).toEqual({ state: 'connected', expiresAt: NOW + 3_600_000 })
    expect(await client.getCredentials()).toEqual({
      accessToken: 'private-access-token',
      accountId: 'chatgpt-account',
    })
    await expect(fetch(callback)).rejects.toThrow()
  })

  it('ignores wrong state, paths, methods, and missing/duplicate codes without consuming the login', async () => {
    const { client, fetchImpl } = clientFor()
    fetchImpl.mockResolvedValue(
      tokenResponse({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 }),
    )
    const { callback } = await begin(client)
    const wrongState = new URL(callback)
    wrongState.searchParams.set('state', 'unrelated-state')
    expect((await fetch(wrongState)).status).toBe(400)
    const wrongPath = new URL(callback)
    wrongPath.pathname = '/unrelated'
    expect((await fetch(wrongPath)).status).toBe(404)
    expect((await fetch(callback, { method: 'POST' })).status).toBe(405)
    const missingCode = new URL(callback)
    missingCode.searchParams.delete('code')
    expect((await fetch(missingCode)).status).toBe(400)
    const duplicateCode = new URL(callback)
    duplicateCode.searchParams.append('code', 'second-code')
    expect((await fetch(duplicateCode)).status).toBe(400)
    expect(fetchImpl).not.toHaveBeenCalled()
    expect((await client.getStatus()).state).toBe('pending')
    expect((await fetch(callback)).status).toBe(200)
    await waitForState(client, 'connected')
  })

  it('accepts only loopback callback peers', () => {
    for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1'])
      expect(isLoopbackAddress(address)).toBe(true)
    for (const address of ['192.168.1.1', '8.8.8.8', '::ffff:192.168.1.1', undefined])
      expect(isLoopbackAddress(address)).toBe(false)
  })

  it('binds the IPv6 localhost address when IPv6 is available', async () => {
    const probe = createServer()
    const available = await new Promise<boolean>((resolve) => {
      probe.once('error', () => resolve(false))
      probe.listen({ host: '::1', port: 0, ipv6Only: true }, () => probe.close(() => resolve(true)))
    })
    if (!available) return
    const { client } = clientFor()
    const { callback } = await begin(client)
    callback.hostname = '[::1]'
    callback.searchParams.set('state', 'wrong-state')
    expect((await fetch(callback)).status).toBe(400)
  })

  it('cancels and closes the callback listener without persisting anything', async () => {
    const { client, store, fetchImpl } = clientFor()
    const { callback } = await begin(client)
    await client.cancelLogin()
    expect(await client.getStatus()).toEqual({ state: 'disconnected' })
    expect(store.saves).toEqual([])
    expect(fetchImpl).not.toHaveBeenCalled()
    await expect(fetch(callback)).rejects.toThrow()
  })

  it('times out and closes the callback listener', async () => {
    const { client, store } = clientFor(new MemoryStore(), vi.fn<typeof fetch>(), { timeoutMs: 50 })
    const { callback } = await begin(client)
    await waitForState(client, 'error')
    expect((await client.getStatus()).error).toContain('timed out')
    expect(store.saves).toEqual([])
    await expect(fetch(callback)).rejects.toThrow()
  })

  it('uses generic errors for provider denial and never reflects provider details', async () => {
    const { client, fetchImpl } = clientFor()
    const { callback } = await begin(client)
    callback.searchParams.set('error', 'access_denied')
    callback.searchParams.set('error_description', 'secret-provider-detail')
    const response = await fetch(callback)
    expect(response.status).toBe(400)
    expect(await response.text()).not.toContain('secret-provider-detail')
    await waitForState(client, 'error')
    expect(JSON.stringify(await client.getStatus())).not.toContain('secret-provider-detail')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rejects malformed token responses without exposing their content', async () => {
    const { client, store, fetchImpl } = clientFor()
    fetchImpl.mockResolvedValue(
      tokenResponse({ access_token: 'secret-access', expires_in: 'invalid-secret-value' }),
    )
    const { callback } = await begin(client)
    await fetch(callback)
    await waitForState(client, 'error')
    expect(JSON.stringify(await client.getStatus())).not.toContain('secret')
    expect(store.saves).toEqual([])
  })

  it('handles an occupied callback port without leaking listener or OS errors', async () => {
    const blocker = createServer()
    await new Promise<void>((resolve) => blocker.listen({ host: '127.0.0.1', port: 0 }, resolve))
    try {
      const port = (blocker.address() as { port: number }).port
      const { client } = clientFor(new MemoryStore(), vi.fn<typeof fetch>(), { callbackPort: port })
      expect(await client.startLogin()).toEqual({
        state: 'error',
        error: 'ChatGPT sign-in callback port is unavailable. Please try again.',
      })
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()))
    }
  })

  it('checks secure storage before returning an authorization URL, including after a cached status read', async () => {
    const { client, store, fetchImpl } = clientFor()
    expect(await client.getStatus()).toEqual({ state: 'disconnected' })
    vi.spyOn(store, 'load').mockRejectedValue(new Error('secret-decryption-details'))
    expect(await client.startLogin()).toEqual({
      state: 'error',
      error: 'ChatGPT account storage is unavailable.',
    })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect((await client.getStatus()).authorizationUrl).toBeUndefined()
  })
})

describe('OAuth refresh and lifecycle races', () => {
  it('loads valid credentials without refreshing or exposing token values in status', async () => {
    const tokens = { ...originalTokens(), expiresAt: NOW + 120_000 }
    const { client, fetchImpl } = clientFor(new MemoryStore(tokens))
    expect(await client.getStatus()).toEqual({ state: 'connected', expiresAt: tokens.expiresAt })
    expect(await client.getCredentials()).toEqual({
      accessToken: tokens.accessToken,
      accountId: tokens.accountId,
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('shares one refresh across concurrent callers and preserves omitted refresh-token rotation and account ID', async () => {
    const response = deferred<Response>()
    const { client, store, fetchImpl } = clientFor(new MemoryStore(originalTokens()))
    fetchImpl.mockReturnValue(response.promise)
    const requests = [client.getCredentials(), client.getCredentials(), client.getCredentials()]
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1))
    const form = new URLSearchParams(fetchImpl.mock.calls[0][1]?.body as URLSearchParams)
    expect(form.get('grant_type')).toBe('refresh_token')
    expect(form.get('refresh_token')).toBe('old-refresh-secret')
    response.resolve(tokenResponse({ access_token: 'refreshed-access', expires_in: 3600 }))
    expect(await Promise.all(requests)).toEqual(
      Array(3).fill({ accessToken: 'refreshed-access', accountId: 'account-1' }),
    )
    expect(store.tokens?.refreshToken).toBe('old-refresh-secret')
    expect(store.saves).toHaveLength(1)
  })

  it('persists rotated refresh tokens before returning refreshed credentials', async () => {
    const { client, store, fetchImpl } = clientFor(new MemoryStore(originalTokens()))
    fetchImpl.mockResolvedValue(
      tokenResponse({
        access_token: 'new-access',
        refresh_token: 'rotated-refresh',
        expires_in: 3600,
      }),
    )
    await client.getCredentials()
    expect(store.tokens?.refreshToken).toBe('rotated-refresh')
  })

  it('clears rejected refresh credentials and reports a safe sign-in state', async () => {
    const { client, store, fetchImpl } = clientFor(new MemoryStore(originalTokens()))
    fetchImpl.mockResolvedValue(
      tokenResponse({ error: 'invalid_grant', error_description: 'private-refresh-secret' }, 400),
    )
    await expect(client.getCredentials()).rejects.toThrow('session expired')
    expect(store.tokens).toBeNull()
    expect(store.clears).toBe(1)
    expect(await client.getStatus()).toEqual({
      state: 'error',
      error: 'Your ChatGPT session expired. Sign in again.',
    })
    await expect(client.getCredentials()).rejects.toThrow('Sign in to ChatGPT')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('keeps credentials on transient errors and allows the next request to retry', async () => {
    const { client, store, fetchImpl } = clientFor(new MemoryStore(originalTokens()))
    fetchImpl
      .mockResolvedValueOnce(
        tokenResponse({ error: 'server_error', error_description: 'private-response-body' }, 503),
      )
      .mockResolvedValueOnce(tokenResponse({ access_token: 'recovered', expires_in: 3600 }))
    await expect(client.getCredentials()).rejects.toThrow('temporarily unavailable')
    expect(store.tokens).toEqual(originalTokens())
    expect(store.clears).toBe(0)
    expect(JSON.stringify(await client.getStatus())).not.toContain('private-response-body')
    expect((await client.getCredentials()).accessToken).toBe('recovered')
    expect((await client.getStatus()).state).toBe('connected')
  })

  it.each([307, 308])(
    'does not forward token forms through an HTTP %s redirect',
    async (status) => {
      let redirectedRequests = 0
      const server = createHttpServer((request, response) => {
        if (request.url === '/token') {
          response.writeHead(status, { Location: '/unexpected-destination' })
          response.end()
        } else {
          redirectedRequests += 1
          response.end('{}')
        }
      })
      await new Promise<void>((resolve) => server.listen({ host: '127.0.0.1', port: 0 }, resolve))
      try {
        const port = (server.address() as { port: number }).port
        const fetchImpl = vi.fn<typeof fetch>((_input, init) =>
          fetch(`http://127.0.0.1:${port}/token`, init),
        )
        const { client, store } = clientFor(new MemoryStore(originalTokens()), fetchImpl)
        await expect(client.getCredentials()).rejects.toThrow('temporarily unavailable')
        expect(redirectedRequests).toBe(0)
        expect(store.tokens).toEqual(originalTokens())
      } finally {
        await new Promise<void>((resolve) => {
          server.close(() => resolve())
          server.closeAllConnections()
        })
      }
    },
  )

  it('does not save a token exchange that completes after cancellation', async () => {
    const response = deferred<Response>()
    const { client, store, fetchImpl } = clientFor()
    fetchImpl.mockReturnValue(response.promise)
    const { callback } = await begin(client)
    await fetch(callback)
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1))
    await client.cancelLogin()
    response.resolve(
      tokenResponse({
        access_token: 'late-access',
        refresh_token: 'late-refresh',
        expires_in: 3600,
      }),
    )
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(await client.getStatus()).toEqual({ state: 'disconnected' })
    expect(store.saves).toEqual([])
  })

  it('does not save a stale refresh after disconnect', async () => {
    const response = deferred<Response>()
    const { client, store, fetchImpl } = clientFor(new MemoryStore(originalTokens()))
    fetchImpl.mockReturnValue(response.promise)
    const request = client.getCredentials().catch((error: Error) => error)
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1))
    await client.disconnect()
    response.resolve(
      tokenResponse({
        access_token: 'late-access',
        refresh_token: 'late-refresh',
        expires_in: 3600,
      }),
    )
    expect(await request).toBeInstanceOf(Error)
    expect(store.tokens).toBeNull()
    expect(store.saves).toEqual([])
    expect(await client.getStatus()).toEqual({ state: 'disconnected' })
  })

  it('waits for a dispatched save before clearing credentials on disconnect', async () => {
    const gate = deferred<void>()
    const store = new MemoryStore(originalTokens())
    const save = vi.spyOn(store, 'save').mockImplementation(async (tokens) => {
      await gate.promise
      store.tokens = tokens
    })
    const { client, fetchImpl } = clientFor(store)
    fetchImpl.mockResolvedValue(
      tokenResponse({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 }),
    )
    const request = client.getCredentials().catch((error: Error) => error)
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    let disconnected = false
    const disconnecting = client.disconnect().then(() => {
      disconnected = true
    })
    await Promise.resolve()
    expect(disconnected).toBe(false)
    gate.resolve()
    await disconnecting
    expect(await request).toBeInstanceOf(Error)
    expect(store.tokens).toBeNull()
    expect(await client.getStatus()).toEqual({ state: 'disconnected' })
  })

  it('prevents an older login from replacing a newer login', async () => {
    const oldResponse = deferred<Response>()
    const { client, store, fetchImpl } = clientFor()
    fetchImpl.mockReturnValueOnce(oldResponse.promise).mockResolvedValueOnce(
      tokenResponse({
        access_token: 'current-access',
        refresh_token: 'current-refresh',
        expires_in: 3600,
      }),
    )
    const first = await begin(client)
    await fetch(first.callback)
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1))
    const second = await begin(client)
    expect(second.authorization.searchParams.get('state')).not.toBe(
      first.authorization.searchParams.get('state'),
    )
    await fetch(second.callback)
    await waitForState(client, 'connected')
    oldResponse.resolve(
      tokenResponse({
        access_token: 'stale-access',
        refresh_token: 'stale-refresh',
        expires_in: 3600,
      }),
    )
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(store.tokens?.accessToken).toBe('current-access')
    expect(store.saves).toHaveLength(1)
  })

  it('does not let an old refresh replace a new browser login', async () => {
    const oldResponse = deferred<Response>()
    const { client, store, fetchImpl } = clientFor(new MemoryStore(originalTokens()))
    fetchImpl.mockReturnValueOnce(oldResponse.promise).mockResolvedValueOnce(
      tokenResponse({
        access_token: 'new-login-access',
        refresh_token: 'new-login-refresh',
        expires_in: 3600,
      }),
    )
    const oldRequest = client.getCredentials().catch((error: Error) => error)
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1))
    const { callback } = await begin(client)
    await fetch(callback)
    await waitForState(client, 'connected')
    oldResponse.resolve(
      tokenResponse({
        access_token: 'stale-refresh-access',
        refresh_token: 'stale-refresh-secret',
        expires_in: 3600,
      }),
    )
    expect(await oldRequest).toBeInstanceOf(Error)
    expect(store.tokens?.accessToken).toBe('new-login-access')
    expect(store.saves).toHaveLength(1)
  })

  it('joins an in-flight rotation after canceling a replacement login', async () => {
    const response = deferred<Response>()
    const { client, store, fetchImpl } = clientFor(new MemoryStore(originalTokens()))
    fetchImpl
      .mockReturnValueOnce(response.promise)
      .mockResolvedValueOnce(tokenResponse({ access_token: 'next-access', expires_in: 3600 }))
    const originalRequest = client.getCredentials().catch((error: Error) => error)
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1))
    await begin(client)
    await client.cancelLogin()
    const currentRequest = client.getCredentials()
    response.resolve(
      tokenResponse({
        access_token: 'rotated-access',
        refresh_token: 'rotated-refresh',
        expires_in: 30,
      }),
    )
    expect(await originalRequest).toBeInstanceOf(Error)
    expect((await currentRequest).accessToken).toBe('rotated-access')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(store.tokens?.refreshToken).toBe('rotated-refresh')
    expect((await client.getCredentials()).accessToken).toBe('next-access')
    const form = new URLSearchParams(fetchImpl.mock.calls[1][1]?.body as URLSearchParams)
    expect(form.get('refresh_token')).toBe('rotated-refresh')
  })

  it('rolls back a dispatched login save before cancellation completes', async () => {
    const gate = deferred<void>()
    const { client, store, fetchImpl } = clientFor()
    const save = vi.spyOn(store, 'save').mockImplementation(async (tokens) => {
      await gate.promise
      store.tokens = tokens
    })
    fetchImpl.mockResolvedValue(
      tokenResponse({
        access_token: 'canceled-access',
        refresh_token: 'canceled-refresh',
        expires_in: 3600,
      }),
    )
    try {
      const { callback } = await begin(client)
      await fetch(callback)
      await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1))
      const canceling = client.cancelLogin()
      gate.resolve()
      await canceling
      expect(store.tokens).toBeNull()
      expect(await client.getStatus()).toEqual({ state: 'disconnected' })
    } finally {
      gate.resolve()
    }
  })

  it('keeps committed refresh rotation usable when a replacement login is canceled', async () => {
    const gate = deferred<void>()
    const { client, store, fetchImpl } = clientFor(new MemoryStore(originalTokens()))
    const originalSave = store.save.bind(store)
    const save = vi.spyOn(store, 'save').mockImplementationOnce(async (tokens) => {
      await gate.promise
      await originalSave(tokens)
    })
    fetchImpl
      .mockResolvedValueOnce(
        tokenResponse({
          access_token: 'superseded-refresh',
          refresh_token: 'rotated-refresh',
          expires_in: 30,
        }),
      )
      .mockResolvedValueOnce(tokenResponse({ access_token: 'resumed-account', expires_in: 3600 }))
    const oldRequest = client.getCredentials().catch((error: Error) => error)
    try {
      await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1))
      const starting = client.startLogin()
      gate.resolve()
      expect((await starting).state).toBe('pending')
      expect(await oldRequest).toBeInstanceOf(Error)
      expect(store.tokens?.refreshToken).toBe('rotated-refresh')
      await client.cancelLogin()
      expect(await client.getStatus()).toEqual({ state: 'connected', expiresAt: NOW + 30_000 })
      expect((await client.getCredentials()).accessToken).toBe('resumed-account')
      const form = new URLSearchParams(fetchImpl.mock.calls[1][1]?.body as URLSearchParams)
      expect(form.get('refresh_token')).toBe('rotated-refresh')
    } finally {
      gate.resolve()
    }
  })
})
