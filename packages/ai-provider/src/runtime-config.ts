import type { AiProviderConfig, AiProviderId } from './types'
import { normalizeReasoningEffort } from './reasoning'

export interface OAuthCredentials {
  accessToken: string
  accountId?: string | undefined
}

export interface RuntimeAiConfig extends AiProviderConfig {
  oauthAccountId?: string | undefined
}

let resolveOAuthCredentials: (() => Promise<OAuthCredentials>) | null = null

/** Installed by the Electron main process; never by a preload or renderer. */
export function setOAuthCredentialResolver(
  resolver: (() => Promise<OAuthCredentials>) | null,
): void {
  resolveOAuthCredentials = resolver
}

/** Cancel this waiter without interrupting a refresh shared by other requests. */
function waitForCredentials(
  credentials: Promise<OAuthCredentials>,
  signal?: AbortSignal,
): Promise<OAuthCredentials> {
  if (!signal) return credentials
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    const onAbort = () => {
      cleanup()
      reject(signal.reason)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    // Keep both handlers attached after cancellation: a late failed refresh must
    // not become an unhandled rejection after its original caller has left.
    credentials.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error: unknown) => {
        cleanup()
        reject(error)
      },
    )
    if (signal.aborted) onAbort()
  })
}

export async function runtimeAiConfig(
  provider: AiProviderId,
  config: AiProviderConfig,
  signal?: AbortSignal,
): Promise<RuntimeAiConfig> {
  signal?.throwIfAborted()
  if (config.authMode !== 'oauth') {
    const reasoningEffort = normalizeReasoningEffort(config.reasoningEffort)
    return {
      apiKey: config.apiKey,
      model: config.model,
      baseUrl: config.baseUrl,
      ...(reasoningEffort ? { reasoningEffort } : {}),
    }
  }
  if (provider !== 'openai') throw new Error('OAuth is not supported for this provider.')
  if (!resolveOAuthCredentials) throw new Error('Sign in to ChatGPT in GenOffice Settings.')
  const credentials = await waitForCredentials(resolveOAuthCredentials(), signal)
  // Never forward renderer-supplied keys, account ids, or endpoints for OAuth.
  return {
    model: config.model,
    authMode: 'oauth',
    apiKey: credentials.accessToken,
    oauthAccountId: credentials.accountId,
  }
}
