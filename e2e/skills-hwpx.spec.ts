import { test, expect } from '@playwright/test'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import type { ElectronApplication, Page } from '@playwright/test'
import { inspectGeneratedHwpx } from '../packages/hwpx-engine/src/index'
import { closeAndSaveVideo, launchShell, screenshotPath, waitForPageWithUrl } from './helpers'
import type { GeneratedDocumentResult } from '../packages/agent-core/src/generated-document'

/**
 * Controlled PDF for the preview boundary: a real, valid document, so pdf.js
 * renders it exactly as it renders Hancom's output. Standard fonts cannot
 * encode Hangul, so the fixture text is ASCII.
 */
async function fixturePdfBase64(pages: number): Promise<string> {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  for (let index = 1; index <= pages; index++) {
    const page = pdf.addPage([595, 842])
    page.drawText(`Hancom preview fixture page ${index}`, { x: 64, y: 720, size: 18, font })
  }
  return Buffer.from(await pdf.save()).toString('base64')
}

/**
 * Replace the `docs:preview-hwpx` handler with a controlled one. The live
 * Hancom leg needs an installed Hancom Office and answers its per-file security
 * prompt by hand, so no unattended run may depend on it.
 *
 * What stays real: the preload bridge, the renderer's request scheduling and
 * failure latch, the pdf.js render of a valid PDF, and the editor's own
 * edit/save path. What this does NOT exercise, because it replaces the handler
 * that performs it, is the main process resolving the path from the sending tab
 * (covered separately in apps/docs/tests/hwpx-preview-ipc.test.ts).
 */
async function stubPreviewIpc(app: ElectronApplication, pdfBase64: string): Promise<void> {
  await app.evaluate(({ ipcMain }, base64: string) => {
    const state = { mode: 'ok' as 'ok' | 'fail', calls: 0, forced: 0 }
    ;(globalThis as unknown as { __hwpxPreviewStub: typeof state }).__hwpxPreviewStub = state
    ipcMain.removeHandler('docs:preview-hwpx')
    ipcMain.handle('docs:preview-hwpx', (_event, force: boolean) => {
      state.calls++
      if (force) state.forced++
      if (state.mode === 'fail')
        return {
          ok: false,
          error: 'Hancom may be waiting for a confirmation dialog on this machine.',
        }
      return {
        ok: true,
        bytes: new Uint8Array(Buffer.from(base64, 'base64')),
        sourceHash: `hash-${state.calls}`,
        hancomVersion: '12.0.0.3146',
        cached: false,
      }
    })
  }, pdfBase64)
}

const previewStub = (app: ElectronApplication) =>
  app.evaluate(
    () =>
      (globalThis as unknown as { __hwpxPreviewStub: { calls: number; forced: number } })
        .__hwpxPreviewStub,
  )

/**
 * What the pane actually drew, read back from the canvas itself: a page of
 * Hancom output is a white sheet carrying dark glyphs, so a canvas that is
 * present and correctly sized but empty (or all background) fails here.
 */
async function firstPageInk(page: Page): Promise<{ white: number; dark: number; total: number }> {
  return page.evaluate(() => {
    const canvas = document.querySelector('canvas.hwpx-preview-page') as HTMLCanvasElement | null
    if (!canvas) return { white: 0, dark: 0, total: 0 }
    const context = canvas.getContext('2d')
    if (!context) return { white: 0, dark: 0, total: 0 }
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height)
    let white = 0
    let dark = 0
    for (let index = 0; index < data.length; index += 4) {
      const [r, g, b] = [data[index], data[index + 1], data[index + 2]]
      if (r > 245 && g > 245 && b > 245) white++
      else if (r < 200 && g < 200 && b < 200) dark++
    }
    return { white, dark, total: data.length / 4 }
  })
}

/**
 * Two frames after the last layout change nothing is mid-redraw, so a
 * screenshot taken here shows the pane a user would see rather than a
 * transient state between two renders.
 */
const settleFrames = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      }),
  )

/** The drawn page has to be on screen in the document area, not merely in the DOM. */
async function expectVisibleRenderedPage(page: Page): Promise<void> {
  const first = page.locator('canvas.hwpx-preview-page').first()
  // A page is taller than the pane, so only part of it can ever be in view.
  await expect(first).toBeInViewport({ ratio: 0.2 })
  await expect
    .poll(async () => (await firstPageInk(page)).dark, { timeout: 15_000 })
    .toBeGreaterThan(500)
  const ink = await firstPageInk(page)
  expect(ink.white / ink.total).toBeGreaterThan(0.9)
}

const setPreviewMode = (app: ElectronApplication, mode: 'ok' | 'fail') =>
  app.evaluate((_electron, next: 'ok' | 'fail') => {
    ;(globalThis as unknown as { __hwpxPreviewStub: { mode: string } }).__hwpxPreviewStub.mode =
      next
  }, mode)

/** The generated document opens in its own tab; find it by its content. */
async function waitForGeneratedTab(app: ElectronApplication, text: string): Promise<Page> {
  const deadline = Date.now() + 30_000
  for (;;) {
    for (const candidate of app.windows()) {
      const found = await candidate
        .evaluate(
          (needle) =>
            document.querySelector('.ProseMirror')?.textContent?.includes(needle) === true,
          text,
        )
        .catch(() => false)
      if (found) return candidate
    }
    if (Date.now() > deadline) throw new Error(`No editor tab containing "${text}"`)
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

/** Real built preload/main/renderer paths; no model calls or user profiles are used. */
test.describe('local skills and experimental HWPX export', () => {
  test('selects an installed skill and opens generated HWPX documents in editor tabs', async () => {
    const profile = await mkdtemp(join(tmpdir(), 'easydoc-skills-hwpx-'))
    const output = join(profile, 'exports')
    const skills = join(profile, 'agent-skills', 'official-letter')
    await mkdir(output)
    await mkdir(skills, { recursive: true })
    await writeFile(
      join(profile, 'app-settings.json'),
      JSON.stringify({
        onboardingSeen: true,
        defaultSaveDir: output,
        analyticsEnabled: false,
      }),
    )
    await writeFile(
      join(skills, 'SKILL.md'),
      [
        '---',
        'name: 공문 작성',
        'description: Formal correspondence from supplied facts',
        'apps: [docs]',
        '---',
        'Read the supplied material. Preserve names and amounts; never invent missing facts.',
      ].join('\n'),
    )
    const launched = await launchShell({
      userDataDir: profile,
      videoDir: 'skills-hwpx',
      lang: 'ko',
    })
    try {
      // Do not launch the host file manager; all actual writes still use the real main handler.
      await launched.app.evaluate(({ shell }) => {
        shell.showItemInFolder = () => undefined
      })
      // Generated HWPX opens in an editor tab, and that tab renders a preview of
      // the saved file: keep this run away from the real Hancom automation.
      await stubPreviewIpc(launched.app, await fixturePdfBase64(1))
      await launched.page.getByRole('button', { name: 'AI 한글 AI .hwpx', exact: true }).click()
      const docs = await waitForPageWithUrl(launched.app, 'docs/out')
      expect(new URL(docs.url()).searchParams.get('outputFormat')).toBe('hwpx')
      await expect(docs.getByText('한글 문서 만들기', { exact: true })).toBeVisible()
      await expect(
        docs.getByText('완성한 문서는 .hwpx 파일로 저장합니다.', { exact: false }),
      ).toBeVisible()
      const composer = docs.locator('.ai-input-box textarea')
      await expect(composer).toBeVisible()
      await composer.fill('@공문')
      const option = docs.getByRole('option').filter({ hasText: '@official-letter' })
      await expect(option).toBeVisible()
      await composer.press('Enter')
      await expect(composer).toHaveValue('@official-letter ')
      await expect(docs.getByRole('listbox')).toHaveCount(0)
      // The completion key must not send a request or start a tool run.
      await expect(composer).toBeEditable()
      await docs.screenshot({ path: screenshotPath('skills-hwpx-mention') })

      const create = (content: string) =>
        docs.evaluate(
          async ({ content }) => {
            const bridge = (
              window as unknown as {
                desktop: {
                  createDocument(request: {
                    type: 'hwpx'
                    title: string
                    content: string
                  }): Promise<GeneratedDocumentResult>
                }
              }
            ).desktop
            return bridge.createDocument({ type: 'hwpx', title: '검증용 공문', content })
          },
          { content },
        )
      const first = await create(
        '<h1>협조 요청</h1><p>금액: 1,250원</p><table><tr><th>항목</th><th>금액</th></tr><tr><td>예산</td><td>1,250원</td></tr></table>',
      )
      expect(first.ok).toBe(true)
      expect(first.opened).toBe(true)
      expect(first.verification).toBe('structural-only')
      expect(first.warnings?.join(' ')).toMatch(/Experimental HWPX/)
      expect(dirname(first.path!)).toBe(output)
      const firstBytes = await readFile(first.path!)
      expect(
        inspectGeneratedHwpx(new Uint8Array(firstBytes)).files['Contents/section0.xml'],
      ).toBeDefined()

      const second = await create('<p>두 번째 생성입니다.</p>')
      expect(second.ok).toBe(true)
      expect(second.path).not.toBe(first.path)
      expect(await readFile(first.path!)).toEqual(firstBytes)
      const failed = await create(
        '<p>외부 이미지 금지</p><img src="https://example.invalid/private.png">',
      )
      expect(failed.ok).toBe(false)
      expect(failed.path).toBeUndefined()
      expect((await readdir(output)).filter((name) => name.endsWith('.hwpx'))).toHaveLength(2)
      await expect(launched.page.locator('.tab-bar .tab-item:not(.tab-home)')).toHaveCount(3)
    } finally {
      await closeAndSaveVideo(launched, 'skills-hwpx')
      await rm(profile, { recursive: true, force: true })
    }
  })

  test('edits, saves and previews a generated HWPX in the document workspace', async () => {
    const profile = await mkdtemp(join(tmpdir(), 'easydoc-hwpx-preview-'))
    const output = join(profile, 'exports')
    await mkdir(output)
    await writeFile(
      join(profile, 'app-settings.json'),
      JSON.stringify({ onboardingSeen: true, defaultSaveDir: output, analyticsEnabled: false }),
    )
    const launched = await launchShell({
      userDataDir: profile,
      videoDir: 'hwpx-preview',
      lang: 'ko',
    })
    try {
      await launched.app.evaluate(({ shell }) => {
        shell.showItemInFolder = () => undefined
      })
      // Installed before the document exists: creating it must never reach the
      // real Hancom automation in an unattended run.
      await stubPreviewIpc(launched.app, await fixturePdfBase64(2))

      await launched.page.getByRole('button', { name: 'AI 한글 AI .hwpx', exact: true }).click()
      const host = await waitForPageWithUrl(launched.app, 'docs/out')
      const created = await host.evaluate(async () => {
        const bridge = (
          window as unknown as {
            desktop: {
              createDocument(request: {
                type: 'hwpx'
                title: string
                content: string
              }): Promise<GeneratedDocumentResult>
            }
          }
        ).desktop
        return bridge.createDocument({
          type: 'hwpx',
          title: '미리보기 검증',
          content: '<h1>협조 요청</h1><p>초안 문장입니다.</p>',
        })
      })
      expect(created.ok).toBe(true)
      expect(created.opened).toBe(true)
      const docs = await waitForGeneratedTab(launched.app, '협조 요청')

      // The generated file is on disk, so the preview renders once by itself.
      const previewTab = docs.getByRole('tab', { name: '한컴 미리 보기' })
      await expect(previewTab).toBeVisible()
      await previewTab.click()
      const pages = docs.locator('canvas.hwpx-preview-page')
      await expect(pages).toHaveCount(2)
      const firstPageBox = await pages.first().boundingBox()
      expect(firstPageBox?.width ?? 0).toBeGreaterThan(0)
      expect(firstPageBox?.height ?? 0).toBeGreaterThan(0)
      await expect(docs.locator('.hwpx-preview-status')).toContainText('12.0.0.3146')
      await expectVisibleRenderedPage(docs)
      await settleFrames(docs)
      await docs.screenshot({ path: screenshotPath('hwpx-preview-saved') })
      expect((await previewStub(launched.app)).calls).toBe(1)

      // Resizing the pane re-renders at the new width; the pages already drawn
      // stay on screen while that runs, so the pane is never captured blank.
      const collapse = docs.locator('.ai-dock .ai-header-btn').last()
      const blankFrames = docs.evaluate(
        () =>
          new Promise<number>((resolve) => {
            const host = document.querySelector('.hwpx-preview-pages') as HTMLElement
            const started = performance.now()
            let blank = 0
            const sample = () => {
              if (host.childElementCount === 0) blank++
              if (performance.now() - started < 2500) requestAnimationFrame(sample)
              else resolve(blank)
            }
            sample()
          }),
      )
      await collapse.click()
      expect(await blankFrames).toBe(0)
      await expect(pages).toHaveCount(2)
      await expectVisibleRenderedPage(docs)

      // Back to editing: the editor kept its content, and a fresh edit marks the
      // shown render as behind the document.
      await docs.getByRole('tab', { name: '편집' }).click()
      const heading = docs.locator('.ProseMirror h1').first()
      await expect(heading).toHaveText('협조 요청')
      await heading.click()
      await docs.keyboard.press('End')
      await docs.keyboard.type(' (수정)')
      await previewTab.click()
      await expect(docs.locator('.hwpx-preview-status')).toContainText('저장')
      await expect(pages).toHaveCount(2)
      expect((await previewStub(launched.app)).calls).toBe(1)

      // A successful save is what refreshes the preview.
      await docs.keyboard.press('ControlOrMeta+s')
      await expect
        .poll(async () => (await previewStub(launched.app)).calls, { timeout: 20_000 })
        .toBe(2)
      await expect(docs.locator('.hwpx-preview-status')).toContainText('12.0.0.3146')
      // The status only claims the saved render once its pages are on screen.
      await expectVisibleRenderedPage(docs)
      const savedPath = created.path as string
      const savedXml = new TextDecoder().decode(
        inspectGeneratedHwpx(new Uint8Array(await readFile(savedPath))).files[
          'Contents/section0.xml'
        ],
      )
      expect(savedXml).toContain('(수정)')

      // A failed render keeps the document editable and stops retrying on its
      // own; only the explicit refresh asks Hancom again.
      await setPreviewMode(launched.app, 'fail')
      await docs.locator('.hwpx-preview-refresh').click()
      await expect(docs.locator('.hwpx-preview-error')).toContainText('confirmation dialog')
      const afterFailure = (await previewStub(launched.app)).calls
      await docs.getByRole('tab', { name: '편집' }).click()
      // Focus is on the tab button after the switch; the caret has to be put
      // back in the document before typing.
      const editedHeading = docs.locator('.ProseMirror h1').first()
      await editedHeading.click()
      await docs.keyboard.press('End')
      await docs.keyboard.type('!')
      await docs.keyboard.press('ControlOrMeta+s')
      await expect(editedHeading).toContainText('(수정)!')
      await expect
        .poll(
          async () =>
            new TextDecoder()
              .decode(
                inspectGeneratedHwpx(new Uint8Array(await readFile(savedPath))).files[
                  'Contents/section0.xml'
                ],
              )
              .includes('(수정)!'),
          { timeout: 20_000 },
        )
        .toBe(true)
      await previewTab.click()
      // The save above must not have re-entered the blocked machine.
      expect((await previewStub(launched.app)).calls).toBe(afterFailure)

      await setPreviewMode(launched.app, 'ok')
      await docs.locator('.hwpx-preview-refresh').click()
      await expect(pages).toHaveCount(2)
      await expectVisibleRenderedPage(docs)
      expect((await previewStub(launched.app)).forced).toBeGreaterThanOrEqual(2)
    } finally {
      await closeAndSaveVideo(launched, 'hwpx-preview')
      await rm(profile, { recursive: true, force: true })
    }
  })
})
