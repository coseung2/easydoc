import { describe, expect, it } from 'vitest'
import { defaultAiSettings, resolveAiSettings, type AiSettings } from '@genoffice/ai-provider'
import {
  aiChatRequestSchema,
  aiSettingsInputSchema,
  aiStreamRequestSchema,
} from '../src/shared/desktop-api'

const oauthSettings = () => ({
  provider: 'openai',
  providers: {
    openai: { apiKey: '', model: 'gpt-5', authMode: 'oauth' as const },
  },
})

describe('AI authentication settings at the Sheets IPC boundary', () => {
  it('preserves OAuth mode through settings, chat, and stream validation without an API key', () => {
    const settings = oauthSettings()
    const validated = [
      aiSettingsInputSchema.parse(settings),
      aiChatRequestSchema.parse({ settings, system: 'test', user: 'ping' }).settings,
      aiStreamRequestSchema.parse({ requestId: 'test', settings, system: 'test', messages: [] })
        .settings,
    ]

    for (const result of validated) {
      expect(result.providers.openai).toEqual(settings.providers.openai)
    }
  })

  it.each(['accessToken', 'refreshToken', 'oauthAccountId'])(
    'rejects renderer-supplied %s',
    (field) => {
      const settings = oauthSettings()
      const input = {
        ...settings,
        providers: { openai: { ...settings.providers.openai, [field]: 'untrusted-value' } },
      }

      expect(aiSettingsInputSchema.safeParse(input).success).toBe(false)
      expect(aiChatRequestSchema.safeParse({ settings: input, system: '', user: '' }).success).toBe(
        false,
      )
      expect(
        aiStreamRequestSchema.safeParse({
          requestId: 'test',
          settings: input,
          system: '',
          messages: [],
        }).success,
      ).toBe(false)
    },
  )

  it('retains legacy API-key settings and rejects unknown authentication modes', () => {
    const config = { apiKey: 'user-provided-key', model: 'test-model' }
    const settings = { provider: 'openai', providers: { openai: config } }
    expect(aiSettingsInputSchema.parse(settings).providers.openai).toEqual(config)
    expect(
      aiSettingsInputSchema.safeParse({
        ...settings,
        providers: { openai: { ...config, authMode: 'bearer-token' } },
      }).success,
    ).toBe(false)
  })

  it('removes renderer credentials and endpoint overrides before saving parsed OAuth settings', () => {
    const input = oauthSettings()
    const settings = aiSettingsInputSchema.parse({
      ...input,
      providers: {
        openai: {
          ...input.providers.openai,
          apiKey: 'renderer-supplied-token',
          baseUrl: 'https://untrusted.example/v1',
        },
      },
    })
    const saved = resolveAiSettings(settings as Partial<AiSettings>, defaultAiSettings())

    expect(saved.providers.openai).toEqual({ apiKey: '', model: 'gpt-5', authMode: 'oauth' })
    expect(JSON.stringify(saved)).not.toContain('renderer-supplied-token')
    expect(JSON.stringify(saved)).not.toContain('untrusted.example')
  })
})
