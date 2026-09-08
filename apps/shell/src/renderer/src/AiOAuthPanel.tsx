import { useEffect, useRef, useState } from 'react'
import type { AiOAuthStatus } from '@genoffice/ai-provider'
import { useI18n } from './locale'

export function AiOAuthPanel() {
  const { t } = useI18n()
  const [status, setStatus] = useState<AiOAuthStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const mounted = useRef(false)
  const revision = useRef(0)

  useEffect(() => {
    mounted.current = true
    const current = ++revision.current
    void window.aiOffice
      .getAiOAuthStatus()
      .then((value) => {
        if (mounted.current && current === revision.current) setStatus(value)
      })
      .catch(() => {
        if (mounted.current && current === revision.current) setError('oauth_failed')
      })
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    if (status?.state !== 'pending' || busy) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      const current = revision.current
      try {
        const next = await window.aiOffice.getAiOAuthStatus()
        if (!cancelled && current === revision.current) {
          setStatus(next)
          if (next.state !== 'pending') return
        }
      } catch {
        // The login has its own timeout; a transient IPC failure does not stop polling.
      }
      if (!cancelled) timer = setTimeout(() => void poll(), 1000)
    }
    timer = setTimeout(() => void poll(), 1000)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [status?.state, busy])

  const run = async (operation: () => Promise<unknown>) => {
    const current = ++revision.current
    setBusy(true)
    setError('')
    try {
      await operation()
      const next = await window.aiOffice.getAiOAuthStatus()
      if (mounted.current && current === revision.current) setStatus(next)
    } catch (cause) {
      if (mounted.current && current === revision.current) {
        setError(cause instanceof Error ? cause.message : 'oauth_failed')
      }
    } finally {
      if (mounted.current && current === revision.current) setBusy(false)
    }
  }

  const failure = error || status?.error
  const failureKey = failure?.includes('storage')
    ? 'setAiOAuthStorage'
    : failure?.includes('port')
      ? 'setAiOAuthPort'
      : 'setAiOAuthError'
  const pending = status?.state === 'pending'
  const connected = status?.state === 'connected'

  return (
    <section className="set-oauth" aria-label="ChatGPT OAuth">
      <p role="status" aria-live="polite">
        {t(
          pending
            ? 'setAiOAuthPending'
            : connected
              ? 'setAiOAuthConnected'
              : 'setAiOAuthDisconnected',
        )}
      </p>
      {failure ? <p role="alert">{t(failureKey)}</p> : null}
      <div className="set-oauth-actions">
        {pending ? (
          <>
            <button
              className="set-btn"
              disabled={busy}
              onClick={() => void run(() => window.aiOffice.openAiOAuthLogin())}
            >
              {t('setAiOAuthOpenBrowser')}
            </button>
            <button
              className="set-btn"
              disabled={busy}
              onClick={() => void run(() => window.aiOffice.cancelAiOAuthLogin())}
            >
              {t('cancel')}
            </button>
          </>
        ) : connected ? (
          <button
            className="set-btn"
            disabled={busy}
            onClick={() => void run(() => window.aiOffice.disconnectAiOAuth())}
          >
            {t('easyDocDisconnect')}
          </button>
        ) : (
          <button
            className="set-btn primary"
            disabled={busy}
            onClick={() => void run(() => window.aiOffice.startAiOAuthLogin())}
          >
            ChatGPT · {t('login')}
          </button>
        )}
      </div>
    </section>
  )
}
