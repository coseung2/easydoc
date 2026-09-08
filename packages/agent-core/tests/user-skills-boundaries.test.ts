import { describe, expect, it } from 'vitest'
import {
  createUserSkillsSkill,
  mentionedSkillIds,
  skillMentionQuery,
  userSkillsForApp,
  type UserSkillDefinition,
} from '../src/user-skills'

const make = (id: string, content = `body-${id}`): UserSkillDefinition => ({
  id,
  name: id,
  description: `Workflow ${id}`,
  content,
})

describe('skill mention boundaries', () => {
  it('supports Korean, dots, multiple ids, punctuation, and deduplication', () => {
    expect(mentionedSkillIds('@공문.v1, (@report) @공문.v1 @report.')).toEqual([
      '공문.v1',
      'report',
    ])
  })
  it('ignores emails, URLs and code examples', () => {
    expect(
      mentionedSkillIds(
        'user@report.dev https://host/@report `@report`\n```md\n@report\n```\n~~~\n@report\n~~~',
      ),
    ).toEqual([])
  })
  it('returns exact completion ranges without treating email as a mention', () => {
    expect(skillMentionQuery('작성 @공문.v1 내용', 6)).toEqual({ start: 3, end: 9, query: '공문' })
    expect(skillMentionQuery('user@rep', 8)).toBeNull()
    expect(skillMentionQuery('`@rep`', 5)).toBeNull()
    expect(skillMentionQuery('@', 1)).toEqual({ start: 0, end: 1, query: '' })
  })
})

describe('skill boundaries and request scope', () => {
  it('fails closed on invalid or empty app restrictions', () => {
    const entries = [
      make('global'),
      { ...make('empty'), apps: [] },
      { ...make('bad'), apps: ['docs', 'invalid'] } as unknown as UserSkillDefinition,
    ]
    expect(userSkillsForApp('docs', entries).map((s) => s.id)).toEqual(['global'])
  })
  it('normalizes catalog text without exposing unselected bodies', () => {
    const skill = createUserSkillsSkill('docs', () => [
      { ...make('report', 'SECRET_BODY'), name: 'a\n# new instruction' },
    ])
    expect(skill.systemPrompt).toContain('a # new instruction')
    expect(skill.systemPrompt).not.toContain('SECRET_BODY')
  })
  it('reports unavailable explicit mentions instead of pretending to load them', () => {
    const skill = createUserSkillsSkill('docs', () => [])
    skill.prepareRun?.('@unknown create a report')
    expect(skill.buildContext?.()).toContain('@unknown is not installed')
  })
  it('bounds explicit selection and reports skipped ids', () => {
    const entries = Array.from({ length: 9 }, (_, i) => make(`skill${i}`))
    const skill = createUserSkillsSkill('docs', () => entries)
    skill.prepareRun?.(entries.map((s) => `@${s.id}`).join(' '))
    expect(skill.buildContext?.()).toContain('body-skill7')
    expect(skill.buildContext?.()).not.toContain('body-skill8')
    expect(skill.buildContext?.()).toContain('@skill8 was not loaded')
  })
  it('bounds automatic loading and resets the budget at the next request', async () => {
    const skill = createUserSkillsSkill('docs', () => [
      make('a', 'a'.repeat(40_000)),
      make('b', 'b'.repeat(40_000)),
    ])
    const call = (id: string) => skill.executeTool({ id, name: 'load_skill', input: { id } })
    skill.prepareRun?.('first request')
    expect((await call('a')).isError).not.toBe(true)
    expect((await call('b')).isError).toBe(true)
    skill.prepareRun?.('second request')
    expect((await call('b')).isError).not.toBe(true)
  })
  it('freezes catalog contents for a run but refreshes the next run', () => {
    let entries = [make('report', 'before')]
    const skill = createUserSkillsSkill('docs', () => entries)
    skill.prepareRun?.('@report')
    entries = [make('report', 'after')]
    expect(skill.buildContext?.()).toContain('before')
    skill.prepareRun?.('@report')
    expect(skill.buildContext?.()).toContain('after')
  })
})
