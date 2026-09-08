import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EncryptedOAuthTokenStore } from '../src/main/ai-oauth-store'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'genoffice-oauth-store-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const tokens = {
  accessToken: 'test-access',
  refreshToken: 'test-refresh',
  expiresAt: 123456,
  accountId: 'test-account',
}

function fixture(available = true) {
  const file = join(root, 'oauth', 'chatgpt.json')
  const ciphertexts = new Map<string, string>()
  const protector = {
    available: vi.fn(() => available),
    encrypt: vi.fn((text: string) => {
      const ciphertext = `opaque-${ciphertexts.size}`
      ciphertexts.set(ciphertext, text)
      return ciphertext
    }),
    decrypt: vi.fn((text: string) => {
      const value = ciphertexts.get(text)
      if (!value) throw new Error('bad cipher')
      return value
    }),
  }
  return { file, protector, store: new EncryptedOAuthTokenStore(file, protector) }
}

describe('encrypted OAuth persistence', () => {
  it('writes only ciphertext and restores credentials through the protector', async () => {
    const { store, file, protector } = fixture()
    expect(await store.load()).toBeNull()
    await store.save(tokens)
    const stored = await readFile(file, 'utf8')
    expect(stored).not.toMatch(/test-access|test-refresh|test-account/)
    expect(JSON.parse(stored)).toEqual({ version: 1, ciphertext: 'opaque-0' })
    expect(await store.load()).toEqual(tokens)
    expect(protector.decrypt).toHaveBeenCalledWith('opaque-0')
    await store.clear()
    expect(await store.load()).toBeNull()
  })

  it('fails closed without secure storage and does not replace a prior credential on failure', async () => {
    const { store, file, protector } = fixture()
    await store.save(tokens)
    const prior = await readFile(file, 'utf8')
    protector.available.mockReturnValue(false)
    await expect(store.save(tokens)).rejects.toThrow('oauth_secure_storage_unavailable')
    await expect(store.load()).rejects.toThrow('oauth_secure_storage_unavailable')
    expect(await readFile(file, 'utf8')).toBe(prior)
    await store.clear()
    expect(await store.load()).toBeNull()
  })

  it('does not expose corrupt storage contents or decrypt errors', async () => {
    const { store, file } = fixture()
    await store.save(tokens)
    await writeFile(file, JSON.stringify({ version: 1, ciphertext: 'test-secret-corrupt' }))
    await expect(store.load()).rejects.toThrow('oauth_storage_error')
  })
})
