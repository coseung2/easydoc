import { afterEach, describe, expect, it, vi } from 'vitest'
import { chatForProvider } from '../src/chat'
import {
  runtimeAiConfig,
  setOAuthCredentialResolver,
  type OAuthCredentials,
} from '../src/runtime-config'
import { streamForProvider } from '../src/stream'
import type { AiProviderConfig } from '../src/types'

const config: AiProviderConfig = { apiKey: '', model: 'gpt-5.6', authMode: 'oauth' }

afterEach(() => {
  setOAuthCredentialResolver(null)
  vi.unstubAllGlobals()
})

describe('OAuth request cancellation during credential refresh', () => {
  it('rejects pre-cancelled requests without starting a refresh', async () => {
    const resolver = vi.fn()
    setOAuthCredentialResolver(resolver)
    const controller = new AbortController()
    const reason = new Error('Cancelled before refresh')
    controller.abort(reason)
    await expect(runtimeAiConfig('openai', config, controller.signal)).rejects.toBe(reason)
    expect(resolver).not.toHaveBeenCalled()
  })

  it.each(['chat', 'stream'] as const)(
    'promptly cancels %s while a shared refresh continues',
    async (mode) => {
      let resolveCredentials!: (credentials: OAuthCredentials) => void
      const credentials = new Promise<OAuthCredentials>((resolve) => {
        resolveCredentials = resolve
      })
      setOAuthCredentialResolver(() => credentials)
      const controller = new AbortController()
      const removeListener = vi.spyOn(controller.signal, 'removeEventListener')
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)
      const request =
        mode === 'chat'
          ? chatForProvider('openai', config, '', '', controller.signal)
          : streamForProvider('openai', config, '', [], [], 10, {
              signal: controller.signal,
              onDelta: () => {},
              onToolCall: () => {},
            })
      const otherRequest = runtimeAiConfig('openai', config)
      const reason = new Error('Caller cancelled')
      const cancelled = expect(request).rejects.toBe(reason)
      controller.abort(reason)
      await cancelled
      expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function))
      expect(fetchMock).not.toHaveBeenCalled()

      resolveCredentials({ accessToken: 'refreshed-token' })
      await expect(otherRequest).resolves.toMatchObject({
        apiKey: 'refreshed-token',
        authMode: 'oauth',
      })
      expect(fetchMock).not.toHaveBeenCalled()
    },
  )

  it('handles a late refresh rejection after its waiter was cancelled', async () => {
    let rejectCredentials!: (error: Error) => void
    setOAuthCredentialResolver(
      () =>
        new Promise((_, reject) => {
          rejectCredentials = reject
        }),
    )
    const controller = new AbortController()
    const request = runtimeAiConfig('openai', config, controller.signal)
    const cancelled = expect(request).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    await cancelled
    rejectCredentials(new Error('Refresh failed after cancellation'))
    // Vitest reports unhandled rejections; allow the late failure handler to run.
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

  it('removes its abort listener when refresh completes normally', async () => {
    setOAuthCredentialResolver(async () => ({ accessToken: 'token' }))
    const controller = new AbortController()
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener')
    await expect(runtimeAiConfig('openai', config, controller.signal)).resolves.toMatchObject({
      apiKey: 'token',
    })
    expect(removeListener).toHaveBeenCalledExactlyOnceWith('abort', expect.any(Function))
  })
})
