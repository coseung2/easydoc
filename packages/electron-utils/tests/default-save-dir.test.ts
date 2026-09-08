import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  configuredDefaultSaveDir,
  readDefaultSaveDirSetting,
  resolveDefaultSaveDir,
} from '../src/index'

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  return { ...fs, accessSync: vi.fn(fs.accessSync) }
})

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'genoffice-save-dir-'))
})

afterEach(() => {
  vi.mocked(accessSync).mockReset()
  rmSync(root, { recursive: true, force: true })
})

describe('readDefaultSaveDirSetting', () => {
  const settingsPath = () => join(root, 'app-settings.json')

  it('returns the configured absolute path', () => {
    writeFileSync(settingsPath(), JSON.stringify({ defaultSaveDir: '/some/where' }))
    expect(readDefaultSaveDirSetting(settingsPath())).toBe('/some/where')
  })

  it('returns null when the file is missing, corrupt, or the key is absent', () => {
    expect(readDefaultSaveDirSetting(settingsPath())).toBeNull()
    writeFileSync(settingsPath(), 'not json')
    expect(readDefaultSaveDirSetting(settingsPath())).toBeNull()
    writeFileSync(settingsPath(), JSON.stringify({ language: 'en' }))
    expect(readDefaultSaveDirSetting(settingsPath())).toBeNull()
  })

  it('rejects non-string and relative values', () => {
    writeFileSync(settingsPath(), JSON.stringify({ defaultSaveDir: 42 }))
    expect(readDefaultSaveDirSetting(settingsPath())).toBeNull()
    writeFileSync(settingsPath(), JSON.stringify({ defaultSaveDir: 'relative/dir' }))
    expect(readDefaultSaveDirSetting(settingsPath())).toBeNull()
  })
})

describe('resolveDefaultSaveDir', () => {
  it('uses the configured folder when it is usable (creating it on demand)', () => {
    const configured = join(root, 'custom', 'nested')
    const resolved = resolveDefaultSaveDir(configured, join(root, 'fallback'))
    expect(resolved).toBe(configured)
    expect(existsSync(configured)).toBe(true)
  })

  it('creates and returns the fallback when nothing is configured', () => {
    const fallback = join(root, 'Documents', 'GenOffice')
    expect(resolveDefaultSaveDir(null, fallback)).toBe(fallback)
    expect(existsSync(fallback)).toBe(true)
  })

  it('degrades to the fallback when the configured folder is not writable', () => {
    const readOnly = join(root, 'read-only')
    mkdirSync(readOnly)
    // chmod does not revoke Windows write access and can be bypassed by privileged users.
    vi.mocked(accessSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
    })
    const fallback = join(root, 'fallback')
    expect(resolveDefaultSaveDir(readOnly, fallback)).toBe(fallback)
    expect(accessSync).toHaveBeenCalledExactlyOnceWith(readOnly, constants.W_OK)
    expect(existsSync(fallback)).toBe(true)
  })
})

describe('configuredDefaultSaveDir', () => {
  it('reads the setting from userData/app-settings.json and honors it', () => {
    const userData = join(root, 'userData')
    const documents = join(root, 'Documents')
    mkdirSync(userData, { recursive: true })
    const custom = join(root, 'my-files')
    writeFileSync(join(userData, 'app-settings.json'), JSON.stringify({ defaultSaveDir: custom }))
    const app = {
      getPath: (name: 'userData' | 'documents') => (name === 'userData' ? userData : documents),
    }
    expect(configuredDefaultSaveDir(app)).toBe(custom)
  })

  it('falls back to <Documents>/GenOffice without a setting', () => {
    const userData = join(root, 'userData')
    const documents = join(root, 'Documents')
    mkdirSync(userData, { recursive: true })
    const app = {
      getPath: (name: 'userData' | 'documents') => (name === 'userData' ? userData : documents),
    }
    expect(configuredDefaultSaveDir(app)).toBe(join(documents, 'GenOffice'))
    expect(existsSync(join(documents, 'GenOffice'))).toBe(true)
  })
})
