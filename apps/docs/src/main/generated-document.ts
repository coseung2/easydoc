import { validateGeneratedDocumentRequest } from '@genoffice/agent-core'
import type { GeneratedDocumentResult } from '@genoffice/agent-core'
import { generatedFileStem, writeGeneratedFile } from '@genoffice/electron-utils'
import { exportHwpx } from '@genoffice/hwpx-engine'

export interface GeneratedDocumentHost {
  saveDir(): string
  openDocx(title: string, html: string): void
  renderPdf(title: string, html: string): Promise<Uint8Array>
  /** Return true only when the file was opened in an editor. */
  openGenerated(path: string): boolean
  reveal(path: string): void
}

/** Isolated orchestration: no direct Electron dependency and no changes to the current document. */
export async function createGeneratedDocument(
  input: unknown,
  host: GeneratedDocumentHost,
): Promise<GeneratedDocumentResult> {
  try {
    const request = validateGeneratedDocumentRequest(input)
    const title = generatedFileStem(request.title)
    if (request.type === 'docx') {
      host.openDocx(title, request.content)
      return { ok: true }
    }
    const hwpx =
      request.type === 'hwpx' ? exportHwpx(request.content, { title, createdAt: new Date() }) : null
    const bytes =
      hwpx?.bytes ??
      (request.type === 'pdf' ? await host.renderPdf(title, request.content) : request.content)
    const path = await writeGeneratedFile(host.saveDir(), title, request.type, bytes)
    const warnings = [...(hwpx?.warnings ?? [])]
    let opened = false
    try {
      if (hwpx) host.reveal(path)
      else opened = host.openGenerated(path)
    } catch {
      warnings.push('The file was saved, but could not be opened or revealed automatically.')
    }
    return {
      ok: true,
      path,
      opened,
      ...(warnings.length ? { warnings } : {}),
      ...(hwpx ? { verification: hwpx.verification } : {}),
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
