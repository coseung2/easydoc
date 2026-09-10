import { app } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

let queue: Promise<unknown> = Promise.resolve()

/** Portable Python and OCR models ship alongside the app; no installed Python or network needed. */
export function readBundledPdfOcr(path: string): Promise<string> {
  const task = queue.catch(() => {}).then(() => new Promise<string>((resolve, reject) => {
    const root = app.isPackaged
      ? join(process.resourcesPath, 'paddle-ocr')
      : join(app.getAppPath(), '../../.task/paddle-bundle')
    const python = join(root, 'python.exe')
    if (!existsSync(python)) { reject(new Error('Local OCR component is missing. Rebuild the OCR bundle or reinstall GenOffice.')); return }
    execFile(python, [join(root, 'local-ocr.py'), path], {
      windowsHide: true, timeout: 300_000, maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    }, (error, stdout) => {
      try {
        const result = JSON.parse(stdout) as { text?: string; error?: string }
        if (error || result.error) throw new Error(result.error ?? 'Local OCR process failed or timed out')
        if (typeof result.text !== 'string') throw new Error('Invalid local OCR response')
        resolve(result.text)
      } catch (failure) { reject(failure) }
    })
  }))
  queue = task
  return task
}
