import { strFromU8, unzipSync } from 'fflate'
import { SaxesParser } from 'saxes'

export interface XmlElement {
  name: string
  attributes: Record<string, string>
}

/** Structural validator only. It neither applies the OWPML XSD nor launches Hancom. */
export function inspectGeneratedHwpx(bytes: Uint8Array): {
  files: Record<string, Uint8Array>
  xml: Record<string, XmlElement[]>
} {
  if (bytes.length < 38 || bytes.length > 32_000_000) throw new Error('Invalid HWPX archive size.')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (
    view.getUint32(0, true) !== 0x04034b50 ||
    view.getUint16(8, true) !== 0 ||
    strFromU8(bytes.subarray(30, 30 + view.getUint16(26, true))) !== 'mimetype'
  ) {
    throw new Error('HWPX must start with an uncompressed mimetype entry.')
  }
  let expanded = 0,
    entries = 0
  const files = unzipSync(bytes, {
    filter: (file) => {
      if (
        ++entries > 100 ||
        (expanded += file.originalSize) > 32_000_000 ||
        file.originalSize > 16_000_000 ||
        file.name.startsWith('/') ||
        file.name.includes('\\') ||
        file.name.split('/').includes('..')
      ) {
        throw new Error('HWPX archive entries exceed the structural limits.')
      }
      return true
    },
  })
  for (const required of [
    'mimetype',
    'version.xml',
    'settings.xml',
    'META-INF/container.xml',
    'META-INF/manifest.xml',
    'Contents/content.hpf',
    'Contents/header.xml',
    'Contents/section0.xml',
  ]) {
    if (!files[required]) throw new Error(`Missing HWPX entry: ${required}`)
  }
  if (strFromU8(files.mimetype!) !== 'application/hwp+zip')
    throw new Error('Invalid HWPX MIME type.')
  const xml: Record<string, XmlElement[]> = {}
  for (const [path, file] of Object.entries(files)) {
    if (!/\.(xml|hpf)$/.test(path)) continue
    const source = strFromU8(file)
    if (/<!DOCTYPE|<!ENTITY/i.test(source))
      throw new Error('DTD/entity declarations are not allowed.')
    const elements: XmlElement[] = []
    const parser = new SaxesParser({ xmlns: true })
    parser.on('error', (error) => {
      throw error
    })
    parser.on('opentag', (tag) => {
      const attributes: Record<string, string> = {}
      for (const a of Object.values(tag.attributes)) attributes[a.name] = a.value
      elements.push({ name: tag.name, attributes })
    })
    parser.write(source).close()
    xml[path] = elements
  }
  const header = xml['Contents/header.xml']!
  const section = xml['Contents/section0.xml']!
  const ids = (name: string) =>
    new Set(header.filter((e) => e.name === name).map((e) => e.attributes.id!))
  const charIds = ids('hh:charPr'),
    paraIds = ids('hh:paraPr'),
    styleIds = ids('hh:style'),
    borderIds = ids('hh:borderFill')
  for (const [name, set] of [
    ['hh:charPr', charIds],
    ['hh:paraPr', paraIds],
    ['hh:style', styleIds],
  ] as const) {
    if (
      !set.size ||
      header.some((e) => e.name === name && !e.attributes.id) ||
      header.filter((e) => e.name === name).length !== set.size
    )
      throw new Error(`Invalid or duplicate style ids in ${name}.`)
  }
  for (const e of [...header, ...section]) {
    for (const [attribute, valid] of [
      ['charPrIDRef', charIds],
      ['paraPrIDRef', paraIds],
      ['styleIDRef', styleIds],
      ['nextStyleIDRef', styleIds],
      ['borderFillIDRef', borderIds],
    ] as const) {
      const value = e.attributes[attribute]
      if (value !== undefined && !valid.has(value))
        throw new Error(`Dangling HWPX ${attribute}: ${value}`)
    }
  }
  const manifest = xml['Contents/content.hpf']!.filter((e) => e.name === 'opf:item')
  const itemIds = new Set(manifest.map((e) => e.attributes.id))
  for (const item of manifest)
    if (!files[item.attributes.href!])
      throw new Error(`Missing manifest resource: ${item.attributes.href}`)
  for (const e of section) {
    if (e.attributes.binaryItemIDRef && !itemIds.has(e.attributes.binaryItemIDRef))
      throw new Error('Missing embedded image reference.')
  }
  const page = section.find((e) => e.name === 'hp:pagePr')
  if (!page || !(Number(page.attributes.width) > 0) || !(Number(page.attributes.height) > 0))
    throw new Error('Missing HWPX page dimensions.')
  if (!section.some((e) => e.name === 'hp:p'))
    throw new Error('HWPX must contain at least one paragraph.')
  return { files, xml }
}
