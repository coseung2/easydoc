import JSZip from 'jszip'
import { XMLParser, XMLValidator } from 'fast-xml-parser'

/** Read section text in document order, including paragraphs inside tables. */
export async function hwpxToText(bytes: Uint8Array): Promise<string> {
  const zip = await JSZip.loadAsync(bytes)
  const sections = Object.keys(zip.files)
    .filter((name) => /^Contents\/section\d+\.xml$/i.test(name))
    .sort((a, b) => Number(a.match(/section(\d+)/i)?.[1]) - Number(b.match(/section(\d+)/i)?.[1]))
  if (!sections.length) throw new Error('Invalid HWPX: no document sections')
  if (sections.length > 1000) throw new Error('HWPX has too many sections')
  const parser = new XMLParser({
    preserveOrder: true,
    ignoreAttributes: true,
    removeNSPrefix: true,
    trimValues: false,
    parseTagValue: false,
  })
  let total = 0
  const output: string[] = []
  for (const name of sections) {
    const xml = await zip.file(name)!.async('string')
    total += xml.length
    if (total > 32 * 1024 * 1024) throw new Error('HWPX expanded text exceeds the extraction limit')
    if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true)
      throw new Error('Invalid HWPX section XML')
    const text: string[] = []
    const walk = (nodes: Array<Record<string, unknown>>, inText = false) => {
      for (const node of nodes)
        for (const [tag, value] of Object.entries(node)) {
          if (tag === '#text' && inText) text.push(String(value))
          else if (tag === 'lineBreak') text.push('\n')
          else if (tag === 'tab') text.push('\t')
          else if (Array.isArray(value)) {
            walk(value, inText || tag === 't')
            if (tag === 'p') text.push('\n')
            if (tag === 'tc') text.push('\t')
          }
        }
    }
    walk(parser.parse(xml))
    output.push(text.join('').trim())
  }
  return output.join('\n\n')
}
