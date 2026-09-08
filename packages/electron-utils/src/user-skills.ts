import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { basename, extname, join } from 'node:path'
import { isUserSkillId, MAX_USER_SKILLS, USER_SKILL_APPS } from '@genoffice/agent-core'
import type { UserSkillApp, UserSkillDefinition } from '@genoffice/agent-core'

export type StoredUserSkillApp = UserSkillApp
export type StoredUserSkill = UserSkillDefinition
export { MAX_USER_SKILLS }
export const USER_SKILLS_DIRNAME = 'agent-skills'
/** Byte limit is checked before allocation/read; the legacy export name is retained. */
export const MAX_USER_SKILL_FILE_CHARS = 64_000
const MAX_CATALOG_BYTES = 1_024_000

const README = `# EasyDoc AI Skills

Create one folder per skill and put a SKILL.md file inside it:

    agent-skills/
      official-letter/
        SKILL.md

Minimal SKILL.md:

    ---
    name: Official letter
    description: Draft Korean public-sector correspondence
    apps: docs
    ---

    # Workflow
    Preserve user-provided facts. Mark missing information instead of inventing it.

Use @official-letter in chat to select this workflow. The @ picker searches the
id, name, and description. Without a mention, the AI may load a matching workflow
using load_skill. Full text is not sent to the model until selected or loaded.

apps is optional; omit it for all editors. Supported values: docs, sheets, slides,
pdf, markdown. Comma-separated, [inline, arrays], and YAML block lists are accepted.
An invalid/empty apps restriction disables the skill instead of making it global.
name and description accept quoted scalars; description also accepts > or | blocks.
Other frontmatter fields are ignored. This is a documented subset, not full YAML.

Use ids made of letters (including Korean), digits, dots, dashes, and underscores.
The first character must be a letter or digit. Do not end an id with a full stop.
Folder skills take precedence over same-id root .md files. README.md is ignored.
Files must be regular UTF-8 files, at most 64,000 bytes each; symlinks are ignored.
Discovery is bounded to 50 skills and 1,024,000 bytes. A request may explicitly
select at most eight skills and load at most 64,000 characters of skill content.

Install only instructions you trust. Skills cannot execute scripts or add tools.
Selected instructions are sent to the configured AI provider. Never put secrets in
skills. Refresh the chat input focus after editing files to reload the catalog.
`

function scalar(value: string): string {
  const text = value.trim()
  return /^(["']).*\1$/.test(text) ? text.slice(1, -1).trim() : text
}

function parseSkillFile(id: string, raw: string): StoredUserSkill | null {
  const text = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  if (text.includes('\0')) return null
  let body = text.trim()
  const meta = new Map<string, string>()
  if (text.startsWith('---\n')) {
    const lines = text.split('\n')
    const end = lines.findIndex((line, i) => i > 0 && line.trim() === '---')
    if (end < 0) return null
    for (let i = 1; i < end; i++) {
      const match = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(lines[i]!)
      if (!match) continue
      const key = match[1]!.toLowerCase()
      if (!['name', 'description', 'apps'].includes(key)) continue
      if (meta.has(key)) return null
      let value = match[2]!.trim()
      const nested: string[] = []
      while (i + 1 < end && /^\s+\S/.test(lines[i + 1]!)) nested.push(lines[++i]!.trim())
      if (key === 'apps' && !value && nested.length) {
        if (nested.some((line) => !line.startsWith('- '))) return null
        value = nested.map((line) => line.slice(2)).join(',')
      } else if (key === 'description' && /^[|>][-+]?$/.test(value)) {
        value = nested.join(' ')
      } else if (nested.length) return null
      meta.set(key, scalar(value))
    }
    body = lines
      .slice(end + 1)
      .join('\n')
      .trim()
  }
  if (!body) return null
  let apps: UserSkillApp[] | undefined
  if (meta.has('apps')) {
    const rawApps = meta.get('apps')!.replace(/^\[/, '').replace(/\]$/, '')
    const values = rawApps.split(',').map(scalar)
    if (!values.length || values.some((v) => !USER_SKILL_APPS.includes(v as UserSkillApp)))
      return null
    apps = [...new Set(values as UserSkillApp[])]
  }
  const clean = (value: string, max: number) => value.replace(/\s+/g, ' ').trim().slice(0, max)
  return {
    id,
    name: clean(meta.get('name') || id, 256),
    description: clean(meta.get('description') || '', 1000),
    content: body,
    ...(apps ? { apps } : {}),
  }
}

export function ensureUserSkillsDir(userDataDir: string): string {
  const dir = join(userDataDir, USER_SKILLS_DIRNAME)
  mkdirSync(dir, { recursive: true })
  if (!lstatSync(dir).isDirectory())
    throw new Error('The skills path must be a real directory, not a symlink.')
  try {
    // Exclusive create never follows or overwrites a pre-existing README symlink.
    writeFileSync(join(dir, 'README.md'), README, { encoding: 'utf8', flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  return dir
}

function readBoundedFile(path: string): string | null {
  if (!lstatSync(path).isFile()) return null
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > MAX_USER_SKILL_FILE_CHARS) return null
    const bytes = Buffer.alloc(MAX_USER_SKILL_FILE_CHARS + 1)
    let length = 0
    while (length < bytes.length) {
      const read = readSync(fd, bytes, length, bytes.length - length, null)
      if (!read) break
      length += read
    }
    if (length > MAX_USER_SKILL_FILE_CHARS) return null
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))
  } finally {
    closeSync(fd)
  }
}

/** Read-only discovery: a missing/unwritable folder never disables AI settings. */
export function listUserSkills(userDataDir: string): StoredUserSkill[] {
  const dir = join(userDataDir, USER_SKILLS_DIRNAME)
  const out: StoredUserSkill[] = []
  try {
    if (!lstatSync(dir).isDirectory()) return out
    const entries = readdirSync(dir, { withFileTypes: true }).sort(
      (a, b) =>
        Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name, 'en'),
    )
    const seen = new Set<string>()
    let bytes = 0
    for (const entry of entries) {
      if (out.length >= MAX_USER_SKILLS) break
      const folder = entry.isDirectory()
      if (!folder && (!entry.isFile() || extname(entry.name).toLowerCase() !== '.md')) continue
      if (entry.name.toLowerCase() === 'readme.md') continue
      const id = folder ? entry.name : basename(entry.name, extname(entry.name))
      if (!isUserSkillId(id) || id.endsWith('.') || seen.has(id)) continue
      try {
        const raw = readBoundedFile(
          folder ? join(dir, entry.name, 'SKILL.md') : join(dir, entry.name),
        )
        if (raw === null) continue
        const size = Buffer.byteLength(raw)
        if (bytes + size > MAX_CATALOG_BYTES) continue
        const parsed = parseSkillFile(id, raw)
        if (!parsed) continue
        seen.add(id)
        bytes += size
        out.push(parsed)
      } catch {
        // One broken entry must not disable the rest of the catalog.
      }
    }
  } catch {
    // No filesystem side effects or permission failure during settings reads.
  }
  return out.sort((a, b) => a.id.localeCompare(b.id, 'en'))
}
