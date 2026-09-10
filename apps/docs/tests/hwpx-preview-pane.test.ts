/**
 * The saved-file preview pane: what the user sees while Hancom renders, when a
 * shown render is labelled as behind the document, and that a PDF which cannot
 * be drawn is reported as a failure instead of a working preview.
 *
 * pdf.js is stubbed here because jsdom has no canvas 2D context; the real
 * pdf.js render of a valid PDF is covered by the Electron E2E.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { HwpxPreviewState } from '../src/renderer/use-hwpx-preview'

const renderCalls: Array<{ pageNo: number }> = []
let pageCount = 2
let renderFails: string | null = null
/** when set, page renders wait for it: lets a test observe a draw in progress */
let renderGate: Promise<void> | null = null

vi.mock('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url', () => ({ default: 'pdf.worker.js' }))
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: () => ({
    promise: Promise.resolve({
      numPages: pageCount,
      getPage: (pageNo: number) =>
        Promise.resolve({
          getViewport: ({ scale }: { scale: number }) => ({
            width: 595 * scale,
            height: 842 * scale,
          }),
          render: () => {
            renderCalls.push({ pageNo })
            return {
              promise: renderFails
                ? Promise.reject(new Error(renderFails))
                : renderGate
                  ? renderGate.then(() => undefined)
                  : Promise.resolve(undefined),
            }
          },
        }),
    }),
    destroy: () => Promise.resolve(),
  }),
}))

const { HwpxPreview } = await import('../src/renderer/components/HwpxPreview')

const ready = (overrides: Partial<HwpxPreviewState> = {}): HwpxPreviewState => ({
  status: 'ready',
  pdf: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]),
  sourceHash: 'hash-1',
  hancomVersion: '12.0.0.3146',
  cached: false,
  error: null,
  renderedRevision: 0,
  paused: false,
  ...overrides,
})

let root: Root | null = null
let container: HTMLDivElement | null = null
let paneWidth = 640
const resizeCallbacks = new Set<() => void>()

beforeAll(() => {
  ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 1 })
  // jsdom reports 0 for every layout box; the pane sizes its pages from the
  // measured width, so give it one.
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => paneWidth,
  })
  globalThis.ResizeObserver = class {
    constructor(private readonly callback: () => void) {}
    observe() {
      resizeCallbacks.add(this.callback)
    }
    unobserve() {}
    disconnect() {
      resizeCallbacks.delete(this.callback)
    }
  } as unknown as typeof ResizeObserver
})

async function mount(props: Parameters<typeof HwpxPreview>[0]) {
  container = document.createElement('div')
  document.body.append(container)
  await act(async () => {
    root = createRoot(container as HTMLDivElement)
    root.render(createElement(HwpxPreview, props))
  })
  return container as HTMLDivElement
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  root = null
  container?.remove()
  container = null
  renderCalls.length = 0
  pageCount = 2
  renderFails = null
  renderGate = null
  paneWidth = 640
  resizeCallbacks.clear()
})

describe('HWPX preview pane', () => {
  it('draws one page per PDF page and reports the rendering Hancom build', async () => {
    const host = await mount({ state: ready(), dirty: false, onRefresh: () => {} })
    expect(renderCalls.map((call) => call.pageNo)).toEqual([1, 2])
    const pages = host.querySelectorAll('canvas.hwpx-preview-page')
    expect(pages).toHaveLength(2)
    expect(pages[0].getAttribute('role')).toBe('img')
    expect(pages[0].getAttribute('aria-label')).toContain('1')
    expect(host.querySelector('[role="status"]')?.textContent).toContain('12.0.0.3146')
    expect(host.querySelector('.hwpx-preview-error')).toBeNull()
  })

  it('tells the user to save when the editor is ahead of the shown render', async () => {
    const host = await mount({ state: ready(), dirty: true, onRefresh: () => {} })
    const status = host.querySelector('[role="status"]')?.textContent ?? ''
    expect(status).toMatch(/save/i)
    // The stale render stays visible: an editing user keeps the last known page.
    expect(host.querySelectorAll('canvas.hwpx-preview-page')).toHaveLength(2)
  })

  it('disables refresh while a render runs and re-enables it on failure', async () => {
    const onRefresh = vi.fn()
    const host = await mount({
      state: ready({ status: 'loading', pdf: null, renderedRevision: null }),
      dirty: false,
      onRefresh,
    })
    const button = host.querySelector('.hwpx-preview-refresh') as HTMLButtonElement
    expect(button.disabled).toBe(true)

    await act(async () => {
      root?.render(
        createElement(HwpxPreview, {
          state: ready({
            status: 'failed',
            pdf: null,
            renderedRevision: null,
            error: 'Hancom may be waiting for a confirmation dialog on this machine.',
          }),
          dirty: false,
          onRefresh,
        }),
      )
    })
    const retry = host.querySelector('.hwpx-preview-refresh') as HTMLButtonElement
    expect(retry.disabled).toBe(false)
    expect(host.querySelector('.hwpx-preview-error')?.textContent).toContain(
      'waiting for a confirmation dialog',
    )
    await act(async () => {
      retry.click()
    })
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })

  it('reports a PDF it cannot draw as a failure, not as a ready preview', async () => {
    renderFails = 'canvas context unavailable'
    const host = await mount({ state: ready(), dirty: false, onRefresh: () => {} })
    expect(host.querySelector('.hwpx-preview-error')?.textContent).toContain(
      'canvas context unavailable',
    )
    expect(host.querySelector('[role="status"]')?.textContent).not.toContain('12.0.0.3146')
    expect(host.querySelectorAll('canvas.hwpx-preview-page')).toHaveLength(0)
  })

  it('keeps the drawn pages on screen while a width change re-renders them', async () => {
    const host = await mount({ state: ready(), dirty: false, onRefresh: () => {} })
    expect(host.querySelectorAll('canvas.hwpx-preview-page')).toHaveLength(2)

    // The pane got wider (window resize, AI dock collapse): the new render
    // starts, and until it finishes the user must still see the old pages.
    paneWidth = 900
    act(() => {
      resizeCallbacks.forEach((callback) => callback())
    })
    expect(host.querySelectorAll('canvas.hwpx-preview-page')).toHaveLength(2)

    await act(async () => {})
    const redrawn = host.querySelectorAll<HTMLCanvasElement>('canvas.hwpx-preview-page')
    expect(redrawn).toHaveLength(2)
    expect(redrawn[0].style.width).toBe('876px')
  })

  it('clears the pane when the document it rendered is gone', async () => {
    const host = await mount({ state: ready(), dirty: false, onRefresh: () => {} })
    expect(host.querySelectorAll('canvas.hwpx-preview-page')).toHaveLength(2)
    await act(async () => {
      root?.render(
        createElement(HwpxPreview, {
          state: ready({ status: 'idle', pdf: null, renderedRevision: null }),
          dirty: false,
          onRefresh: () => {},
        }),
      )
    })
    expect(host.querySelectorAll('canvas.hwpx-preview-page')).toHaveLength(0)
  })

  it('reports a newly saved render as in progress until its pages are drawn', async () => {
    const host = await mount({ state: ready(), dirty: false, onRefresh: () => {} })
    expect(host.querySelector('[role="status"]')?.textContent).toContain('12.0.0.3146')

    let release = () => {}
    renderGate = new Promise<void>((resolve) => {
      release = resolve
    })
    // A save produced a new render: different bytes, so what is on screen no
    // longer describes the saved file.
    await act(async () => {
      root?.render(
        createElement(HwpxPreview, {
          state: ready({ pdf: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x32]) }),
          dirty: false,
          onRefresh: () => {},
        }),
      )
    })
    expect(host.querySelector('[role="status"]')?.textContent).toMatch(/rendering/i)
    expect(host.querySelectorAll('canvas.hwpx-preview-page')).toHaveLength(0)

    await act(async () => {
      release()
      await renderGate
    })
    expect(host.querySelectorAll('canvas.hwpx-preview-page')).toHaveLength(2)
    expect(host.querySelector('[role="status"]')?.textContent).toContain('12.0.0.3146')
  })

  it('keeps the saved-render status while a width change redraws the same bytes', async () => {
    const host = await mount({ state: ready(), dirty: false, onRefresh: () => {} })
    let release = () => {}
    renderGate = new Promise<void>((resolve) => {
      release = resolve
    })
    paneWidth = 900
    await act(async () => {
      resizeCallbacks.forEach((callback) => callback())
    })
    // Mid-redraw: the pages the status describes are still the ones on screen.
    expect(host.querySelectorAll('canvas.hwpx-preview-page')).toHaveLength(2)
    expect(host.querySelector('[role="status"]')?.textContent).toContain('12.0.0.3146')
    await act(async () => {
      release()
      await renderGate
    })
    expect(host.querySelector('[role="status"]')?.textContent).toContain('12.0.0.3146')
  })

  it('shows a draw failure instead of a render in progress', async () => {
    renderFails = 'canvas context unavailable'
    const host = await mount({
      state: ready({ status: 'loading' }),
      dirty: false,
      onRefresh: () => {},
    })
    expect(host.querySelector('[role="status"]')?.textContent).toContain('No preview available')
    expect(host.querySelector('.hwpx-preview-error')?.textContent).toContain(
      'canvas context unavailable',
    )
  })
})
