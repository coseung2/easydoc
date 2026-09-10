import { parseFragment, type DefaultTreeAdapterMap } from 'parse5'
import { embeddedImage } from './images'
import {
  DEFAULT_TEXT_STYLE,
  HWPX_COLUMN_WIDTH_SCALE,
  HWPX_INDENT_PT,
  HWPX_LIMITS,
  HWPX_MAX_INDENT,
  HWPX_MIN_COLUMN_SHARE,
  distributeWidths,
} from './model'
import type { Block, GeneratedDocument, Inline, Paragraph, TextStyle } from './model'

type Node = DefaultTreeAdapterMap['node']
type Element = DefaultTreeAdapterMap['element']
const element = (node: Node): node is Element => 'tagName' in node
const children = (node: Node): Node[] => ('childNodes' in node ? node.childNodes : [])
const attr = (node: Element, name: string) => node.attrs.find((a) => a.name === name)?.value
const INLINE = new Set(['span', 'strong', 'b', 'em', 'i', 'u', 's', 'strike', 'code', 'br', 'img'])
const ALLOWED = new Set([
  ...INLINE,
  'p',
  'div',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'pre',
  'blockquote',
  'ul',
  'ol',
  'li',
  'table',
  'colgroup',
  'col',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'td',
  'th',
])
const ATTRIBUTES = new Set([
  'style',
  'align',
  'src',
  'alt',
  'width',
  'height',
  'colspan',
  'rowspan',
  'start',
  'lang',
  'dir',
  'title',
])
/** `<col>` carries only width information; `<colgroup>` carries none. */
const COL_ATTRIBUTES = new Set(['style', 'width', 'span'])

interface Format {
  text: TextStyle
  align: Paragraph['align']
  lineHeight: number
  heading: number
  indent: number
  pre: boolean
}
const BASE: Format = {
  text: DEFAULT_TEXT_STYLE,
  align: 'left',
  lineHeight: 160,
  heading: 0,
  indent: 0,
  pre: false,
}

function sizePt(value: string): number {
  const match = /^(\d+(?:\.\d+)?)(pt|px)?$/.exec(value)
  const size = match ? Number(match[1]) * (match[2] === 'px' ? 0.75 : 1) : 0
  if (size < 6 || size > 72) throw new Error('HWPX font-size must be 6–72 pt (or equivalent px).')
  return size
}

function formatFor(node: Element, parent: Format, warn?: (message: string) => void): Format {
  const format: Format = { ...parent, text: { ...parent.text } }
  const tag = node.tagName
  if (/^h[1-6]$/.test(tag)) {
    format.heading = Number(tag[1])
    format.text.sizePt = [24, 20, 17, 15, 13, 12][format.heading - 1]!
    format.text.bold = true
    format.text.font = '함초롬돋움'
  }
  if (tag === 'strong' || tag === 'b' || tag === 'th') format.text.bold = true
  if (tag === 'em' || tag === 'i') format.text.italic = true
  if (tag === 'u') format.text.underline = true
  if (tag === 's' || tag === 'strike') format.text.strike = true
  if (tag === 'pre') format.pre = true
  if (tag === 'blockquote') format.indent += 1
  const declarations = (attr(node, 'style') ?? '').split(';').filter((s) => s.trim())
  if (attr(node, 'align')) declarations.push(`text-align:${attr(node, 'align')}`)
  for (const declaration of declarations) {
    const colon = declaration.indexOf(':')
    if (colon < 1) throw new Error('Invalid inline CSS in HWPX input.')
    const key = declaration.slice(0, colon).trim().toLowerCase()
    const value = declaration.slice(colon + 1).trim()
    switch (key) {
      case 'font-size':
        format.text.sizePt = sizePt(value)
        break
      case 'font-family': {
        const font = value
          .split(',')[0]!
          .trim()
          .replace(/^['"]|['"]$/g, '')
        // ';' and quotes would not survive re-parsing of normalized inline CSS.
        if (!font || font.length > 100 || /[<>\\;'"]/.test(font))
          throw new Error('Invalid font family.')
        format.text.font = /^(Malgun Gothic|맑은고딕)$/i.test(font) ? '맑은 고딕' : font
        break
      }
      case 'font-weight':
        if (!/^(normal|bold|[1-9]00)$/.test(value)) throw new Error('Unsupported font-weight.')
        format.text.bold = value === 'bold' || Number(value) >= 600
        break
      case 'font-style':
        if (!/^(normal|italic)$/.test(value)) throw new Error('Unsupported font-style.')
        format.text.italic = value === 'italic'
        break
      case 'text-decoration':
        if (!/^(none|underline|line-through|underline line-through)$/.test(value))
          throw new Error('Unsupported text-decoration.')
        format.text.underline = value.includes('underline')
        format.text.strike = value.includes('line-through')
        break
      case 'color': {
        if (!/^#[a-f\d]{3}(?:[a-f\d]{3})?$/i.test(value))
          throw new Error('HWPX colors must be #RGB or #RRGGBB.')
        format.text.color = (
          value.length === 4 ? '#' + [...value.slice(1)].map((c) => c + c).join('') : value
        ).toUpperCase()
        break
      }
      case 'text-align':
        if (!['left', 'center', 'right', 'justify'].includes(value))
          throw new Error('Unsupported text-align.')
        format.align = value as Paragraph['align']
        break
      case 'line-height': {
        const n =
          value === 'normal'
            ? 160
            : /^\d+(?:\.\d+)?%?$/.test(value)
              ? Number.parseFloat(value) * (value.endsWith('%') ? 1 : 100)
              : 0
        if (n < 100 || n > 300) throw new Error('line-height must be 1–3 or 100%–300%.')
        format.lineHeight = n
        break
      }
      case 'margin-left': {
        // Paragraph indentation is level-based (one level = 14 pt / 1400 HWPUNIT),
        // so a length is quantized to the nearest level instead of being dropped.
        const match = /^(\d+(?:\.\d+)?)(pt|px)?$/.exec(value)
        const pt = match ? Number(match[1]) * (match[2] === 'px' ? 0.75 : 1) : NaN
        if (!Number.isFinite(pt) || pt > 1000)
          throw new Error('margin-left must be 0–1000 pt (or equivalent px).')
        const level = Math.min(HWPX_MAX_INDENT, Math.round(pt / HWPX_INDENT_PT))
        if (Math.abs(level * HWPX_INDENT_PT - pt) > 0.5)
          warn?.('Paragraph indentation was rounded to whole 14 pt levels.')
        format.indent = level
        break
      }
      default:
        throw new Error(
          `Unsupported HWPX CSS property: ${key}. Remove it rather than assuming fidelity.`,
        )
    }
  }
  return format
}

/**
 * Explicit column widths from a leading `<colgroup>`. Supported forms per `<col>`:
 * `style="width:25%"`, `style="width:120px"`, `style="width:90pt"` or `width="120"`
 * (pixels), optionally repeated with `span="n"`. Percent and length forms must not
 * be mixed inside one table, and either every column is declared or none are.
 * Lengths are converted to points before the ratio is taken, so `72pt` and `96px`
 * describe the same column width.
 *
 * The result is the canonical grid: shares of `HWPX_COLUMN_WIDTH_SCALE` summing to
 * exactly that scale, each at least `HWPX_MIN_COLUMN_SHARE`. Both the writer and
 * the normalized HTML use these numbers, so a clamped column is visible in the
 * editor instead of being applied only to the written file.
 */
function columnWidths(group: Element, warn: (message: string) => void): number[] {
  const weights: number[] = []
  let unit: '%' | 'length' | null = null
  for (const child of children(group)) {
    if (!element(child)) {
      if ('value' in child && child.value.trim()) throw new Error('Invalid colgroup content.')
      continue
    }
    if (child.tagName !== 'col') throw new Error('colgroup may contain only col elements.')
    const declarations = (attr(child, 'style') ?? '').split(';').filter((s) => s.trim())
    let width: string | undefined
    for (const declaration of declarations) {
      const colon = declaration.indexOf(':')
      if (colon < 1) throw new Error('Invalid inline CSS in HWPX input.')
      const key = declaration.slice(0, colon).trim().toLowerCase()
      if (key !== 'width') throw new Error(`Unsupported HWPX col CSS property: ${key}.`)
      width = declaration.slice(colon + 1).trim()
    }
    width ??= attr(child, 'width')
    if (width === undefined) throw new Error('Every HWPX col must declare a width, or none may.')
    const match = /^(\d+(?:\.\d+)?)(%|px|pt)?$/.exec(width)
    if (!match) throw new Error('HWPX column widths must be positive % or px/pt lengths.')
    const declared = Number(match[1])
    const percent = match[2] === '%'
    // px and pt are the same physical quantity; compare them in points.
    const value = percent ? declared : declared * (match[2] === 'pt' ? 1 : 0.75)
    if (!(value > 0) || (percent ? declared > 100 : declared > 20_000))
      throw new Error('HWPX column widths must be positive % or px/pt lengths.')
    const next = percent ? '%' : 'length'
    if (unit && unit !== next) throw new Error('HWPX column widths cannot mix % and lengths.')
    unit = next
    const span = attr(child, 'span') ?? '1'
    if (!/^\d+$/.test(span) || Number(span) < 1 || Number(span) > HWPX_LIMITS.tableColumns)
      throw new Error('Invalid col span.')
    for (let i = 0; i < Number(span); i++) weights.push(value)
  }
  if (!weights.length) throw new Error('An HWPX colgroup must declare at least one column.')
  if (weights.length > HWPX_LIMITS.tableColumns) throw new Error('Too many HWPX table columns.')
  warn('Table column widths are kept in proportion; the table spans the text width.')
  const sum = weights.reduce((a, b) => a + b, 0)
  if (weights.some((weight) => (weight * HWPX_COLUMN_WIDTH_SCALE) / sum < HWPX_MIN_COLUMN_SHARE))
    warn('Very narrow table columns were widened to a readable minimum width.')
  return distributeWidths(HWPX_COLUMN_WIDTH_SCALE, weights, HWPX_MIN_COLUMN_SHARE)
}

/** Bounded, passive HTML subset. Unsupported semantic content fails instead of disappearing. */
export function parseHwpxHtml(html: string): GeneratedDocument {
  if (typeof html !== 'string' || !html.trim() || html.length > HWPX_LIMITS.htmlChars)
    throw new Error('HWPX content is empty or exceeds the HTML size limit.')
  // XML 1.0 disallows these controls; reject before the HTML parser can rewrite them.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ud800-\udfff\ufffe\uffff]/u.test(html))
    throw new Error('HWPX content contains invalid XML characters.')
  const root = parseFragment(html)
  let nodes = 0,
    cells = 0,
    images = 0,
    imageBytes = 0,
    blockCount = 0
  const stack = children(root).map((node) => ({ node, depth: 1 }))
  while (stack.length) {
    const { node, depth } = stack.pop()!
    if (++nodes > HWPX_LIMITS.nodes || depth > HWPX_LIMITS.depth)
      throw new Error('HWPX HTML structure exceeds limits.')
    if (element(node)) {
      if (!ALLOWED.has(node.tagName))
        throw new Error(`Unsupported HWPX element: <${node.tagName}>.`)
      for (const attribute of node.attrs) {
        const allowed =
          node.tagName === 'col'
            ? COL_ATTRIBUTES.has(attribute.name)
            : node.tagName === 'colgroup'
              ? false
              : ATTRIBUTES.has(attribute.name)
        if (!allowed || attribute.namespace)
          throw new Error(`Unsupported HWPX attribute: ${attribute.name}.`)
        if (attribute.name === 'dir' && attribute.value !== 'ltr')
          throw new Error('Only left-to-right HWPX generation is supported.')
      }
    }
    for (const child of children(node)) stack.push({ node: child, depth: depth + 1 })
  }
  const warnings = new Set<string>()
  const warn = (message: string) => void warnings.add(message)
  const paragraph = (runs: Inline[], format: Format): Paragraph => {
    if (++blockCount > HWPX_LIMITS.blocks) throw new Error('Too many HWPX paragraphs/blocks.')
    if (format.indent > HWPX_MAX_INDENT)
      warn('Indentation deeper than 8 levels was flattened to the 8th level.')
    return {
      kind: 'paragraph',
      runs,
      align: format.align,
      lineHeight: format.lineHeight,
      heading: format.heading,
      // Clamped once here so the model, the written bytes and the normalized
      // HTML all describe the same indentation.
      indent: Math.min(format.indent, HWPX_MAX_INDENT),
      pre: format.pre,
    }
  }
  const inline = (list: Node[], format: Format): Inline[] => {
    const out: Inline[] = []
    for (const node of list) {
      if (node.nodeName === '#comment') continue
      if (node.nodeName === '#text' && 'value' in node) {
        const text = format.pre ? node.value : node.value.replace(/[\t\n\r ]+/g, ' ')
        if (text) out.push({ kind: 'text', text, style: { ...format.text } })
      } else if (element(node)) {
        const next = formatFor(node, format, warn)
        if (node.tagName === 'br') out.push({ kind: 'text', text: '\n', style: { ...next.text } })
        else if (node.tagName === 'img') {
          const image = embeddedImage(
            attr(node, 'src') ?? '',
            attr(node, 'alt') ?? '',
            attr(node, 'width'),
            attr(node, 'height'),
          )
          if (
            ++images > HWPX_LIMITS.images ||
            (imageBytes += image.bytes.length) > HWPX_LIMITS.totalImageBytes
          )
            throw new Error('HWPX image budget exceeded.')
          out.push(image)
        } else if (INLINE.has(node.tagName)) out.push(...inline(children(node), next))
        else throw new Error(`Block <${node.tagName}> cannot appear inside this HWPX paragraph.`)
      }
    }
    return out
  }

  const blocks = (list: Node[], format: Format, inCell = false): Block[] => {
    const out: Block[] = []
    let pending: Node[] = []
    const flush = () => {
      if (pending.length) {
        const runs = inline(pending, format)
        if (runs.some((run) => run.kind === 'image' || run.text.trim()))
          out.push(paragraph(runs, format))
        pending = []
      }
    }
    for (const node of list) {
      if (node.nodeName === '#comment') continue
      if (!element(node) || INLINE.has(node.tagName)) {
        pending.push(node)
        continue
      }
      flush()
      if (node.tagName === 'colgroup' || node.tagName === 'col')
        throw new Error('A colgroup may appear only inside a table.')
      const next = formatFor(node, format, warn)
      if (node.tagName === 'div' || node.tagName === 'blockquote')
        out.push(...blocks(children(node), next, inCell))
      else if (node.tagName === 'ul' || node.tagName === 'ol') {
        warn('Lists use editable text markers, not automatic HWP numbering.')
        let number = Number(attr(node, 'start') ?? 1)
        if (!Number.isInteger(number) || number < 1 || number > 100_000)
          throw new Error('Invalid ordered-list start.')
        for (const li of children(node)) {
          if (!element(li)) {
            if ('value' in li && li.value.trim()) throw new Error('Invalid list content.')
            continue
          }
          if (li.tagName !== 'li') throw new Error('Lists may contain only li elements.')
          const formatLi = formatFor(li, { ...next, indent: next.indent + 1 }, warn)
          const items = blocks(children(li), formatLi, inCell)
          if (items.some((b) => b.kind === 'table'))
            throw new Error('Tables inside lists are not supported.')
          const first = items[0] as Paragraph | undefined
          const marker = node.tagName === 'ol' ? `${number++}. ` : '• '
          if (first) first.runs.unshift({ kind: 'text', text: marker, style: { ...formatLi.text } })
          else
            items.push(
              paragraph([{ kind: 'text', text: marker, style: { ...formatLi.text } }], formatLi),
            )
          out.push(...items)
        }
      } else if (node.tagName === 'table') {
        if (inCell) throw new Error('Nested HWPX tables are not supported.')
        const rowNodes: Element[] = []
        let declaredWidths: number[] | undefined
        for (const child of children(node)) {
          if (!element(child)) {
            if ('value' in child && child.value.trim()) throw new Error('Invalid table content.')
            continue
          }
          if (child.tagName === 'tr') rowNodes.push(child)
          else if (child.tagName === 'colgroup') {
            if (declaredWidths || rowNodes.length)
              throw new Error('A colgroup must appear once before the table rows.')
            declaredWidths = columnWidths(child, warn)
          } else if (['thead', 'tbody', 'tfoot'].includes(child.tagName)) {
            for (const row of children(child)) {
              if (element(row) && row.tagName === 'tr') rowNodes.push(row)
              else if (element(row) || ('value' in row && row.value.trim()))
                throw new Error('Invalid table row.')
            }
          } else throw new Error('Unsupported table child.')
        }
        const rows = rowNodes.map((row) => {
          const rowFormat = formatFor(row, next, warn)
          return children(row)
            .filter(element)
            .map((cell) => {
              if (!['td', 'th'].includes(cell.tagName)) throw new Error('Invalid table cell.')
              if (++cells > HWPX_LIMITS.tableCells) throw new Error('Too many table cells.')
              if (
                [attr(cell, 'colspan'), attr(cell, 'rowspan')].some(
                  (s) => s !== undefined && s !== '1',
                )
              )
                throw new Error('Merged HWPX cells are not yet supported.')
              const cellFormat = formatFor(cell, rowFormat, warn)
              const content = blocks(children(cell), cellFormat, true)
              if (!content.length) content.push(paragraph([], cellFormat))
              return { header: cell.tagName === 'th', paragraphs: content as Paragraph[] }
            })
        })
        const columns = rows[0]?.length ?? 0
        if (
          !columns ||
          columns > HWPX_LIMITS.tableColumns ||
          rows.some((row) => row.length !== columns)
        )
          throw new Error(
            'HWPX tables must be non-empty rectangular grids with at most 32 columns.',
          )
        if (declaredWidths && declaredWidths.length !== columns)
          throw new Error('The HWPX colgroup must declare exactly one width per column.')
        out.push({
          kind: 'table',
          rows,
          ...(declaredWidths ? { columnWidths: declaredWidths } : {}),
        })
      } else if (node.tagName === 'p' || node.tagName === 'pre' || /^h[1-6]$/.test(node.tagName)) {
        out.push(paragraph(inline(children(node), next), next))
      } else throw new Error(`Unexpected block <${node.tagName}> in HWPX content.`)
    }
    flush()
    return out
  }
  const result = blocks(children(root), BASE)
  if (!result.length) throw new Error('No HWPX document content was found.')
  return { blocks: result, warnings: [...warnings] }
}
