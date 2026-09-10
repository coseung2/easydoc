import { useState } from 'react'
import { isSymbolFontFamily } from '@genoffice/ui'
import { useI18n } from '../i18n/locale'
import { cssFontFamily } from '../line-metrics'
import { matchesFontSearch, resolveFontName } from '../font-names'

const STORAGE_KEY = 'genoffice.favorite-fonts.v1'
const DEFAULT_FAVORITES = ['강원교육모두', '안동엄마까투리', '배달의민족 주아', 'Gmarket Sans']

function readFavorites(): string[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')
    if (Array.isArray(stored))
      return [
        ...new Set(
          stored.filter(
            (f): f is string => typeof f === 'string' && f.length > 0 && f.length < 200,
          ),
        ),
      ]
  } catch {
    /* Keep the picker usable when storage is unavailable. */
  }
  return DEFAULT_FAVORITES
}

export function FontFamilyMenu({
  builtins,
  system,
  current,
  body,
  onPick,
}: {
  builtins: readonly string[]
  system: readonly string[]
  current: string | null | undefined
  body: string
  onPick: (font: string | null) => void
}) {
  const { t } = useI18n()
  const [storedFavorites, setFavorites] = useState(readFavorites)
  const available = [...builtins, ...system]
  const favorites = [...new Set(storedFavorites.map(font => resolveFontName(font, available)))]
  const [search, setSearch] = useState('')
  const [showSystem, setShowSystem] = useState(false)
  const matches = (font: string) => matchesFontSearch(font, search)
  const toggle = (font: string) => {
    const next = favorites.includes(font)
      ? favorites.filter((f) => f !== font)
      : [...favorites, font]
    setFavorites(next)
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    } catch {
      /* Session state remains usable. */
    }
  }
  const row = (font: string) => (
    <div className="font-menu-row" key={font}>
      <button
        disabled={!builtins.includes(font) && !system.includes(font) && font !== current}
        className={font === current ? 'active' : ''}
        onClick={() => onPick(font)}
        style={{ fontFamily: isSymbolFontFamily(font) ? undefined : cssFontFamily(font) }}
      >
        {font}
        {!builtins.includes(font) && !system.includes(font) && font !== current && <small> · {t('fontNotInstalled')}</small>}
      </button>
      <button
        className="font-menu-star"
        aria-label={`${t(favorites.includes(font) ? 'fontFavoriteRemove' : 'fontFavoriteAdd')}: ${font}`}
        aria-pressed={favorites.includes(font)}
        onClick={() => toggle(font)}
      >
        {favorites.includes(font) ? '★' : '☆'}
      </button>
    </div>
  )
  const others = [
    ...new Set([
      ...builtins,
      ...(current ? [current] : []),
      ...(showSystem || search.trim() ? system : []),
    ]),
  ].filter((f) => f !== body && !favorites.includes(f) && matches(f))
  return (
    <div data-rb-panel="" className="spacing-menu rb-font-family-menu">
      <input
        className="font-menu-search"
        aria-label={t('fontSearch')}
        placeholder={t('fontSearch')}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <div className="rb-menu-group-label">{t('fontFavorites')}</div>
      {favorites.filter(matches).map(row)}
      <div className="rb-menu-group-label">{t('fontBasic')}</div>
      {!search && (
        <button className={!current ? 'active' : ''} onClick={() => onPick(null)}>
          {t('ribbonFontBodyNamed', { font: body })}
        </button>
      )}
      {others.map(row)}
      <button
        className="font-menu-system-toggle"
        aria-expanded={showSystem}
        onClick={() => setShowSystem(!showSystem)}
      >
        {t(showSystem ? 'fontHideSystem' : 'fontShowSystem')}
      </button>
    </div>
  )
}
