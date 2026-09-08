import { describe, expect, it } from 'vitest'
import { defaultAiSettings, resolveAiSettings } from '../src/providers'
import { OPENAI_REASONING_EFFORTS } from '../src/reasoning'
import { runtimeAiConfig } from '../src/runtime-config'
import type { AiProviderConfig } from '../src/types'

describe('reasoning configuration across public/runtime settings', () => {
  it.each(OPENAI_REASONING_EFFORTS)(
    'preserves %s on save/read and API-key execution',
    async (effort) => {
      const settings = defaultAiSettings()
      settings.provider = 'openai'
      settings.providers.openai = {
        apiKey: 'test-key',
        model: 'gpt-5.6-luna',
        authMode: 'api-key',
        reasoningEffort: effort,
      }
      settings.aiRules = 'Keep source figures unchanged.'
      settings.userSkills = [
        { id: 'private', name: 'Private', description: '', content: 'local-only' },
      ]
      const persisted = resolveAiSettings(settings, defaultAiSettings())
      expect(persisted.providers.openai.reasoningEffort).toBe(effort)
      expect(persisted.aiRules).toBe(settings.aiRules)
      expect(persisted).not.toHaveProperty('userSkills')
      const runtime = await runtimeAiConfig('openai', persisted.providers.openai)
      expect(runtime.reasoningEffort).toBe(effort)
    },
  )

  it('does not forward invalid effort or unknown credential fields', async () => {
    const config = {
      apiKey: 'test-key',
      model: 'gpt-5.6-luna',
      reasoningEffort: 'invented',
      oauthAccountId: 'must-not-leak',
      refreshToken: 'must-not-leak',
    } as unknown as AiProviderConfig
    const settings = defaultAiSettings()
    settings.providers.openai = config
    const persisted = resolveAiSettings(settings, defaultAiSettings())
    expect(persisted.providers.openai).not.toHaveProperty('reasoningEffort')
    expect(persisted.providers.openai).not.toHaveProperty('refreshToken')
    expect(await runtimeAiConfig('openai', config)).toEqual({
      apiKey: 'test-key',
      model: 'gpt-5.6-luna',
      baseUrl: undefined,
    })
  })
})
