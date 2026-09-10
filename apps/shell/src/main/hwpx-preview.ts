/**
 * Hancom-rendered preview of a saved HWPX file (main process service).
 *
 * The renderer never names a path: the shell resolves the saved path from the
 * sender-bound tab and calls `preview(filePath)`. One render at a time
 * (serialized queue, same shape as bundled-ocr.ts), each in a hidden
 * single-shot PowerShell STA child process driving the locally installed
 * Hancom automation object (scripts/hwpx/hwpx-to-pdf.ps1).
 *
 * Contract decisions worth knowing before changing this file:
 * - A successful PDF proves that this document opened and exported on this
 *   machine with this Hancom build. It is not evidence of general HWPX
 *   interoperability.
 * - Every render writes a fresh, immutable artifact (source hash + nonce in the
 *   file name) and a small pointer file. A returned `pdfPath` is never
 *   overwritten or deleted by the next render; stale artifacts are pruned only
 *   once they are older than the retention window.
 * - Cache reuse requires the same source hash, the same helper contract, and
 *   the same installed-Hancom fingerprint, and it expires after
 *   `cacheMaxAgeMs`. `{ force: true }` skips it entirely, because identical
 *   bytes and the same Hancom build can still render differently after a font
 *   install.
 * - The source is hashed before and after rendering; a document saved again
 *   mid-render is rejected instead of returning a PDF for the wrong revision.
 * - No Electron import: the shell supplies `cacheDir` and the helper paths.
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  closeSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

/** Bump when the helper's behaviour changes so older artifacts are not reused. */
export const HWPX_PREVIEW_CONTRACT = 'hwpx-pdf-1'

const ARTIFACT_PREFIX = 'hwpx-preview-'
const OWNERSHIP_SUFFIX = '.owned.json'

export interface HwpxPreviewSuccess {
  ok: true
  pdfPath: string
  sourceHash: string
  hancomVersion: string
  /** True when the PDF came from the cache instead of a fresh Hancom render. */
  cached: boolean
}

export interface HwpxPreviewFailure {
  ok: false
  error: string
}

export type HwpxPreviewResult = HwpxPreviewSuccess | HwpxPreviewFailure

export interface HwpxPreviewRequestOptions {
  /** Explicit refresh: ignore any cached PDF and render again. */
  force?: boolean
}

/** One helper invocation. */
export interface HwpxRenderRequest {
  sourcePath: string
  outputPath: string
  ownershipFile: string
  timeoutMs: number
  /** Runners must stop their own child before settling cancellation. */
  signal?: AbortSignal
}

export type HwpxRenderOutcome =
  | { ok: true; pdfPath: string; hancomVersion: string }
  | { ok: false; error: string; timedOut?: boolean }

export interface HwpxPreviewRunner {
  render(request: HwpxRenderRequest): Promise<HwpxRenderOutcome>
  /** Terminate only the helper-owned Hancom processes listed in the file. */
  abandon(ownershipFile: string): Promise<void>
}

export interface HwpxPreviewServiceOptions {
  /** Writable directory owned by this service for rendered PDFs and pointers. */
  cacheDir: string
  /** Directory holding hwpx-to-pdf.ps1 and stop-owned-hwp.ps1. */
  helperDir?: string
  /** Full path to hwpx-to-pdf.ps1 (defaults to helperDir/hwpx-to-pdf.ps1). */
  helperPath?: string
  /** Full path to stop-owned-hwp.ps1 (defaults to helperDir/stop-owned-hwp.ps1). */
  cleanupHelperPath?: string
  /** Hard limit for one render, including Hancom start-up. */
  timeoutMs?: number
  /** Cached PDFs older than this are re-rendered. */
  cacheMaxAgeMs?: number
  /** Artifacts older than this may be deleted; keep it >= cacheMaxAgeMs. */
  artifactRetentionMs?: number
  /**
   * Identity of the installed Hancom build. A cached PDF is reused only when
   * this still matches, so a Hancom update invalidates old renders. Returning
   * an empty string disables cache reuse.
   */
  environmentFingerprint?: () => string
  /** Injected for tests; defaults to the PowerShell STA child process. */
  runner?: HwpxPreviewRunner
  /** Injected for tests. */
  now?: () => number
}

export interface HwpxPreviewService {
  preview(filePath: string, options?: HwpxPreviewRequestOptions): Promise<HwpxPreviewResult>
  /** Drop cached artifacts: one document's, or every artifact this service wrote. */
  clear(filePath?: string): void
  /** Call and await before Electron exits. Idempotent; no further previews start. */
  dispose(): Promise<void>
}

interface PointerFile {
  contract: string
  sourceHash: string
  hancomVersion: string
  environmentFingerprint: string
  artifact: string
  createdAt: number
}

/**
 * 90s: a cold Hancom automation start plus a one-page export measured ~70s on
 * the reference machine (HWP 2022 12.0.0.3146). Anything materially longer is a
 * stalled render (for example Hancom waiting on its own dialog), and the
 * service reports that instead of hanging the UI.
 */
const DEFAULT_TIMEOUT_MS = 90_000
const DEFAULT_CACHE_MAX_AGE_MS = 60 * 60 * 1000
const DEFAULT_ARTIFACT_RETENTION_MS = 2 * 60 * 60 * 1000
/** How long an installed-Hancom fingerprint may be trusted before re-reading it. */
const FINGERPRINT_TTL_MS = 60_000

/**
 * Windows-only: the preview needs the installed Hancom Office automation
 * object. Callers should treat `ok:false` as "no preview available" and keep
 * showing the editor.
 */
export function createHwpxPreviewService(options: HwpxPreviewServiceOptions): HwpxPreviewService {
  const cacheDir = options.cacheDir
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const cacheMaxAgeMs = options.cacheMaxAgeMs ?? DEFAULT_CACHE_MAX_AGE_MS
  const retentionMs = Math.max(
    options.artifactRetentionMs ?? DEFAULT_ARTIFACT_RETENTION_MS,
    cacheMaxAgeMs,
  )
  const now = options.now ?? (() => Date.now())
  const fingerprint = options.environmentFingerprint ?? installedHancomFingerprint
  const helperPath =
    options.helperPath ?? (options.helperDir ? join(options.helperDir, 'hwpx-to-pdf.ps1') : '')
  const cleanupHelperPath =
    options.cleanupHelperPath ??
    (options.helperDir ? join(options.helperDir, 'stop-owned-hwp.ps1') : '')
  const runner = options.runner ?? createPowerShellRunner(helperPath, cleanupHelperPath)

  let queue: Promise<unknown> = Promise.resolve()
  const shutdown = new AbortController()
  let disposal: Promise<void> | undefined
  const canceled: HwpxPreviewFailure = {
    ok: false,
    error: 'Hancom preview canceled: service disposed',
  }

  function preview(
    filePath: string,
    request: HwpxPreviewRequestOptions = {},
  ): Promise<HwpxPreviewResult> {
    if (shutdown.signal.aborted) return Promise.resolve(canceled)
    // Serialize: Hancom automation is a single shared desktop resource, and two
    // concurrent instances would race over the same document.
    const task = queue.catch(() => {}).then(() => renderOnce(filePath, request.force === true))
    queue = task
    return task
  }

  async function renderOnce(filePath: string, force: boolean): Promise<HwpxPreviewResult> {
    if (shutdown.signal.aborted) return canceled
    if (!filePath || !isAbsolute(filePath) || !/\.hwpx$/i.test(filePath))
      return { ok: false, error: 'Preview needs the absolute path of a saved .hwpx file' }
    if (!existsSync(filePath)) return { ok: false, error: 'Save the document before previewing it' }

    let sourceHash: string
    try {
      sourceHash = hashFile(filePath)
    } catch {
      return { ok: false, error: 'Could not read the saved document' }
    }

    const key = documentKey(filePath)
    const pointerPath = join(cacheDir, `${ARTIFACT_PREFIX}${key}.json`)
    const environment = safeFingerprint(fingerprint)

    if (!force) {
      const cached = readPointer(
        cacheDir,
        pointerPath,
        key,
        sourceHash,
        environment,
        cacheMaxAgeMs,
        now(),
      )
      if (cached)
        return {
          ok: true,
          pdfPath: join(cacheDir, cached.artifact),
          sourceHash,
          hancomVersion: cached.hancomVersion,
          cached: true,
        }
    }

    try {
      mkdirSync(cacheDir, { recursive: true })
    } catch {
      return { ok: false, error: 'Could not prepare the preview cache directory' }
    }
    prune(cacheDir, key, retentionMs, now())

    // Immutable artifact per render: a path already handed to a caller is never
    // rewritten by a later request.
    const artifact = `${ARTIFACT_PREFIX}${key}-${sourceHash.slice(0, 12)}-${randomBytes(4).toString('hex')}.pdf`
    const pdfPath = join(cacheDir, artifact)
    const ownershipFile = join(cacheDir, `${ARTIFACT_PREFIX}${key}${OWNERSHIP_SUFFIX}`)

    let outcome: HwpxRenderOutcome
    try {
      const rendering = runner.render({
        sourcePath: filePath,
        outputPath: pdfPath,
        ownershipFile,
        timeoutMs,
        signal: shutdown.signal,
      })
      // An injected or faulty runner may ignore abort. Bound shutdown anyway;
      // a late result must never publish a cache pointer or success.
      let abortTimer: ReturnType<typeof setTimeout> | undefined
      let onAbort: () => void = () => {}
      const cancellation = new Promise<HwpxRenderOutcome>((resolveCanceled) => {
        onAbort = () => {
          abortTimer = setTimeout(() => resolveCanceled(canceled), 2500)
        }
        shutdown.signal.addEventListener('abort', onAbort, { once: true })
        if (shutdown.signal.aborted) onAbort()
      })
      try {
        outcome = await Promise.race([rendering, cancellation])
      } finally {
        shutdown.signal.removeEventListener('abort', onAbort)
        if (abortTimer) clearTimeout(abortTimer)
      }
    } catch (failure) {
      outcome = { ok: false, error: messageOf(failure) }
    }
    if (shutdown.signal.aborted || !outcome.ok) {
      // The helper cleans up after itself when it runs to completion. Any
      // failure path may have left it unable to do so (killed on timeout,
      // spawn error, crash), so always run the ownership-proving cleanup.
      await safeAbandon(ownershipFile)
      remove(pdfPath)
      return shutdown.signal.aborted ? canceled : (outcome as HwpxPreviewFailure)
    }
    if (!outcome.hancomVersion) {
      remove(pdfPath)
      return { ok: false, error: 'Could not confirm which Hancom version rendered this preview' }
    }
    if (!samePath(outcome.pdfPath, pdfPath)) {
      remove(pdfPath)
      return { ok: false, error: 'The Hancom preview helper wrote to an unexpected location' }
    }
    if (!isPdfFile(pdfPath)) {
      remove(pdfPath)
      return { ok: false, error: 'Hancom produced an unreadable PDF for this document' }
    }

    // Revision guard: the editor may have saved again while Hancom rendered.
    let hashAfter: string
    try {
      hashAfter = hashFile(filePath)
    } catch {
      remove(pdfPath)
      return { ok: false, error: 'Could not confirm the document was unchanged while rendering' }
    }
    if (hashAfter !== sourceHash) {
      remove(pdfPath)
      return { ok: false, error: 'The document changed while the preview was rendering' }
    }

    const pointer: PointerFile = {
      contract: HWPX_PREVIEW_CONTRACT,
      sourceHash,
      hancomVersion: outcome.hancomVersion,
      environmentFingerprint: environment,
      artifact,
      createdAt: now(),
    }
    try {
      writeFileSync(pointerPath, JSON.stringify(pointer), 'utf8')
    } catch {
      // A missing pointer only costs a re-render next time.
    }
    return {
      ok: true,
      pdfPath,
      sourceHash,
      hancomVersion: outcome.hancomVersion,
      cached: false,
    }
  }

  function clear(filePath?: string): void {
    let entries: string[]
    try {
      entries = readdirSync(cacheDir)
    } catch {
      return
    }
    const scope = filePath ? `${ARTIFACT_PREFIX}${documentKey(filePath)}` : ARTIFACT_PREFIX
    // Only artifacts and pointers this service created, never a recursive
    // directory removal. Ownership records are live state for an in-flight
    // render: deleting one would strip the proof needed to clean up.
    for (const entry of entries) {
      if (!entry.startsWith(scope) || entry !== basename(entry)) continue
      if (entry.endsWith(OWNERSHIP_SUFFIX)) continue
      remove(join(cacheDir, entry))
    }
  }

  async function safeAbandon(ownershipFile: string): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        runner.abandon(ownershipFile),
        new Promise<void>((resolveBound) => {
          timer = setTimeout(resolveBound, 7000)
        }),
      ])
    } catch {
      // Nothing further to do; never escalate to a broad process kill.
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  function dispose(): Promise<void> {
    if (!disposal) {
      shutdown.abort()
      disposal = queue.then(
        () => {},
        () => {},
      )
    }
    // A COM startup interrupted before HWND ownership was recorded remains
    // unproven; shutdown never guesses which HWP process to terminate.
    return disposal
  }

  return { preview, clear, dispose }
}

/** Cache identity of one document path under the current helper contract. */
function documentKey(filePath: string): string {
  return createHash('sha256')
    .update(`${HWPX_PREVIEW_CONTRACT}\n${filePath.toLowerCase()}`)
    .digest('hex')
    .slice(0, 32)
}

function hashFile(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

function readPointer(
  cacheDir: string,
  pointerPath: string,
  documentKeyValue: string,
  sourceHash: string,
  environment: string,
  maxAgeMs: number,
  currentTime: number,
): PointerFile | null {
  // An unknown environment must not serve a cached render.
  if (!environment) return null
  if (!existsSync(pointerPath)) return null
  let pointer: PointerFile
  try {
    pointer = JSON.parse(readFileSync(pointerPath, 'utf8')) as PointerFile
  } catch {
    return null
  }
  if (pointer.contract !== HWPX_PREVIEW_CONTRACT) return null
  if (pointer.sourceHash !== sourceHash) return null
  if (pointer.environmentFingerprint !== environment) return null
  if (typeof pointer.hancomVersion !== 'string' || !pointer.hancomVersion) return null
  if (typeof pointer.createdAt !== 'number') return null
  if (currentTime - pointer.createdAt > maxAgeMs || currentTime < pointer.createdAt) return null
  if (typeof pointer.artifact !== 'string' || pointer.artifact !== basename(pointer.artifact))
    return null
  // The artifact must be the one this document/revision produced.
  if (
    !pointer.artifact.startsWith(
      `${ARTIFACT_PREFIX}${documentKeyValue}-${sourceHash.slice(0, 12)}-`,
    )
  )
    return null
  if (!isPdfFile(join(cacheDir, pointer.artifact))) return null
  return pointer
}

/** Delete this document's artifacts once they age past the retention window. */
function prune(cacheDir: string, key: string, retentionMs: number, currentTime: number): void {
  let entries: string[]
  try {
    entries = readdirSync(cacheDir)
  } catch {
    return
  }
  const prefix = `${ARTIFACT_PREFIX}${key}-`
  for (const entry of entries) {
    if (!entry.startsWith(prefix) || !entry.endsWith('.pdf')) continue
    const path = join(cacheDir, entry)
    try {
      if (currentTime - statSync(path).mtimeMs > retentionMs) remove(path)
    } catch {
      // Ignore: the file may already be gone.
    }
  }
}

function isPdfFile(path: string): boolean {
  let handle: number | null = null
  try {
    if (statSync(path).size < 5) return false
    handle = openSync(path, 'r')
    const head = Buffer.alloc(5)
    readSync(handle, head, 0, 5, 0)
    return head.toString('latin1') === '%PDF-'
  } catch {
    return false
  } finally {
    if (handle !== null)
      try {
        closeSync(handle)
      } catch {
        // Nothing to recover from a failed close of a read handle.
      }
  }
}

function samePath(left: string, right: string): boolean {
  // Compare resolved paths so `dir\\.\\file.pdf` or a relative reply is not
  // mistaken for a different location, and only fold case on Windows.
  const a = resolve(left)
  const b = resolve(right)
  if (process.platform === 'win32') return a.toLowerCase() === b.toLowerCase()
  return a === b
}

function safeFingerprint(probe: () => string): string {
  try {
    return probe()
  } catch {
    return ''
  }
}

function remove(path: string): void {
  try {
    rmSync(path, { force: true })
  } catch {
    // Leftovers are harmless: the next render writes a new artifact.
  }
}

function messageOf(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure)
}

let cachedFingerprint: { value: string; readAt: number } | undefined

/**
 * Identity of the installed Hancom automation server: the registered
 * LocalServer32 executable plus its size and modification time. A Hancom update
 * changes it, which invalidates cached renders. Read-only registry query; no
 * value is created or modified.
 */
export function installedHancomFingerprint(): string {
  // Re-read periodically: a Hancom update during a long session must invalidate
  // cached renders instead of being masked by a process-lifetime value.
  const currentTime = Date.now()
  if (cachedFingerprint && currentTime - cachedFingerprint.readAt < FINGERPRINT_TTL_MS)
    return cachedFingerprint.value
  const store = (value: string): string => {
    cachedFingerprint = { value, readAt: currentTime }
    return value
  }
  if (process.platform !== 'win32') return store('')
  const clsid = queryRegistry('HKLM\\SOFTWARE\\Classes\\HWPFrame.HwpObject\\CLSID')
  if (!clsid) return store('')
  const command =
    queryRegistry(`HKLM\\SOFTWARE\\Classes\\WOW6432Node\\CLSID\\${clsid}\\LocalServer32`) ??
    queryRegistry(`HKLM\\SOFTWARE\\Classes\\CLSID\\${clsid}\\LocalServer32`)
  if (!command) return store('')
  const executable = executablePathFromCommand(command)
  if (!executable) return store('')
  try {
    const info = statSync(executable)
    return store(`${executable.toLowerCase()}|${info.size}|${Math.round(info.mtimeMs)}`)
  } catch {
    return store('')
  }
}

/**
 * Extract the server executable from a LocalServer32 command line. The
 * registered value may be quoted or bare, and this machine registers it bare
 * with spaces in the path:
 *   C:\Program Files (x86)\HNC\Office 2022\HOffice120\bin\hwp.exe -Automation
 * so splitting on the first space is wrong. For an unquoted value, take the
 * shortest prefix ending in `.exe` that actually exists on disk.
 */
export function executablePathFromCommand(
  command: string,
  exists: (path: string) => boolean = (path) => existsSync(path),
): string {
  const expanded = expandEnvironmentStrings(command).trim()
  if (!expanded) return ''
  const quoted = expanded.match(/^"([^"]+)"/)?.[1]?.trim()
  if (quoted) return exists(quoted) ? quoted : ''
  for (const match of expanded.matchAll(/\.exe(?=\s|$)/gi)) {
    const candidate = expanded.slice(0, (match.index ?? 0) + match[0].length).trim()
    if (exists(candidate)) return candidate
  }
  // No `.exe` boundary matched a real file: fall back to a single-token value.
  const single = expanded.split(/\s+/)[0] ?? ''
  return single && exists(single) ? single : ''
}

/** Expand `%VAR%` references, as a REG_EXPAND_SZ consumer must. */
function expandEnvironmentStrings(value: string): string {
  return value.replace(/%([^%]+)%/g, (whole, name: string) => process.env[name] ?? whole)
}

/** Read one default registry value with reg.exe; returns null when absent. */
function queryRegistry(key: string): string | null {
  const result = spawnSync('reg.exe', ['query', key, '/ve'], {
    windowsHide: true,
    encoding: 'utf8',
    timeout: 5_000,
  })
  if (result.status !== 0 || !result.stdout) return null
  const match = result.stdout.match(/REG_(?:SZ|EXPAND_SZ)\s+(.+)/)
  return match?.[1]?.trim() ?? null
}

/** Default runner: hidden, single-shot PowerShell STA child process. */
export function createPowerShellRunner(
  helperPath: string,
  cleanupHelperPath: string,
  powershellPath = join(
    process.env['SystemRoot'] ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  ),
): HwpxPreviewRunner {
  return {
    render(request) {
      if (process.platform !== 'win32')
        return Promise.resolve<HwpxRenderOutcome>({
          ok: false,
          error: 'Hancom preview needs Windows with Hancom Office installed',
        })
      if (!helperPath || !existsSync(helperPath))
        return Promise.resolve<HwpxRenderOutcome>({
          ok: false,
          error: 'The Hancom preview helper script is missing from this installation',
        })
      return runPowerShell(
        powershellPath,
        [
          '-NoProfile',
          '-NonInteractive',
          '-STA',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          helperPath,
          '-Source',
          request.sourcePath,
          '-Output',
          request.outputPath,
          '-OwnershipFile',
          request.ownershipFile,
        ],
        request.timeoutMs,
        dirname(helperPath),
        request.signal,
      ).then((result) => {
        if (!result.ok)
          return {
            ok: false as const,
            error: result.error,
            ...(result.timedOut ? { timedOut: true } : {}),
          }
        return parseHelperOutput(result.stdout, request.outputPath)
      })
    },
    async abandon(ownershipFile) {
      if (process.platform !== 'win32') return
      if (!cleanupHelperPath || !existsSync(cleanupHelperPath)) return
      if (!existsSync(ownershipFile)) return
      await runPowerShell(
        powershellPath,
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          cleanupHelperPath,
          '-OwnershipFile',
          ownershipFile,
        ],
        5_000,
        dirname(cleanupHelperPath),
      )
    },
  }
}

/** Parse the helper's single JSON line. */
export function parseHelperOutput(stdout: string, expectedPdfPath: string): HwpxRenderOutcome {
  const line = stdout
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter((value) => value.startsWith('{'))
    .pop()
  if (!line) return { ok: false, error: 'The Hancom preview helper returned no result' }
  let payload: {
    ok?: boolean
    pdfPath?: string
    hancomVersion?: string
    error?: string
    stage?: string
  }
  try {
    payload = JSON.parse(line) as typeof payload
  } catch {
    return { ok: false, error: 'The Hancom preview helper returned an unreadable result' }
  }
  if (payload.ok !== true)
    return {
      ok: false,
      error: payload.error
        ? `Hancom could not render this document (${payload.stage ?? 'unknown stage'}): ${payload.error}`
        : 'Hancom could not render this document',
    }
  return {
    ok: true,
    pdfPath: payload.pdfPath ?? expectedPdfPath,
    hancomVersion: payload.hancomVersion ?? '',
  }
}

function runPowerShell(
  executable: string,
  args: string[],
  timeoutMs: number,
  cwd: string,
  signal?: AbortSignal,
): Promise<{ ok: true; stdout: string } | { ok: false; error: string; timedOut?: boolean }> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ ok: false, error: 'Hancom preview canceled' })
      return
    }
    const child = spawn(executable, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(cwd && existsSync(cwd) ? { cwd } : {}),
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    let stopResult: { ok: false; error: string; timedOut?: boolean } | undefined
    let stopTimer: ReturnType<typeof setTimeout> | undefined
    const finish = (
      result: { ok: true; stdout: string } | { ok: false; error: string; timedOut?: boolean },
    ) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (stopTimer) clearTimeout(stopTimer)
      signal?.removeEventListener('abort', onAbort)
      resolve(result)
    }
    const stop = (result: { ok: false; error: string; timedOut?: boolean }) => {
      if (settled || stopResult) return
      stopResult = result
      child.kill()
      // Normally close arrives first. Never wait indefinitely for a dead child.
      stopTimer = setTimeout(() => finish(result), 2000)
    }
    const onAbort = () => stop({ ok: false, error: 'Hancom preview canceled' })
    const timer = setTimeout(() => {
      // Kill our own child only. Helper-created Hancom processes are handled
      // through the ownership file, never by image name.
      stop({
        ok: false,
        error: `Hancom did not finish the preview within ${Math.round(timeoutMs / 1000)}s. Hancom may be waiting for a confirmation dialog on this machine.`,
        timedOut: true,
      })
    }, timeoutMs)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (failure) => finish({ ok: false, error: messageOf(failure) }))
    child.on('close', (code) => {
      if (stopResult) {
        finish(stopResult)
        return
      }
      if (code === 0 || stdout.includes('{')) finish({ ok: true, stdout })
      else
        finish({
          ok: false,
          error: stderr.trim() || `The Hancom preview helper exited with code ${code}`,
        })
    })
  })
}
