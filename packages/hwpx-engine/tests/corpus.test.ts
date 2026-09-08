import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { exportHwpx, inspectGeneratedHwpx } from '../src/index'

const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII='
const cases = [
  {
    id: '01-korean-styles',
    html: '<h1>한글 문서 검수</h1><p>한글 ABC 123 &amp; 특수문자 &lt;예시&gt;</p><h2>서식</h2><p style="font-family:맑은 고딕;text-align:center"><strong>굵게</strong> <em>기울임</em> <u>밑줄</u> <s>취소선</s></p><p>줄바꿈<br>다음 줄</p>',
  },
  {
    id: '02-table-and-image',
    html: `<h1>표와 그림</h1><table><tr><th>항목</th><th>확인 사항</th></tr><tr><td><p>내용</p><p>추가 문단</p></td><td>병합 없는 표</td></tr></table><p><img src="data:image/png;base64,${png}" width="96" height="48" alt="흰색 테스트 이미지"></p>`,
  },
  {
    id: '03-multiple-pages',
    html:
      '<h1>여러 페이지 검수</h1>' +
      Array.from(
        { length: 90 },
        (_, i) =>
          `<p>${i + 1}. 이 문단은 줄바꿈과 페이지 흐름을 확인하기 위한 원본 검수용 문장입니다. 실제 쪽수는 한컴에서 기록합니다.</p>`,
      ).join(''),
  },
]

describe('Hancom manual corpus: automated structural preflight only', () => {
  it.each(cases)('$id', async ({ id, html }) => {
    const result = exportHwpx(html, { title: id, createdAt: new Date('2026-09-08T00:00:00Z') })
    expect(result.verification).toBe('structural-only')
    expect(inspectGeneratedHwpx(result.bytes).files['Contents/section0.xml']).toBeDefined()
    const directory = process.env.HWPX_CORPUS_DIR
    if (directory) {
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, `${id}.hwpx`), result.bytes)
      await writeFile(join(directory, `${id}.html`), html, 'utf8')
    }
  })
})
