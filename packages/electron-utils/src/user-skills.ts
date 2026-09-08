import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'

export type StoredUserSkillApp = 'docs' | 'sheets' | 'slides' | 'pdf' | 'markdown'

export interface StoredUserSkill {
  id: string
  name: string
  description: string
  content: string
  apps?: StoredUserSkillApp[]
}

export const USER_SKILLS_DIRNAME = 'agent-skills'
export const MAX_USER_SKILL_FILE_CHARS = 64_000
export const MAX_USER_SKILLS = 50

const VALID_APPS = new Set<StoredUserSkillApp>(['docs', 'sheets', 'slides', 'pdf', 'markdown'])
const SAFE_SKILL_ID_RE = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,127}$/u
const README = `# EasyDoc AI Skills

Create one folder per skill and put a \`SKILL.md\` file inside it:

\`\`\`
agent-skills/
  official-letter/
    SKILL.md
\`\`\`

Minimal SKILL.md:

\`\`\`md
---
name: Official letter
description: Draft Korean public-sector official letters
apps: docs
---

# Workflow
Write the reusable instructions here.
\`\`\`

The folder name is the invocation id. Use \`@official-letter\` in chat to force that skill for the current turn. If you do not mention it, the AI can load a matching skill automatically from its description.

\`apps\` is optional. Use a comma-separated list such as \`docs, slides\`; omit it to make the skill available everywhere.
`

function cleanScalar(value: string): string {
  const trimmed = value.trim()
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1).trim()
  }
  return trimmed
}

function parseApps(value: string | undefined): StoredUserSkillApp[] | undefined {
  if (!value) return undefined
  const normalized = value.trim().replace(/^\[/, '').replace(/\]$/, '')
  const apps = normalized
    .split(',')
    .map((part) => cleanScalar(part))
    .filter((part): part is StoredUserSkillApp => VALID_APPS.has(part as StoredUserSkillApp))
  return apps.length > 0 ? [...new Set(apps)] : undefined
}

function parseSkillFile(id: string, raw: string): StoredUserSkill | null {
  const text = raw.slice(0, MAX_USER_SKILL_FILE_CHARS).replace(/^\uFEFF/, '')
  let body = text
  const meta = new Map<string, string>()
  if (text.startsWith('---\n') || text.startsWith('---\r\n')) {
    const lines = text.split(/\r?\n/)
    const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
    if (end > 0) {
      for (const line of lines.slice(1, end)) {
        const match = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line)
        if (match) meta.set(match[1]!.toLowerCase(), cleanScalar(match[2] ?? ''))
      }
      body = lines
        .slice(end + 1)
        .join('\n')
        .trim()
    }
  }
  if (!body) return null
  const name = (meta.get('name') || id).slice(0, 256)
  const description = (meta.get('description') || '').slice(0, 1000)
  const apps = parseApps(meta.get('apps'))
  return { id, name, description, content: body, ...(apps ? { apps } : {}) }
}

/** Ensure the folder exists and contains a small format/invocation guide. */
export function ensureUserSkillsDir(userDataDir: string): string {
  const dir = join(userDataDir, USER_SKILLS_DIRNAME)
  mkdirSync(dir, { recursive: true })
  const readmePath = join(dir, 'README.md')
  if (!existsSync(readmePath)) writeFileSync(readmePath, README, 'utf8')
  return dir
}

/** Read user-owned SKILL.md files. Invalid/unreadable entries are skipped fail-closed. */
export function listUserSkills(userDataDir: string): StoredUserSkill[] {
  const dir = ensureUserSkillsDir(userDataDir)
  const out: StoredUserSkill[] = []
  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (out.length >= MAX_USER_SKILLS) break
    let id = ''
    let filePath = ''
    if (entry.isDirectory()) {
      id = entry.name.trim()
      filePath = join(dir, entry.name, 'SKILL.md')
    } else if (
      entry.isFile() &&
      extname(entry.name).toLowerCase() === '.md' &&
      entry.name.toLowerCase() !== 'readme.md'
    ) {
      id = basename(entry.name, extname(entry.name)).trim()
      filePath = join(dir, entry.name)
    }
    if (!SAFE_SKILL_ID_RE.test(id) || !filePath || !existsSync(filePath)) continue
    try {
      const parsed = parseSkillFile(id, readFileSync(filePath, 'utf8'))
      if (parsed) out.push(parsed)
    } catch {
      // One broken skill must not disable the rest of the catalog.
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}
