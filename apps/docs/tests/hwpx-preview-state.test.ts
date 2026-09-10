/**
 * HWPX preview scheduling: when Hancom is actually asked to render, and what
 * the pane reports in between. The rules exist because a render drives a shared
 * desktop resource and can stall on Hancom's per-file security prompt, so an
 * automatic retry loop would pile modals onto an already blocked machine.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { act, createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useHwpxPreview, type HwpxPreviewHandle } from '../src/renderer/use-hwpx-preview'
import type { HwpxPreviewResponse } from '../src/shared/ipc'

const FILE = 'C:\\docs\\보고서.hwpx'

interface Deferred {
  resolve: (value: HwpxPreviewResponse) => void
  force: boolean
}

function harness() {
  const calls: Deferred[] = []
  const request = (force: boolean) =>
    new Promise<HwpxPreviewResponse>((resolve) => {
      calls.push({ resolve, force })
    })
  let latest: HwpxPreviewHandle | null = null
  const Probe = (props: { filePath: string | null; savedRevision: number; enabled: boolean }) => {
    latest = useHwpxPreview({ ...props, request })
    return null
  }
  const container = document.createElement('div')
  document.body.append(container)
  let root: Root | null = null
  const render = (props: {
    filePath?: string | null
    savedRevision?: number
    enabled?: boolean
  }) => {
    const element = createElement(Probe, {
      filePath: props.filePath === undefined ? FILE : props.filePath,
      savedRevision: props.savedRevision ?? 0,
      enabled: props.enabled ?? true,
    }) as ReactElement
    act(() => {
      if (!root) root = createRoot(container)
      root.render(element)
    })
  }
  return {
    calls,
    render,
    handle: () => latest as HwpxPreviewHandle,
    unmount: () => {
      act(() => root?.unmount())
      root = null
      container.remove()
    },
  }
}

const success = (overrides: Partial<Extract<HwpxPreviewResponse, { ok: true }>> = {}) =>
  ({
    ok: true,
    bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]),
    sourceHash: 'hash-1',
    hancomVersion: '12.0.0.3146',
    cached: false,
    ...overrides,
  }) satisfies HwpxPreviewResponse

const settle = async (deferred: Deferred, response: HwpxPreviewResponse) => {
  await act(async () => {
    deferred.resolve(response)
    await Promise.resolve()
  })
}

let active: ReturnType<typeof harness> | null = null
afterEach(() => {
  active?.unmount()
  active = null
})

describe('HWPX saved-file preview scheduling', () => {
  it('renders once for the saved file and again after the next save', async () => {
    const app = (active = harness())
    app.render({ savedRevision: 0 })
    expect(app.calls).toHaveLength(1)
    expect(app.calls[0].force).toBe(false)
    await settle(app.calls[0], success())
    expect(app.handle().state.status).toBe('ready')
    expect(app.handle().state.hancomVersion).toBe('12.0.0.3146')

    // Re-rendering the same document/revision (pane reopened, unrelated state
    // change) must not start another Hancom render.
    app.render({ savedRevision: 0 })
    expect(app.calls).toHaveLength(1)

    app.render({ savedRevision: 1 })
    expect(app.calls).toHaveLength(2)
    await settle(app.calls[1], success({ sourceHash: 'hash-2', cached: true }))
    expect(app.handle().state.sourceHash).toBe('hash-2')
    expect(app.handle().staleRender).toBe(false)
  })

  it('stops automatic renders after a failure until an explicit refresh', async () => {
    const app = (active = harness())
    app.render({ savedRevision: 0 })
    await settle(app.calls[0], { ok: false, error: 'Hancom may be waiting for a dialog' })
    expect(app.handle().state.status).toBe('failed')

    // A later save must not re-enter a machine that is already blocked.
    app.render({ savedRevision: 1 })
    expect(app.calls).toHaveLength(1)
    expect(app.handle().state.paused).toBe(true)

    act(() => app.handle().refresh())
    expect(app.calls).toHaveLength(2)
    expect(app.calls[1].force).toBe(true)
    await settle(app.calls[1], success({ sourceHash: 'hash-3' }))
    expect(app.handle().state.status).toBe('ready')

    // The latch is cleared: the following save renders automatically again.
    app.render({ savedRevision: 2 })
    expect(app.calls).toHaveLength(3)
  })

  it('never publishes a render that a newer save or document replaced', async () => {
    const app = (active = harness())
    app.render({ savedRevision: 0 })
    app.render({ savedRevision: 1 })
    expect(app.calls).toHaveLength(2)

    // The first (now superseded) render finishes last; its bytes describe the
    // previous revision and must not be shown as the current preview.
    await settle(app.calls[1], success({ sourceHash: 'newer' }))
    await settle(app.calls[0], success({ sourceHash: 'older' }))
    expect(app.handle().state.sourceHash).toBe('newer')
    expect(app.handle().state.renderedRevision).toBe(1)

    // Switching documents drops the previous preview instead of relabelling it.
    app.render({ filePath: 'C:\\docs\\다른.hwpx', savedRevision: 0 })
    expect(app.handle().state.pdf).toBeNull()
    expect(app.calls).toHaveLength(3)
    // A late reply from the previous document cannot appear under the new one.
    await settle(app.calls[2], success({ sourceHash: 'second-doc' }))
    expect(app.handle().state.sourceHash).toBe('second-doc')
  })

  it('marks the shown render stale once a newer save exists', async () => {
    const app = (active = harness())
    app.render({ savedRevision: 0 })
    await settle(app.calls[0], success())
    app.render({ savedRevision: 1 })
    // The new render is in flight: the previous pages stay on screen, labelled
    // as older than the saved file.
    expect(app.handle().staleRender).toBe(true)
    expect(app.handle().state.pdf).not.toBeNull()
  })

  it('requests nothing for a docx tab or after unmount', async () => {
    const app = (active = harness())
    app.render({ filePath: 'C:\\docs\\보고서.docx', savedRevision: 0 })
    expect(app.calls).toHaveLength(0)

    app.render({ filePath: FILE, savedRevision: 0 })
    expect(app.calls).toHaveLength(1)
    const inFlight = app.calls[0]
    app.unmount()
    active = null
    // Resolving after unmount must not touch a gone component.
    await settle(inFlight, success())
  })
})
