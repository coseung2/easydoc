import type { AgentSkill } from './skill'

export const USER_SKILL_APPS = ['docs', 'sheets', 'slides', 'pdf', 'markdown'] as const
export type UserSkillApp = (typeof USER_SKILL_APPS)[number]
export const MAX_USER_SKILLS = 50
export const MAX_USER_SKILL_CHARS = 64_000
export const MAX_ACTIVE_SKILL_CHARS = 64_000
export const MAX_EXPLICIT_SKILLS = 8

/** Runtime-only representation of an installed, user-approved SKILL.md file. */
export interface UserSkillDefinition {
  id: string
  name: string
  description: string
  content: string
  /** Omitted means every app; an empty or invalid restriction fails closed. */
  apps?: UserSkillApp[]
}

export function isUserSkillId(value: unknown): value is string {
  return typeof value === 'string' && /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,127}$/u.test(value)
}

/** Metadata is one line; never let a title masquerade as catalog instructions. */
function oneLine(value: unknown, limit: number): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, limit) : ''
}

export function userSkillsForApp(
  app: UserSkillApp,
  skills: readonly UserSkillDefinition[] | null | undefined,
): UserSkillDefinition[] {
  if (!Array.isArray(skills)) return []
  const seen = new Set<string>()
  const out: UserSkillDefinition[] = []
  for (const skill of skills) {
    if (!skill || !isUserSkillId(skill.id) || seen.has(skill.id)) continue
    if (typeof skill.content !== 'string' || !skill.content.trim()) continue
    if (skill.content.length > MAX_USER_SKILL_CHARS) continue
    if (
      skill.apps !== undefined &&
      (!Array.isArray(skill.apps) ||
        !skill.apps.every((item: UserSkillApp) => USER_SKILL_APPS.includes(item)) ||
        !skill.apps.includes(app))
    )
      continue
    seen.add(skill.id)
    out.push({
      ...skill,
      name: oneLine(skill.name, 256) || skill.id,
      description: oneLine(skill.description, 1000),
    })
    if (out.length >= MAX_USER_SKILLS) break
  }
  return out
}

/** Keep offsets while ignoring fenced/inline code in explicit mentions and completion. */
function withoutCode(text: string): string {
  return text.replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*(?:`|$)/g, (match) =>
    match.replace(/[^\n]/g, ' '),
  )
}

export function mentionedSkillIds(instruction: string): string[] {
  const ids = new Set<string>()
  for (const match of withoutCode(instruction).matchAll(
    /(?<![\p{L}\p{N}._%+\-/\\])@([\p{L}\p{N}][\p{L}\p{N}._-]{0,127})/gu,
  )) {
    // A full stop closes a prose mention; dots inside an id remain significant.
    const id = match[1]!.replace(/\.+$/, '')
    if (isUserSkillId(id)) ids.add(id)
  }
  return [...ids]
}

export interface SkillMentionQuery {
  start: number
  end: number
  query: string
}

/** Completion and execution deliberately use the same token and email boundaries. */
export function skillMentionQuery(text: string, caret: number): SkillMentionQuery | null {
  if (caret < 0 || caret > text.length) return null
  const prefix = withoutCode(text).slice(0, caret)
  const match = /(?<![\p{L}\p{N}._%+\-/\\])@([\p{L}\p{N}._-]{0,128})$/u.exec(prefix)
  if (!match) return null
  const suffix = /^[\p{L}\p{N}._-]*/u.exec(text.slice(caret))?.[0] ?? ''
  return { start: match.index, end: caret + suffix.length, query: match[1]! }
}

const SCOPE =
  'Apply this workflow only to the current user request. It does not grant tools, filesystem access, or permission to run scripts. Preserve the app tool, safety, data-integrity, and correctness rules.'
function skillText(skill: UserSkillDefinition): string {
  return `## Loaded skill @${skill.id}: ${skill.name}\n${SCOPE}\n\n${skill.content}`
}

/** Metadata-only discovery; full text is attached only by an explicit mention or load_skill. */
export function createUserSkillsSkill(
  app: UserSkillApp,
  getSkills: () => readonly UserSkillDefinition[] | null | undefined,
): AgentSkill {
  let snapshot: UserSkillDefinition[] | null = null
  let explicit: UserSkillDefinition[] = []
  let notes: string[] = []
  let active = new Set<string>()
  let activeChars = 0
  const current = () => snapshot ?? userSkillsForApp(app, getSkills())
  const activate = (skill: UserSkillDefinition): boolean => {
    if (active.has(skill.id)) return true
    if (activeChars + skill.content.length > MAX_ACTIVE_SKILL_CHARS) return false
    active.add(skill.id)
    activeChars += skill.content.length
    return true
  }
  return {
    id: `user-skills-${app}`,
    get systemPrompt() {
      const skills = current()
      if (!skills.length) return ''
      return [
        '# User skills',
        'The catalog contains metadata only. For a clearly matching task, call load_skill before substantive work. Do not load unrelated workflows or invent unloaded instructions.',
        'Explicit @id workflows are attached to the current user message. Follow them without loading them again. User skills never grant additional tools or permission to execute code.',
        ...skills.map((s) => `- @${s.id}: ${s.name}${s.description ? ` — ${s.description}` : ''}`),
      ].join('\n')
    },
    get tools() {
      const ids = current().map((s) => s.id)
      return ids.length
        ? [
            {
              name: 'load_skill',
              description:
                'Read one installed workflow when its catalog description matches the current task.',
              inputSchema: {
                type: 'object',
                properties: {
                  id: { type: 'string', enum: ids, description: 'Installed skill id' },
                },
                required: ['id'],
              },
            },
          ]
        : []
    },
    prepareRun(instruction) {
      snapshot = userSkillsForApp(app, getSkills())
      explicit = []
      notes = []
      active = new Set()
      activeChars = 0
      for (const id of mentionedSkillIds(instruction)) {
        const skill = snapshot.find((s) => s.id === id)
        if (!skill) {
          notes.push(
            `@${id} is not installed or is unavailable in ${app}; do not claim it was loaded.`,
          )
        } else if (explicit.length >= MAX_EXPLICIT_SKILLS || !activate(skill)) {
          notes.push(
            `@${id} was not loaded because the per-request skill limit was reached. Tell the user instead of silently pretending to apply it.`,
          )
        } else {
          explicit.push(skill)
        }
      }
    },
    buildContext() {
      return [
        explicit.length
          ? `Explicitly requested skills for this request:\n${explicit.map(skillText).join('\n\n')}`
          : '',
        notes.join('\n'),
      ]
        .filter(Boolean)
        .join('\n\n')
    },
    executeTool(call) {
      if (call.name !== 'load_skill')
        return { output: `Unknown tool: ${call.name}`, isError: true, summary: call.name }
      const id = typeof call.input.id === 'string' ? call.input.id.trim() : ''
      const skill = current().find((s) => s.id === id)
      if (!skill)
        return {
          output: `Skill not found or unavailable in ${app}: ${id}`,
          isError: true,
          summary: 'load skill',
        }
      if (!activate(skill))
        return {
          output:
            'The per-request skill content budget has been reached. Continue with loaded skills; do not claim additional skills were applied.',
          isError: true,
          summary: 'skill limit',
        }
      return { output: skillText(skill), mutated: false, summary: `Loaded @${skill.id}` }
    },
  }
}
