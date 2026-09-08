import { describe, expect, it } from 'vitest'
import { activeProvider, defaultAiSettings, resolveAiSettings } from '../src/providers'

describe('public OAuth settings', () => {
  it('restores a saved keyless OpenAI model through account login', () => {
    const input = defaultAiSettings()
    input.provider = 'openai'
    input.providers.openai.model = 'gpt-5.6-luna'
    const resolved = resolveAiSettings(input, defaultAiSettings())
    expect(resolved.provider).toBe('openai')
    expect(resolved.providers.openai).toEqual({
      apiKey: '',
      model: 'gpt-5.6-luna',
      authMode: 'oauth',
    })
    const reopened = resolveAiSettings(JSON.parse(JSON.stringify(resolved)), defaultAiSettings())
    expect(reopened).toEqual(resolved)
  })

  it('does not turn an explicit API-key choice or custom endpoint into OAuth', () => {
    const input = defaultAiSettings()
    input.provider = 'openai'
    input.providers.openai.authMode = 'api-key'
    expect(resolveAiSettings(input, defaultAiSettings()).providers.openai.authMode).toBe('api-key')
    delete input.providers.openai.authMode
    input.providers.openai.baseUrl = 'https://example.test/v1'
    expect(resolveAiSettings(input, defaultAiSettings()).providers.openai.authMode).toBeUndefined()
  })

  it('keeps explicit ChatGPT OAuth selected without a renderer API key', () => {
    const settings = defaultAiSettings()
    settings.provider = 'openai'
    settings.providers.openai.authMode = 'oauth'
    expect(activeProvider(settings)).toBe('openai')
  })

  it('does not persist injected credentials or redirect URLs in OAuth settings', () => {
    const input = defaultAiSettings()
    input.provider = 'openai'
    Object.assign(input.providers.openai, {
      authMode: 'oauth',
      apiKey: 'renderer-key',
      baseUrl: 'https://example.invalid',
      accessToken: 'private-access',
      refreshToken: 'private-refresh',
      oauthAccountId: 'private-account',
    })
    const settings = resolveAiSettings(input, defaultAiSettings())
    expect(settings.providers.openai).toEqual({
      authMode: 'oauth',
      apiKey: '',
      model: input.providers.openai.model,
    })
    expect(JSON.stringify(settings)).not.toMatch(/renderer-key|private-|example.invalid/)
    expect(activeProvider(settings)).toBe('openai')
  })

  it('preserves supported API-key fields and removes unknown fields', () => {
    const input = defaultAiSettings()
    Object.assign(input.providers.openai, {
      apiKey: ' key ',
      model: ' model ',
      baseUrl: ' https://example.test/v1 ',
      authMode: 'api-key',
      refreshToken: 'private-refresh',
    })
    expect(resolveAiSettings(input, defaultAiSettings()).providers.openai).toEqual({
      apiKey: 'key',
      model: 'model',
      baseUrl: 'https://example.test/v1',
      authMode: 'api-key',
    })
  })
})
