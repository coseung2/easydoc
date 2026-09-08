import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureUserSkillsDir, listUserSkills } from '../src/user-skills'

const roots: string[] = []

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'genoffice-skills-'))
  roots.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('user skill store', () => {
  it('creates the skills folder guide and parses folder SKILL.md frontmatter', () => {
    const userData = root()
    const skillsDir = ensureUserSkillsDir(userData)
    expect(readFileSync(join(skillsDir, 'README.md'), 'utf8')).toContain('@official-letter')

    const skillDir = join(skillsDir, 'official-letter')
    mkdirSync(skillDir)
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      [
        '---',
        'name: Korean official letter',
        'description: Draft public-sector correspondence',
        'apps: docs, slides',
        '---',
        '',
        '# Workflow',
        'Use a concise formal structure.',
      ].join('\n'),
    )

    expect(listUserSkills(userData)).toEqual([
      {
        id: 'official-letter',
        name: 'Korean official letter',
        description: 'Draft public-sector correspondence',
        apps: ['docs', 'slides'],
        content: '# Workflow\nUse a concise formal structure.',
      },
    ])
  })

  it('accepts root markdown skills, skips README, and ignores empty skill bodies', () => {
    const userData = root()
    const skillsDir = ensureUserSkillsDir(userData)
    writeFileSync(join(skillsDir, 'briefing.md'), '# Briefing\nKeep it short.')
    mkdirSync(join(skillsDir, 'empty'))
    writeFileSync(join(skillsDir, 'empty', 'SKILL.md'), '---\nname: Empty\n---\n')

    expect(listUserSkills(userData)).toEqual([
      {
        id: 'briefing',
        name: 'briefing',
        description: '',
        content: '# Briefing\nKeep it short.',
      },
    ])
  })
})
