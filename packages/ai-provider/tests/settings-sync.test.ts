import { describe, expect, it, vi } from 'vitest'
import { watchAiSettings } from '../src/settings-sync'
import { defaultAiSettings } from '../src/providers'
import type { AiSettings } from '../src/types'

describe('editor settings refresh', () => {
  it('refreshes on focus and ignores stale replies and replies after disposal', async () => {
    const pending: ((settings: AiSettings) => void)[] = []
    const load = vi.fn(() => new Promise<AiSettings>((resolve) => pending.push(resolve)))
    const apply = vi.fn()
    const events = new EventTarget()
    const stop = watchAiSettings(load, apply, events)
    const old = defaultAiSettings()
    const current = defaultAiSettings()
    current.provider = 'openai'
    current.providers.openai.model = 'gpt-6-astra'
    events.dispatchEvent(new Event('ai-settings-changed'))
    pending[1](current)
    await Promise.resolve()
    pending[0](old)
    await Promise.resolve()
    expect(apply).toHaveBeenCalledExactlyOnceWith(current)
    events.dispatchEvent(new Event('focus'))
    stop()
    pending[2](old)
    events.dispatchEvent(new Event('focus'))
    await Promise.resolve()
    expect(load).toHaveBeenCalledTimes(3)
    expect(apply).toHaveBeenCalledOnce()
  })

  it('retries a failed initial read on the next focus', async () => {
    const settings = defaultAiSettings()
    const load = vi.fn().mockRejectedValueOnce(new Error('IPC failed')).mockResolvedValue(settings)
    const apply = vi.fn()
    const events = new EventTarget()
    const stop = watchAiSettings(load, apply, events)
    await Promise.resolve()
    events.dispatchEvent(new Event('focus'))
    await Promise.resolve()
    expect(apply).toHaveBeenCalledExactlyOnceWith(settings)
    stop()
  })
})
