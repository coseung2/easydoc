/**
 * `docs:preview-hwpx` authorization: the renderer asks for "my preview" and the
 * main process decides which file that is. A renderer must not be able to name
 * a path, and a tab with no HWPX must get a plain failure instead of a render.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { HwpxPreviewResponse } from '../src/shared/ipc'

type Handler = (event: { sender: { id: number } }, ...args: unknown[]) => unknown
const handlers = new Map<string, Handler>()

vi.mock('electron', () => {
  const noop = () => undefined
  const webContents = { id: 1, send: noop, on: noop, once: noop, isDestroyed: () => false }
  return {
    app: {
      isPackaged: false,
      getPath: () => '/tmp',
      getAppPath: () => '/tmp',
      getVersion: () => '0.0.0',
      getLocale: () => 'ko-KR',
      on: noop,
      whenReady: () => Promise.resolve(),
    },
    BrowserWindow: class {
      static getAllWindows = () => []
      static getFocusedWindow = () => null
      webContents = webContents
      on = noop
      once = noop
      loadURL = noop
      loadFile = noop
    },
    WebContentsView: class {
      webContents = webContents
    },
    Menu: { buildFromTemplate: () => ({ popup: noop }), setApplicationMenu: noop },
    MenuItem: class {},
    dialog: { showSaveDialog: () => Promise.resolve({ canceled: true }) },
    ipcMain: {
      handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
      on: noop,
      removeHandler: (channel: string) => handlers.delete(channel),
    },
    nativeTheme: { on: noop, themeSource: 'system' },
    shell: { showItemInFolder: noop, openExternal: noop },
    clipboard: { writeText: noop },
    nativeImage: { createFromDataURL: () => ({}) },
    session: { defaultSession: { on: noop } },
    webContents: { getAllWebContents: () => [] },
  }
})

let docsMain: typeof import('../src/main/docs-main')

beforeAll(async () => {
  docsMain = await import('../src/main/docs-main')
  docsMain.registerDocsIpc()
})

afterEach(() => {
  docsMain.setHwpxPreviewHook(null)
})

const invoke = (senderId: number, force = false) =>
  handlers.get('docs:preview-hwpx')!({ sender: { id: senderId } }, force) as Promise<
    HwpxPreviewResponse
  >

const success = {
  ok: true as const,
  bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]),
  sourceHash: 'hash-1',
  hancomVersion: '12.0.0.3146',
  cached: false,
}

describe('docs:preview-hwpx authorization', () => {
  it('renders the path bound to the calling tab, which the renderer never sends', async () => {
    docsMain.queueDocsAiContent(41, {
      title: '보고서',
      html: '<p>본문</p>',
      hwpxPath: 'C:\\docs\\보고서.hwpx',
    })
    const seen: Array<{ filePath: string; force: boolean }> = []
    docsMain.setHwpxPreviewHook((filePath, options) => {
      seen.push({ filePath, force: options.force })
      return Promise.resolve(success)
    })

    const result = await invoke(41, true)
    expect(result).toMatchObject({ ok: true, hancomVersion: '12.0.0.3146' })
    expect(seen).toEqual([{ filePath: 'C:\\docs\\보고서.hwpx', force: true }])

    // A different tab has its own binding; asking from an unbound tab renders
    // nothing, whatever the renderer passes.
    const other = await invoke(42)
    expect(other).toEqual({ ok: false, error: 'No HWPX document is associated with this tab' })
    expect(seen).toHaveLength(1)
  })

  it('reports a missing preview service instead of failing the invoke', async () => {
    docsMain.queueDocsAiContent(43, {
      title: '보고서',
      html: '<p>본문</p>',
      hwpxPath: 'C:\\docs\\보고서.hwpx',
    })
    const standalone = await invoke(43)
    expect(standalone).toEqual({
      ok: false,
      error: 'Hancom preview is not available in this build',
    })
  })

  it('turns a hook failure into a preview failure the pane can show', async () => {
    docsMain.queueDocsAiContent(44, {
      title: '보고서',
      html: '<p>본문</p>',
      hwpxPath: 'C:\\docs\\보고서.hwpx',
    })
    docsMain.setHwpxPreviewHook(() => Promise.reject(new Error('helper script is missing')))
    expect(await invoke(44)).toEqual({ ok: false, error: 'helper script is missing' })
  })
})
