import { HWPX_COLUMN_WIDTH_SCALE, HWPX_INDENT_PT } from './model'
import type { Block, GeneratedDocument, Paragraph, TextRun, TextStyle } from './model'

/**
 * Serializes the parsed model back into the same restricted HTML subset the
 * parser accepts, so the editor edits what was actually written into the HWPX
 * file rather than the upstream document HTML.
 *
 * Model limitation: list structure is flattened while parsing into indented
 * paragraphs whose visible marker (an ordered "1. " or a bullet) is ordinary
 * text. This serializer emits those paragraphs as paragraphs and keeps the
 * markers as text, so re-exporting an unedited document reproduces the same
 * markers instead of numbering them a second time. ul/ol nesting, start, and
 * div/blockquote grouping are not recoverable from the model.
 */
export function documentToHtml(document: GeneratedDocument): string {
  return document.blocks.map(block).join('')
}

const text = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const attribute = (value: string) => text(value).replace(/"/g, '&quot;')
/** Shortest stable decimal form, so serialization stays deterministic. */
const num = (value: number) => String(Number(value.toFixed(4)))
/**
 * Image geometry keeps full precision: an aspect-derived pixel size can be a
 * long fraction, and rounding it would move the written shape on the next
 * export. The floor keeps the value in plain decimal notation, which the parser
 * requires; the writer already clamps a shape to at least 1 HWPUNIT.
 */
const pixels = (value: number) => {
  const clamped = Math.min(Math.max(Number.isFinite(value) ? value : 1e-6, 1e-6), 10_000)
  const text = String(clamped)
  return text.includes('e') ? clamped.toFixed(6) : text
}

function styleAttribute(declarations: string[]): string {
  return declarations.length ? ` style="${attribute(declarations.join(';'))}"` : ''
}

/**
 * Every supported text property is written explicitly, so a value survives the
 * round trip regardless of the tag-derived defaults of the enclosing block
 * (a heading, for example, sets bold plus its own size and font).
 */
function runStyle(style: TextStyle): string {
  const decoration = [style.underline ? 'underline' : '', style.strike ? 'line-through' : '']
    .filter(Boolean)
    .join(' ')
  return [
    `font-family:${style.font}`,
    `font-size:${num(style.sizePt)}pt`,
    `font-weight:${style.bold ? 'bold' : 'normal'}`,
    `font-style:${style.italic ? 'italic' : 'normal'}`,
    `text-decoration:${decoration || 'none'}`,
    `color:${style.color}`,
  ].join(';')
}

function textRun(run: TextRun, pre: boolean): string {
  // Outside pre a newline run came from br; inside pre it is literal text.
  const body = pre ? text(run.text) : run.text.split('\n').map(text).join('<br>')
  return `<span${styleAttribute([runStyle(run.style)])}>${body}</span>`
}

function paragraph(p: Paragraph): string {
  const tag = p.heading ? `h${p.heading}` : p.pre ? 'pre' : 'p'
  const declarations = [`text-align:${p.align}`, `line-height:${num(p.lineHeight)}%`]
  if (p.indent > 0) declarations.push(`margin-left:${num(p.indent * HWPX_INDENT_PT)}pt`)
  const body = p.runs
    .map((run) =>
      run.kind === 'text'
        ? textRun(run, p.pre)
        : `<img src="data:${run.mime};base64,${Buffer.from(run.bytes).toString('base64')}"` +
          ` alt="${attribute(run.alt)}" width="${pixels(run.widthPx)}" height="${pixels(run.heightPx)}">`,
    )
    .join('')
  // Runs are always wrapped in a span, so no leading newline sits directly after
  // the pre start tag where HTML parsing would drop it.
  return `<${tag}${styleAttribute(declarations)}>${body}</${tag}>`
}

function block(item: Block): string {
  if (item.kind === 'paragraph') return paragraph(item)
  const columns = item.columnWidths
    ? `<colgroup>${item.columnWidths
        .map((width) => `<col style="width:${num((width * 100) / HWPX_COLUMN_WIDTH_SCALE)}%">`)
        .join('')}</colgroup>`
    : ''
  const rows = item.rows
    .map((row) => {
      const cells = row
        .map((cell) => {
          const tag = cell.header ? 'th' : 'td'
          return `<${tag}>${cell.paragraphs.map(paragraph).join('')}</${tag}>`
        })
        .join('')
      return `<tr>${cells}</tr>`
    })
    .join('')
  return `<table>${columns}<tbody>${rows}</tbody></table>`
}
