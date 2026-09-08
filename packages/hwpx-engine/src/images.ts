import type { ImageRun } from './model'
import { HWPX_LIMITS } from './model'
import { validatePngChunks } from './png-integrity'

function dimensions(bytes: Buffer, mime: ImageRun['mime']): [number, number] {
  if (mime === 'image/png') {
    if (
      bytes.length < 45 ||
      bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
      bytes.readUInt32BE(8) !== 13 ||
      bytes.toString('ascii', 12, 16) !== 'IHDR' ||
      bytes.toString('ascii', bytes.length - 8, bytes.length - 4) !== 'IEND'
    ) {
      throw new Error('Invalid embedded PNG image.')
    }
    validatePngChunks(bytes)
    return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)]
  }
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) {
    throw new Error('Invalid embedded JPEG image.')
  }
  let offset = 2
  while (offset + 4 <= bytes.length) {
    if (bytes[offset++] !== 0xff) break
    while (bytes[offset] === 0xff) offset++
    const marker = bytes[offset++]
    if (marker === 0xda || marker === 0xd9) break
    if (marker === 0x01 || (marker !== undefined && marker >= 0xd0 && marker <= 0xd7)) continue
    if (offset + 2 > bytes.length) break
    const length = bytes.readUInt16BE(offset)
    if (length < 2 || offset + length > bytes.length) break
    if (
      marker !== undefined &&
      [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
        marker,
      )
    ) {
      if (length < 8) break
      return [bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3)]
    }
    offset += length
  }
  throw new Error('JPEG dimensions could not be read.')
}

/** No URLs, local paths, SVG, or active content; decoding is bounded before allocation. */
export function embeddedImage(src: string, alt: string, width?: string, height?: string): ImageRun {
  const match = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/]+={0,2})$/.exec(src)
  if (!match || match[2]!.length > Math.ceil(HWPX_LIMITS.imageBytes / 3) * 4) {
    throw new Error(
      'HWPX images must be bounded base64 PNG/JPEG data URIs; external URLs are not fetched.',
    )
  }
  const bytes = Buffer.from(match[2]!, 'base64')
  if (bytes.toString('base64') !== match[2] || bytes.length > HWPX_LIMITS.imageBytes) {
    throw new Error('Invalid or oversized image encoding.')
  }
  const mime = match[1] as ImageRun['mime']
  const [naturalWidth, naturalHeight] = dimensions(bytes, mime)
  if (
    !naturalWidth ||
    !naturalHeight ||
    naturalWidth > 10_000 ||
    naturalHeight > 10_000 ||
    naturalWidth * naturalHeight > 40_000_000
  ) {
    throw new Error('Embedded image dimensions exceed the supported limit.')
  }
  const dimension = (value: string | undefined): number | undefined => {
    if (value === undefined) return undefined
    if (!/^\d+(?:\.\d+)?(?:px)?$/.test(value))
      throw new Error('Image dimensions must be positive pixels.')
    const n = Number.parseFloat(value)
    if (n <= 0 || n > 10_000) throw new Error('Image dimensions are out of range.')
    return n
  }
  const w = dimension(width),
    h = dimension(height)
  return {
    kind: 'image',
    bytes,
    mime,
    alt: alt.slice(0, 1000),
    widthPx: w ?? (h ? (h * naturalWidth) / naturalHeight : naturalWidth),
    heightPx: h ?? (w ? (w * naturalHeight) / naturalWidth : naturalHeight),
  }
}
