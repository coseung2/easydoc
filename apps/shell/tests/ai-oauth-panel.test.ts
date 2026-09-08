/** @vitest-environment jsdom */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiOAuthStatus } from '@genoffice/ai-provider'
import type { HomeApi } from '../src/shared/home-api'
import { AiOAuthPanel } from '../src/renderer/src/AiOAuthPanel'
import { LocaleProvider } from '../src/renderer/src/locale'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let host: HTMLDivElement
let root: Root
let state: AiOAuthStatus
const api = {
  getAiOAuthStatus: vi.fn(async () => state),
  startAiOAuthLogin: vi.fn(async () => {
    state = { state: 'pending' }
    return state
  }),
  cancelAiOAuthLogin: vi.fn(async () => {
    state = { state: 'disconnected' }
  }),
  disconnectAiOAuth: vi.fn(async () => {
    state = { state: 'disconnected' }
  }),
  openAiOAuthLogin: vi.fn(async () => {}),
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  state = { state: 'disconnected' }
  api.getAiOAuthStatus.mockImplementation(async () => state)
  window.aiOffice = api as unknown as HomeApi
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

async function render() {
  await act(async () => {
    root.render(createElement(LocaleProvider, { initial: 'ko' }, createElement(AiOAuthPanel)))
  })
}
async function click(text: string) {
  const button = [...host.querySelectorAll('button')].find((item) =>
    item.textContent?.includes(text),
  )
  expect(button).toBeDefined()
  await act(async () => {
    button!.click()
  })
}

describe('ChatGPT OAuth settings controls', () => {
  it('starts browser sign-in, polls to connected, and disconnects', async () => {
    await render()
    await click('로그인')
    expect(api.startAiOAuthLogin).toHaveBeenCalledOnce()
    expect(host.textContent).toContain('브라우저에서 로그인을 완료')
    state = { state: 'connected' }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(host.textContent).toContain('ChatGPT 연결됨')
    await click('연결 해제')
    expect(api.disconnectAiOAuth).toHaveBeenCalledOnce()
    expect(host.textContent).toContain('ChatGPT에 연결되지 않음')
  })

  it('can reopen and cancel a pending login, then stops polling', async () => {
    state = { state: 'pending' }
    await render()
    await click('브라우저 열기')
    expect(api.openAiOAuthLogin).toHaveBeenCalledOnce()
    await click('취소')
    expect(api.cancelAiOAuthLogin).toHaveBeenCalledOnce()
    const count = api.getAiOAuthStatus.mock.calls.length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })
    expect(api.getAiOAuthStatus).toHaveBeenCalledTimes(count)
  })

  it('does not let a stale initial status overwrite a newer login', async () => {
    let resolveInitial!: (value: AiOAuthStatus) => void
    api.getAiOAuthStatus.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveInitial = resolve
        }),
    )
    await render()
    await click('로그인')
    await act(async () => {
      resolveInitial({ state: 'disconnected' })
    })
    expect(host.textContent).toContain('브라우저에서 로그인을 완료')
  })

  it('shows localized safe errors rather than raw credentials or exception bodies', async () => {
    state = { state: 'error', error: 'oauth_storage_error: secret-test-value' }
    await render()
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('안전한 인증정보 저장소')
    expect(host.textContent).not.toContain('secret-test-value')
  })
})
