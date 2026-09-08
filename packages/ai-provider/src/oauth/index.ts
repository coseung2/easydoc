import { createHash, randomBytes } from 'node:crypto'
import type { AiOAuthStatus } from '../types'
import { openCallbackServer, type CallbackServer } from './callback'

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize'
const TOKEN_URL = 'https://auth.openai.com/oauth/token'
const REFRESH_MARGIN_MS = 60_000
const SIGN_IN_FAILED = 'ChatGPT sign-in failed. Please try again.'
const SESSION_EXPIRED = 'Your ChatGPT session expired. Sign in again.'
const TEMPORARY_ERROR = 'ChatGPT authentication is temporarily unavailable. Try again.'
const STORAGE_ERROR = 'ChatGPT account storage is unavailable.'
const SIGN_IN_CHANGED = 'ChatGPT sign-in changed. Retry the request.'

export interface OAuthTokens {
  accessToken: string
  refreshToken: string
  expiresAt: number
  accountId?: string
}

export interface OAuthTokenStore {
  load(): Promise<OAuthTokens | null>
  save(tokens: OAuthTokens): Promise<void>
  clear(): Promise<void>
}

interface LoginAttempt {
  generation: number
  state: string
  verifier: string
  abort: AbortController
  setup: Promise<CallbackServer | undefined>
  timer?: ReturnType<typeof setTimeout>
  authorizationUrl?: string
}

class TokenError extends Error {
  constructor(readonly invalidGrant = false) {
    super(invalidGrant ? SESSION_EXPIRED : TEMPORARY_ERROR)
  }
}

function validTokens(value: OAuthTokens | null): value is OAuthTokens {
  return Boolean(
    value &&
    typeof value.accessToken === 'string' &&
    value.accessToken.trim() &&
    typeof value.refreshToken === 'string' &&
    value.refreshToken.trim() &&
    Number.isFinite(value.expiresAt) &&
    value.expiresAt > 0,
  )
}

function accountIdFromTokens(...tokens: unknown[]): string | undefined {
  for (const token of tokens) {
    if (typeof token !== 'string') continue
    try {
      const encoded = token.split('.')[1]
      if (!encoded) continue
      const claims = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
      const accountId =
        claims?.['https://api.openai.com/auth']?.chatgpt_account_id ?? claims?.chatgpt_account_id
      if (typeof accountId === 'string' && /^[A-Za-z0-9_-]{1,256}$/u.test(accountId))
        return accountId
    } catch {
      // These unverified claims only select the account accompanying the bearer token.
    }
  }
  return undefined
}

export class ChatGptOAuthClient {
  private readonly store: OAuthTokenStore
  private readonly fetchImpl: typeof globalThis.fetch
  private readonly callbackPort: number
  private readonly timeoutMs: number
  private readonly now: () => number
  private tokens: OAuthTokens | null | undefined
  private loading?: Promise<void>
  private storageQueue: Promise<void> = Promise.resolve()
  private generation = 0
  private credentialVersion = 0
  private pending?: LoginAttempt
  private error?: string
  private refresh?: {
    credentialVersion: number
    abort: AbortController
    promise: Promise<OAuthTokens>
  }

  constructor(options: {
    store: OAuthTokenStore
    fetch?: typeof globalThis.fetch
    callbackPort?: number
    timeoutMs?: number
    now?: () => number
  }) {
    this.store = options.store
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.callbackPort = options.callbackPort ?? 1455
    this.timeoutMs = options.timeoutMs ?? 300_000
    this.now = options.now ?? Date.now
    if (
      !Number.isInteger(this.callbackPort) ||
      this.callbackPort < 0 ||
      this.callbackPort > 65535 ||
      !Number.isFinite(this.timeoutMs) ||
      this.timeoutMs <= 0
    ) {
      throw new Error('Invalid ChatGPT sign-in options.')
    }
  }

  async getStatus(): Promise<AiOAuthStatus> {
    if (this.pending) return this.pendingStatus(this.pending)
    try {
      await this.ensureLoaded()
    } catch {
      return { state: 'error', error: STORAGE_ERROR }
    }
    if (this.pending) return this.pendingStatus(this.pending)
    if (this.error) return { state: 'error', error: this.error }
    if (this.tokens) return { state: 'connected', expiresAt: this.tokens.expiresAt }
    return { state: 'disconnected' }
  }

  async startLogin(): Promise<AiOAuthStatus> {
    const previous = this.pending
    const generation = ++this.generation
    // A refresh may rotate its grant while the user starts another login. Let it
    // finish for the prior account until a new account commits or disconnect clears it.
    this.error = undefined
    const attempt: LoginAttempt = {
      generation,
      state: randomBytes(32).toString('base64url'),
      verifier: randomBytes(32).toString('base64url'),
      abort: new AbortController(),
      setup: Promise.resolve(undefined),
    }
    this.pending = attempt
    attempt.setup = (async () => {
      await this.closeAttempt(previous)
      if (!this.isCurrent(attempt)) return undefined
      // Check secure storage before offering a browser login, even if credentials are cached.
      await this.withStore(async () => {
        if (!this.isCurrent(attempt)) return
        let tokens: OAuthTokens | null
        try {
          tokens = await this.store.load()
        } catch {
          throw new Error(STORAGE_ERROR)
        }
        if (tokens !== null && !validTokens(tokens)) throw new Error(STORAGE_ERROR)
        if (this.isCurrent(attempt)) this.tokens = tokens ? { ...tokens } : null
      })
      if (!this.isCurrent(attempt)) return undefined
      return openCallbackServer({
        port: this.callbackPort,
        state: attempt.state,
        onCode: (code) => {
          void this.completeLogin(attempt, code)
        },
        onDenied: () => {
          void this.failLogin(attempt, SIGN_IN_FAILED)
        },
      })
    })()
    attempt.timer = setTimeout(() => {
      void this.failLogin(attempt, 'ChatGPT sign-in timed out. Please try again.')
    }, this.timeoutMs)
    attempt.timer.unref?.()
    try {
      const callback = await attempt.setup
      if (!callback || !this.isCurrent(attempt)) {
        await callback?.close()
        return this.getStatus()
      }
      const params = new URLSearchParams({
        client_id: CLIENT_ID,
        response_type: 'code',
        redirect_uri: callback.redirectUri,
        scope: 'openid profile email offline_access',
        state: attempt.state,
        code_challenge: createHash('sha256').update(attempt.verifier).digest('base64url'),
        code_challenge_method: 'S256',
        codex_cli_simplified_flow: 'true',
        id_token_add_organizations: 'true',
        originator: 'genoffice',
      })
      attempt.authorizationUrl = `${AUTHORIZE_URL}?${params}`
      return this.pendingStatus(attempt)
    } catch (error) {
      await this.failLogin(
        attempt,
        error instanceof Error && error.message === STORAGE_ERROR
          ? STORAGE_ERROR
          : 'ChatGPT sign-in callback port is unavailable. Please try again.',
      )
      return this.getStatus()
    }
  }

  async cancelLogin(): Promise<void> {
    const attempt = this.pending
    if (!attempt) return
    ++this.generation
    this.pending = undefined
    this.error = undefined
    await Promise.all([this.closeAttempt(attempt), this.withStore(async () => undefined)])
  }

  async disconnect(): Promise<void> {
    const generation = ++this.generation
    ++this.credentialVersion
    const attempt = this.pending
    this.pending = undefined
    this.refresh?.abort.abort()
    this.refresh = undefined
    this.tokens = null
    this.error = undefined
    const clearing = this.withStore(async () => {
      try {
        await this.store.clear()
      } catch {
        if (this.generation === generation) this.error = STORAGE_ERROR
        throw new Error(STORAGE_ERROR)
      }
    })
    await Promise.all([this.closeAttempt(attempt), clearing])
  }

  async getCredentials(): Promise<{ accessToken: string; accountId?: string }> {
    await this.ensureLoaded()
    if (this.pending) throw new Error('Complete ChatGPT sign-in before sending a request.')
    if (!this.tokens) throw new Error('Sign in to ChatGPT to continue.')
    const generation = this.generation
    const credentialVersion = this.credentialVersion
    let tokens = this.tokens
    if (tokens.expiresAt <= this.now() + REFRESH_MARGIN_MS) {
      if (!this.refresh || this.refresh.credentialVersion !== credentialVersion) {
        const abort = new AbortController()
        const promise = this.refreshTokens(tokens, generation, credentialVersion, abort.signal)
        const flight = { credentialVersion, abort, promise }
        this.refresh = flight
        void promise
          .finally(() => {
            if (this.refresh === flight) this.refresh = undefined
          })
          .catch(() => undefined)
      }
      tokens = await this.refresh.promise
    }
    if (this.generation !== generation) throw new Error(SIGN_IN_CHANGED)
    return {
      accessToken: tokens.accessToken,
      ...(tokens.accountId ? { accountId: tokens.accountId } : {}),
    }
  }

  private pendingStatus(attempt: LoginAttempt): AiOAuthStatus {
    return {
      state: 'pending',
      ...(attempt.authorizationUrl ? { authorizationUrl: attempt.authorizationUrl } : {}),
    }
  }

  private isCurrent(attempt: LoginAttempt): boolean {
    return (
      this.pending === attempt &&
      this.generation === attempt.generation &&
      !attempt.abort.signal.aborted
    )
  }

  private async closeAttempt(attempt?: LoginAttempt): Promise<void> {
    if (!attempt) return
    attempt.abort.abort()
    clearTimeout(attempt.timer)
    try {
      await (await attempt.setup)?.close()
    } catch {
      // Failed setup already closes any listeners it created.
    }
  }

  private async failLogin(attempt: LoginAttempt, message: string): Promise<void> {
    if (!this.isCurrent(attempt)) return
    ++this.generation
    this.pending = undefined
    this.error = message
    await this.closeAttempt(attempt)
  }

  private async completeLogin(attempt: LoginAttempt, code: string): Promise<void> {
    if (!this.isCurrent(attempt)) return
    try {
      const callback = await attempt.setup
      if (!callback || !this.isCurrent(attempt)) return
      const tokens = await this.requestTokens(
        {
          grant_type: 'authorization_code',
          code,
          redirect_uri: callback.redirectUri,
          code_verifier: attempt.verifier,
        },
        attempt.abort.signal,
      )
      if (!this.isCurrent(attempt)) return
      if (!(await this.saveTokens(tokens, attempt.generation, 'login'))) return
      if (!this.isCurrent(attempt)) return
      this.pending = undefined
      this.error = undefined
      this.refresh?.abort.abort()
      this.refresh = undefined
      await this.closeAttempt(attempt)
    } catch {
      await this.failLogin(attempt, SIGN_IN_FAILED)
    }
  }

  private async refreshTokens(
    previous: OAuthTokens,
    generation: number,
    credentialVersion: number,
    signal: AbortSignal,
  ): Promise<OAuthTokens> {
    try {
      const tokens = await this.requestTokens(
        { grant_type: 'refresh_token', refresh_token: previous.refreshToken },
        signal,
        previous,
      )
      if (!(await this.saveTokens(tokens, generation, 'refresh', credentialVersion)))
        throw new Error(SIGN_IN_CHANGED)
      if (this.credentialVersion !== credentialVersion) throw new Error(SIGN_IN_CHANGED)
      if (this.generation === generation) this.error = undefined
      return tokens
    } catch (error) {
      // OAuth failures cross IPC; raw causes may contain private request data.
      // eslint-disable-next-line preserve-caught-error
      if (this.credentialVersion !== credentialVersion) throw new Error(SIGN_IN_CHANGED)
      if (error instanceof TokenError && error.invalidGrant) {
        this.tokens = null
        await this.withStore(async () => {
          if (this.credentialVersion !== credentialVersion) return
          try {
            await this.store.clear()
          } catch {
            throw new Error(STORAGE_ERROR)
          }
        })
      }
      if (this.generation === generation) {
        this.error = error instanceof TokenError ? error.message : TEMPORARY_ERROR
      }
      // eslint-disable-next-line preserve-caught-error -- Only sanitized OAuth diagnostics may escape.
      throw new Error(error instanceof TokenError ? error.message : TEMPORARY_ERROR)
    }
  }

  private async requestTokens(
    fields: Record<string, string>,
    signal: AbortSignal,
    previous?: OAuthTokens,
  ): Promise<OAuthTokens> {
    let response: Response
    let data: Record<string, unknown>
    try {
      response = await this.fetchImpl(TOKEN_URL, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: new URLSearchParams({ client_id: CLIENT_ID, ...fields }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(Math.min(this.timeoutMs, 30_000))]),
      })
      const value: unknown = await response.json()
      data = value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
    } catch {
      throw new TokenError()
    }
    if (!response.ok)
      throw new TokenError(
        (response.status === 400 || response.status === 401) && data.error === 'invalid_grant',
      )
    const refreshToken =
      typeof data.refresh_token === 'string' && data.refresh_token.trim()
        ? data.refresh_token
        : previous?.refreshToken
    const expiresAt = this.now() + Number(data.expires_in) * 1000
    if (
      typeof data.access_token !== 'string' ||
      !data.access_token.trim() ||
      !refreshToken ||
      typeof data.expires_in !== 'number' ||
      data.expires_in <= 0 ||
      !Number.isFinite(expiresAt)
    )
      throw new TokenError()
    const accountId = accountIdFromTokens(data.id_token, data.access_token) ?? previous?.accountId
    return {
      accessToken: data.access_token,
      refreshToken,
      expiresAt,
      ...(accountId ? { accountId } : {}),
    }
  }

  private withStore<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.storageQueue.then(operation)
    this.storageQueue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private async ensureLoaded(): Promise<void> {
    if (this.tokens !== undefined) return
    if (!this.loading) {
      const generation = this.generation
      this.loading = this.withStore(async () => {
        let tokens: OAuthTokens | null
        try {
          tokens = await this.store.load()
        } catch {
          throw new Error(STORAGE_ERROR)
        }
        if (tokens !== null && !validTokens(tokens)) throw new Error(STORAGE_ERROR)
        if (this.generation === generation) this.tokens = tokens ? { ...tokens } : null
      }).finally(() => {
        this.loading = undefined
      })
    }
    await this.loading
    if (this.tokens === undefined && !this.pending) await this.ensureLoaded()
  }

  private saveTokens(
    tokens: OAuthTokens,
    generation: number,
    source: 'login' | 'refresh',
    credentialVersion = this.credentialVersion,
  ): Promise<boolean> {
    return this.withStore(async () => {
      if (
        source === 'refresh'
          ? this.credentialVersion !== credentialVersion
          : this.generation !== generation
      )
        return false
      const previous = this.tokens
      try {
        await this.store.save({ ...tokens })
      } catch {
        throw new Error(STORAGE_ERROR)
      }
      if (source === 'refresh') {
        // A pending replacement login still owns the prior account until it commits.
        // Keep valid rotation for that account, while disconnect/replacement commits
        // invalidate its version and cannot be overwritten by a late refresh.
        if (this.credentialVersion !== credentialVersion) return false
        this.tokens = tokens
        return true
      }
      if (this.generation !== generation) {
        // A canceled login may already have dispatched its disk write. Restore the
        // prior account before the next generation's queued work runs.
        try {
          if (previous) await this.store.save({ ...previous })
          else await this.store.clear()
        } catch {
          throw new Error(STORAGE_ERROR)
        }
        return false
      }
      this.tokens = tokens
      ++this.credentialVersion
      return true
    })
  }
}
