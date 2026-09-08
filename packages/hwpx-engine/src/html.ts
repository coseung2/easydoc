import { parseFragment, type DefaultTreeAdapterMap } from 'parse5'
import { embeddedImage } from './images'
import { DEFAULT_TEXT_STYLE, HWPX_LIMITS } from './model'
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

function formatFor(node: Element, parent: Format): Format {
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
        if (!font || font.length > 100 || /[<>\\]/.test(font))
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
      default:
        throw new Error(
          `Unsupported HWPX CSS property: ${key}. Remove it rather than assuming fidelity.`,
        )
    }
  }
  return format
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
        if (!ATTRIBUTES.has(attribute.name) || attribute.namespace)
          throw new Error(`Unsupported HWPX attribute: ${attribute.name}.`)
        if (attribute.name === 'dir' && attribute.value !== 'ltr')
          throw new Error('Only left-to-right HWPX generation is supported.')
      }
    }
    for (const child of children(node)) stack.push({ node: child, depth: depth + 1 })
  }
  const warnings = new Set<string>()
  const paragraph = (runs: Inline[], format: Format): Paragraph => {
    if (++blockCount > HWPX_LIMITS.blocks) throw new Error('Too many HWPX paragraphs/blocks.')
    return {
      kind: 'paragraph',
      runs,
      align: format.align,
      lineHeight: format.lineHeight,
      heading: format.heading,
      indent: format.indent,
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
        const next = formatFor(node, format)
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
      const next = formatFor(node, format)
      if (node.tagName === 'div' || node.tagName === 'blockquote')
        out.push(...blocks(children(node), next, inCell))
      else if (node.tagName === 'ul' || node.tagName === 'ol') {
        warnings.add('Lists use editable text markers, not automatic HWP numbering.')
        let number = Number(attr(node, 'start') ?? 1)
        if (!Number.isInteger(number) || number < 1 || number > 100_000)
          throw new Error('Invalid ordered-list start.')
        for (const li of children(node)) {
          if (!element(li)) {
            if ('value' in li && li.value.trim()) throw new Error('Invalid list content.')
            continue
          }
          if (li.tagName !== 'li') throw new Error('Lists may contain only li elements.')
          const formatLi = formatFor(li, { ...next, indent: next.indent + 1 })
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
        for (const child of children(node)) {
          if (!element(child)) {
            if ('value' in child && child.value.trim()) throw new Error('Invalid table content.')
            continue
          }
          if (child.tagName === 'tr') rowNodes.push(child)
          else if (['thead', 'tbody', 'tfoot'].includes(child.tagName)) {
            for (const row of children(child)) {
              if (element(row) && row.tagName === 'tr') rowNodes.push(row)
              else if (element(row) || ('value' in row && row.value.trim()))
                throw new Error('Invalid table row.')
            }
          } else throw new Error('Unsupported table child.')
        }
        const rows = rowNodes.map((row) => {
          const rowFormat = formatFor(row, next)
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
              const cellFormat = formatFor(cell, rowFormat)
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
        out.push({ kind: 'table', rows })
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
