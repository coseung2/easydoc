import { test, expect } from '@playwright/test'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { inspectGeneratedHwpx } from '../packages/hwpx-engine/src/index'
import { closeAndSaveVideo, launchShell, screenshotPath, waitForPageWithUrl } from './helpers'
import type { GeneratedDocumentResult } from '../packages/agent-core/src/generated-document'

/** Real built preload/main/renderer paths; no model calls or user profiles are used. */
test.describe('local skills and experimental HWPX export', () => {
  test('selects an installed skill and safely writes an export without an editor tab', async () => {
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
      await launched.page.locator('.quick-card').first().click()
      const docs = await waitForPageWithUrl(launched.app, 'docs/out')
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
      expect(first.opened).toBe(false)
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
      await expect(launched.page.locator('.tab-bar .tab-item:not(.tab-home)')).toHaveCount(1)
    } finally {
      await closeAndSaveVideo(launched, 'skills-hwpx')
      await rm(profile, { recursive: true, force: true })
    }
  })
})
