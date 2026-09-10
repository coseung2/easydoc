/**
 * Hancom-rendered preview of the saved HWPX behind the current tab.
 *
 * A render costs a full Hancom start-up (~70s on the reference machine) and
 * drives a shared desktop resource, so it runs on the two events the UX
 * promises — the file arriving on disk and each successful save — plus an
 * explicit refresh. It is keyed on the document, not on whether the pane
 * happens to be visible, so the status a user opens the pane on always
 * describes the current saved file.
 *
 * A failure (no Hancom, its per-file security prompt, a timeout) latches: later
 * saves no longer trigger Hancom automatically, because on this machine a
 * blocked render leaves a modal that repeated attempts only pile onto. Only an
 * explicit refresh clears the latch.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { HwpxPreviewResponse } from '../shared/ipc'

export type HwpxPreviewStatus = 'idle' | 'loading' | 'ready' | 'failed'

export interface HwpxPreviewState {
  status: HwpxPreviewStatus
  /** PDF bytes of the last successful render (kept while a refresh runs). */
  pdf: Uint8Array | null
  /** SHA-256 of the saved file `pdf` was rendered from. */
  sourceHash: string | null
  hancomVersion: string | null
  /** the shown render came from the service cache rather than a fresh export */
  cached: boolean
  error: string | null
  /** savedRevision the shown render was made from (null until one succeeds) */
  renderedRevision: number | null
  /** a save (or a new file) happened since the last automatic attempt failed */
  paused: boolean
}

const IDLE: HwpxPreviewState = {
  status: 'idle',
  pdf: null,
  sourceHash: null,
  hancomVersion: null,
  cached: false,
  error: null,
  renderedRevision: null,
  paused: false,
}

export interface HwpxPreviewOptions {
  /** save path of the open document; a non-.hwpx path disables the preview */
  filePath: string | null
  /** bumped once per successful save of this document */
  savedRevision: number
  /** this document has a Hancom preview at all (an HWPX tab, not a docx one) */
  enabled: boolean
  /** injected in tests */
  request?: (force: boolean) => Promise<HwpxPreviewResponse>
}

export interface HwpxPreviewHandle {
  state: HwpxPreviewState
  /** the shown render is older than the current saved file */
  staleRender: boolean
  /** explicit refresh: ignores the cached render and clears the failure latch */
  refresh: () => void
}

const isHwpx = (path: string | null): boolean => !!path && /\.hwpx$/i.test(path)

export function useHwpxPreview(options: HwpxPreviewOptions): HwpxPreviewHandle {
  const { filePath, savedRevision, enabled } = options
  const [state, setState] = useState<HwpxPreviewState>(IDLE)
  // Only the newest request may publish. Bumped by every request, by a document
  // or revision change, and on unmount, so a slow render can never overwrite a
  // newer result or land after the document it described is gone.
  const requestSeq = useRef(0)
  /** the (file, revision) this hook last asked Hancom for */
  const attempt = useRef<{ file: string | null; revision: number } | null>(null)
  /** set by a failed attempt; blocks automatic renders until an explicit refresh */
  const failed = useRef(false)
  const requestRef = useRef(options.request)
  requestRef.current = options.request

  const run = useCallback((file: string, revision: number, force: boolean) => {
    attempt.current = { file, revision }
    const seq = ++requestSeq.current
    setState((prev) => ({ ...prev, status: 'loading', error: null, paused: false }))
    const invoke = requestRef.current ?? ((value: boolean) => window.desktop.previewHwpx(value))
    void invoke(force).then(
      (result) => {
        if (seq !== requestSeq.current) return
        if (!result.ok) {
          failed.current = true
          setState((prev) => ({ ...prev, status: 'failed', error: result.error }))
          return
        }
        failed.current = false
        setState({
          status: 'ready',
          pdf: result.bytes,
          sourceHash: result.sourceHash,
          hancomVersion: result.hancomVersion,
          cached: result.cached,
          error: null,
          renderedRevision: revision,
          paused: false,
        })
      },
      (failure: unknown) => {
        if (seq !== requestSeq.current) return
        failed.current = true
        setState((prev) => ({
          ...prev,
          status: 'failed',
          error: failure instanceof Error ? failure.message : String(failure),
        }))
      },
    )
  }, [])

  useEffect(() => {
    const active = enabled && isHwpx(filePath)
    const last = attempt.current
    const sameTarget = active && last?.file === filePath && last.revision === savedRevision
    // A different document (or a new revision) invalidates any in-flight render:
    // its result describes bytes this pane no longer shows.
    if (!sameTarget) requestSeq.current++
    if (last && last.file !== filePath) {
      // Another document owns another preview; showing the previous bytes under
      // the new file's name would misreport what Hancom produced.
      attempt.current = null
      failed.current = false
      setState(IDLE)
    }
    if (!active || sameTarget) return
    if (failed.current) {
      // Latched: the user decides when Hancom is tried again.
      setState((prev) => ({ ...prev, paused: true }))
      return
    }
    run(filePath as string, savedRevision, false)
  }, [enabled, filePath, savedRevision, run])

  // Unmount: nothing may publish into a gone component.
  useEffect(
    () => () => {
      requestSeq.current++
    },
    [],
  )

  const refresh = useCallback(() => {
    if (!enabled || !isHwpx(filePath)) return
    failed.current = false
    run(filePath as string, savedRevision, true)
  }, [enabled, filePath, savedRevision, run])

  return {
    state,
    staleRender: state.renderedRevision !== null && state.renderedRevision !== savedRevision,
    refresh,
  }
}
