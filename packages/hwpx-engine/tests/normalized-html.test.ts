import { describe, expect, it } from 'vitest'
import { strFromU8, unzipSync } from 'fflate'
import { HWPXReader, TextExtractMethod, TextExtractor } from 'ownhwpx'
import {
  HWPX_COLUMN_WIDTH_SCALE,
  HWPX_MAX_INDENT,
  documentToHtml,
  exportHwpx,
  parseHwpxHtml,
} from '../src/index'
import { distributeWidths } from '../src/model'

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII='
const options = { title: '정규화 HTML', createdAt: new Date('2026-09-08T00:00:00Z') }
const textOf = (bytes: Uint8Array) =>
  TextExtractor.extract(
    HWPXReader.fromBytes(bytes),
    TextExtractMethod.AppendControlTextAfterParagraphText,
    false,
    null,
  )
const columnWidths = (bytes: Uint8Array) =>
  [
    ...strFromU8(unzipSync(bytes)['Contents/section0.xml']!).matchAll(
      /<hp:cellSz\s+width="(\d+)"/g,
    ),
  ].map((match) => Number(match[1]))

describe('normalized editor HTML', () => {
  it('re-exports byte-identically and preserves extracted text', () => {
    const source =
      '<h2>제목</h2><p style="text-align:center;line-height:1.8"><strong>굵게</strong> <em>기울임</em> <u>밑줄</u> <s>취소</s> <span style="font-size:14pt;color:#369">색</span></p>' +
      '<p>앞<br>뒤</p><blockquote><p>인용</p></blockquote>' +
      '<table><colgroup><col style="width:70%"><col style="width:30%"></colgroup><tr><th>항목</th><th>금액</th></tr><tr><td><p>준비비</p><p><strong>검토</strong></p></td><td>1,000</td></tr></table>' +
      `<p><img src="data:image/png;base64,${PNG}" width="96" height="48" alt="테스트"></p>`
    const first = exportHwpx(source, options)
    const second = exportHwpx(first.editorHtml, options)
    // The normalized HTML describes the same document the bytes were written from.
    expect(second.bytes).toEqual(first.bytes)
    expect(second.editorHtml).toBe(first.editorHtml)
    expect(textOf(second.bytes)).toBe(textOf(first.bytes))
  })

  it('is derived from the parsed model, not the original HTML', () => {
    const result = exportHwpx('<div><p>본문</p></div>', options)
    // div/blockquote grouping and editor-only wrappers do not survive; content does.
    expect(result.editorHtml).not.toContain('<div')
    expect(result.editorHtml).toContain('본문')
    expect(documentToHtml(parseHwpxHtml('<div><p>본문</p></div>'))).toBe(result.editorHtml)
  })

  it('keeps list markers as text without renumbering on a no-edit roundtrip', () => {
    const source =
      '<ol start="3"><li>세 번째<ul><li>중첩 항목</li></ul></li><li>네 번째</li></ol><ul><li>항목</li></ul>'
    const first = exportHwpx(source, options)
    const second = exportHwpx(first.editorHtml, options)
    for (const marker of ['3. 세 번째', '• 중첩 항목', '4. 네 번째', '• 항목']) {
      expect(textOf(first.bytes)).toContain(marker)
      expect(textOf(second.bytes)).toContain(marker)
    }
    // A second export must not add another marker in front of the first one.
    expect(second.editorHtml).toBe(first.editorHtml)
    expect(textOf(second.bytes)).not.toContain('• 3.')
    expect(textOf(second.bytes)).not.toContain('1. 3.')
    // Nested items keep their deeper indentation as an explicit margin-left.
    expect(first.editorHtml).toContain('margin-left:14pt')
    expect(first.editorHtml).toContain('margin-left:28pt')
  })

  it('keeps inline formatting, pre whitespace and image geometry explicit', () => {
    const result = exportHwpx(
      `<p><strong>굵게</strong><em>기울임</em></p><pre>  들여쓴\t칸</pre><p><img src="data:image/png;base64,${PNG}" width="96" height="48" alt="테스트"></p>`,
      options,
    )
    expect(result.editorHtml).toContain('font-weight:bold')
    expect(result.editorHtml).toContain('font-style:italic')
    expect(result.editorHtml).toContain('<pre')
    expect(result.editorHtml).toContain('  들여쓴\t칸')
    expect(result.editorHtml).toContain('width="96" height="48"')
    expect(result.editorHtml).toContain('alt="테스트"')
    const roundtrip = parseHwpxHtml(result.editorHtml)
    const pre = roundtrip.blocks.find((b) => b.kind === 'paragraph' && b.pre)
    expect(
      pre && pre.kind === 'paragraph' && pre.runs[0]!.kind === 'text' && pre.runs[0]!.text,
    ).toBe('  들여쓴\t칸')
  })

  it('keeps aspect-derived image geometry stable across a roundtrip', () => {
    // 1x1 source scaled by width only: the derived height must survive re-parsing.
    const first = exportHwpx(
      `<p><img src="data:image/png;base64,${PNG}" width="100" alt=""></p>`,
      options,
    )
    const second = exportHwpx(first.editorHtml, options)
    expect(second.editorHtml).toBe(first.editorHtml)
    expect(second.bytes).toEqual(first.bytes)
  })

  it('keeps empty paragraphs, which editors produce with a bare Enter', () => {
    const first = exportHwpx('<p>위</p><p></p><p>아래</p>', options)
    expect(first.editorHtml).toContain('<p style="text-align:left;line-height:160%"></p>')
    const second = exportHwpx(first.editorHtml, options)
    expect(second.editorHtml).toBe(first.editorHtml)
    expect(second.bytes).toEqual(first.bytes)
  })

  it('escapes markup and quotes so normalized HTML re-parses to the same text', () => {
    const result = exportHwpx('<p>금액 &amp; 세금 &lt;예시&gt; "인용" 😀</p>', options)
    expect(result.editorHtml).toContain('금액 &amp; 세금 &lt;예시&gt; "인용" 😀')
    expect(textOf(exportHwpx(result.editorHtml, options).bytes)).toContain(
      '금액 & 세금 <예시> "인용" 😀',
    )
  })

  it('flattens indentation deeper than the supported levels once, in both outputs', () => {
    // 10 nested blockquotes exceed the 8 supported indent levels.
    const deep = '<blockquote>'.repeat(10) + '<p>깊은 인용</p>' + '</blockquote>'.repeat(10)
    const first = exportHwpx(deep, options)
    expect(first.warnings.join(' ')).toContain('flattened to the 8th level')
    expect(first.editorHtml).toContain(`margin-left:${HWPX_MAX_INDENT * 14}pt`)
    const paragraph = parseHwpxHtml(first.editorHtml).blocks[0]!
    expect(paragraph.kind === 'paragraph' && paragraph.indent).toBe(HWPX_MAX_INDENT)
    // The flattening happens in the model, so a second export changes nothing.
    const second = exportHwpx(first.editorHtml, options)
    expect(second.bytes).toEqual(first.bytes)
    expect(second.editorHtml).toBe(first.editorHtml)
    expect(second.warnings.join(' ')).not.toContain('flattened to the 8th level')
  })
})

describe('explicit table column widths', () => {
  it('writes unequal cell widths in the declared proportion', () => {
    const widths = columnWidths(
      exportHwpx(
        '<table><colgroup><col style="width:70%"><col style="width:30%"></colgroup><tr><td>가</td><td>나</td></tr></table>',
        options,
      ).bytes,
    )
    expect(widths).toHaveLength(2)
    expect(widths[0]! + widths[1]!).toBe(59528 - 5669 * 2)
    expect(widths[0]! / (widths[0]! + widths[1]!)).toBeCloseTo(0.7, 3)
  })

  it('treats equal px and pt declarations as equal columns', () => {
    const px = columnWidths(
      exportHwpx(
        '<table><colgroup><col style="width:96px"><col style="width:96px"></colgroup><tr><td>가</td><td>나</td></tr></table>',
        options,
      ).bytes,
    )
    const mixedUnitsSameSize = columnWidths(
      exportHwpx(
        '<table><colgroup><col style="width:72pt"><col style="width:96px"></colgroup><tr><td>가</td><td>나</td></tr></table>',
        options,
      ).bytes,
    )
    expect(mixedUnitsSameSize).toEqual(px)
    expect(px[0]).toBe(px[1])
  })

  it('accepts col width attributes and span, and survives the normalized roundtrip', () => {
    const source =
      '<table><colgroup><col width="200"><col span="2" width="100"></colgroup><tr><td>가</td><td>나</td><td>다</td></tr></table>'
    const first = exportHwpx(source, options)
    const declared = columnWidths(first.bytes)
    expect(declared[0]! / declared[1]!).toBeCloseTo(2, 2)
    // Equal shares can differ by the single leftover HWPUNIT of the text width.
    expect(Math.abs(declared[1]! - declared[2]!)).toBeLessThanOrEqual(1)
    expect(first.editorHtml).toContain(
      '<colgroup><col style="width:50%"><col style="width:25%"><col style="width:25%"></colgroup>',
    )
    expect(columnWidths(exportHwpx(first.editorHtml, options).bytes)).toEqual(declared)
  })

  it('keeps even columns when no colgroup is declared', () => {
    const result = exportHwpx('<table><tr><td>가</td><td>나</td><td>다</td></tr></table>', options)
    const widths = columnWidths(result.bytes)
    expect(widths).toHaveLength(3)
    expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1)
    expect(widths.reduce((a, b) => a + b, 0)).toBe(59528 - 5669 * 2)
    expect(result.editorHtml).not.toContain('colgroup')
  })

  it.each([
    [
      '<table><colgroup><col style="width:50%"></colgroup><tr><td>가</td><td>나</td></tr></table>',
      /exactly one width per column/,
    ],
    [
      '<table><colgroup><col style="width:50%"><col></colgroup><tr><td>가</td><td>나</td></tr></table>',
      /must declare a width/,
    ],
    [
      '<table><colgroup><col style="width:50%"><col style="width:120px"></colgroup><tr><td>가</td><td>나</td></tr></table>',
      /cannot mix/,
    ],
    [
      '<table><colgroup><col style="background:red"></colgroup><tr><td>가</td></tr></table>',
      /col CSS property/,
    ],
    [
      '<table><colgroup span="2"><col style="width:50%"><col style="width:50%"></colgroup><tr><td>가</td><td>나</td></tr></table>',
      /Unsupported HWPX attribute/,
    ],
    [
      '<table><colgroup><col style="width:50%" class="x"><col style="width:50%"></colgroup><tr><td>가</td><td>나</td></tr></table>',
      /Unsupported HWPX attribute/,
    ],
    [
      '<table><colgroup><col style="width:0%"><col style="width:100%"></colgroup><tr><td>가</td><td>나</td></tr></table>',
      /positive/,
    ],
    [
      '<table><tr><td>가</td></tr><colgroup><col style="width:100%"></colgroup></table>',
      /before the table rows/,
    ],
    ['<col style="width:50%">', /only inside a table/],
    ['<colgroup><col style="width:50%"></colgroup>', /only inside a table/],
  ])('rejects ambiguous column declarations: %s', (input, error) => {
    expect(() => exportHwpx(input, options)).toThrow(error)
  })

  it('warns that declared widths are proportional to the text width', () => {
    const result = exportHwpx(
      '<table><colgroup><col style="width:70%"><col style="width:30%"></colgroup><tr><td>가</td><td>나</td></tr></table>',
      options,
    )
    expect(result.warnings.join(' ')).toContain('kept in proportion')
  })

  it('widens a too-narrow column in the model, so bytes and editor HTML agree', () => {
    const first = exportHwpx(
      '<table><colgroup><col style="width:1%"><col style="width:99%"></colgroup><tr><td>가</td><td>나</td></tr></table>',
      options,
    )
    expect(first.warnings.join(' ')).toContain('widened to a readable minimum width')
    // 200/10000 is the minimum share; the editor sees the same 2% column that
    // was written into the file.
    expect(first.editorHtml).toContain(
      '<colgroup><col style="width:2%"><col style="width:98%"></colgroup>',
    )
    const widths = columnWidths(first.bytes)
    expect(widths[0]! / (widths[0]! + widths[1]!)).toBeCloseTo(0.02, 3)
    const second = exportHwpx(first.editorHtml, options)
    expect(columnWidths(second.bytes)).toEqual(widths)
    expect(second.editorHtml).toBe(first.editorHtml)
    expect(second.warnings.join(' ')).not.toContain('widened to a readable minimum width')
  })

  it('keeps 32 extreme-ratio columns within the text width', () => {
    const cols =
      '<col style="width:600px">' + '<col style="width:1px">'.repeat(HWPX_MAX_INDENT * 4 - 1)
    const cells = '<td>가</td>'.repeat(32)
    const result = exportHwpx(
      `<table><colgroup>${cols}</colgroup><tr>${cells}</tr></table>`,
      options,
    )
    const widths = columnWidths(result.bytes)
    expect(widths).toHaveLength(32)
    expect(widths.reduce((a, b) => a + b, 0)).toBe(59528 - 5669 * 2)
    expect(Math.min(...widths)).toBeGreaterThan(0)
    expect(columnWidths(exportHwpx(result.editorHtml, options).bytes)).toEqual(widths)
  })
})

describe('width distribution', () => {
  it('always sums to the total and respects the minimum', () => {
    const total = 59528 - 5669 * 2
    const extremes = [
      [1_000_000, ...Array.from({ length: 31 }, () => 1)],
      Array.from({ length: 32 }, (_, i) => i + 1),
      Array.from({ length: 32 }, () => 1e-6),
      [1e15, 1, 1],
      [100, 0.5],
    ]
    for (const weights of extremes) {
      const widths = distributeWidths(total, weights, 900)
      expect(widths).toHaveLength(weights.length)
      expect(widths.reduce((a, b) => a + b, 0)).toBe(total)
      expect(Math.min(...widths)).toBeGreaterThanOrEqual(900)
    }
  })

  it('is a fixed point for widths that already sum to the total', () => {
    const widths = distributeWidths(HWPX_COLUMN_WIDTH_SCALE, [7000, 2000, 1000])
    expect(widths).toEqual([7000, 2000, 1000])
    expect(distributeWidths(HWPX_COLUMN_WIDTH_SCALE, widths)).toEqual(widths)
  })

  it('rejects impossible or non-finite distributions instead of returning a broken total', () => {
    expect(() =>
      distributeWidths(
        100,
        Array.from({ length: 32 }, () => 1),
        900,
      ),
    ).toThrow(/cannot be distributed/)
    expect(() => distributeWidths(1000, [Number.POSITIVE_INFINITY, 1])).toThrow(/positive/)
    expect(() => distributeWidths(1000, [Number.MAX_VALUE, Number.MAX_VALUE])).toThrow(
      /too large|positive/,
    )
    expect(() => distributeWidths(1000, [])).toThrow(/cannot be distributed/)
  })
})
