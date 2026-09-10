/**
 * HWPX editor bridge (save half).
 *
 * Serializes the live ProseMirror document into the restricted HTML the HWPX
 * exporter accepts. It reads the PM model rather than `editor.getHTML()`,
 * because the editor's own DOM carries display-only chrome (line-factor custom
 * properties, dark-page twins, measured column pixels, marker decorations) that
 * the exporter rejects, and it drops the colgroup shares and run styles the
 * HWPX model does keep.
 *
 * Every emitted property is one the exporter understands, so a document opened
 * from `exportHwpx().editorHtml` and saved without edits reproduces the same
 * HWPX content: same alignment, line spacing, indent levels, fonts, sizes,
 * colors, list marker text, column shares and image dimensions.
 */
import type { Editor } from '@tiptap/core'
import type { PmMark, PmNode } from './editor/convert'
import { isHwpxCodeParagraph } from './hwpx-editor-content'

/** One indent level in the HWPX writer is 14 pt (1400 HWPUNIT). */
const INDENT_PT = 14
const MAX_INDENT = 8

const escapeText = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const escapeAttribute = (value: string) => escapeText(value).replace(/"/g, '&quot;')
const num = (value: number) => String(Number(value.toFixed(4)))

interface RunFormat {
  bold: boolean
  italic: boolean
  underline: boolean
  strike: boolean
  font?: string
  sizePt?: number
  color?: string
}

/** Marks that carry no HWPX meaning but keep their text; the caller is told. */
const DROPPED_MARK_NOTES: Record<string, string> = {
  link: 'Hyperlinks are saved as plain text; HWPX links are not supported yet.',
  comment: 'Comments are not saved into the HWPX file.',
}
/** Marks that mean the text is not plain live content: saving would misrepresent it. */
const TRACKED_MARKS = new Set(['ins', 'del', 'rprChange'])
const FIELD_MARKS = new Set(['refField', 'instrField'])

function runFormat(marks: PmMark[] | undefined, notes: string[]): RunFormat {
  const format: RunFormat = { bold: false, italic: false, underline: false, strike: false }
  for (const mark of marks ?? []) {
    switch (mark.type) {
      case 'bold':
        format.bold = true
        break
      case 'italic':
        format.italic = true
        break
      case 'underline':
        format.underline = true
        break
      case 'strike':
        format.strike = true
        break
      case 'docTextStyle': {
        const attrs = mark.attrs ?? {}
        // The HWPX model has a single font name per run: prefer the East Asian
        // slot, which is what Korean generated documents declare.
        const font = (attrs.font ?? attrs.fontAscii) as string | undefined
        if (font) format.font = font
        const size = attrs.sizeHalfPoints as number | undefined
        if (size) format.sizePt = size / 2
        const color = attrs.color as string | undefined
        if (color && color !== 'auto') format.color = `#${color}`
        if (attrs.boldOff === true) format.bold = false
        if (attrs.italicOff === true) format.italic = false
        break
      }
      default: {
        if (TRACKED_MARKS.has(mark.type)) {
          // Struck-through deleted text must never be written as live content,
          // and an insertion mark is only meaningful next to its deletion.
          throw new Error(
            'Accept or reject the tracked changes before saving this document as HWPX.',
          )
        }
        if (FIELD_MARKS.has(mark.type)) {
          throw new Error('Fields and cross-references cannot be saved into HWPX yet.')
        }
        const note = DROPPED_MARK_NOTES[mark.type]
        if (!note) throw new Error(`"${mark.type}" formatting cannot be saved into HWPX yet.`)
        if (!notes.includes(note)) notes.push(note)
        break
      }
    }
  }
  return format
}

function runStyleAttribute(format: RunFormat): string {
  const declarations = [
    format.font ? `font-family:${format.font}` : '',
    format.sizePt ? `font-size:${num(format.sizePt)}pt` : '',
    `font-weight:${format.bold ? 'bold' : 'normal'}`,
    `font-style:${format.italic ? 'italic' : 'normal'}`,
    `text-decoration:${
      [format.underline ? 'underline' : '', format.strike ? 'line-through' : '']
        .filter(Boolean)
        .join(' ') || 'none'
    }`,
    format.color ? `color:${format.color}` : '',
  ].filter(Boolean)
  return ` style="${escapeAttribute(declarations.join(';'))}"`
}

/** Inline content of one block: text runs, hard breaks and embedded images. */
function inlineHtml(node: PmNode, pre: boolean, notes: string[]): string {
  let html = ''
  for (const child of node.content ?? []) {
    if (child.type === 'text') {
      const text = child.text ?? ''
      if (!text) continue
      html += `<span${runStyleAttribute(runFormat(child.marks, notes))}>${escapeText(text)}</span>`
    } else if (child.type === 'hardBreak') {
      // Inside <pre> a literal newline is the whitespace-significant form the
      // exporter reads back; elsewhere a <br> is a soft break.
      html += pre ? '\n' : '<br>'
    } else if (child.type === 'docInlineImage') {
      const attrs = child.attrs ?? {}
      const dataUrl = String(attrs.dataUrl ?? '')
      if (!/^data:image\/(png|jpeg);base64,/.test(dataUrl)) {
        throw new Error('HWPX documents support only embedded PNG or JPEG images.')
      }
      const width = Number(attrs.widthPx)
      const height = Number(attrs.heightPx)
      html +=
        `<img src="${escapeAttribute(dataUrl)}" alt=""` +
        (width > 0 ? ` width="${num(width)}"` : '') +
        (height > 0 ? ` height="${num(height)}"` : '') +
        '>'
    } else if (child.type === 'docInlineMath' || child.type === 'docNoteRef') {
      throw new Error(
        'Formulas and footnote references cannot be saved into HWPX yet. Remove them or save as DOCX.',
      )
    } else {
      // No recursive salvage: an unknown inline node would silently lose either
      // its meaning or its content.
      throw new Error(`"${child.type}" content cannot be saved into HWPX yet.`)
    }
  }
  return html
}

function paragraphStyleAttribute(attrs: Record<string, unknown> | undefined): string {
  const declarations: string[] = []
  const align = attrs?.align as string | undefined
  declarations.push(`text-align:${align === 'distribute' ? 'justify' : (align ?? 'left')}`)
  const spacing = lineSpacingPercent(attrs)
  declarations.push(`line-height:${num(spacing)}%`)
  const indent = indentLevel(attrs)
  if (indent > 0) declarations.push(`margin-left:${num(indent * INDENT_PT)}pt`)
  return ` style="${escapeAttribute(declarations.join(';'))}"`
}

/** Line spacing as the exporter's percentage; 160% is the writer's default. */
function lineSpacingPercent(attrs: Record<string, unknown> | undefined): number {
  const rule = attrs?.lineRule as string | undefined
  const spacing = attrs?.lineSpacing as number | undefined
  const rawTwips = attrs?.lineRawTwips as number | undefined
  const multiple =
    spacing ?? (rule === 'auto' && rawTwips ? rawTwips / 240 : undefined) ?? undefined
  if (multiple == null) return 160
  const percent = multiple * 100
  // The exporter accepts 100–300%; clamp instead of failing a normal edit.
  return Math.min(300, Math.max(100, percent))
}

/** Indent levels the HWPX writer supports (whole 14 pt steps, max 8). */
function indentLevel(attrs: Record<string, unknown> | undefined): number {
  const left = attrs?.indentLeft as number | undefined
  const ilvl = attrs?.ilvl as number | undefined
  if (left != null && left > 0) {
    return Math.min(MAX_INDENT, Math.max(0, Math.round(left / 20 / INDENT_PT)))
  }
  // A list item created in the editor has no w:ind of its own; its level is
  // the indent the exporter reproduces.
  if (ilvl != null && ilvl > 0) return Math.min(MAX_INDENT, ilvl)
  return 0
}

/** Marker text of an editor-created list item; already-normalized paragraphs keep theirs as text. */
function listMarker(node: PmNode, ordinal: number): string {
  return node.attrs?.kind === 'ordered' ? `${ordinal}. ` : '• '
}

function paragraphHtml(node: PmNode, notes: string[], marker?: string): string {
  const attrs = node.attrs
  const pre = isHwpxCodeParagraph(attrs)
  const tag = pre ? 'pre' : 'p'
  const body = inlineHtml(node, pre, notes)
  const prefix = marker
    ? `<span${runStyleAttribute(runFormat(firstRunMarks(node), notes))}>${escapeText(marker)}</span>`
    : ''
  return `<${tag}${paragraphStyleAttribute(attrs)}>${prefix}${body}</${tag}>`
}

function firstRunMarks(node: PmNode): PmMark[] | undefined {
  for (const child of node.content ?? []) {
    if (child.type === 'text') return child.marks
  }
  return undefined
}

function headingHtml(node: PmNode, notes: string[]): string {
  const level = Math.min(Math.max(Number(node.attrs?.level) || 1, 1), 6)
  return (
    `<h${level}${paragraphStyleAttribute(node.attrs)}>` +
    `${inlineHtml(node, false, notes)}</h${level}>`
  )
}

function tableHtml(node: PmNode, notes: string[]): string {
  const rows = node.content ?? []
  if (rows.length === 0) throw new Error('An empty table cannot be saved into HWPX.')
  const columns = (rows[0]?.content ?? []).reduce(
    (sum, cell) => sum + (Number(cell.attrs?.colspan) || 1),
    0,
  )
  for (const row of rows) {
    for (const cell of row.content ?? []) {
      if ((Number(cell.attrs?.colspan) || 1) !== 1 || (Number(cell.attrs?.rowspan) || 1) !== 1) {
        throw new Error('Merged table cells cannot be saved into HWPX yet.')
      }
    }
    if ((row.content ?? []).length !== columns) {
      throw new Error('HWPX tables must keep the same number of cells in every row.')
    }
  }
  const shares = columnWidthPercents(node, columns)
  const colgroup = shares
    ? `<colgroup>${shares.map((share) => `<col style="width:${num(share)}%">`).join('')}</colgroup>`
    : ''
  const body = rows
    .map((row) => {
      const cells = (row.content ?? [])
        .map((cell) => {
          const tag = cell.type === 'docTableHeader' ? 'th' : 'td'
          const content = (cell.content ?? [])
            .map((block) => blockHtml(block, notes, true))
            .filter(Boolean)
            .join('')
          return `<${tag}>${content || '<p></p>'}</${tag}>`
        })
        .join('')
      return `<tr>${cells}</tr>`
    })
    .join('')
  return `<table>${colgroup}<tbody>${body}</tbody></table>`
}

/** Column shares from the PM grid: percentages first, else measured pixels. */
function columnWidthPercents(node: PmNode, columns: number): number[] | null {
  const pct = node.attrs?.colWidthsPct as number[] | null | undefined
  const source =
    pct && pct.length === columns
      ? pct
      : collectColumnPixels(node, columns)
  if (!source || source.length !== columns || source.some((value) => !(value > 0))) return null
  const total = source.reduce((sum, value) => sum + value, 0)
  return source.map((value) => (value / total) * 100)
}

/** Per-column px widths (the editor stores them per cell after a column drag). */
function collectColumnPixels(node: PmNode, columns: number): number[] | null {
  const first = node.content?.[0]?.content
  if (!first || first.length !== columns) return null
  const widths: number[] = []
  for (const cell of first) {
    const colwidth = cell.attrs?.colwidth as number[] | null | undefined
    const width = colwidth?.[0]
    if (!(typeof width === 'number' && width > 0)) return null
    widths.push(width)
  }
  return widths
}

/** One top-level (or in-cell) block. Returns '' for blocks with nothing to save. */
function blockHtml(
  node: PmNode,
  notes: string[],
  inCell: boolean,
  listOrdinal?: () => number,
): string {
  switch (node.type) {
    case 'docHeading':
      return headingHtml(node, notes)
    case 'docParagraph':
      return paragraphHtml(node, notes)
    case 'docListItem':
      return paragraphHtml(node, notes, listMarker(node, listOrdinal ? listOrdinal() : 1))
    case 'docTable':
      if (inCell) throw new Error('Nested tables cannot be saved into HWPX.')
      return tableHtml(node, notes)
    case 'docNestedTable':
      throw new Error('Nested tables cannot be saved into HWPX.')
    case 'docProtected':
      throw new Error(
        'This document contains content the HWPX exporter cannot write (fields, shapes or text boxes).',
      )
    default:
      throw new Error(`"${node.type}" content cannot be saved into HWPX yet.`)
  }
}

/**
 * Live editor → restricted HWPX HTML. Throws with a specific reason when the
 * document holds content the exporter cannot write, so the save reports a
 * failure instead of silently dropping it.
 *
 * `notes` collects properties that are saved as plain text on purpose
 * (hyperlink targets, comments), so the caller can tell the user rather than
 * letting them disappear quietly.
 */
export function hwpxEditorHtml(editor: Editor, notes: string[] = []): string {
  const doc = editor.getJSON() as PmNode
  const blocks = doc.content ?? []
  const parts: string[] = []
  // Ordered-list numbering restarts whenever a run of ordered items ends, so a
  // list the user typed numbers the same way the exporter would.
  let ordinal = 0
  let previousOrdered = false
  for (const block of blocks) {
    const ordered = block.type === 'docListItem' && block.attrs?.kind === 'ordered'
    if (ordered) ordinal = previousOrdered ? ordinal + 1 : 1
    previousOrdered = ordered
    parts.push(blockHtml(block, notes, false, () => ordinal))
  }
  const html = parts.filter(Boolean).join('')
  if (!html) throw new Error('The document is empty; there is nothing to save into HWPX.')
  return html
}
