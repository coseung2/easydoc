import { describe, expect, it } from 'vitest'
import { matchesFontSearch, resolveFontName } from '../src/renderer/font-names'

describe('installed font aliases', () => {
  it('uses the exact installed family for Korean aliases and spacing variants', () => {
    expect(resolveFontName('지마켓 산스', ['Gmarket Sans'])).toBe('Gmarket Sans')
    expect(resolveFontName('배달의민족 주아', ['BM JUA'])).toBe('BM JUA')
    expect(resolveFontName('안동엄마까투리', ['ANDONGKATURI'])).toBe('ANDONGKATURI')
    expect(resolveFontName('맑은고딕', ['Malgun Gothic'])).toBe('Malgun Gothic')
  })
  it('never substitutes a different installed font for a missing favorite', () => {
    expect(resolveFontName('Gmarket Sans', ['Arial', 'Pretendard'])).toBe('Gmarket Sans')
    expect(resolveFontName('강원교육모두', ['강원교육튼튼'])).toBe('강원교육모두')
  })
  it('searches the actual family through Korean and English aliases', () => {
    expect(matchesFontSearch('Pretendard', '프리텐다드')).toBe(true)
    expect(matchesFontSearch('Noto Sans KR', '본고딕')).toBe(true)
    expect(matchesFontSearch('Gmarket Sans', '지마켓')).toBe(true)
    expect(matchesFontSearch('Arial', '주아')).toBe(false)
  })
})
