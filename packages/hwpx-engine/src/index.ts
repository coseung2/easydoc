import { strToU8, zipSync, type Zippable } from 'fflate'
import { parseHwpxHtml } from './html'
import { writeOwnHwpx } from './ownhwpx-adapter'
import type { HwpxWriteOptions } from './ownhwpx-adapter'
import { inspectGeneratedHwpx } from './validate'

export { HWPX_LIMITS } from './model'
export { parseHwpxHtml } from './html'
export { inspectGeneratedHwpx } from './validate'
export type { HwpxWriteOptions } from './ownhwpx-adapter'

export interface HwpxExportResult {
  bytes: Uint8Array
  warnings: string[]
  verification: 'structural-only'
}

export const HWPX_EXPERIMENTAL_WARNING =
  'Experimental HWPX export: ZIP/XML structure was checked, but Hancom opening, pagination, and visual fidelity have not been verified. Review the file in Hancom before submitting it.'

/** No filesystem/network side effects. The host owns safe saving and user-facing routing. */
export function exportHwpx(html: string, options: HwpxWriteOptions): HwpxExportResult {
  if (
    !options ||
    typeof options.title !== 'string' ||
    options.title.length > 200 ||
    !options.title.trim()
  )
    throw new Error('HWPX title must contain 1–200 characters.')
  // Validate metadata with the same XML character policy as content.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ud800-\udfff\ufffe\uffff]/u.test(options.title))
    throw new Error('Invalid characters in HWPX title.')
  const document = parseHwpxHtml(html)
  const raw = writeOwnHwpx(document, options)
  const inspected = inspectGeneratedHwpx(raw)
  const preview = document.blocks
    .flatMap((block) =>
      block.kind === 'paragraph'
        ? [block]
        : block.rows.flatMap((row) => row.flatMap((cell) => cell.paragraphs)),
    )
    .map((p) => p.runs.map((r) => (r.kind === 'text' ? r.text : r.alt)).join(''))
    .join('\n')
    .slice(0, 40_000)
  // SDK ZIP timestamps depend on wall-clock time. Canonical package timestamps
  // make byte-for-byte regression tests possible for identical input/options.
  const entries: Zippable = {}
  const mtime = new Date(2000, 0, 1)
  for (const [name, bytes] of Object.entries(inspected.files))
    entries[name] = [bytes, { level: name === 'mimetype' ? 0 : 6, mtime }]
  entries['Preview/PrvText.txt'] = [strToU8(preview), { level: 6, mtime }]
  const bytes = zipSync(entries)
  inspectGeneratedHwpx(bytes)
  return {
    bytes,
    warnings: [HWPX_EXPERIMENTAL_WARNING, ...document.warnings],
    verification: 'structural-only',
  }
}
