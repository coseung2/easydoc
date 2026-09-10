import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { exportHwpx, parseHwpxHtml } from '@genoffice/hwpx-engine'
import type { Block, GeneratedDocument, Paragraph } from '@genoffice/hwpx-engine'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { hwpxEditorNodes } from '../src/renderer/hwpx-editor-content'
import { hwpxEditorHtml } from '../src/renderer/hwpx-editor-html'

const editors = new Set<Editor>()
afterEach(() => {
  for (const editor of editors) editor.destroy()
  editors.clear()
})

/** 1x1 PNG, same fixture the engine's own tests embed. */
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII='

const SOURCE =
  '<h1>협조 요청</h1>' +
  '<p>금액: <strong>1,250원</strong> <span style="color:#FF0000">확인</span></p>' +
  '<ul><li>첫째</li><li>둘째</li></ul>' +
  '<ol><li>하나</li><li>둘</li></ol>' +
  '<table><colgroup><col style="width:30%"><col style="width:70%"></colgroup>' +
  '<tr><th>항목</th><th>금액</th></tr><tr><td>예산</td><td>1,250원</td></tr></table>' +
  `<p><img src="${PNG}" width="48" height="24"></p>` +
  '<p style="text-align:center;line-height:200%">가운데</p>'

/** The document as the exporter wrote it: editorHtml is the tab's content. */
function generated(source = SOURCE) {
  return exportHwpx(source, { title: '검증', createdAt: new Date(2000, 0, 1) })
}

function openInEditor(html: string): Editor {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
    content: { type: 'doc', content: hwpxEditorNodes(html) as never },
  })
  editors.add(editor)
  return editor
}

/**
 * ProseMirror stores one text node per distinct mark set, so a marker run and
 * the item text that carries the same formatting come back as a single run.
 * Comparing documents with equally-styled neighbours merged keeps the
 * comparison about content and formatting rather than run segmentation.
 */
function coalesce(document: GeneratedDocument): Block[] {
  const paragraph = (p: Paragraph): Paragraph => {
    const runs: Paragraph['runs'] = []
    for (const run of p.runs) {
      const previous = runs[runs.length - 1]
      if (
        run.kind === 'text' &&
        previous?.kind === 'text' &&
        JSON.stringify(previous.style) === JSON.stringify(run.style)
      ) {
        runs[runs.length - 1] = { ...previous, text: previous.text + run.text }
      } else runs.push(run)
    }
    return { ...p, runs }
  }
  return document.blocks.map((block) =>
    block.kind === 'paragraph'
      ? paragraph(block)
      : {
          ...block,
          rows: block.rows.map((row) =>
            row.map((cell) => ({ ...cell, paragraphs: cell.paragraphs.map(paragraph) })),
          ),
        },
  )
}

describe('generated HWPX opens in the editor and saves back unchanged', () => {
  it('writes the same document content after a zero-edit save', () => {
    const exported = generated()
    const editor = openInEditor(exported.editorHtml)
    const resavedHtml = hwpxEditorHtml(editor)
    expect(coalesce(parseHwpxHtml(resavedHtml))).toEqual(
      coalesce(parseHwpxHtml(exported.editorHtml)),
    )
  })

  it('is byte-stable: opening and saving the saved file again changes nothing', () => {
    const exported = generated()
    const first = exportHwpx(hwpxEditorHtml(openInEditor(exported.editorHtml)), {
      title: '검증',
      createdAt: new Date(2000, 0, 1),
    })
    const second = exportHwpx(hwpxEditorHtml(openInEditor(first.editorHtml)), {
      title: '검증',
      createdAt: new Date(2000, 0, 1),
    })
    expect(Buffer.from(second.bytes).equals(Buffer.from(first.bytes))).toBe(true)
  })

  it('keeps run styles, alignment, spacing, indents, column shares and image size', () => {
    const exported = generated()
    const editor = openInEditor(exported.editorHtml)
    const document = parseHwpxHtml(hwpxEditorHtml(editor))
    const paragraphs = document.blocks.filter((block) => block.kind === 'paragraph')
    const heading = paragraphs.find((p) => p.heading === 1)!
    expect(heading.runs[0]).toMatchObject({
      kind: 'text',
      text: '협조 요청',
      style: { bold: true, sizePt: 24, font: '함초롬돋움' },
    })
    const amount = paragraphs.find((p) =>
      p.runs.some((run) => run.kind === 'text' && run.text === '1,250원'),
    )!
    expect(amount.runs.map((run) => (run.kind === 'text' ? run.style.bold : null))).toContain(true)
    expect(
      amount.runs.some((run) => run.kind === 'text' && run.style.color === '#FF0000'),
    ).toBe(true)
    // list markers survive as text at one indent level, and are not renumbered
    const items = paragraphs
      .filter((p) => p.indent === 1)
      .map((p) => p.runs.map((run) => (run.kind === 'text' ? run.text : '')).join(''))
    expect(items).toEqual(['• 첫째', '• 둘째', '1. 하나', '2. 둘'])
    const centered = paragraphs.find((p) =>
      p.runs.some((run) => run.kind === 'text' && run.text === '가운데'),
    )!
    expect(centered).toMatchObject({ align: 'center', lineHeight: 200 })
    const table = document.blocks.find((block) => block.kind === 'table')!
    expect(table.kind === 'table' && table.columnWidths).toEqual([3000, 7000])
    const image = paragraphs
      .flatMap((p) => p.runs)
      .find((run) => run.kind === 'image')
    expect(image).toMatchObject({ widthPx: 48, heightPx: 24 })
  })

  it('carries an edit into the saved document without disturbing the rest', () => {
    const exported = generated()
    const editor = openInEditor(exported.editorHtml)
    editor.commands.setTextSelection(1)
    editor.commands.insertContent('수정 ')
    const document = parseHwpxHtml(hwpxEditorHtml(editor))
    const texts = document.blocks
      .filter((block) => block.kind === 'paragraph')
      .map((p) => p.runs.map((run) => (run.kind === 'text' ? run.text : '[img]')).join(''))
    expect(texts[0]).toBe('수정 협조 요청')
    expect(texts).toContain('• 첫째')
    const table = document.blocks.find((block) => block.kind === 'table')!
    expect(table.kind === 'table' && table.columnWidths).toEqual([3000, 7000])
  })

  it('keeps a typed list item saveable with its own marker and level', () => {
    const exported = generated('<p>본문</p>')
    const editor = openInEditor(exported.editorHtml)
    editor.commands.insertContent({
      type: 'docListItem',
      attrs: { kind: 'ordered', ilvl: 1 },
      content: [{ type: 'text', text: '새 항목' }],
    } as never)
    const document = parseHwpxHtml(hwpxEditorHtml(editor))
    const item = document.blocks
      .filter((block) => block.kind === 'paragraph')
      .find((p) => p.runs.some((run) => run.kind === 'text' && run.text === '새 항목'))!
    expect(item.indent).toBe(1)
    expect(item.runs[0]).toMatchObject({ kind: 'text', text: '1. ' })
  })

  it('reports unsupported content instead of dropping it', () => {
    const exported = generated('<p>본문</p>')
    const editor = openInEditor(exported.editorHtml)
    editor.commands.insertContent({
      type: 'docInlineMath',
      attrs: { omml: '<m:oMath/>', mathml: '', latex: 'x^2', text: 'x^2' },
    } as never)
    expect(() => hwpxEditorHtml(editor)).toThrow(/HWPX/)
  })

  it('saves a typed URL as plain text and says the link is not kept', () => {
    const exported = generated('<p>본문</p>')
    const editor = openInEditor(exported.editorHtml)
    // what the auto-link extension produces after typing a URL and a space
    editor.commands.insertContentAt(editor.state.doc.content.size - 1, {
      type: 'text',
      text: ' https://example.test',
      marks: [{ type: 'link', attrs: { href: 'https://example.test', rId: null } }],
    } as never)
    const notes: string[] = []
    const html = hwpxEditorHtml(editor, notes)
    expect(notes.join(' ')).toMatch(/Hyperlink/)
    // the text itself is kept, so nothing the user typed disappears
    const text = parseHwpxHtml(html)
      .blocks.filter((block) => block.kind === 'paragraph')
      .flatMap((p) => p.runs)
      .map((run) => (run.kind === 'text' ? run.text : ''))
      .join('')
    expect(text).toContain('https://example.test')
    expect(html).not.toContain('<a ')
  })

  it('refuses to save tracked changes rather than writing deleted text as live', () => {
    const exported = generated('<p>본문</p>')
    const editor = openInEditor(exported.editorHtml)
    editor.commands.selectAll()
    editor.commands.setMark('del', { author: '검토자', date: null })
    expect(() => hwpxEditorHtml(editor)).toThrow(/tracked changes/)
  })

  it('refuses to open markup the HWPX model cannot represent', () => {
    expect(() => hwpxEditorNodes('<p>ok</p><iframe src="file:///x"></iframe>')).toThrow(/iframe/)
    expect(() => hwpxEditorNodes('   ')).toThrow(/no content/)
  })
})
