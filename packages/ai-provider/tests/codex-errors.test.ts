import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chatForProvider } from '../src/chat'
import { setRescueFetch } from '../src/fetch'
import { setOAuthCredentialResolver } from '../src/runtime-config'
import { streamForProvider } from '../src/stream'
import type { AiProviderConfig } from '../src/types'
import { errorResponse, okResponse, sseStream } from './test-utils'

// Deliberately synthetic credentials used only to exercise reflection boundaries.
const privateToken = 'synthetic-private-oauth-token-for-test'
const privateAccount = 'synthetic-private-account-for-test'
const reflected = JSON.stringify({
  authorization: `Bearer ${privateToken}`,
  account: privateAccount,
})
const config: AiProviderConfig = { apiKey: '', model: 'test-model', authMode: 'oauth' }

function eventResponse(event: unknown): Response {
  return okResponse(sseStream([`data: ${JSON.stringify(event)}`, '']))
}

beforeEach(() => {
  setOAuthCredentialResolver(async () => ({ accessToken: privateToken, accountId: privateAccount }))
})

afterEach(() => {
  setOAuthCredentialResolver(null)
  setRescueFetch(null)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const failures: Array<[string, () => Response | Promise<Response>]> = [
  ['HTTP authentication error', () => errorResponse(401, reflected)],
  [
    'HTTP JSON model error',
    () =>
      errorResponse(
        400,
        JSON.stringify({ error: { code: 'model_not_found', message: reflected } }),
      ),
  ],
  ['SSE top-level error', () => eventResponse({ error: { message: reflected } })],
  ['SSE error event', () => eventResponse({ type: 'error', message: reflected })],
  [
    'SSE failed response',
    () => eventResponse({ type: 'response.failed', response: { error: { message: reflected } } }),
  ],
  [
    'SSE rate limit error',
    () =>
      eventResponse({ type: 'error', error: { code: 'rate_limit_exceeded', message: reflected } }),
  ],
  [
    'SSE incomplete reason',
    () =>
      eventResponse({
        type: 'response.incomplete',
        response: { incomplete_details: { reason: reflected } },
      }),
  ],
  [
    'SSE invalid terminal status',
    () => eventResponse({ type: 'response.completed', response: { status: reflected } }),
  ],
  [
    'thrown fetch error with cause',
    () => Promise.reject(new Error(`fetch failed ${reflected}`, { cause: new Error(reflected) })),
  ],
  ['thrown non-Error fetch value', () => Promise.reject(reflected)],
]

describe.each(['chat', 'stream'] as const)('ChatGPT %s errors keep credentials private', (mode) => {
  it.each(failures)('does not expose credentials in %s', async (_name, result) => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(result))
    let publicError: unknown
    if (mode === 'chat') {
      const reply = await chatForProvider('openai', config, 'sys', 'hi')
      expect(reply.ok).toBe(false)
      publicError = reply.error
    } else {
      publicError = await streamForProvider('openai', config, 'sys', [], [], 10, {
        signal: new AbortController().signal,
        onDelta: () => {},
        onToolCall: () => {},
      }).catch((error: unknown) => error)
      expect(publicError).toBeInstanceOf(Error)
      expect(publicError).not.toHaveProperty('cause')
    }
    const visible =
      publicError instanceof Error
        ? `${publicError.message}\n${publicError.stack}\n${JSON.stringify(publicError)}`
        : String(publicError)
    expect(visible).not.toContain(privateToken)
    expect(visible).not.toContain(privateAccount)
    expect(visible).not.toContain(reflected)
    expect(visible).toMatch(/ChatGPT/)
  })
})

describe('ChatGPT safe error diagnostics', () => {
  it('does not log reflected credentials when the network rescue path fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error(`fetch failed ${reflected}`)))
    setRescueFetch(async () => {
      throw new Error(reflected)
    })
    const reply = await chatForProvider('openai', config, '', '')
    expect(reply).toEqual({
      ok: false,
      error: 'ChatGPT network error. Check your connection and try again.',
    })
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      '[ai-provider] fetch failed, retrying via rescue fetch',
    )
    expect(JSON.stringify(warn.mock.calls)).not.toContain(privateToken)
    expect(JSON.stringify(warn.mock.calls)).not.toContain(privateAccount)
  })

  it.each([
    ['rate_limit_exceeded', /rate limit reached/],
    ['usage_limit_reached', /usage limit has been reached/],
    ['model_not_found', /model is unavailable/],
  ])('preserves useful guidance for %s without raw error messages', async (code, message) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        eventResponse({
          type: 'response.failed',
          response: { error: { code, message: reflected } },
        }),
      ),
    )
    expect(await chatForProvider('openai', config, '', '')).toMatchObject({
      ok: false,
      error: expect.stringMatching(message),
    })
  })

  it('preserves caller cancellation identity during a response read', async () => {
    const controller = new AbortController()
    const reason = new Error('Caller stopped this request')
    let headersArrived!: () => void
    const ready = new Promise<void>((resolve) => {
      headersArrived = resolve
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse(new ReadableStream())))
    const request = streamForProvider('openai', config, '', [], [], 10, {
      signal: controller.signal,
      onDelta: () => {},
      onToolCall: () => {},
      onActivity: headersArrived,
    })
    const rejected = expect(request).rejects.toBe(reason)
    await ready
    controller.abort(reason)
    await rejected
  })
})
