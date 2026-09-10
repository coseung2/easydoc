import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { hwpxToText } from '../src/hwpx'

describe('HWPX attachments', () => {
  it('reads numbered sections, Korean text and table cells in order', async () => {
    const zip = new JSZip()
    zip.file('Contents/section10.xml', '<s><p><run><t>마지막</t></run></p></s>')
    zip.file(
      'Contents/section2.xml',
      '<s><p><run><t>예산 &amp; 일정</t></run></p><tbl><tr><tc><p><run><t>1,250원</t></run></p></tc></tr></tbl></s>',
    )
    const text = await hwpxToText(await zip.generateAsync({ type: 'uint8array' }))
    expect(text).toContain('예산 & 일정')
    expect(text).toContain('1,250원')
    expect(text.indexOf('예산')).toBeLessThan(text.indexOf('마지막'))
  })
  it('rejects missing sections and entity declarations', async () => {
    await expect(
      hwpxToText(await new JSZip().generateAsync({ type: 'uint8array' })),
    ).rejects.toThrow('no document sections')
    const zip = new JSZip().file('Contents/section0.xml', '<!DOCTYPE s><s/>')
    await expect(hwpxToText(await zip.generateAsync({ type: 'uint8array' }))).rejects.toThrow(
      'Invalid HWPX',
    )
  })
})
