import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { generatedFileStem, writeGeneratedFile } from '../src/generated-file'

const roots: string[] = []
async function root() {
  const path = await mkdtemp(join(tmpdir(), 'easydoc-generated-'))
  roots.push(path)
  return path
}
afterEach(async () => {
  for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true })
})

describe('safe generated files', () => {
  it.each(['CON', 'con.txt', 'PRN', 'LPT9.data', 'AUX', 'COM1', 'NUL'])(
    'avoids Windows reserved stem %s',
    (name) => {
      expect(generatedFileStem(name)).toBe(`_${name}`)
    },
  )
  it('normalizes separators, trailing dots, empty stems and surrogate pairs', () => {
    expect(generatedFileStem('../a\\b: c... ')).toBe('.._a_b_ c')
    expect(generatedFileStem('...')).toBe('Untitled')
    expect(Array.from(generatedFileStem('😀'.repeat(100)))).toHaveLength(55)
    expect(Buffer.byteLength(generatedFileStem('😀'.repeat(100)), 'utf8')).toBeLessThanOrEqual(220)
  })
  it('never overwrites an existing file, even across concurrent requests', async () => {
    const dir = await root()
    await writeFile(join(dir, '보고서.hwpx'), 'original')
    const paths = await Promise.all(
      Array.from({ length: 10 }, (_, i) => writeGeneratedFile(dir, '보고서', 'hwpx', `file${i}`)),
    )
    expect(new Set(paths).size).toBe(10)
    expect(await readFile(join(dir, '보고서.hwpx'), 'utf8')).toBe('original')
    expect(await readdir(dir)).toHaveLength(11)
    for (let i = 0; i < paths.length; i++)
      expect(await readFile(paths[i]!, 'utf8')).toBe(`file${i}`)
  })
  it.skipIf(process.platform === 'win32')(
    'does not follow an existing output symlink',
    async () => {
      const dir = await root()
      const target = join(dir, 'private.txt')
      await writeFile(target, 'original')
      await symlink(target, join(dir, 'report.hwpx'))
      const result = await writeGeneratedFile(dir, 'report', 'hwpx', 'generated')
      expect(basename(result)).toBe('report (1).hwpx')
      expect(await readFile(target, 'utf8')).toBe('original')
    },
  )
  it('rejects an injected extension before writing', async () => {
    const dir = await root()
    await expect(writeGeneratedFile(dir, 'report', '../bad', 'text')).rejects.toThrow(/extension/)
    expect(await readdir(dir)).toEqual([])
  })
})
