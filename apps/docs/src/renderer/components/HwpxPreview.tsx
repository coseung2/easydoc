/**
 * Read-only view of the PDF that the installed Hancom Office exported from the
 * saved HWPX. It shows what Hancom made of the file on disk, so it lags the
 * editor by design: the caller mounts it in place of the editor's scroller
 * (the editor itself stays mounted) and tells it when the buffer is dirty.
 * Rendering reuses the same pdf.js setup as the PDF app (worker bundled,
 * CMaps/standard fonts/wasm copied into the renderer output).
 */
import { useEffect, useRef, useState } from 'react'
import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'
import { useI18n } from '../i18n/locale'
import type { HwpxPreviewState } from '../use-hwpx-preview'

GlobalWorkerOptions.workerSrc = workerUrl

// Non-embedded fonts (CJK above all) need these data directories; the build
// copies them next to the renderer entry, so the same URL works in dev.
const ASSET_BASE = new URL('pdfjs/', document.baseURI).href
const DOC_OPTS = {
  cMapUrl: `${ASSET_BASE}cmaps/`,
  cMapPacked: true,
  standardFontDataUrl: `${ASSET_BASE}standard_fonts/`,
  wasmUrl: `${ASSET_BASE}wasm/`,
}

/** Page bitmaps at up to 2x device pixels: beyond that memory doubles for no visible gain. */
const MAX_DPR = 2

export function HwpxPreview({
  state,
  dirty,
  onRefresh,
}: {
  state: HwpxPreviewState
  /** the editor holds unsaved edits, so this render is behind the document */
  dirty: boolean
  onRefresh: () => void
}) {
  const { t } = useI18n()
  const pagesRef = useRef<HTMLDivElement>(null)
  const [renderError, setRenderError] = useState<string | null>(null)
  // The pages on screen were drawn from these bytes. New bytes are a different
  // revision of the saved file, so they may not be shown under the old ones;
  // the same bytes at a new width are a redraw of what the user already sees.
  const paintedRef = useRef<Uint8Array | null>(null)
  const [drawing, setDrawing] = useState(false)
  // useI18n hands out a fresh translator per render, so the draw effect reads
  // it through a ref: depending on it directly would restart the render on
  // every state change it causes.
  const tRef = useRef(t)
  tRef.current = t
  // Pages are laid out to the pane's width, which is unknown until this
  // component is mounted and visible, and changes when the window or the AI
  // dock resizes. Re-rendering on the observed width keeps the first paint
  // correct instead of falling back to an arbitrary scale.
  const [paneWidth, setPaneWidth] = useState(0)
  const pdf = state.pdf

  useEffect(() => {
    const host = pagesRef.current
    if (!host) return
    const measure = () => setPaneWidth(host.clientWidth)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(host)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const host = pagesRef.current
    if (!host) return
    // Nothing to show (another document took over, or its render failed): the
    // previous file's pages must not stay under the new file's name.
    if (!pdf) {
      host.replaceChildren()
      paintedRef.current = null
      setDrawing(false)
      return
    }
    if (paneWidth <= 0) return
    // Same bytes at a new width: a redraw of what the user already sees, so the
    // status keeps describing the render on screen. Different bytes: a newer
    // saved file that nothing has drawn yet.
    const redraw = paintedRef.current === pdf
    if (!redraw) {
      host.replaceChildren()
      paintedRef.current = null
      setDrawing(true)
    }
    setRenderError(null)
    let cancelled = false
    let loaded: PDFDocumentProxy | null = null
    // A width change (window resize, AI dock collapse) redraws pages that are
    // already on screen: they stay until the whole new set is ready, so the
    // pane is never blank in between. With nothing to preserve — a first paint,
    // or a newly rendered file — pages appear as they finish instead.
    const progressive = host.childElementCount === 0
    // pdf.js takes ownership of the buffer it is handed; copy so a later
    // re-render (or a retry) still has the original bytes to work from.
    const task = getDocument({ data: new Uint8Array(pdf), ...DOC_OPTS })
    void (async () => {
      try {
        loaded = await task.promise
        if (cancelled) return
        const width = paneWidth - 24
        const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR)
        const canvases: HTMLCanvasElement[] = []
        for (let pageNo = 1; pageNo <= loaded.numPages; pageNo++) {
          const page = await loaded.getPage(pageNo)
          if (cancelled) return
          const base = page.getViewport({ scale: 1 })
          const scale = width > 0 ? Math.min(width / base.width, 2) : 1
          const viewport = page.getViewport({ scale })
          const canvas = document.createElement('canvas')
          canvas.className = 'hwpx-preview-page'
          canvas.setAttribute('role', 'img')
          canvas.setAttribute(
            'aria-label',
            tRef.current('appHwpxPreviewPageOf', { current: pageNo, total: loaded.numPages }),
          )
          canvas.width = Math.floor(viewport.width * dpr)
          canvas.height = Math.floor(viewport.height * dpr)
          canvas.style.width = `${Math.floor(viewport.width)}px`
          canvas.style.height = `${Math.floor(viewport.height)}px`
          await page.render({
            canvas,
            viewport,
            transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
          }).promise
          if (cancelled) return
          canvases.push(canvas)
          // Show pages as they finish instead of after the whole document.
          if (progressive) host.replaceChildren(...canvases)
        }
        if (!progressive) host.replaceChildren(...canvases)
        paintedRef.current = pdf
        setDrawing(false)
      } catch (failure) {
        if (cancelled) return
        host.replaceChildren()
        paintedRef.current = null
        setDrawing(false)
        setRenderError(failure instanceof Error ? failure.message : String(failure))
      }
    })()
    return () => {
      cancelled = true
      // 6.x removed PDFDocumentProxy.destroy(); the loading task owns teardown.
      void task.destroy()
    }
  }, [pdf, paneWidth])

  // Busy covers both legs of the pipeline: Hancom exporting the saved file and
  // this pane drawing the PDF it returned. Until the drawn pages are the ones
  // the newest bytes describe, the pane must not claim that render is on screen.
  const busy = state.status === 'loading' || drawing
  // A PDF that arrived but cannot be drawn is not a working preview: the
  // display failure outranks the render's own success.
  const failed = state.status === 'failed' || !!renderError
  return (
    <section className="hwpx-preview" aria-label={t('appHwpxPreviewTitle')}>
      <div className="hwpx-preview-bar">
        <span className="hwpx-preview-status" role="status">
          {failed
            ? t('appHwpxPreviewFailedShort')
            : busy
              ? t('appHwpxPreviewRendering')
              : state.status === 'ready'
                ? dirty
                  ? t('appHwpxPreviewStale')
                  : t('appHwpxPreviewSaved', { version: state.hancomVersion ?? '' })
                : t('appHwpxPreviewHint')}
        </span>
        <button className="hwpx-preview-refresh" onClick={onRefresh} disabled={busy}>
          {t('appHwpxPreviewRefresh')}
        </button>
      </div>
      {state.status === 'failed' && state.error && (
        <p className="hwpx-preview-error">{t('appHwpxPreviewFailed', { error: state.error })}</p>
      )}
      {renderError && (
        <p className="hwpx-preview-error">
          {t('appHwpxPreviewUnreadable', { error: renderError })}
        </p>
      )}
      <div className="hwpx-preview-pages" ref={pagesRef} />
    </section>
  )
}

/**
 * Edit / Hancom-preview switch for an HWPX tab. Local to the affected content
 * (directly above the document area), keyboard-navigable like a tab list.
 */
export function HwpxViewTabs({
  view,
  onView,
  editLabel,
  previewLabel,
}: {
  view: 'edit' | 'preview'
  onView: (next: 'edit' | 'preview') => void
  editLabel: string
  previewLabel: string
}) {
  const order: Array<'edit' | 'preview'> = ['edit', 'preview']
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
    if (!delta) return
    event.preventDefault()
    const next = order[(order.indexOf(view) + delta + order.length) % order.length]
    onView(next)
  }
  return (
    <div className="hwpx-view-tabs" role="tablist" onKeyDown={onKeyDown}>
      {order.map((value) => (
        <button
          key={value}
          role="tab"
          type="button"
          aria-selected={view === value}
          tabIndex={view === value ? 0 : -1}
          className={view === value ? 'on' : ''}
          onClick={() => onView(value)}
        >
          {value === 'edit' ? editLabel : previewLabel}
        </button>
      ))}
    </div>
  )
}
