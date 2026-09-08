import React, { forwardRef, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { skillMentionQuery, userSkillsForApp } from '@genoffice/agent-core'
import type { UserSkillApp, UserSkillDefinition } from '@genoffice/agent-core'
import { normalizeLang, type Lang } from '@genoffice/i18n'
import './skill-mentions.css'

const LABELS: Record<Lang, readonly [string, string, string]> = {
  en: ['Skills', 'No matching skills', 'Could not load skills'],
  ko: ['스킬', '일치하는 스킬이 없습니다', '스킬 목록을 불러오지 못했습니다'],
  zh: ['技能', '没有匹配的技能', '无法加载技能'],
  'zh-TW': ['技能', '沒有相符的技能', '無法載入技能'],
  ja: ['スキル', '一致するスキルがありません', 'スキルを読み込めませんでした'],
  fr: ['Compétences', 'Aucune compétence correspondante', 'Chargement impossible'],
  de: ['Skills', 'Keine passenden Skills', 'Skills konnten nicht geladen werden'],
  es: ['Habilidades', 'No hay habilidades coincidentes', 'No se pudieron cargar las habilidades'],
  th: ['สกิล', 'ไม่พบสกิลที่ตรงกัน', 'โหลดสกิลไม่สำเร็จ'],
  id: ['Skill', 'Tidak ada skill yang cocok', 'Gagal memuat skill'],
  ru: ['Навыки', 'Нет подходящих навыков', 'Не удалось загрузить навыки'],
  ar: ['المهارات', 'لا توجد مهارات مطابقة', 'تعذر تحميل المهارات'],
  pt: ['Habilidades', 'Nenhuma habilidade correspondente', 'Não foi possível carregar habilidades'],
  it: ['Competenze', 'Nessuna competenza corrispondente', 'Impossibile caricare le competenze'],
  pl: ['Umiejętności', 'Brak pasujących umiejętności', 'Nie można wczytać umiejętności'],
  nl: ['Vaardigheden', 'Geen overeenkomende vaardigheden', 'Vaardigheden laden mislukt'],
  ms: ['Kemahiran', 'Tiada kemahiran sepadan', 'Gagal memuatkan kemahiran'],
  he: ['מיומנויות', 'אין מיומנויות תואמות', 'טעינת המיומנויות נכשלה'],
  hi: ['स्किल', 'कोई मेल खाता स्किल नहीं', 'स्किल लोड नहीं हो सके'],
}

export interface SkillMentionProps {
  skillApp?: UserSkillApp | undefined
  /** Refresh on input focus. Return local definitions, not instructions fetched from the web. */
  loadSkills?: (() => Promise<readonly UserSkillDefinition[] | undefined>) | undefined
}

type Props = Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'> &
  SkillMentionProps & {
    value: string
    onValueChange(value: string): void
  }

/** Shared text input: only completion keys are intercepted; normal editing stays native. */
export const SkillMentionTextarea = forwardRef<HTMLTextAreaElement, Props>(
  function SkillMentionTextarea(
    { value, onValueChange, skillApp, loadSkills, onKeyDown, onFocus, onBlur, onSelect, ...props },
    forwardedRef,
  ) {
    const ref = useRef<HTMLTextAreaElement | null>(null)
    const nextCaret = useRef<number | null>(null)
    const revision = useRef(0)
    const listId = useId()
    const [skills, setSkills] = useState<readonly UserSkillDefinition[]>([])
    const [focused, setFocused] = useState(false)
    const [failed, setFailed] = useState(false)
    const [loaded, setLoaded] = useState(false)
    const [caret, setCaret] = useState(0)
    const [activeIndex, setActiveIndex] = useState(0)
    const [dismissed, setDismissed] = useState<string | null>(null)
    useEffect(
      () => () => {
        revision.current++
      },
      [],
    )
    useLayoutEffect(() => {
      if (nextCaret.current === null) return
      ref.current?.setSelectionRange(nextCaret.current, nextCaret.current)
      nextCaret.current = null
    }, [value])

    const query = skillMentionQuery(value, caret)
    const key = `${value}\n${caret}`
    const open = !!(focused && loaded && query && skillApp && loadSkills && dismissed !== key)
    const needle = query?.query.toLocaleLowerCase() ?? ''
    const matches = skillApp
      ? userSkillsForApp(skillApp, skills)
          .filter((skill) =>
            `${skill.id} ${skill.name} ${skill.description}`.toLocaleLowerCase().includes(needle),
          )
          .slice(0, 8)
      : []
    const selected = Math.min(activeIndex, Math.max(0, matches.length - 1))
    const labels =
      LABELS[normalizeLang(typeof document === 'undefined' ? 'en' : document.documentElement.lang)]

    const choose = (skill: UserSkillDefinition) => {
      if (!query) return
      const token = `@${skill.id} `
      const suffix = value.slice(query.end).replace(/^ /, '')
      const next = value.slice(0, query.start) + token + suffix
      const position = query.start + token.length
      nextCaret.current = position
      setCaret(position)
      setDismissed(`${next}\n${position}`)
      onValueChange(next)
      ref.current?.focus()
    }

    return (
      <div className="ai-skill-textarea">
        {open && (
          <div className="ai-skill-menu" role="listbox" id={listId} aria-label={labels[0]}>
            {matches.map((skill, i) => (
              <button
                type="button"
                role="option"
                id={`${listId}-${i}`}
                key={skill.id}
                className="ai-skill-option"
                aria-selected={i === selected}
                tabIndex={-1}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(skill)}
              >
                <strong>@{skill.id}</strong>
                <span>{skill.name}</span>
                {skill.description && <small>{skill.description}</small>}
              </button>
            ))}
            {!matches.length && (
              <div className="ai-skill-status" role="status">
                {failed ? labels[2] : labels[1]}
              </div>
            )}
          </div>
        )}
        <textarea
          {...props}
          ref={(node) => {
            ref.current = node
            if (typeof forwardedRef === 'function') forwardedRef(node)
            else if (forwardedRef) forwardedRef.current = node
          }}
          value={value}
          aria-autocomplete={loadSkills ? 'list' : undefined}
          aria-controls={open ? listId : undefined}
          aria-activedescendant={open && matches.length ? `${listId}-${selected}` : undefined}
          onChange={(event) => {
            setCaret(event.target.selectionStart)
            setActiveIndex(0)
            setDismissed(null)
            onValueChange(event.target.value)
          }}
          onSelect={(event) => {
            // React can emit the old selection in the same key event that chose a skill.
            if (nextCaret.current === null) setCaret(event.currentTarget.selectionStart)
            onSelect?.(event)
          }}
          onClick={(event) => {
            setCaret(event.currentTarget.selectionStart)
            props.onClick?.(event)
          }}
          onFocus={(event) => {
            setFocused(true)
            setCaret(event.currentTarget.selectionStart)
            setDismissed(null)
            const request = ++revision.current
            setLoaded(false)
            if (loadSkills)
              void Promise.resolve()
                .then(loadSkills)
                .then((loaded) => {
                  if (request !== revision.current) return
                  setSkills(loaded ?? [])
                  setFailed(false)
                  setLoaded(true)
                })
                .catch(() => {
                  if (request !== revision.current) return
                  setSkills([])
                  setFailed(true)
                  setLoaded(true)
                })
            onFocus?.(event)
          }}
          onBlur={(event) => {
            setFocused(false)
            onBlur?.(event)
          }}
          onKeyDown={(event) => {
            // Korean IMEs can send Enter with keyCode 229 after isComposing becomes false.
            if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
            if (open && event.key === 'Escape') {
              event.preventDefault()
              setDismissed(key)
              return
            }
            if (
              open &&
              matches.length &&
              ['ArrowDown', 'ArrowUp', 'Enter', 'Tab'].includes(event.key) &&
              !event.shiftKey
            ) {
              event.preventDefault()
              if (event.key === 'ArrowDown') setActiveIndex((selected + 1) % matches.length)
              else if (event.key === 'ArrowUp')
                setActiveIndex((selected + matches.length - 1) % matches.length)
              else choose(matches[selected]!)
              return
            }
            onKeyDown?.(event)
          }}
        />
      </div>
    )
  },
)
