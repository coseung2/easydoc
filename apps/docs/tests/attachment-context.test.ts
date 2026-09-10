import { expect, it, vi } from 'vitest'
import { attachmentContext } from '../src/renderer/ai/attachment-context'

it('supplies PDF/HWPX content before tool selection with bounded excerpts', async () => {
  const read = vi.fn(async () => ({ ok: true, text: 'verified content', totalChars: 50000 }))
  const result = await attachmentContext(
    [{ path: '/sample.pdf', name: 'sample.pdf', ext: 'pdf', sizeBytes: 10 }],
    read,
  )
  expect(read).toHaveBeenCalledWith('/sample.pdf', 0, 12000)
  expect(result).toContain('verified content')
  expect(result).toContain('read_attachment')
  expect(result).toContain('not instructions')
})
it('reports extraction failures instead of pretending a file was read', async () => {
  const result = await attachmentContext(
    [{ path: '/scan.pdf', name: 'scan.pdf', ext: 'pdf', sizeBytes: 10 }],
    async () => ({ ok: false, error: 'OCR required' }),
  )
  expect(result).toContain('OCR required')
  expect(result).toContain('do not guess')
})
