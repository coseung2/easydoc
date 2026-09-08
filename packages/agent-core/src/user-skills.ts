import type { AgentSkill } from './skill'

export type UserSkillApp = 'docs' | 'sheets' | 'slides' | 'pdf' | 'markdown'

/** Runtime-only representation of one user-owned SKILL.md file. */
export interface UserSkillDefinition {
  /** Invocation id, normally the containing folder name: @<id>. */
  id: string
  /** Human-readable title from frontmatter; falls back to id. */
  name: string
  /** Short catalog description shown to the model before it decides to load the skill. */
  description: string
  /** SKILL.md body with frontmatter removed. */
  content: string
  /** Omitted/empty means available in every app. */
  apps?: UserSkillApp[]
}

const MAX_CATALOG_SKILLS = 50
const MAX_EXPLICIT_SKILLS = 8
const SAFE_SKILL_ID_RE = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,127}$/u

function skillsForApp(
  app: UserSkillApp,
  getSkills: () => readonly UserSkillDefinition[] | null | undefined,
): UserSkillDefinition[] {
  const seen = new Set<string>()
  const out: UserSkillDefinition[] = []
  for (const skill of getSkills() ?? []) {
    const id = String(skill.id ?? '').trim()
    if (!SAFE_SKILL_ID_RE.test(id) || seen.has(id)) continue
    if (skill.apps?.length && !skill.apps.includes(app)) continue
    seen.add(id)
    out.push({ ...skill, id })
    if (out.length >= MAX_CATALOG_SKILLS) break
  }
  return out
}

/** Exact @id mentions; punctuation closes the id so normal prose is unaffected. */
function mentionedSkillIds(instruction: string): string[] {
  const ids: string[] = []
  const seen = new Set<string>()
  for (const match of instruction.matchAll(/(?<![\p{L}\p{N}._%+-])@([^\s@,.;:!?()[\]{}<>]+)/gu)) {
    const id = match[1]?.trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  return ids
}

/**
 * Progressive-disclosure user skill layer.
 *
 * The catalog (id/name/description only) is always visible to the model. Full
 * SKILL.md bodies enter model context only when the user explicitly writes
 * @id, or when the model calls load_skill because the task matches a catalog
 * description.
 */
export function createUserSkillsSkill(
  app: UserSkillApp,
  getSkills: () => readonly UserSkillDefinition[] | null | undefined,
): AgentSkill {
  let explicitIds: string[] = []

  const current = () => skillsForApp(app, getSkills)
  const byId = (id: string) => current().find((skill) => skill.id === id)

  return {
    id: `user-skills-${app}`,
    get systemPrompt() {
      const skills = current()
      if (skills.length === 0) return ''
      const catalog = skills
        .map(
          (skill) =>
            `- @${skill.id}: ${skill.name}${skill.description ? ` — ${skill.description}` : ''}`,
        )
        .join('\n')
      return [
        '# User skills',
        'The user has installed reusable SKILL.md workflows. The catalog below contains metadata only; do not assume details that have not been loaded.',
        'When a task clearly matches a skill and the user did not explicitly @mention it, call load_skill before doing the substantive work. Do not load unrelated skills.',
        'When the user explicitly writes @<id>, that skill is already attached to the current user message; follow it without calling load_skill again unless you genuinely need to re-read it.',
        '',
        catalog,
      ].join('\n')
    },
    get tools() {
      const ids = current().map((skill) => skill.id)
      if (ids.length === 0) return []
      return [
        {
          name: 'load_skill',
          description:
            'Load the full instructions for one installed user skill from the catalog. Use only when the current task matches that skill.',
          inputSchema: {
            type: 'object',
            properties: {
              id: {
                type: 'string',
                enum: ids,
                description: 'Skill id from the user-skills catalog',
              },
            },
            required: ['id'],
          },
        },
      ]
    },
    prepareRun: (instruction) => {
      const available = new Set(current().map((skill) => skill.id))
      explicitIds = mentionedSkillIds(instruction)
        .filter((id) => available.has(id))
        .slice(0, MAX_EXPLICIT_SKILLS)
    },
    buildContext: () => {
      if (explicitIds.length === 0) return ''
      const sections = explicitIds
        .map((id) => byId(id))
        .filter((skill): skill is UserSkillDefinition => Boolean(skill))
        .map(
          (skill) =>
            `<user-skill id="${skill.id}">\nSkill name: ${skill.name}\n\n${skill.content}\n</user-skill>`,
        )
      return sections.length
        ? `The user explicitly requested these installed skills for this turn:\n${sections.join('\n\n')}`
        : ''
    },
    executeTool: (call) => {
      if (call.name !== 'load_skill') {
        return { output: `Unknown tool: ${call.name}`, isError: true, summary: call.name }
      }
      const id = String(call.input.id ?? '').trim()
      const skill = byId(id)
      if (!skill) {
        return {
          output: `Skill not found or unavailable in ${app}: ${id}`,
          isError: true,
          summary: 'load skill',
        }
      }
      return {
        output: `<user-skill id="${skill.id}">\nSkill name: ${skill.name}\n\n${skill.content}\n</user-skill>`,
        mutated: false,
        summary: `Loaded @${skill.id}`,
      }
    },
  }
}
