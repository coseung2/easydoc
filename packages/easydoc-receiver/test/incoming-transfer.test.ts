import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs, { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { IncomingTransfer, safeFilename } from '../src/incoming-transfer.ts'
import type { TransferStartMessage } from '@easydoc/protocol'

const TRANSFER_ID = '123e4567-e89b-42d3-a456-426614174000'
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const startFor = (name: string, bytes: Uint8Array, chunkSize = 4): TransferStartMessage => ({
  type: 'transfer:start',
  transferId: TRANSFER_ID,
  destinationDeviceId: 'school-pc',
  name,
  size: bytes.byteLength,
  mime: 'application/pdf',
  sha256: sha256(bytes),
  chunkSize,
})

async function withTempDir(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'easydoc-'))
  try {
    await run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('streams Korean-named files to .part and atomically finalizes after checksum', () =>
  withTempDir(async (dir) => {
    const bytes = new TextEncoder().encode('hello document')
    const start = startFor('학급교육과정.pdf', bytes, 5)
    const receiver = await IncomingTransfer.create(start, dir, async () => 1_000_000)
    assert.equal(receiver.resumeFromChunk, 0)
    await receiver.writeChunk(0, bytes.subarray(0, 5))
    await receiver.writeChunk(1, bytes.subarray(5, 10))
    const done = await receiver.writeChunk(2, bytes.subarray(10))
    assert.equal(done.complete, true)
    assert.equal(path.basename(done.finalPath!), '학급교육과정.pdf')
    assert.deepEqual(await readFile(done.finalPath!), Buffer.from(bytes))
  }))

test('resume survives explicit interruption and duplicate chunks are idempotent', () =>
  withTempDir(async (dir) => {
    const bytes = new TextEncoder().encode('abcdefgh')
    const start = startFor('scan.pdf', bytes, 4)
    const first = await IncomingTransfer.create(start, dir, async () => 1_000_000)
    await first.writeChunk(0, bytes.subarray(0, 4))
    await first.interrupt()
    await assert.rejects(() => first.writeChunk(1, bytes.subarray(4)), /transfer_interrupted/)

    const resumed = await IncomingTransfer.resume(TRANSFER_ID, dir)
    assert.equal(resumed.resumeFromChunk, 1)
    const duplicate = await resumed.writeChunk(0, bytes.subarray(0, 4))
    assert.equal(duplicate.receivedThroughChunk, 0)
    const done = await resumed.writeChunk(1, bytes.subarray(4))
    assert.equal(done.complete, true)
  }))

test('filename collisions use numbered copies', () =>
  withTempDir(async (dir) => {
    await writeFile(path.join(dir, 'scan.pdf'), 'existing')
    const bytes = new TextEncoder().encode('next')
    const receiver = await IncomingTransfer.create(
      startFor('scan.pdf', bytes),
      dir,
      async () => 1_000_000,
    )
    const done = await receiver.writeChunk(0, bytes)
    assert.equal(path.basename(done.finalPath!), 'scan (1).pdf')
    assert.equal(await readFile(path.join(dir, 'scan.pdf'), 'utf8'), 'existing')
  }))

test('transfers with the same filename reserve separate partial files', () =>
  withTempDir(async (dir) => {
    const firstBytes = new TextEncoder().encode('first')
    const secondBytes = new TextEncoder().encode('second')
    const first = await IncomingTransfer.create(
      startFor('scan.pdf', firstBytes, firstBytes.length),
      dir,
      async () => 1_000_000,
    )
    let second: IncomingTransfer | undefined
    try {
      second = await IncomingTransfer.create(
        {
          ...startFor('scan.pdf', secondBytes, secondBytes.length),
          transferId: '123e4567-e89b-42d3-a456-426614174001',
        },
        dir,
        async () => 1_000_000,
      )
      assert.notEqual(first.partPath, second.partPath)
      const [firstDone, secondDone] = await Promise.all([
        first.writeChunk(0, firstBytes),
        second.writeChunk(0, secondBytes),
      ])
      assert.notEqual(firstDone.finalPath, secondDone.finalPath)
      assert.deepEqual(await readFile(firstDone.finalPath!), Buffer.from(firstBytes))
      assert.deepEqual(await readFile(secondDone.finalPath!), Buffer.from(secondBytes))
    } finally {
      await first.cancel()
      await second?.cancel()
    }
  }))

test('finalization preserves files created after the transfer started', () =>
  withTempDir(async (dir) => {
    const bytes = new TextEncoder().encode('received')
    const receiver = await IncomingTransfer.create(
      startFor('scan.pdf', bytes, bytes.length),
      dir,
      async () => 1_000_000,
    )
    await writeFile(path.join(dir, 'scan.pdf'), 'created while receiving')
    await writeFile(path.join(dir, 'scan (1).pdf'), 'another existing document')

    const done = await receiver.writeChunk(0, bytes)
    assert.equal(path.basename(done.finalPath!), 'scan (2).pdf')
    assert.deepEqual(await readFile(done.finalPath!), Buffer.from(bytes))
    assert.equal(await readFile(path.join(dir, 'scan.pdf'), 'utf8'), 'created while receiving')
    assert.equal(
      await readFile(path.join(dir, 'scan (1).pdf'), 'utf8'),
      'another existing document',
    )
    await assert.rejects(() => readFile(receiver.partPath), { code: 'ENOENT' })
    await assert.rejects(() => readFile(receiver.metadataPath), { code: 'ENOENT' })
  }))

test('an existing partial file is preserved when reserving a destination', () =>
  withTempDir(async (dir) => {
    await writeFile(path.join(dir, 'scan.pdf.part'), 'interrupted transfer')
    const bytes = new TextEncoder().encode('received')
    const receiver = await IncomingTransfer.create(
      startFor('scan.pdf', bytes, bytes.length),
      dir,
      async () => 1_000_000,
    )
    const done = await receiver.writeChunk(0, bytes)
    assert.equal(path.basename(done.finalPath!), 'scan (1).pdf')
    assert.equal(await readFile(path.join(dir, 'scan.pdf.part'), 'utf8'), 'interrupted transfer')
  }))

for (const cleanupTarget of ['partPath', 'metadataPath'] as const) {
  test(`published transfers complete even when ${cleanupTarget} cleanup fails`, (t) =>
    withTempDir(async (dir) => {
      const bytes = new TextEncoder().encode('received')
      const receiver = await IncomingTransfer.create(
        startFor('scan.pdf', bytes, bytes.length),
        dir,
        async () => 1_000_000,
      )
      const originalRm = fs.rm
      const removedPaths: unknown[] = []
      t.mock.method(fs, 'rm', async (...args: Parameters<typeof fs.rm>) => {
        removedPaths.push(args[0])
        if (args[0] === receiver[cleanupTarget]) {
          throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
        }
        return originalRm(...args)
      })
      syncBuiltinESMExports()
      try {
        const done = await receiver.writeChunk(0, bytes)
        assert.equal(done.complete, true)
        assert.equal(done.bytesWritten, bytes.length)
        assert.equal(done.receivedThroughChunk, 0)
        assert.deepEqual(await readFile(done.finalPath!), Buffer.from(bytes))
        assert.ok(removedPaths.includes(receiver.partPath))
        assert.ok(removedPaths.includes(receiver.metadataPath))
        assert.ok((await readFile(receiver[cleanupTarget])).length > 0)
        const cleanedPath = cleanupTarget === 'partPath' ? receiver.metadataPath : receiver.partPath
        await assert.rejects(() => readFile(cleanedPath), { code: 'ENOENT' })
      } finally {
        t.mock.restoreAll()
        syncBuiltinESMExports()
      }
    }))
}

test('checksum mismatch leaves the partial file unexposed', () =>
  withTempDir(async (dir) => {
    const bytes = new TextEncoder().encode('data')
    const start = { ...startFor('bad.pdf', bytes), sha256: '0'.repeat(64) }
    const receiver = await IncomingTransfer.create(start, dir, async () => 1_000_000)
    await assert.rejects(() => receiver.writeChunk(0, bytes), /checksum_mismatch/)
    await assert.rejects(() => readFile(path.join(dir, 'bad.pdf')))
    assert.deepEqual(await readFile(path.join(dir, 'bad.pdf.part')), Buffer.from(bytes))
  }))

test('fails before transfer when free space is insufficient', () =>
  withTempDir(async (dir) => {
    const bytes = new Uint8Array(10)
    await assert.rejects(
      () => IncomingTransfer.create(startFor('big.pdf', bytes, 10), dir, async () => 9),
      /insufficient_space/,
    )
  }))

test('rejects Windows-unsafe names instead of normalizing path traversal or reserved devices', () => {
  for (const name of [
    '../scan.pdf',
    '..\\scan.pdf',
    'bad:name.pdf',
    'bad?.pdf',
    'CON.pdf',
    'LPT1.txt',
    '.',
    '..',
  ]) {
    assert.throws(() => safeFilename(name), /invalid_filename/, name)
  }
  assert.equal(safeFilename(' 보고서.pdf. '), '보고서.pdf')
})
