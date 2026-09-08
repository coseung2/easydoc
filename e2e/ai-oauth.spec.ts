import { test, expect } from '@playwright/test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchShell, closeAndSaveVideo, screenshotPath } from './helpers'

test('ChatGPT OAuth can be selected, saved, and managed from AI settings', async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'genoffice-oauth-e2e-'))
  await writeFile(
    join(userDataDir, 'app-settings.json'),
    JSON.stringify({ onboardingSeen: true, starPrompt: { resolved: true } }),
  )
  const launched = await launchShell({ userDataDir, videoDir: 'ai-oauth', lang: 'ko' })
  const { app, page } = launched
  try {
    // Exercise the real preload/settings path without opening a real account login.
    await app.evaluate(({ ipcMain }) => {
      let state = 'disconnected'
      for (const channel of [
        'ai:oauth-status',
        'ai:oauth-start',
        'ai:oauth-cancel',
        'ai:oauth-disconnect',
        'ai:oauth-open',
      ]) {
        ipcMain.removeHandler(channel)
      }
      ipcMain.handle('ai:oauth-status', () => ({ state }))
      ipcMain.handle('ai:oauth-start', () => {
        state = 'pending'
        return { state }
      })
      ipcMain.handle('ai:oauth-cancel', () => {
        state = 'disconnected'
      })
      ipcMain.handle('ai:oauth-disconnect', () => {
        state = 'disconnected'
      })
      ipcMain.handle('ai:oauth-open', () => {})
    })
    await page.locator('.account-btn').click()
    await page.locator('.set-nav-item').nth(1).click()
    await page.getByRole('button', { name: '제공업체', exact: true }).click()
    await page.getByRole('option', { name: 'OpenAI', exact: true }).click()
    await page.getByRole('button', { name: '인증 방식', exact: true }).click()
    await page.getByRole('option', { name: 'ChatGPT (OAuth)', exact: true }).click()
    await expect(page.locator('#set-ai-key')).toHaveCount(0)
    await expect(page.locator('#set-ai-base-url')).toHaveCount(0)
    await expect(page.locator('#set-ai-max-tokens')).toHaveCount(0)
    const panel = page.getByRole('region', { name: 'ChatGPT OAuth' })
    await panel.getByRole('button', { name: 'ChatGPT · 로그인' }).click()
    await expect(panel).toContainText('브라우저에서 로그인을 완료')
    await panel.getByRole('button', { name: '취소', exact: true }).click()
    await expect(panel).toContainText('ChatGPT에 연결되지 않음')
    await page.locator('.set-pane-footer .primary').click()
    const stored = await page.evaluate(async () => {
      const settings = await (window as any).aiOffice.getAiSettings()
      return { provider: settings.provider, config: settings.providers.openai }
    })
    expect(stored.provider).toBe('openai')
    expect(stored.config).toMatchObject({ authMode: 'oauth', apiKey: '' })
    expect(stored.config.baseUrl).toBeUndefined()
    await page.screenshot({ path: screenshotPath('chatgpt-oauth-settings') })
  } finally {
    await closeAndSaveVideo(launched, 'ai-oauth')
  }
})
