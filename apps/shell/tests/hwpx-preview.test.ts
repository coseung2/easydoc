import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createHwpxPreviewService,
  executablePathFromCommand,
  parseHelperOutput,
  type HwpxPreviewRunner,
  type HwpxRenderRequest,
  type HwpxRenderOutcome,
} from '../src/main/hwpx-preview'

const roots: string[] = []

describe('preview shutdown', () => {
  it('cancels active work, awaits ownership cleanup, and never starts queued or new work', async () => {
    const { cacheDir, source } = workspace()
    let started!: () => void
    const ready = new Promise<void>((resolve) => {
      started = resolve
    })
    let finishCleanup!: () => void
    const cleaning = new Promise<void>((resolve) => {
      finishCleanup = resolve
    })
    let enteredCleanup!: () => void
    const cleanupReady = new Promise<void>((resolve) => {
      enteredCleanup = resolve
    })
    const requests: HwpxRenderRequest[] = []
    const runner: HwpxPreviewRunner = {
      render(request) {
        requests.push(request)
        writeFileSync(request.ownershipFile, '{"processes":[{"pid":4242,"startedAt":"test"}]}')
        started()
        return new Promise((resolve) => {
          request.signal!.addEventListener(
            'abort',
            () => {
              // Even a success already in flight at abort must not be published.
              writeFileSync(request.outputPath, '%PDF-1.4 late output')
              resolve({ ok: true, pdfPath: request.outputPath, hancomVersion: '12' })
            },
            { once: true },
          )
        })
      },
      async abandon(path) {
        expect(readFileSync(path, 'utf8')).toContain('4242')
        enteredCleanup()
        await cleaning
        rmSync(path)
      },
    }
    const service = createHwpxPreviewService({
      cacheDir,
      runner,
      environmentFingerprint: () => 'test',
    })
    const active = service.preview(source)
    await ready
    const queued = service.preview(source, { force: true })
    service.clear()
    let disposed = false
    const disposal = service.dispose()
    expect(service.dispose()).toBe(disposal)
    void disposal.then(() => {
      disposed = true
    })
    await cleanupReady
    expect(disposed).toBe(false)
    expect(await service.preview(source)).toMatchObject({
      ok: false,
      error: expect.stringContaining('canceled'),
    })
    finishCleanup()
    await disposal
    for (const result of await Promise.all([active, queued])) {
      expect(result).toMatchObject({ ok: false, error: expect.stringContaining('canceled') })
    }
    expect(requests).toHaveLength(1)
    expect(readdirSync(cacheDir)).toEqual([])
  })

  it('bounds shutdown for an abort-ignoring runner and rejects its late success', async () => {
    vi.useFakeTimers()
    try {
      const { cacheDir, source } = workspace()
      let complete!: (outcome: HwpxRenderOutcome) => void
      let request!: HwpxRenderRequest
      let cleanupRecord = ''
      const service = createHwpxPreviewService({
        cacheDir,
        environmentFingerprint: () => 'test',
        runner: {
          render(value) {
            request = value
            writeFileSync(value.ownershipFile, 'retained proof')
            return new Promise((resolve) => {
              complete = resolve
            })
          },
          abandon(path) {
            cleanupRecord = readFileSync(path, 'utf8')
            return new Promise(() => {})
          },
        },
      })
      const active = service.preview(source)
      await vi.advanceTimersByTimeAsync(0)
      const queued = service.preview(source)
      const disposal = service.dispose()
      await vi.advanceTimersByTimeAsync(9500)
      await disposal
      expect(cleanupRecord).toBe('retained proof')
      expect((await active).ok).toBe(false)
      expect((await queued).ok).toBe(false)
      complete({ ok: true, pdfPath: request.outputPath, hancomVersion: '12' })
      await vi.advanceTimersByTimeAsync(0)
      expect(readdirSync(cacheDir)).toEqual([basename(request.ownershipFile)])
    } finally {
      vi.useRealTimers()
    }
  })
})

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'hwpx-preview-'))
  roots.push(root)
  const cacheDir = join(root, 'cache')
  mkdirSync(cacheDir, { recursive: true })
  const source = join(root, 'saved.hwpx')
  writeFileSync(source, 'first revision')
  return { root, cacheDir, source }
}

interface FakeRunner extends HwpxPreviewRunner {
  calls: HwpxRenderRequest[]
  abandoned: string[]
  maxConcurrent: number
}

/** Writes a plausible PDF at the requested path, like the real helper does. */
function fakeRunner(
  behaviour: (
    request: HwpxRenderRequest,
    call: number,
  ) => 'ok' | 'timeout' | 'error' | 'garbage' | 'elsewhere' | 'noversion' | 'redundant-path' = () =>
    'ok',
  onRender?: (request: HwpxRenderRequest) => void,
): FakeRunner {
  let active = 0
  const runner: FakeRunner = {
    calls: [],
    abandoned: [],
    maxConcurrent: 0,
    async render(request) {
      active += 1
      runner.maxConcurrent = Math.max(runner.maxConcurrent, active)
      runner.calls.push(request)
      const mode = behaviour(request, runner.calls.length)
      await new Promise((resolve) => setTimeout(resolve, 5))
      onRender?.(request)
      active -= 1
      if (mode === 'timeout') return { ok: false, error: 'Hancom did not finish', timedOut: true }
      if (mode === 'error') return { ok: false, error: 'Hancom could not render this document' }
      if (mode === 'garbage') {
        writeFileSync(request.outputPath, 'not a pdf at all')
        return { ok: true, pdfPath: request.outputPath, hancomVersion: '12.0.0.3146' }
      }
      if (mode === 'elsewhere') {
        const other = join(request.outputPath, '..', 'somewhere-else.pdf')
        writeFileSync(other, '%PDF-1.4 elsewhere')
        return { ok: true, pdfPath: other, hancomVersion: '12.0.0.3146' }
      }
      if (mode === 'noversion') {
        writeFileSync(request.outputPath, '%PDF-1.4 no version reported')
        return { ok: true, pdfPath: request.outputPath, hancomVersion: '' }
      }
      if (mode === 'redundant-path') {
        // Same file, spelled with a redundant path segment.
        writeFileSync(request.outputPath, '%PDF-1.4 redundant spelling')
        const noisy = join(dirname(request.outputPath), '.', basename(request.outputPath))
        return { ok: true, pdfPath: noisy, hancomVersion: '12.0.0.3146' }
      }
      writeFileSync(request.outputPath, `%PDF-1.4 render ${runner.calls.length}`)
      return { ok: true, pdfPath: request.outputPath, hancomVersion: '12.0.0.3146' }
    },
    async abandon(ownershipFile) {
      runner.abandoned.push(ownershipFile)
    },
  }
  return runner
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true })
    } catch {
      // temp cleanup only
    }
  }
})

describe('HWPX Hancom preview service', () => {
  it('renders once, then serves the same saved revision from the cache', async () => {
    const { cacheDir, source } = workspace()
    const runner = fakeRunner()
    const service = createHwpxPreviewService({
      cacheDir,
      runner,
      environmentFingerprint: () => 'hwp-12.0.0.3146',
    })

    const first = await service.preview(source)
    const second = await service.preview(source)

    expect(first).toMatchObject({ ok: true, cached: false, hancomVersion: '12.0.0.3146' })
    expect(second).toMatchObject({ ok: true, cached: true })
    if (!first.ok || !second.ok) throw new Error('expected both previews to succeed')
    expect(second.pdfPath).toBe(first.pdfPath)
    expect(second.sourceHash).toBe(first.sourceHash)
    expect(runner.calls).toHaveLength(1)
    expect(readFileSync(first.pdfPath, 'utf8')).toContain('%PDF-')
  })

  it('re-renders after the file is saved again and keeps the earlier artifact readable', async () => {
    const { cacheDir, source } = workspace()
    const runner = fakeRunner()
    const service = createHwpxPreviewService({
      cacheDir,
      runner,
      environmentFingerprint: () => 'hwp-12.0.0.3146',
    })

    const first = await service.preview(source)
    writeFileSync(source, 'second revision')
    const second = await service.preview(source)

    if (!first.ok || !second.ok) throw new Error('expected both previews to succeed')
    expect(second.cached).toBe(false)
    expect(second.sourceHash).not.toBe(first.sourceHash)
    expect(second.pdfPath).not.toBe(first.pdfPath)
    // The path already handed to a caller must not be overwritten or removed.
    expect(readFileSync(first.pdfPath, 'utf8')).toContain('render 1')
    expect(readFileSync(second.pdfPath, 'utf8')).toContain('render 2')
  })

  it('force bypasses a valid cache entry and returns a distinct artifact', async () => {
    const { cacheDir, source } = workspace()
    const runner = fakeRunner()
    const service = createHwpxPreviewService({
      cacheDir,
      runner,
      environmentFingerprint: () => 'hwp-12.0.0.3146',
    })

    const first = await service.preview(source)
    const refreshed = await service.preview(source, { force: true })

    if (!first.ok || !refreshed.ok) throw new Error('expected both previews to succeed')
    expect(runner.calls).toHaveLength(2)
    expect(refreshed.cached).toBe(false)
    expect(refreshed.pdfPath).not.toBe(first.pdfPath)
    expect(existsSync(first.pdfPath)).toBe(true)
  })

  it('drops the cache when the installed Hancom fingerprint changes', async () => {
    const { cacheDir, source } = workspace()
    const runner = fakeRunner()
    let fingerprint = 'hwp-12.0.0.3146'
    const service = createHwpxPreviewService({
      cacheDir,
      runner,
      environmentFingerprint: () => fingerprint,
    })

    await service.preview(source)
    fingerprint = 'hwp-12.0.0.9999'
    const afterUpdate = await service.preview(source)

    expect(afterUpdate).toMatchObject({ ok: true, cached: false })
    expect(runner.calls).toHaveLength(2)
  })

  it('does not serve a cached render when the Hancom install cannot be identified', async () => {
    const { cacheDir, source } = workspace()
    const runner = fakeRunner()
    const service = createHwpxPreviewService({
      cacheDir,
      runner,
      environmentFingerprint: () => '',
    })

    await service.preview(source)
    await service.preview(source)

    expect(runner.calls).toHaveLength(2)
  })

  it('expires cache entries after the configured lifetime', async () => {
    const { cacheDir, source } = workspace()
    const runner = fakeRunner()
    let clock = 1_000_000
    const service = createHwpxPreviewService({
      cacheDir,
      runner,
      cacheMaxAgeMs: 60_000,
      now: () => clock,
      environmentFingerprint: () => 'hwp-12.0.0.3146',
    })

    await service.preview(source)
    clock += 30_000
    expect(await service.preview(source)).toMatchObject({ cached: true })
    clock += 60_000
    expect(await service.preview(source)).toMatchObject({ cached: false })
    expect(runner.calls).toHaveLength(2)
  })

  it('rejects a render whose source changed while Hancom was working', async () => {
    const { cacheDir, source } = workspace()
    const runner = fakeRunner(
      () => 'ok',
      () => writeFileSync(source, 'saved again during the render'),
    )
    const service = createHwpxPreviewService({
      cacheDir,
      runner,
      environmentFingerprint: () => 'hwp-12.0.0.3146',
    })

    const result = await service.preview(source)

    expect(result).toEqual({
      ok: false,
      error: 'The document changed while the preview was rendering',
    })
    expect(readdirSync(cacheDir).filter((name) => name.endsWith('.pdf'))).toEqual([])
  })

  it('cleans up helper-owned Hancom processes after a timeout and caches nothing', async () => {
    const { cacheDir, source } = workspace()
    const runner = fakeRunner((_, call) => (call === 1 ? 'timeout' : 'ok'))
    const service = createHwpxPreviewService({
      cacheDir,
      runner,
      environmentFingerprint: () => 'hwp-12.0.0.3146',
    })

    const timedOut = await service.preview(source)
    expect(timedOut).toMatchObject({ ok: false })
    expect(runner.abandoned).toEqual([runner.calls[0]?.ownershipFile])
    expect(readdirSync(cacheDir).filter((name) => name.endsWith('.pdf'))).toEqual([])

    // A later attempt still works: the failure left no poisoned cache entry.
    expect(await service.preview(source)).toMatchObject({ ok: true, cached: false })
  })

  it('does not run two Hancom renders at the same time', async () => {
    const { cacheDir, source, root } = workspace()
    const other = join(root, 'second.hwpx')
    writeFileSync(other, 'another document')
    const runner = fakeRunner()
    const service = createHwpxPreviewService({
      cacheDir,
      runner,
      environmentFingerprint: () => 'hwp-12.0.0.3146',
    })

    const [a, b] = await Promise.all([service.preview(source), service.preview(other)])

    expect(a.ok && b.ok).toBe(true)
    expect(runner.calls).toHaveLength(2)
    expect(runner.maxConcurrent).toBe(1)
  })

  it('refuses a result written outside the requested artifact path', async () => {
    const { cacheDir, source } = workspace()
    const service = createHwpxPreviewService({
      cacheDir,
      runner: fakeRunner(() => 'elsewhere'),
      environmentFingerprint: () => 'hwp-12.0.0.3146',
    })

    expect(await service.preview(source)).toEqual({
      ok: false,
      error: 'The Hancom preview helper wrote to an unexpected location',
    })
  })

  it('refuses and does not cache an output that is not a PDF', async () => {
    const { cacheDir, source } = workspace()
    const runner = fakeRunner((_, call) => (call === 1 ? 'garbage' : 'ok'))
    const service = createHwpxPreviewService({
      cacheDir,
      runner,
      environmentFingerprint: () => 'hwp-12.0.0.3146',
    })

    expect(await service.preview(source)).toEqual({
      ok: false,
      error: 'Hancom produced an unreadable PDF for this document',
    })
    expect(await service.preview(source)).toMatchObject({ ok: true, cached: false })
  })

  it('clear() only removes its own artifacts and forces the next render', async () => {
    const { cacheDir, source } = workspace()
    const unrelated = join(cacheDir, 'user-file.txt')
    writeFileSync(unrelated, 'keep me')
    const runner = fakeRunner()
    const service = createHwpxPreviewService({
      cacheDir,
      runner,
      environmentFingerprint: () => 'hwp-12.0.0.3146',
    })

    await service.preview(source)
    service.clear(source)
    await service.preview(source)
    service.clear()

    expect(runner.calls).toHaveLength(2)
    expect(existsSync(unrelated)).toBe(true)
    expect(readdirSync(cacheDir).filter((name) => name.startsWith('hwpx-preview-'))).toEqual([])
  })

  it('rejects paths the shell should never forward', async () => {
    const { cacheDir, root } = workspace()
    const service = createHwpxPreviewService({
      cacheDir,
      runner: fakeRunner(),
      environmentFingerprint: () => 'hwp-12.0.0.3146',
    })

    expect(await service.preview('saved.hwpx')).toMatchObject({ ok: false })
    expect(await service.preview(join(root, 'saved.docx'))).toMatchObject({ ok: false })
    expect(await service.preview(join(root, 'missing.hwpx'))).toEqual({
      ok: false,
      error: 'Save the document before previewing it',
    })
  })

  it('accepts the requested artifact spelled with a redundant path segment', async () => {
    const { cacheDir, source } = workspace()
    const service = createHwpxPreviewService({
      cacheDir,
      runner: fakeRunner(() => 'redundant-path'),
      environmentFingerprint: () => 'hwp-12.0.0.3146',
    })

    const outcome = await service.preview(source)
    if (!outcome.ok) throw new Error(outcome.error)
    expect(outcome).toMatchObject({ ok: true, cached: false })
  })

  it('refuses a render that does not report a Hancom version', async () => {
    const { cacheDir, source } = workspace()
    const service = createHwpxPreviewService({
      cacheDir,
      runner: fakeRunner(() => 'noversion'),
      environmentFingerprint: () => 'hwp-12.0.0.3146',
    })

    expect(await service.preview(source)).toEqual({
      ok: false,
      error: 'Could not confirm which Hancom version rendered this preview',
    })
    expect(readdirSync(cacheDir).filter((name) => name.endsWith('.pdf'))).toEqual([])
  })

  it('runs ownership cleanup after any failed render, not only a timeout', async () => {
    const { cacheDir, source } = workspace()
    const runner = fakeRunner(() => 'error')
    const service = createHwpxPreviewService({
      cacheDir,
      runner,
      environmentFingerprint: () => 'hwp-12.0.0.3146',
    })

    await service.preview(source)

    expect(runner.abandoned).toEqual([runner.calls[0]?.ownershipFile])
  })

  it('clear() keeps the ownership record of an in-flight render', async () => {
    const { cacheDir, source } = workspace()
    let ownershipFile = ''
    const runner = fakeRunner(
      () => 'ok',
      (request) => {
        ownershipFile = request.ownershipFile
        // The real helper writes this before Hancom opens the document.
        writeFileSync(ownershipFile, '{"processes":[{"pid":4242,"startedAt":"now"}]}')
        service.clear()
      },
    )
    const service = createHwpxPreviewService({
      cacheDir,
      runner,
      environmentFingerprint: () => 'hwp-12.0.0.3146',
    })

    await service.preview(source)

    expect(existsSync(ownershipFile)).toBe(true)
  })

  it('ignores a pointer that names another revision artifact', async () => {
    const { cacheDir, source } = workspace()
    const runner = fakeRunner()
    const service = createHwpxPreviewService({
      cacheDir,
      runner,
      environmentFingerprint: () => 'hwp-12.0.0.3146',
    })

    const first = await service.preview(source)
    if (!first.ok) throw new Error('expected the first preview to succeed')
    const pointer = readdirSync(cacheDir).find((name) => name.endsWith('.json'))
    if (!pointer) throw new Error('expected a pointer file')
    const pointerPath = join(cacheDir, pointer)
    const parsed = JSON.parse(readFileSync(pointerPath, 'utf8')) as Record<string, unknown>
    // Same document key, but an artifact belonging to a different source hash.
    const foreign = String(parsed['artifact']).replace(/-[0-9a-f]{12}-/, '-ffffffffffff-')
    writeFileSync(join(cacheDir, foreign), '%PDF-1.4 foreign revision')
    writeFileSync(pointerPath, JSON.stringify({ ...parsed, artifact: foreign }), 'utf8')

    expect(await service.preview(source)).toMatchObject({ ok: true, cached: false })
    expect(runner.calls).toHaveLength(2)
  })
})

describe('installed Hancom executable resolution', () => {
  const installed = 'C:\\Program Files (x86)\\HNC\\Office 2022\\HOffice120\\bin\\hwp.exe'

  it('handles the unquoted LocalServer32 value registered on this machine', () => {
    expect(
      executablePathFromCommand(`${installed} -Automation`, (path) => path === installed),
    ).toBe(installed)
  })

  it('handles a quoted value', () => {
    expect(
      executablePathFromCommand(
        `"${installed}" -Automation -Embedding`,
        (path) => path === installed,
      ),
    ).toBe(installed)
  })

  it('expands environment references', () => {
    process.env['HWPX_TEST_ROOT'] = 'C:\\Program Files (x86)\\HNC'
    const value = '%HWPX_TEST_ROOT%\\Office 2022\\HOffice120\\bin\\hwp.exe -Automation'
    try {
      expect(executablePathFromCommand(value, (path) => path === installed)).toBe(installed)
    } finally {
      delete process.env['HWPX_TEST_ROOT']
    }
  })

  it('returns nothing when no candidate exists on disk', () => {
    expect(executablePathFromCommand(`${installed} -Automation`, () => false)).toBe('')
    expect(executablePathFromCommand('', () => true)).toBe('')
  })
})

describe('helper output parsing', () => {
  it('accepts the real success line and keeps the reported version', () => {
    const outcome = parseHelperOutput(
      '{"ok":true,"pdfPath":"C:\\\\cache\\\\a.pdf","stage":"done","hancomVersion":"12.0.0.3146"}\r\n',
      'C:\\cache\\a.pdf',
    )
    expect(outcome).toEqual({ ok: true, pdfPath: 'C:\\cache\\a.pdf', hancomVersion: '12.0.0.3146' })
  })

  it('surfaces the failing stage from the helper', () => {
    const outcome = parseHelperOutput(
      '{"ok":false,"error":"Hancom refused to open the document","stage":"open"}',
      'C:\\cache\\a.pdf',
    )
    expect(outcome).toMatchObject({ ok: false })
    if (outcome.ok) throw new Error('expected a failure')
    expect(outcome.error).toContain('open')
    expect(outcome.error).toContain('refused to open')
  })

  it('treats noise without a result line as a failure', () => {
    expect(parseHelperOutput('powershell wrote nothing useful', 'C:\\cache\\a.pdf')).toMatchObject({
      ok: false,
    })
  })
})
