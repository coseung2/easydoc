import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { uniqueGeneratedPdfPath } from '../src/main/generated-output'

describe('uniqueGeneratedPdfPath', () => {
  it.each([
    '../report-merged.pdf',
    '..\\report-merged.pdf',
    '/other/nested/report-merged.pdf',
    'C:\\other\\nested\\report-merged.pdf',
    '\\\\server\\share\\report-merged.pdf',
    '../other\\nested/report-merged.pdf',
  ])('keeps generated PDFs inside the configured directory for %s', (suggestedName) => {
    expect(uniqueGeneratedPdfPath('/save', suggestedName, () => false)).toBe(
      join('/save', 'report-merged.pdf'),
    )
  })

  it('adds a PDF extension and skips existing names', () => {
    const occupied = new Set([join('/save', 'report.pdf'), join('/save', 'report-2.pdf')])
    expect(uniqueGeneratedPdfPath('/save', 'report', (path) => occupied.has(path))).toBe(
      join('/save', 'report-3.pdf'),
    )
  })

  it('sanitizes characters that are invalid in file names', () => {
    expect(uniqueGeneratedPdfPath('/save', 'a:b?.pdf', () => false)).toBe(join('/save', 'a_b_.pdf'))
  })

  it('preserves drive-relative-looking title text before sanitizing and numbering', () => {
    const occupied = new Set([join('/save', 'C_report.PDF')])
    expect(uniqueGeneratedPdfPath('/save', 'C:report.PDF', (path) => occupied.has(path))).toBe(
      join('/save', 'C_report-2.pdf'),
    )
  })

  it('preserves an existing PDF extension regardless of case', () => {
    expect(uniqueGeneratedPdfPath('/save', ' report.PDF ', () => false)).toBe(
      join('/save', 'report.PDF'),
    )
  })

  it.each(['', '.', '..'])('uses a default name for %j', (suggestedName) => {
    expect(uniqueGeneratedPdfPath('/save', suggestedName, () => false)).toBe(
      join('/save', 'merged.pdf'),
    )
  })
})
