import { describe, expect, it } from 'vitest'
import { pngCrc32, validatePngChunks } from '../src/png-integrity'
import { embeddedImage } from '../src/images'

const good = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=',
  'base64',
)
const oldInvalidFixture =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aNogAAAAASUVORK5CYII='

describe('independent PNG integrity gate', () => {
  it('matches the standard CRC32 check vector', () => {
    expect(pngCrc32(Buffer.from('123456789'))).toBe(0xcbf43926)
    expect(pngCrc32(new Uint8Array())).toBe(0)
  })

  it('accepts a complete known-good RGBA PNG', () => {
    expect(() => validatePngChunks(good)).not.toThrow()
    expect(embeddedImage(`data:image/png;base64,${good.toString('base64')}`, 'pixel').widthPx).toBe(
      1,
    )
  })

  it('rejects the corrupt IDAT previously hidden by signature/dimension-only checks', () => {
    expect(() =>
      embeddedImage(`data:image/png;base64,${oldInvalidFixture}`, 'bad fixture'),
    ).toThrow(/checksum/)
  })

  it('rejects payload corruption despite an intact header and IEND', () => {
    const broken = Buffer.from(good)
    broken[43] = broken[43]! ^ 1
    expect(() => validatePngChunks(broken)).toThrow(/checksum/)
  })

  it('rejects truncated or overflowing chunks and trailing bytes', () => {
    expect(() => validatePngChunks(good.subarray(0, good.length - 1))).toThrow(/incomplete/)
    const overflow = Buffer.from(good)
    overflow.writeUInt32BE(0xffffffff, 33)
    expect(() => validatePngChunks(overflow)).toThrow(/Truncated/)
    expect(() => validatePngChunks(Buffer.concat([good, Buffer.from([0])]))).toThrow(/end marker/)
  })
})
