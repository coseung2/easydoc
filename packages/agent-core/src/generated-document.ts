/** One shared contract for newly authored documents, not editor round-trip saves. */
export const GENERATED_DOCUMENT_TYPES = ['docx', 'pdf', 'md', 'hwpx'] as const
export type GeneratedDocumentType = (typeof GENERATED_DOCUMENT_TYPES)[number]
export const MAX_GENERATED_DOCUMENT_TITLE_CHARS = 200
export const MAX_GENERATED_DOCUMENT_CONTENT_CHARS = 2_000_000

export interface GeneratedDocumentRequest {
  type: GeneratedDocumentType
  title: string
  content: string
}

export interface GeneratedDocumentResult {
  ok: boolean
  path?: string
  error?: string
  /** False means saved/revealed, not opened in an editor tab. */
  opened?: boolean
  warnings?: string[]
  verification?: 'structural-only'
}

export function isGeneratedDocumentType(value: unknown): value is GeneratedDocumentType {
  return (
    typeof value === 'string' && GENERATED_DOCUMENT_TYPES.includes(value as GeneratedDocumentType)
  )
}

export function validateGeneratedDocumentRequest(input: unknown): GeneratedDocumentRequest {
  if (!input || typeof input !== 'object') throw new Error('Invalid document request.')
  const { type, title, content } = input as Partial<GeneratedDocumentRequest>
  if (!isGeneratedDocumentType(type)) throw new Error('type must be one of docx/pdf/md/hwpx')
  if (
    typeof title !== 'string' ||
    !title.trim() ||
    title.length > MAX_GENERATED_DOCUMENT_TITLE_CHARS
  )
    throw new Error('Document title must contain 1–200 characters.')
  if (
    typeof content !== 'string' ||
    !content.trim() ||
    content.length > MAX_GENERATED_DOCUMENT_CONTENT_CHARS
  )
    throw new Error('Document content is empty or exceeds 2,000,000 characters.')
  return { type, title: title.trim(), content }
}

/** Keep the capability boundary next to the shared type catalog. */
export const HWPX_TOOL_GUIDE =
  'hwpx creates an experimental Hancom document from restricted HTML: paragraphs/headings, bold/italic/underline/strike, text-align, font-size/font-family/color/line-height, simple lists, rectangular unmerged tables, and embedded base64 PNG/JPEG images. No external image URLs, merged/nested tables, charts, equations, arbitrary CSS, or HWP5 output. The file is saved and opened in a document tab when supported by the host; use the returned opened flag. Report compatibility warnings; Hancom visual/open verification is still required.'

export function generatedDocumentResultText(
  type: string,
  title: string,
  result: GeneratedDocumentResult,
): string {
  if (!result.ok) return result.error || 'Document creation failed.'
  const description = result.path
    ? `Created the new document at ${result.path}${result.opened === false ? '. The file was saved, not opened in an editor tab.' : ' and opened it in a new tab.'}`
    : `Created the new document "${title}.${type}" in a new tab; it saves itself into the default folder.`
  return [description, ...(result.warnings ?? [])].join('\n')
}
