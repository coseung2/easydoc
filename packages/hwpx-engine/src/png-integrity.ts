/** PNG chunk integrity, independent of SDK serialization and image dimensions. */
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
  return crc >>> 0
})

export function pngCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** This verifies chunk boundaries/CRCs, not pixel decoding or Hancom rendering. */
export function validatePngChunks(bytes: Uint8Array): void {
  if (bytes.length < 45) throw new Error('Invalid embedded PNG image.')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 8
  let count = 0
  let dataSeen = false
  let ended = false
  while (offset + 12 <= bytes.length) {
    if (++count > 10000) throw new Error('PNG chunk limit exceeded.')
    const size = view.getUint32(offset)
    const end = offset + 12 + size
    if (end > bytes.length) throw new Error('Truncated PNG chunk.')
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8))
    if (!/^[A-Za-z]{4}$/.test(type)) throw new Error('Invalid PNG chunk type.')
    if (count === 1 && (type !== 'IHDR' || size !== 13))
      throw new Error('PNG must start with IHDR.')
    if (count > 1 && type === 'IHDR') throw new Error('Duplicate PNG header.')
    const actual = pngCrc32(bytes.subarray(offset + 4, offset + 8 + size))
    if (actual !== view.getUint32(offset + 8 + size))
      throw new Error(`PNG ${type} checksum mismatch.`)
    if (type === 'IDAT') dataSeen = true
    if (type === 'IEND') {
      if (size !== 0 || end !== bytes.length || !dataSeen)
        throw new Error('Invalid PNG end marker.')
      ended = true
      break
    }
    offset = end
  }
  if (!ended) throw new Error('PNG image is incomplete.')
}
