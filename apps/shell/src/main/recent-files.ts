import { statSync } from 'node:fs'
import { basename, extname } from 'node:path'
import type { RecentEntry, RecentPage, RecentQuery } from '../shared/home-api'

const RECENT_PAGE_DEFAULT = 50
const RECENT_PAGE_MAX = 200

function toRecentEntry(path: string, starredPaths: ReadonlySet<string>): RecentEntry {
  try {
    const stat = statSync(path)
    return {
      path,
      name: basename(path),
      ext: extname(path).slice(1).toLowerCase(),
      mtimeMs: stat.mtimeMs,
      sizeBytes: stat.size,
      starred: starredPaths.has(path),
    }
  } catch {
    // A failed stat is often transient (disconnected drive, pending mount,
    // cloud placeholder) — dropping the entry made the recents list silently
    // lose files until a later reload (r158). Word keeps unavailable recents
    // listed; the row is flagged so the UI can dim it and offer removal.
    return {
      path,
      name: basename(path),
      ext: extname(path).slice(1).toLowerCase(),
      mtimeMs: 0,
      sizeBytes: 0,
      starred: starredPaths.has(path),
      missing: true,
    }
  }
}

export function statPathEntries(
  paths: readonly string[],
  starredPaths: ReadonlySet<string>,
): RecentEntry[] {
  return paths.map((path) => toRecentEntry(path, starredPaths))
}

export function normalizeRecentQuery(
  raw: unknown,
): Required<Omit<RecentQuery, 'ext'>> & { ext?: string } {
  const query = (raw ?? {}) as RecentQuery
  const offset = Number.isFinite(query.offset) ? Math.max(0, Math.floor(query.offset!)) : 0
  const limit = Number.isFinite(query.limit)
    ? Math.min(RECENT_PAGE_MAX, Math.max(0, Math.floor(query.limit!)))
    : RECENT_PAGE_DEFAULT
  // Sidebar keys are bare extensions ("xlsx"), but IPC callers may send
  // ".xlsx", " XLSX ", or "..." — normalize so openable files cannot hide
  // behind a filter that only differs in dots/case/whitespace.
  const rawExt =
    typeof query.ext === 'string' ? query.ext.trim().toLowerCase().replace(/^\.+/, '') : ''
  const ext = rawExt ? rawExt : undefined
  return { offset, limit, ext }
}

/** sidebar filter keys that stand for a family of extensions, not one exact ext */
const EXT_FAMILY: Record<string, readonly string[]> = { xlsx: ['xlsx', 'xlsm'] }

function filterPaths(paths: readonly string[], ext?: string): readonly string[] {
  if (!ext) return paths
  const family = EXT_FAMILY[ext] ?? [ext]
  return paths.filter((path) => family.includes(extname(path).slice(1).toLowerCase()))
}

/** Page over the recents paths, preserving the source's newest-first order (unavailable paths stay, flagged missing). */
export function pageRecentPaths(
  paths: readonly string[],
  raw: unknown,
  starredPaths: ReadonlySet<string>,
): RecentPage {
  const { offset, limit, ext } = normalizeRecentQuery(raw)
  // Counts include unavailable files, so only the visible page needs filesystem
  // metadata. This also keeps sidebar count-only requests off disconnected drives.
  const filtered = filterPaths(paths, ext)
  return {
    entries:
      limit === 0 ? [] : statPathEntries(filtered.slice(offset, offset + limit), starredPaths),
    total: filtered.length,
    totalAll: paths.length,
  }
}

/** Starred pages use the same filters, but sort by file modification time. */
export function pageStarredPaths(paths: readonly string[], raw: unknown): RecentPage {
  const { offset, limit, ext } = normalizeRecentQuery(raw)
  const filtered = filterPaths(paths, ext)
  // Sorting needs every matching file's metadata, unless no rows are requested.
  const entries =
    limit === 0 || offset >= filtered.length
      ? []
      : statPathEntries(filtered, new Set(paths))
          .sort((a, b) => b.mtimeMs - a.mtimeMs)
          .slice(offset, offset + limit)
  return {
    entries,
    total: filtered.length,
    totalAll: paths.length,
  }
}
