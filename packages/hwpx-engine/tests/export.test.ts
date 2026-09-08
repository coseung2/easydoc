import { describe, expect, it } from 'vitest'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { HWPXReader, TextExtractor, TextExtractMethod } from 'ownhwpx'
import { exportHwpx, inspectGeneratedHwpx, parseHwpxHtml } from '../src/index'

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII='
const options = { title: '한글 문서 검증 & 비교', createdAt: new Date('2026-09-08T00:00:00Z') }
const textOf = (bytes: Uint8Array) =>
  TextExtractor.extract(
    HWPXReader.fromBytes(bytes),
    TextExtractMethod.AppendControlTextAfterParagraphText,
    false,
    null,
  )

describe('experimental HWPX export', () => {
  it('writes Korean, emoji and escaped XML without changing content', () => {
    const result = exportHwpx('<h1>보고서</h1><p>금액 &amp; 세금 &lt;예시&gt; 😀</p>', options)
    const { files, xml } = inspectGeneratedHwpx(result.bytes)
    expect(Object.keys(files)[0]).toBe('mimetype')
    expect(strFromU8(files.mimetype!)).toBe('application/hwp+zip')
    expect(textOf(result.bytes)).toContain('금액 & 세금 <예시> 😀')
    expect(strFromU8(files['Contents/content.hpf']!)).toContain('한글 문서 검증 &amp; 비교')
    expect(
      xml['Contents/section0.xml']!.find((e) => e.name === 'hp:pagePr')?.attributes,
    ).toMatchObject({ width: '59528', height: '84189' })
    expect(result.verification).toBe('structural-only')
    expect(result.warnings[0]).toContain('have not been verified')
  })

  it('serializes headings, inline emphasis, colors, font mapping and paragraph alignment', () => {
    const result = exportHwpx(
      '<h2>제목</h2><p style="text-align:center;line-height:1.8;font-family:맑은고딕"><strong>굵게</strong> <em>기울임</em> <u>밑줄</u> <s>취소</s> <span style="font-size:14pt;color:#369">색</span></p>',
      options,
    )
    const { files, xml } = inspectGeneratedHwpx(result.bytes)
    const header = strFromU8(files['Contents/header.xml']!)
    expect(header).toContain('Heading 2')
    expect(header).toContain('맑은 고딕')
    expect(header).toContain('<hh:bold')
    expect(header).toContain('<hh:italic')
    expect(header).toContain('type="BOTTOM"')
    expect(header).toContain('<hh:strikeout')
    expect(header).toContain('#336699')
    expect(
      xml['Contents/header.xml']!.some(
        (e) => e.name === 'hh:align' && e.attributes.horizontal === 'CENTER',
      ),
    ).toBe(true)
    expect(header).toContain('value="180"')
  })

  it('keeps line breaks and editable list text with an explicit numbering limitation', () => {
    const result = exportHwpx(
      '<p>앞<br>뒤</p><ol start="3"><li>세 번째</li><li>네 번째</li></ol><ul><li>항목</li></ul>',
      options,
    )
    const section = strFromU8(unzipSync(result.bytes)['Contents/section0.xml']!)
    expect(section).toContain('<hp:lineBreak')
    expect(textOf(result.bytes)).toContain('3. 세 번째')
    expect(textOf(result.bytes)).toContain('4. 네 번째')
    expect(result.warnings.join(' ')).toContain('not automatic HWP numbering')
  })

  it('creates rectangular tables with cell addresses, sizes, spans and styled cell paragraphs', () => {
    const result = exportHwpx(
      '<table><tr><th>항목</th><th>금액</th></tr><tr><td><p>준비비</p><p><strong>검토</strong></p></td><td>1,000</td></tr></table><p>끝</p>',
      options,
    )
    const { xml } = inspectGeneratedHwpx(result.bytes)
    const section = xml['Contents/section0.xml']!
    expect(section.find((e) => e.name === 'hp:tbl')?.attributes).toMatchObject({
      rowCnt: '2',
      colCnt: '2',
      repeatHeader: '1',
    })
    expect(section.filter((e) => e.name === 'hp:cellAddr').map((e) => e.attributes)).toEqual([
      { colAddr: '0', rowAddr: '0' },
      { colAddr: '1', rowAddr: '0' },
      { colAddr: '0', rowAddr: '1' },
      { colAddr: '1', rowAddr: '1' },
    ])
    expect(section.filter((e) => e.name === 'hp:cellSpan')).toHaveLength(4)
    expect(section.filter((e) => e.name === 'hp:subList')).toHaveLength(4)
    expect(textOf(result.bytes)).toContain('준비비')
    expect(textOf(result.bytes)).toContain('1,000')
    expect(textOf(result.bytes)).toContain('끝')
  })

  it('embeds images, connects manifest ids, and keeps original bytes', () => {
    const result = exportHwpx(
      `<p>이미지</p><p><img src="data:image/png;base64,${PNG}" alt="테스트" width="96" height="48"></p>`,
      options,
    )
    const { files, xml } = inspectGeneratedHwpx(result.bytes)
    expect(files['BinData/image1.png']).toEqual(new Uint8Array(Buffer.from(PNG, 'base64')))
    expect(
      xml['Contents/section0.xml']!.find((e) => e.name === 'hc:img')?.attributes.binaryItemIDRef,
    ).toBe('image1')
    expect(
      xml['Contents/content.hpf']!.some(
        (e) => e.attributes.id === 'image1' && e.attributes.href === 'BinData/image1.png',
      ),
    ).toBe(true)
    expect(
      HWPXReader.fromBytes(result.bytes).contentHPFFile.manifestList.some((e) => e.id === 'image1'),
    ).toBe(true)
  })

  it('is byte-identical for the same source/options and includes a text preview', () => {
    const a = exportHwpx('<p>동일한 결과</p>', options)
    const b = exportHwpx('<p>동일한 결과</p>', options)
    expect(a.bytes).toEqual(b.bytes)
    expect(strFromU8(unzipSync(a.bytes)['Preview/PrvText.txt']!)).toBe('동일한 결과')
  })

  it.each([
    ['', /empty/],
    ['<script>alert(1)</script><p>text</p>', /Unsupported/],
    ['<p onclick="alert(1)">text</p>', /attribute/],
    ['<iframe src="https://example.test"/>', /Unsupported/],
    ['<p style="background-image:url(file:///secret)">text</p>', /CSS/],
    ['<p><img src="https://example.test/a.png"></p>', /data URIs/],
    ['<p><img src="file:///etc/passwd"></p>', /data URIs/],
    ['<p><img src="data:image/svg+xml;base64,AAAA"></p>', /data URIs/],
    ['<p><img src="data:image/png;base64,AAAA"></p>', /Invalid embedded/],
    ['<table><tr><td colspan="2">merged</td></tr></table>', /Merged/],
    ['<table><tr><td>a</td><td>b</td></tr><tr><td>c</td></tr></table>', /rectangular/],
    ['<table><tr><td><table><tr><td>x</td></tr></table></td></tr></table>', /Nested/],
    ['<p><formula>x^2</formula></p>', /Unsupported/],
    ['<p>\u0000</p>', /invalid XML/],
    ['<p>\ud800</p>', /invalid XML/],
    ['<p dir="rtl">text</p>', /left-to-right/],
    ['<p style="font-size:1000pt">text</p>', /font-size/],
  ])('rejects unsupported or unsafe input: %s', (input, error) => {
    expect(() => exportHwpx(input, options)).toThrow(error)
  })

  it('bounds deep HTML and paragraph counts', () => {
    expect(() => parseHwpxHtml('<div>'.repeat(40) + 'text' + '</div>'.repeat(40))).toThrow(/limits/)
    expect(() => parseHwpxHtml('<p>text</p>'.repeat(2001))).toThrow(/Too many/)
  })

  it('rejects dangling references and missing resources rather than calling the archive valid', () => {
    const valid = exportHwpx('<p>검증</p>', options).bytes
    const files = unzipSync(valid)
    files['Contents/section0.xml'] = strToU8(
      strFromU8(files['Contents/section0.xml']!).replace('charPrIDRef="0"', 'charPrIDRef="9999"'),
    )
    const repack = () =>
      zipSync({
        mimetype: [files.mimetype!, { level: 0 }],
        ...Object.fromEntries(Object.entries(files).filter(([name]) => name !== 'mimetype')),
      })
    expect(() => inspectGeneratedHwpx(repack())).toThrow(/Dangling/)
    delete files['Contents/header.xml']
    expect(() => inspectGeneratedHwpx(repack())).toThrow(/Missing/)
  })
})
