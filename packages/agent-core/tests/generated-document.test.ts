import { describe, expect, it } from 'vitest'
import {
  GENERATED_DOCUMENT_TYPES,
  generatedDocumentResultText,
  validateGeneratedDocumentRequest,
} from '../src/generated-document'

describe('generated document contract', () => {
  it.each(GENERATED_DOCUMENT_TYPES)('accepts %s without inferring another format', (type) => {
    expect(
      validateGeneratedDocumentRequest({ type, title: ' Title ', content: '<p>Text</p>' }),
    ).toEqual({ type, title: 'Title', content: '<p>Text</p>' })
  })
  it.each([
    null,
    {},
    { type: 'hwp', title: 'T', content: 'x' },
    { type: 'hwpx', title: '', content: 'x' },
    { type: 'hwpx', title: 'T', content: '' },
    { type: 'hwpx', title: 'T', content: 'x'.repeat(2_000_001) },
  ])('rejects an invalid request', (input) => {
    expect(() => validateGeneratedDocumentRequest(input)).toThrow()
  })
  it('never says HWPX was opened as an editable tab and preserves warnings', () => {
    const text = generatedDocumentResultText('hwpx', 'Report', {
      ok: true,
      path: '/output/Report.hwpx',
      opened: false,
      warnings: ['Manual Hancom review required.'],
      verification: 'structural-only',
    })
    expect(text).toContain('not opened in an editor tab')
    expect(text).not.toContain('opened it in a new tab')
    expect(text).toContain('Manual Hancom review required')
  })
  it('does not turn a failed save into a success claim', () => {
    expect(generatedDocumentResultText('hwpx', 'Report', { ok: false, error: 'disk full' })).toBe(
      'disk full',
    )
  })
})
