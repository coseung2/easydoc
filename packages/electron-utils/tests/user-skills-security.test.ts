import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureUserSkillsDir, listUserSkills } from '../src/user-skills'

const roots: string[] = []
function root() {
  const p = mkdtempSync(join(tmpdir(), 'easydoc-skills-test-'))
  roots.push(p)
  return p
}
afterEach(() => {
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true })
})

describe('safe local skill discovery', () => {
  it('does not create a folder just by reading settings', () => {
    const p = root()
    expect(listUserSkills(p)).toEqual([])
    expect(existsSync(join(p, 'agent-skills'))).toBe(false)
  })
  it('rejects malformed frontmatter, invalid scopes, empty files, and oversized UTF-8 input', () => {
    const p = root(),
      dir = ensureUserSkillsDir(p)
    for (const [id, text] of Object.entries({
      empty: '   ',
      unclosed: '---\nname: Test',
      wrong: '---\napps: docz\n---\nwrong',
      mixed: '---\napps: docs, docz\n---\nwrong',
      noapps: '---\napps: []\n---\nwrong',
      big: '한'.repeat(30_000),
      null: 'body\0text',
    }))
      writeFileSync(join(dir, `${id}.md`), text)
    expect(listUserSkills(p)).toEqual([])
  })
  it('supports documented YAML subsets and deterministic folder precedence', () => {
    const p = root(),
      dir = ensureUserSkillsDir(p)
    writeFileSync(join(dir, 'report.v1.md'), 'flat duplicate')
    mkdirSync(join(dir, 'report.v1'))
    writeFileSync(
      join(dir, 'report.v1', 'SKILL.md'),
      '---\nname: "보고서"\ndescription: >\n  First line\n  second line\napps:\n  - docs\n  - slides\n---\nfolder body',
    )
    const result = listUserSkills(p)
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      id: 'report.v1',
      name: '보고서',
      description: 'First line second line',
      apps: ['docs', 'slides'],
      content: 'folder body',
    })
  })
  it('caps the sorted catalog at fifty entries', () => {
    const p = root(),
      dir = ensureUserSkillsDir(p)
    for (let i = 59; i >= 0; i--)
      writeFileSync(join(dir, `skill${String(i).padStart(2, '0')}.md`), 'workflow')
    const result = listUserSkills(p)
    expect(result).toHaveLength(50)
    expect(result[0]!.id).toBe('skill00')
    expect(result[49]!.id).toBe('skill49')
  })
  it.skipIf(process.platform === 'win32')(
    'never reads a symlinked skill file or skills root',
    () => {
      const p = root(),
        dir = ensureUserSkillsDir(p),
        outside = root()
      writeFileSync(join(outside, 'private.md'), 'PRIVATE DATA')
      mkdirSync(join(dir, 'leak'))
      symlinkSync(join(outside, 'private.md'), join(dir, 'leak', 'SKILL.md'))
      symlinkSync(join(outside, 'private.md'), join(dir, 'flat.md'))
      expect(listUserSkills(p)).toEqual([])
      const other = root()
      symlinkSync(outside, join(other, 'agent-skills'))
      expect(listUserSkills(other)).toEqual([])
      expect(() => ensureUserSkillsDir(other)).toThrow()
    },
  )
})
