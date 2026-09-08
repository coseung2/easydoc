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
}

export interface TableBlock {
  kind: 'table'
  rows: Array<Array<{ header: boolean; paragraphs: Paragraph[] }>>
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
