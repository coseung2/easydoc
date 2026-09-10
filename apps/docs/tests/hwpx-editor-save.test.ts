import { afterEach, describe, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import { exportHwpx, parseHwpxHtml } from '@genoffice/hwpx-engine'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { applyAiDocContent, save, type FileActionContext } from '../src/renderer/file-actions'
import type { DocState } from '../src/renderer/doc-state'

const editors = new Set<Editor>()
afterEach(() => {
  for (const editor of editors) editor.destroy()
  editors.clear()
  delete (window as unknown as { desktop?: unknown }).desktop
})

function createEditor(): Editor {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
    content: {
      type: 'doc',
      content: [{ type: 'docParagraph', attrs: { docxIndex: null } }],
    },
  })
  editors.add(editor)
  return editor
}

interface Harness {
  ctx: FileActionContext
  editor: Editor
  doc: () => DocState | null
  status: () => string
}

/** Minimal FileActionContext: the HWPX paths touch document state and status only. */
function harness(initial: DocState | null): Harness {
  const editor = createEditor()
  let doc = initial
  let status = ''
  const ctx = {
    editor,
    get doc() {
      return doc
    },
    dirtyRef: { current: false },
    saveInFlightRef: { current: false },
    saveIncompleteRef: { current: false },
    setDoc: (update: unknown) => {
      doc = typeof update === 'function' ? (update as (p: DocState | null) => DocState)(doc) : (update as DocState)
    },
    setStatus: (value: string) => {
      status = value
    },
    setSection: vi.fn(),
    setSections: vi.fn(),
    section: null,
    sections: [],
    // composite dirty check inputs (all clean)
    sectionDirty: false,
    sectionsDirty: [],
    trailingStartType: null,
    pageColorDirty: false,
    headerDirty: false,
    footerDirty: false,
    hfVariantsDirty: [],
    sectionHfEdits: {},
    pgNumEdit: null,
    pgNumDirtySections: [],
    numberingDirty: false,
    styleUpserts: {},
    titlePgDirty: false,
    evenOddHfDirty: false,
    watermarkDirty: false,
    inksDirty: false,
    notesDirty: false,
    sourcesDirty: false,
    themeFontsDirty: false,
    themeColorsDirty: false,
    commentsDirty: false,
    protectionDirty: false,
  } as unknown as FileActionContext
  return { ctx, editor, doc: () => doc, status: () => status }
}

const blankDoc = (): DocState => ({
  parsed: {} as DocState['parsed'],
  filePath: null,
  fileName: 'Untitled.docx',
  hash: '',
  isBlank: true,
})

const hwpxDoc = (path: string): DocState => ({
  parsed: {} as DocState['parsed'],
  filePath: path,
  fileName: path.split(/[\\/]/).pop()!,
  hash: '',
})

describe('generated HWPX lands in the editor tab', () => {
  it('shows the written document, binds the path and starts clean', async () => {
    const { ctx, editor, doc, status } = harness(blankDoc())
    const exported = exportHwpx('<h1>보고서</h1><ul><li>첫째</li></ul>', {
      title: '보고서',
      createdAt: new Date(2000, 0, 1),
    })
    await applyAiDocContent(ctx, {
      title: '보고서',
      html: exported.editorHtml,
      hwpxPath: 'C:\\docs\\보고서.hwpx',
    })
    expect(doc()).toMatchObject({ filePath: 'C:\\docs\\보고서.hwpx', fileName: '보고서.hwpx' })
    expect(ctx.dirtyRef.current).toBe(false)
    expect(status()).not.toBe('')
    const json = editor.getJSON() as { content?: Array<{ type: string }> }
    expect(json.content?.map((node) => node.type)).toEqual(['docHeading', 'docParagraph'])
    expect(editor.getText()).toContain('• 첫째')
  })

  it('reports unsupported generated content instead of salvaging plain text', async () => {
    const { ctx, editor, doc, status } = harness(blankDoc())
    await applyAiDocContent(ctx, {
      title: 'T',
      html: '<p>본문</p><iframe src="file:///x"></iframe>',
      hwpxPath: 'C:\\docs\\T.hwpx',
    })
    expect(status()).toMatch(/iframe/)
    // the canvas is untouched: no salvaged text pretending to be the saved file
    expect(editor.getText()).toBe('')
    expect(doc()?.filePath).toBeNull()
  })
})

describe('HWPX save', () => {
  it('writes the live document and marks it clean', async () => {
    const { ctx, editor, doc } = harness(hwpxDoc('C:\\docs\\a.hwpx'))
    editor.commands.setContent({
      type: 'doc',
      content: [
        {
          type: 'docHeading',
          attrs: { docxIndex: null, level: 1 },
          content: [{ type: 'text', text: '제목' }],
        },
      ],
    } as never)
    ctx.dirtyRef.current = true
    const saveHwpx = vi.fn(async (_html: string, _saveAs: boolean) => ({
      ok: true,
      path: 'C:\\docs\\a.hwpx',
    }))
    ;(window as unknown as { desktop: unknown }).desktop = { saveHwpx }
    expect(await save(ctx, false)).toBe(true)
    const html = saveHwpx.mock.calls[0]![0]
    expect(parseHwpxHtml(html).blocks[0]).toMatchObject({ heading: 1 })
    expect(ctx.dirtyRef.current).toBe(false)
    expect(doc()?.filePath).toBe('C:\\docs\\a.hwpx')
  })

  it('keeps the document dirty when the user keeps typing during the write', async () => {
    const { ctx, editor } = harness(hwpxDoc('C:\\docs\\a.hwpx'))
    editor.commands.setContent({
      type: 'doc',
      content: [
        {
          type: 'docParagraph',
          attrs: { docxIndex: null },
          content: [{ type: 'text', text: '본문' }],
        },
      ],
    } as never)
    ctx.dirtyRef.current = true
    ;(window as unknown as { desktop: unknown }).desktop = {
      saveHwpx: async () => {
        // an edit arriving while the main process writes: the file is older
        editor.commands.insertContent('추가')
        return { ok: true, path: 'C:\\docs\\a.hwpx' }
      },
    }
    expect(await save(ctx, false)).toBe(true)
    expect(ctx.dirtyRef.current).toBe(true)
    expect(ctx.saveIncompleteRef.current).toBe(true)
  })

  it('keeps the document dirty and reports the reason when the export fails', async () => {
    const { ctx, editor, status } = harness(hwpxDoc('C:\\docs\\a.hwpx'))
    editor.commands.setContent({
      type: 'doc',
      content: [
        {
          type: 'docParagraph',
          attrs: { docxIndex: null },
          content: [
            {
              type: 'docInlineMath',
              attrs: { omml: '<m:oMath/>', mathml: '', latex: 'x^2', text: 'x^2' },
            },
          ],
        },
      ],
    } as never)
    ctx.dirtyRef.current = true
    const saveHwpx = vi.fn()
    ;(window as unknown as { desktop: unknown }).desktop = { saveHwpx }
    expect(await save(ctx, false)).toBe(false)
    expect(saveHwpx).not.toHaveBeenCalled()
    expect(status()).toMatch(/HWPX/)
    expect(ctx.dirtyRef.current).toBe(true)
  })

  it('stays dirty and silent when Save As is canceled', async () => {
    const { ctx, editor } = harness(hwpxDoc('C:\\docs\\a.hwpx'))
    editor.commands.setContent({
      type: 'doc',
      content: [
        {
          type: 'docParagraph',
          attrs: { docxIndex: null },
          content: [{ type: 'text', text: '본문' }],
        },
      ],
    } as never)
    ctx.dirtyRef.current = true
    ;(window as unknown as { desktop: unknown }).desktop = { saveHwpx: async () => ({ ok: false }) }
    expect(await save(ctx, true)).toBe(false)
    expect(ctx.dirtyRef.current).toBe(true)
  })
})
