/** Small generation-only model. It deliberately does not replace the DOCX editor model. */
export interface TextStyle {
  bold: boolean
  italic: boolean
  underline: boolean
  strike: boolean
  sizePt: number
  font: string
  color: string
}

export interface TextRun {
  kind: 'text'
  text: string
  style: TextStyle
}

export interface ImageRun {
  kind: 'image'
  bytes: Uint8Array
  mime: 'image/png' | 'image/jpeg'
  widthPx: number
  heightPx: number
  alt: string
}

export type Inline = TextRun | ImageRun
export interface Paragraph {
  kind: 'paragraph'
  runs: Inline[]
  align: 'left' | 'center' | 'right' | 'justify'
  lineHeight: number
  heading: number
  indent: number
  /** Whitespace-significant paragraph (<pre>); normalized HTML must not collapse its text. */
  pre: boolean
}

export interface TableBlock {
  kind: 'table'
  rows: Array<Array<{ header: boolean; paragraphs: Paragraph[] }>>
  /**
   * Explicit column widths as ten-thousandths of the table width, summing to
   * exactly 10000. Absent means "split the content width evenly". Proportional
   * storage keeps `%` and `px` column declarations equivalent and lets the
   * writer and the normalized-HTML serializer agree without re-normalizing.
   */
  columnWidths?: number[]
}

/**
 * Largest-remainder distribution of `total` across positive `weights`. The
 * result always sums to exactly `total` with every entry >= `minimum`, and is a
 * fixed point for weights that already sum to `total` and clear the minimum.
 * Extreme ratios lose precision (a column stops at `minimum`) instead of
 * producing a broken total or an unusably narrow column.
 */
export function distributeWidths(total: number, weights: number[], minimum = 1): number[] {
  const count = weights.length
  if (!Number.isInteger(total) || !Number.isInteger(minimum) || minimum < 1)
    throw new Error('Table column widths cannot be distributed over the available width.')
  if (count < 1 || count * minimum > total)
    throw new Error('Table column widths cannot be distributed over the available width.')
  if (weights.some((weight) => !Number.isFinite(weight) || weight <= 0))
    throw new Error('Table column widths must be positive.')
  const sum = weights.reduce((a, b) => a + b, 0)
  if (!Number.isFinite(sum) || !(sum > 0))
    throw new Error('Table column widths are too large to distribute.')
  // Multiplying first keeps ordinary weights exact (a share that already equals
  // the total stays a fixed point). Extreme weights are scaled down first so the
  // products stay inside the exactly representable integer range.
  const largest = Math.max(...weights)
  const scale =
    largest * total > Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER / (largest * total) : 1
  const scaled = scale === 1 ? weights : weights.map((weight) => weight * scale)
  const scaledSum = scale === 1 ? sum : scaled.reduce((a, b) => a + b, 0)
  if (!Number.isFinite(scaledSum) || !(scaledSum > 0))
    throw new Error('Table column widths are too large to distribute.')
  const exact = scaled.map((weight) => (weight * total) / scaledSum)
  const out = exact.map((value) => Math.max(minimum, Math.floor(value)))
  // Deterministic order: largest fractional part first, then original position.
  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index)
    .map((entry) => entry.index)
  let remainder = total - out.reduce((a, b) => a + b, 0)
  for (let i = 0; remainder > 0; i = (i + 1) % count, remainder--) out[order[i]!]! += 1
  // Clamping tiny columns up to the minimum can overshoot; repay from the widest.
  while (remainder < 0) {
    let widest = -1
    for (let i = 0; i < count; i++)
      if (out[i]! > minimum && (widest < 0 || out[i]! > out[widest]!)) widest = i
    if (widest < 0) throw new Error('Table column widths cannot be distributed.')
    out[widest]! -= 1
    remainder++
  }
  if (out.reduce((a, b) => a + b, 0) !== total || out.some((value) => value < minimum))
    throw new Error('Table column width distribution failed.')
  return out
}

export type Block = Paragraph | TableBlock
export interface GeneratedDocument {
  blocks: Block[]
  warnings: string[]
}

export const DEFAULT_TEXT_STYLE: TextStyle = {
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  sizePt: 11,
  font: '함초롬바탕',
  color: '#000000',
}

export const HWPX_LIMITS = {
  htmlChars: 4_000_000,
  nodes: 20_000,
  depth: 32,
  blocks: 2_000,
  tableCells: 5_000,
  tableColumns: 32,
  images: 32,
  imageBytes: 4_000_000,
  totalImageBytes: 12_000_000,
  styleVariants: 128,
} as const

/** Column widths are proportional; the table itself always spans the content width. */
export const HWPX_COLUMN_WIDTH_SCALE = 10_000
/**
 * Narrowest column, as a share of `HWPX_COLUMN_WIDTH_SCALE`. Applied while
 * parsing so the model, the written bytes and the normalized HTML all describe
 * the same grid; the writer never narrows a column further on its own.
 */
export const HWPX_MIN_COLUMN_SHARE = 200
/** One indent level in the writer is 1400 HWPUNIT = 14 pt. */
export const HWPX_INDENT_PT = 14
/** Deeper indentation is flattened to this level in the model and in the output. */
export const HWPX_MAX_INDENT = 8
