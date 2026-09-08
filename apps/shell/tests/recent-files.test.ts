import { beforeEach, describe, expect, it, vi } from 'vitest'
import { statSync } from 'node:fs'
import { normalizeRecentQuery, pageRecentPaths, pageStarredPaths } from '../src/main/recent-files'

vi.mock('node:fs', () => ({ statSync: vi.fn() }))

const statMock = vi.mocked(statSync)

beforeEach(() => {
  statMock.mockReset()
  statMock.mockImplementation(() => ({ mtimeMs: 100, size: 20 }) as ReturnType<typeof statSync>)
})

describe('recent file metadata work', () => {
  it('stats only the filtered page, preserving source order and full counts', () => {
    const paths = ['older.xlsx', 'notes.docx', 'macro.XLSM', 'latest.xlsx']
    const page = pageRecentPaths(
      paths,
      { ext: ' .XLSX ', offset: 1, limit: 1 },
      new Set(['macro.XLSM']),
    )

    expect(statMock.mock.calls.map(([path]) => path)).toEqual(['macro.XLSM'])
    expect(page).toMatchObject({
      total: 3,
      totalAll: 4,
      entries: [{ path: 'macro.XLSM', ext: 'xlsm', starred: true, mtimeMs: 100, sizeBytes: 20 }],
    })
  })

  it('returns filtered counts including unavailable paths without stats', () => {
    statMock.mockImplementation(() => {
      throw new Error('disconnected drive')
    })

    const page = pageRecentPaths(
      ['missing.xlsx', 'missing.xlsm', 'notes.docx'],
      { ext: 'xlsx', limit: 0 },
      new Set(),
    )

    expect(page).toEqual({ entries: [], total: 2, totalAll: 3 })
    expect(statMock).not.toHaveBeenCalled()
  })

  it('keeps missing rows on a visible page and includes off-page paths in counts', () => {
    statMock.mockImplementation(() => {
      throw new Error('disconnected drive')
    })

    const page = pageRecentPaths(
      ['first.docx', 'missing.docx', 'last.docx'],
      { offset: 1, limit: 1 },
      new Set(),
    )

    expect(statMock).toHaveBeenCalledExactlyOnceWith('missing.docx')
    expect(page).toMatchObject({
      total: 3,
      totalAll: 3,
      entries: [{ path: 'missing.docx', missing: true, mtimeMs: 0, sizeBytes: 0 }],
    })
  })

  it('does no filesystem work for an offset beyond the filtered result', () => {
    expect(
      pageRecentPaths(['book.xlsx', 'notes.docx'], { ext: 'xlsx', offset: 1 }, new Set()),
    ).toEqual({ entries: [], total: 1, totalAll: 2 })
    expect(statMock).not.toHaveBeenCalled()
  })
})

describe('starred files', () => {
  it('includes macro workbooks in Sheets and sorts by mtime before paging', () => {
    const mtimes: Record<string, number> = {
      'older.xlsx': 100,
      'macro.XLSM': 300,
      'latest.xlsx': 200,
    }
    statMock.mockImplementation(
      (path) => ({ mtimeMs: mtimes[String(path)], size: 20 }) as ReturnType<typeof statSync>,
    )

    const page = pageStarredPaths(['older.xlsx', 'notes.docx', 'macro.XLSM', 'latest.xlsx'], {
      ext: ' .XLSX ',
      offset: 0,
      limit: 2,
    })

    expect(page.total).toBe(3)
    expect(page.totalAll).toBe(4)
    expect(page.entries.map((entry) => [entry.path, entry.starred])).toEqual([
      ['macro.XLSM', true],
      ['latest.xlsx', true],
    ])
    expect(statMock.mock.calls.map(([path]) => path)).toEqual([
      'older.xlsx',
      'macro.XLSM',
      'latest.xlsx',
    ])
  })

  it('preserves source order for equal mtimes and keeps missing files', () => {
    statMock.mockImplementation((path) => {
      if (path === 'missing.xlsx') throw new Error('missing')
      return { mtimeMs: 100, size: 20 } as ReturnType<typeof statSync>
    })

    const page = pageStarredPaths(['missing.xlsx', 'first.xlsx', 'second.xlsm'], {
      offset: 1,
      limit: 2,
    })

    expect(page.entries.map((entry) => [entry.path, entry.missing === true])).toEqual([
      ['second.xlsm', false],
      ['missing.xlsx', true],
    ])
    expect(page.total).toBe(3)
  })

  it.each([{ limit: 0 }, { offset: 2 }])(
    'returns counts without stats when no rows are needed: %j',
    (query) => {
      expect(
        pageStarredPaths(['book.xlsx', 'missing.xlsm', 'notes.docx'], { ext: 'xlsx', ...query }),
      ).toEqual({ entries: [], total: 2, totalAll: 3 })
      expect(statMock).not.toHaveBeenCalled()
    },
  )
})

describe('recent pagination bounds', () => {
  it.each([
    [
      { offset: -3, limit: -1 },
      { offset: 0, limit: 0 },
    ],
    [
      { offset: 2.9, limit: 3.8 },
      { offset: 2, limit: 3 },
    ],
    [
      { offset: NaN, limit: Infinity },
      { offset: 0, limit: 50 },
    ],
    [
      { offset: '2', limit: '3' },
      { offset: 0, limit: 50 },
    ],
    [{ limit: 999 }, { offset: 0, limit: 200 }],
  ])('normalizes %j', (query, expected) => {
    expect(normalizeRecentQuery(query)).toMatchObject(expected)
  })
})
