import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { EasyDocStore, type SecretProtector } from '../src/storage.ts'

class TestProtector implements SecretProtector {
  private readonly available: boolean
  constructor(available = true) {
    this.available = available
  }
  isAvailable(): boolean {
    return this.available
  }
  protect(value: string): string {
    return Buffer.from(`protected:${value}`, 'utf8').toString('base64')
  }
  unprotect(value: string): string {
    const decoded = Buffer.from(value, 'base64').toString('utf8')
    if (!decoded.startsWith('protected:')) throw new Error('invalid_secret')
    return decoded.slice('protected:'.length)
  }
}

async function withTempDir(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'easydoc-store-'))
  try {
    await run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const defaults = (receiveDir: string) => ({
  relayBaseUrl: 'https://relay.example',
  receiveDir,
  desktopAlias: 'GenOffice PC',
  autoOpen: true,
})

test('persists pairings while keeping private material protected at rest', () =>
  withTempDir(async (directory) => {
    const store = new EasyDocStore(
      directory,
      defaults(path.join(directory, 'received')),
      new TestProtector(),
    )
    await store.load()
    await store.addPairing(
      {
        version: 1,
        deviceId: 'desktop-1',
        roomId: 'room-1',
        publicKey: 'public-key',
        desktopAlias: 'GenOffice PC',
      },
      { devicePrivateKey: 'PRIVATE-KEY-MATERIAL', bootstrapSecret: 'BOOTSTRAP-SECRET' },
    )

    assert.equal(store.getDevicePrivateKey('desktop-1'), 'PRIVATE-KEY-MATERIAL')
    assert.equal(store.getBootstrapSecret('room-1'), 'BOOTSTRAP-SECRET')
    const secretsOnDisk = await readFile(path.join(directory, 'secrets.json'), 'utf8')
    assert.equal(secretsOnDisk.includes('PRIVATE-KEY-MATERIAL'), false)
    assert.equal(secretsOnDisk.includes('BOOTSTRAP-SECRET'), false)

    const reopened = new EasyDocStore(
      directory,
      defaults(path.join(directory, 'fallback')),
      new TestProtector(),
    )
    await reopened.load()
    assert.equal(reopened.listPairings()[0]?.roomId, 'room-1')
    assert.equal(reopened.getDevicePrivateKey('desktop-1'), 'PRIVATE-KEY-MATERIAL')
  }))

test('fails closed when secure storage is unavailable', () =>
  withTempDir(async (directory) => {
    const store = new EasyDocStore(directory, defaults(directory), new TestProtector(false))
    await store.load()
    await assert.rejects(
      () =>
        store.addPairing(
          {
            version: 1,
            deviceId: 'desktop-1',
            roomId: 'room-1',
            publicKey: 'public-key',
            desktopAlias: 'GenOffice PC',
          },
          { devicePrivateKey: 'private', bootstrapSecret: 'bootstrap' },
        ),
      /secure_storage_unavailable/,
    )
  }))
