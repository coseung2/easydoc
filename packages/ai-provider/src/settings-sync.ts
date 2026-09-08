import type { AiSettings } from './types'

/** Reload when an editor regains focus after changes in the shell settings. */
export function watchAiSettings(
  load: () => Promise<AiSettings>,
  apply: (settings: AiSettings) => void,
  events: EventTarget = window,
): () => void {
  let revision = 0
  let disposed = false
  const refresh = () => {
    const current = ++revision
    void load()
      .then((settings) => {
        if (!disposed && current === revision) apply(settings)
      })
      .catch(() => {
        // Preserve the last loaded settings; the next focus retries a failed IPC read.
      })
  }
  events.addEventListener('focus', refresh)
  // The preload forwards a payload-free notification after settings are saved.
  events.addEventListener('ai-settings-changed', refresh)
  refresh()
  return () => {
    disposed = true
    events.removeEventListener('focus', refresh)
    events.removeEventListener('ai-settings-changed', refresh)
  }
}
