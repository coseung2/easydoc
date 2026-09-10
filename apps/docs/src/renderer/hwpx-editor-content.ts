/**
 * HWPX editor bridge (import half).
 *
 * A generated HWPX file is described by the engine's normalized HTML
 * (`exportHwpx().editorHtml`), which is serialized from the very model that
 * produced the saved bytes. This module maps that HTML into ProseMirror nodes
 * while keeping every property the HWPX model actually supports: paragraph
 * alignment, line spacing, indent levels, run font/size/weight/style/
 * decoration/color, table column shares and inline image dimensions.
 *
 * The generic docx import path is deliberately not reused: it drops inline run
 * styles, paragraph spacing/indent and colgroup shares (measured 2026-09-10),
 * which would make a zero-edit save rewrite the document differently from the
 * file on disk. Unsupported markup throws instead of degrading to plain text —
 * a generated document must never be shown as editable content that cannot be
 * saved back.
 */
import { CODE_BLOCK_PRESET } from './ai/protocol'
import type { PmMark, PmNode } from './editor/convert'
import { isEastAsianFontName } from './font-list'

/** Page margins the HWPX writer uses (20 mm), in twips, for canvas parity. */
export const HWPX_PAGE_MARGIN_TWIPS = Math.round((20 / 25.4) * 1440)

/** Run properties that live on the docTextStyle mark. */
interface RunStyle {
  font?: string
  fontAscii?: string
  sizeHalfPoints?: number
  color?: string
}

interface InlineContext {
  style: RunStyle
  bold: boolean
  italic: boolean
  underline: boolean
  strike: boolean
}

const BASE_CONTEXT: InlineContext = {
  style: {},
  bold: false,
  italic: false,
  underline: false,
  strike: false,
}

function lengthPt(value: string): number | null {
  const match = /^(-?\d+(?:\.\d+)?)(pt|px)?$/.exec(value.trim())
  if (!match) return null
  const size = Number(match[1])
  if (!Number.isFinite(size)) return null
  return match[2] === 'px' ? size * 0.75 : size
}

/** '#RRGGBB' / 'rgb(r, g, b)' → OOXML hex without '#'; null when unusable. */
function colorHex(value: string): string | null {
  const css = value.trim()
  if (!css) return null
  const rgb = /^rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(css)
  if (rgb) {
    return [rgb[1], rgb[2], rgb[3]]
      .map((part) => Number(part).toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase()
  }
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(css)
  if (!hex) return null
  const digits = hex[1]!
  const full =
    digits.length === 3
      ? [...digits].map((digit) => digit + digit).join('')
      : digits
  return full.toUpperCase()
}

function firstFontFamily(value: string): string | null {
  const first = value.split(',')[0]?.trim().replace(/^["']|["']$/g, '')
  return first ? first : null
}

/** Paragraph-level formatting of one normalized block element. */
function paragraphAttrs(el: HTMLElement, extra: Record<string, unknown> = {}) {
  const style = el.style
  const align = style.textAlign?.trim()
  let lineSpacing: number | null = null
  const lineHeight = style.lineHeight?.trim()
  if (lineHeight) {
    const percent = /^(\d+(?:\.\d+)?)%$/.exec(lineHeight)
    const value = percent ? Number(percent[1]) / 100 : Number.parseFloat(lineHeight)
    if (Number.isFinite(value) && value > 0) lineSpacing = value
  }
  let indentLeft: number | null = null
  const marginLeft = style.marginLeft?.trim()
  if (marginLeft) {
    const pt = lengthPt(marginLeft)
    if (pt != null && pt > 0) indentLeft = Math.round(pt * 20)
  }
  return {
    docxIndex: null,
    ...(align && ['left', 'center', 'right', 'justify'].includes(align) ? { align } : {}),
    ...(lineSpacing != null ? { lineSpacing, lineRule: 'auto' } : {}),
    ...(indentLeft != null ? { indentLeft } : {}),
    ...extra,
  }
}

/** Merge one element's inline declarations into the inherited run context. */
function inlineContext(el: HTMLElement, parent: InlineContext): InlineContext {
  const next: InlineContext = { ...parent, style: { ...parent.style } }
  const tag = el.tagName.toLowerCase()
  if (tag === 'strong' || tag === 'b') next.bold = true
  if (tag === 'em' || tag === 'i') next.italic = true
  if (tag === 'u') next.underline = true
  if (tag === 's' || tag === 'strike' || tag === 'del') next.strike = true
  const style = el.style
  const weight = style.fontWeight?.trim()
  if (weight) next.bold = weight === 'bold' || Number(weight) >= 600
  const fontStyle = style.fontStyle?.trim()
  if (fontStyle) next.italic = fontStyle === 'italic' || fontStyle === 'oblique'
  const decoration = (style.textDecorationLine || style.textDecoration)?.trim()
  if (decoration) {
    next.underline = decoration.includes('underline')
    next.strike = decoration.includes('line-through')
  }
  const family = style.fontFamily ? firstFontFamily(style.fontFamily) : null
  if (family) {
    // Word/OOXML keeps Latin and East Asian faces in separate slots; the HWPX
    // model has one name, so it lands in the slot its script belongs to.
    if (isEastAsianFontName(family)) {
      next.style.font = family
      delete next.style.fontAscii
    } else {
      next.style.fontAscii = family
      delete next.style.font
    }
  }
  const size = style.fontSize ? lengthPt(style.fontSize) : null
  if (size != null && size > 0) next.style.sizeHalfPoints = Math.round(size * 2)
  const color = style.color ? colorHex(style.color) : null
  if (color) next.style.color = color
  return next
}

function marksOf(context: InlineContext): PmMark[] {
  const marks: PmMark[] = []
  if (context.bold) marks.push({ type: 'bold' })
  if (context.italic) marks.push({ type: 'italic' })
  if (context.underline) marks.push({ type: 'underline' })
  if (context.strike) marks.push({ type: 'strike' })
  if (Object.keys(context.style).length > 0) {
    marks.push({ type: 'docTextStyle', attrs: { ...context.style } })
  }
  return marks
}

function imageNode(el: HTMLElement, notes: string[]): PmNode {
  const src = el.getAttribute('src') ?? ''
  if (!/^data:image\/(png|jpeg);base64,/.test(src)) {
    throw new Error('This HWPX document embeds an image the editor cannot display.')
  }
  // The editor's inline-image node has no alt attribute, so alt text cannot
  // round-trip through an edit session. Say so instead of losing it silently.
  if ((el.getAttribute('alt') ?? '').trim()) {
    notes.push('Image alternative text is not kept when the document is saved again.')
  }
  const dimension = (name: string): number | null => {
    const raw = el.getAttribute(name)
    if (!raw) return null
    const value = Number.parseFloat(raw)
    return Number.isFinite(value) && value > 0 ? Math.round(value) : null
  }
  return {
    type: 'docInlineImage',
    attrs: { dataUrl: src, widthPx: dimension('width'), heightPx: dimension('height'), xml: '' },
  }
}

function inlineNodes(parent: Node, context: InlineContext, notes: string[]): PmNode[] {
  const out: PmNode[] = []
  parent.childNodes.forEach((child) => {
    if (child.nodeType === child.TEXT_NODE) {
      const raw = child.textContent ?? ''
      if (!raw) return
      const marks = marksOf(context)
      out.push({ type: 'text', text: raw, ...(marks.length ? { marks } : {}) })
      return
    }
    if (child.nodeType !== child.ELEMENT_NODE) return
    const el = child as HTMLElement
    const tag = el.tagName.toLowerCase()
    if (tag === 'br') {
      out.push({ type: 'hardBreak' })
      return
    }
    if (tag === 'img') {
      out.push(imageNode(el, notes))
      return
    }
    if (!['span', 'strong', 'b', 'em', 'i', 'u', 's', 'strike', 'code'].includes(tag)) {
      throw new Error(`This HWPX document uses <${tag}> inside a paragraph, which cannot be opened.`)
    }
    out.push(...inlineNodes(el, inlineContext(el, context), notes))
  })
  return out
}

/** <pre> keeps its newlines: split them into hard breaks, text verbatim. */
function preInlineNodes(el: HTMLElement, notes: string[]): PmNode[] {
  const nodes: PmNode[] = []
  const walk = (parent: Node, context: InlineContext) => {
    parent.childNodes.forEach((child) => {
      if (child.nodeType === child.TEXT_NODE) {
        const raw = child.textContent ?? ''
        const marks = marksOf(context)
        const lines = raw.split('\n')
        lines.forEach((line, index) => {
          if (index > 0) nodes.push({ type: 'hardBreak' })
          if (line) nodes.push({ type: 'text', text: line, ...(marks.length ? { marks } : {}) })
        })
        return
      }
      if (child.nodeType !== child.ELEMENT_NODE) return
      const inner = child as HTMLElement
      const tag = inner.tagName.toLowerCase()
      if (tag === 'br') {
        nodes.push({ type: 'hardBreak' })
        return
      }
      if (tag === 'img') {
        nodes.push(imageNode(inner, notes))
        return
      }
      walk(inner, inlineContext(inner, context))
    })
  }
  walk(el, BASE_CONTEXT)
  return nodes
}

function columnShares(table: HTMLElement): number[] | null {
  const cols = Array.from(table.querySelectorAll(':scope > colgroup > col'))
  if (cols.length === 0) return null
  const weights: number[] = []
  for (const col of cols) {
    const el = col as HTMLElement
    const declared = el.style.width?.trim() || el.getAttribute('width') || ''
    const percent = /^(\d+(?:\.\d+)?)%$/.exec(declared)
    const value = percent ? Number(percent[1]) : (lengthPt(declared) ?? 0)
    if (!(value > 0)) return null
    const span = Number(el.getAttribute('span') ?? '1')
    for (let i = 0; i < (Number.isInteger(span) && span > 0 ? span : 1); i++) weights.push(value)
  }
  const total = weights.reduce((sum, weight) => sum + weight, 0)
  return weights.map((weight) => (weight / total) * 100)
}

function cellNode(cell: HTMLElement, notes: string[]): PmNode {
  const content = blockNodes(cell, notes, true)
  return {
    type: cell.tagName.toLowerCase() === 'th' ? 'docTableHeader' : 'docTableCell',
    attrs: { colspan: 1, rowspan: 1 },
    content: content.length > 0 ? content : [{ type: 'docParagraph', attrs: { docxIndex: null } }],
  }
}

function tableNode(table: HTMLElement, notes: string[]): PmNode {
  const rows = Array.from(table.querySelectorAll(':scope > tr, :scope > tbody > tr'))
  if (rows.length === 0) throw new Error('This HWPX document contains an empty table.')
  const shares = columnShares(table)
  return {
    type: 'docTable',
    attrs: {
      docxIndex: null,
      // the HWPX writer always spans the text column; column shares define the grid
      colWidthsPct: shares,
      widthPct: 100,
      tblAutoFit: 'fixed',
    },
    content: rows.map((row) => ({
      type: 'docTableRow',
      attrs: {},
      content: Array.from((row as HTMLElement).querySelectorAll(':scope > td, :scope > th')).map(
        (cell) => cellNode(cell as HTMLElement, notes),
      ),
    })),
  }
}

function blockNodes(parent: HTMLElement, notes: string[], inCell = false): PmNode[] {
  const out: PmNode[] = []
  parent.childNodes.forEach((child) => {
    if (child.nodeType === child.TEXT_NODE) {
      if ((child.textContent ?? '').trim()) {
        throw new Error('This HWPX document has text outside a paragraph.')
      }
      return
    }
    if (child.nodeType !== child.ELEMENT_NODE) return
    const el = child as HTMLElement
    const tag = el.tagName.toLowerCase()
    const heading = /^h([1-6])$/.exec(tag)
    if (heading) {
      out.push({
        type: 'docHeading',
        attrs: paragraphAttrs(el, { level: Number(heading[1]) }),
        content: inlineNodes(el, BASE_CONTEXT, notes),
      })
    } else if (tag === 'p') {
      const content = inlineNodes(el, BASE_CONTEXT, notes)
      out.push({
        type: 'docParagraph',
        attrs: paragraphAttrs(el),
        ...(content.length ? { content } : {}),
      })
    } else if (tag === 'pre') {
      out.push({
        type: 'docParagraph',
        attrs: paragraphAttrs(el, {
          shadingFill: CODE_BLOCK_PRESET.shadingFill,
          borders: CODE_BLOCK_PRESET.borders,
        }),
        content: preInlineNodes(el, notes),
      })
    } else if (tag === 'table') {
      if (inCell) throw new Error('Nested HWPX tables are not supported.')
      out.push(tableNode(el, notes))
    } else if (tag === 'div' || tag === 'blockquote' || tag === 'colgroup') {
      if (tag !== 'colgroup') out.push(...blockNodes(el, notes, inCell))
    } else {
      throw new Error(`This HWPX document uses <${tag}>, which the editor cannot open.`)
    }
  })
  return out
}

/**
 * Normalized HWPX HTML → top-level ProseMirror nodes. Throws when the markup
 * carries something the HWPX model cannot round-trip, so the caller reports a
 * real failure instead of showing salvaged text as the saved document.
 *
 * `notes` collects properties the editor cannot carry through an edit session
 * (currently image alt text); the caller surfaces them instead of losing them
 * without a word.
 */
export function hwpxEditorNodes(html: string, notes: string[] = []): PmNode[] {
  if (typeof html !== 'string' || !html.trim()) {
    throw new Error('The generated HWPX document has no content.')
  }
  const parsed = new DOMParser().parseFromString(html, 'text/html')
  const nodes = blockNodes(parsed.body, notes)
  if (nodes.length === 0) throw new Error('The generated HWPX document has no content.')
  return nodes
}

/** Shared with the save half so both directions agree on the code-block preset. */
export function isHwpxCodeParagraph(attrs: Record<string, unknown> | undefined): boolean {
  return (
    attrs?.shadingFill === CODE_BLOCK_PRESET.shadingFill &&
    attrs?.borders === CODE_BLOCK_PRESET.borders
  )
}
