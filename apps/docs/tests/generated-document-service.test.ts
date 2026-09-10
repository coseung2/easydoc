import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspectGeneratedHwpx, parseHwpxHtml } from '@genoffice/hwpx-engine'
import { createGeneratedDocument, type GeneratedDocumentHost } from '../src/main/generated-document'

const roots: string[] = []
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'easydoc-doc-generation-'))
  roots.push(dir)
  const host: GeneratedDocumentHost = {
    saveDir: () => dir,
    openDocx: vi.fn(),
    renderPdf: vi.fn(async () => Buffer.from('pdf-test-bytes')),
    openGenerated: vi.fn(() => true),
    reveal: vi.fn(),
  }
  return { dir, host }
}
afterEach(async () => {
  for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('isolated document generation service', () => {
  it('writes real HWPX and reveals it without passing it to a DOCX tab router', async () => {
    const { dir, host } = await setup()
    const result = await createGeneratedDocument(
      { type: 'hwpx', title: '보고서', content: '<h1>보고서</h1><p>확인된 내용</p>' },
      host,
    )
    expect(result).toMatchObject({ ok: true, opened: false, verification: 'structural-only' })
    expect(result.warnings?.[0]).toContain('have not been verified')
    expect(
      inspectGeneratedHwpx(await readFile(result.path!)).files['Contents/section0.xml'],
    ).toBeDefined()
    expect(host.reveal).toHaveBeenCalledWith(join(dir, '보고서.hwpx'))
    expect(host.openGenerated).not.toHaveBeenCalled()
    expect(host.openDocx).not.toHaveBeenCalled()
  })

  it('opens the written document, not the request content, in the HWPX editor tab', async () => {
    const { host } = await setup()
    const openHwpx = vi.fn()
    host.openHwpx = openHwpx
    // <ul> is flattened into indented paragraphs while writing: the tab must
    // receive that normalized form, or a zero-edit save would renumber the list.
    const content = '<h1>보고서</h1><ul><li>첫째</li></ul>'
    const result = await createGeneratedDocument(
      { type: 'hwpx', title: '보고서', content },
      host,
    )
    expect(result).toMatchObject({ ok: true, opened: true })
    expect(host.reveal).not.toHaveBeenCalled()
    const [title, html, path] = openHwpx.mock.calls[0]!
    expect(title).toBe('보고서')
    expect(path).toBe(result.path)
    expect(html).not.toBe(content)
    expect(html).not.toContain('<ul')
    // the opened HTML describes the same document the file holds
    expect(parseHwpxHtml(html).blocks).toHaveLength(2)
    expect(html).toContain('• ')
  })

  it('reports a saved file with a warning when the HWPX tab cannot be opened', async () => {
    const { host } = await setup()
    host.openHwpx = () => {
      throw new Error('no tab host')
    }
    const result = await createGeneratedDocument(
      { type: 'hwpx', title: 'T', content: '<p>x</p>' },
      host,
    )
    expect(result).toMatchObject({ ok: true, opened: false })
    expect(result.warnings?.join(' ')).toContain('could not be opened or revealed')
    expect(await readFile(result.path!)).not.toHaveLength(0)
  })

  it('keeps DOCX on the existing queued editor path', async () => {
    const { dir, host } = await setup()
    expect(
      await createGeneratedDocument(
        { type: 'docx', title: 'Document', content: '<p>Text</p>' },
        host,
      ),
    ).toEqual({ ok: true })
    expect(host.openDocx).toHaveBeenCalledWith('Document', '<p>Text</p>')
    expect(await readdir(dir)).toEqual([])
  })
  it.each(['pdf', 'md'])('retains the %s content path and routes a saved file', async (type) => {
    const { host } = await setup()
    const result = await createGeneratedDocument(
      { type, title: 'Document', content: 'Source content' },
      host,
    )
    expect(result).toMatchObject({ ok: true, opened: true })
    expect(await readFile(result.path!, 'utf8')).toBe(
      type === 'pdf' ? 'pdf-test-bytes' : 'Source content',
    )
    expect(host.openGenerated).toHaveBeenCalledWith(result.path)
  })
  it('returns a saved-file warning when presentation fails, not a failed save', async () => {
    const { host } = await setup()
    host.reveal = () => {
      throw new Error('no file manager')
    }
    const result = await createGeneratedDocument(
      { type: 'hwpx', title: 'T', content: '<p>x</p>' },
      host,
    )
    expect(result.ok).toBe(true)
    expect(result.warnings?.join(' ')).toContain('could not be opened or revealed')
    expect(await readFile(result.path!)).not.toHaveLength(0)
  })
  it('rejects unsupported content before creating any file', async () => {
    const { dir, host } = await setup()
    const result = await createGeneratedDocument(
      { type: 'hwpx', title: 'T', content: '<iframe src="file:///private"/>' },
      host,
    )
    expect(result.ok).toBe(false)
    expect(await readdir(dir)).toEqual([])
    expect(host.reveal).not.toHaveBeenCalled()
  })
})
