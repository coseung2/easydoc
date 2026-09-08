import { describe, expect, it } from 'vitest'
import { composeSkills } from '../src/skill'
import { createUserSkillsSkill, type UserSkillDefinition } from '../src/user-skills'

const skills: UserSkillDefinition[] = [
  {
    id: 'official-letter',
    name: 'Official letter',
    description: 'Draft formal public-sector letters',
    content: '# Rules\nUse the official-letter workflow.',
    apps: ['docs'],
  },
  {
    id: 'all-apps',
    name: 'General workflow',
    description: 'Reusable general workflow',
    content: '# General\nCheck the result carefully.',
  },
]

describe('createUserSkillsSkill', () => {
  it('shows only app-relevant catalog metadata and exposes load_skill', async () => {
    const skill = createUserSkillsSkill('docs', () => skills)
    expect(skill.systemPrompt).toContain('@official-letter')
    expect(skill.systemPrompt).toContain('@all-apps')
    expect(skill.systemPrompt).not.toContain('Use the official-letter workflow.')
    expect(skill.tools.map((tool) => tool.name)).toEqual(['load_skill'])

    const loaded = await skill.executeTool({
      id: '1',
      name: 'load_skill',
      input: { id: 'official-letter' },
    })
    expect(loaded.output).toContain('Use the official-letter workflow.')
  })

  it('attaches full content immediately when the user explicitly writes @id', () => {
    const skill = createUserSkillsSkill('docs', () => skills)
    skill.prepareRun?.('이 문서를 @official-letter 형식으로 작성해줘')
    expect(skill.buildContext?.()).toContain('Use the official-letter workflow.')

    skill.prepareRun?.('이번에는 일반 문서로 작성해줘')
    expect(skill.buildContext?.()).toBe('')

    skill.prepareRun?.('메일은 user@official-letter.example 입니다')
    expect(skill.buildContext?.()).toBe('')
  })

  it('filters app-scoped skills and composes prepareRun across skills', () => {
    const user = createUserSkillsSkill('sheets', () => skills)
    expect(user.systemPrompt).not.toContain('@official-letter')
    expect(user.systemPrompt).toContain('@all-apps')

    const prepared: string[] = []
    const combined = composeSkills('combined', '', [
      {
        id: 'probe',
        systemPrompt: '',
        tools: [],
        prepareRun: (instruction) => prepared.push(instruction),
        executeTool: (call) => ({ output: '', summary: call.name }),
      },
      user,
    ])
    combined.prepareRun?.('hello')
    expect(prepared).toEqual(['hello'])
  })
})
