/** Search aliases resolve only to a family actually reported by the font picker. */
const ALIASES: readonly (readonly string[])[] = [
  ['Malgun Gothic', '맑은 고딕'],
  ['Batang', '바탕'],
  ['Dotum', '돋움'],
  ['Gulim', '굴림'],
  ['Gungsuh', '궁서'],
  ['Noto Sans KR', '노토 산스', '본고딕'],
  ['Noto Serif KR', '노토 세리프', '본명조'],
  ['Pretendard', '프리텐다드'],
  ['Gmarket Sans', 'Gmarket Sans TTF', 'GmarketSans', '지마켓 산스', 'G마켓 산스'],
  ['BM JUA', 'BM JUA_TTF', 'BMJUA', '배달의민족 주아', '배달의민족 주아체', '주아'],
  ['GangwonEduAll', '강원교육모두'],
  ['GangwonEduPower', '강원교육튼튼'],
  ['GangwonEduSaeeum', '강원교육새음'],
  ['GangwonEduHyeonokT', '강원교육현옥샘'],
  ['ANDONGKATURI', '안동엄마까투리', '안동엄마까투리체'],
]

export function normalizeFontName(name: string): string {
  return name.normalize('NFKC').toLowerCase().replace(/[\s_-]+/g, '')
}

export function resolveFontName(name: string, available: readonly string[]): string {
  const normalized = normalizeFontName(name)
  const exact = available.find(font => normalizeFontName(font) === normalized)
  if (exact) return exact
  const aliases = ALIASES.find(group => group.some(alias => normalizeFontName(alias) === normalized))
  return available.find(font => aliases?.some(alias => normalizeFontName(alias) === normalizeFontName(font))) ?? name
}

export function matchesFontSearch(font: string, search: string): boolean {
  const needle = normalizeFontName(search)
  const names = ALIASES.find(group => group.some(alias => normalizeFontName(alias) === normalizeFontName(font))) ?? [font]
  return names.some(name => normalizeFontName(name).includes(needle))
}
