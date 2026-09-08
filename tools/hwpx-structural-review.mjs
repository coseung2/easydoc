#!/usr/bin/env node
/** Independent package checks for generated HWPX, not a Hancom compatibility certificate. */
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const require = createRequire(new URL('../packages/hwpx-engine/package.json', import.meta.url))
const { unzipSync, strFromU8 } = require('fflate')
// ownhwpx depends on saxes; resolve from that package rather than assuming hoisting.
const sdkRequire = createRequire(require.resolve('ownhwpx'))
const { SaxesParser } = sdkRequire('saxes')

const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024
const MAX_PART_BYTES = 16 * 1024 * 1024
const MAX_TOTAL_BYTES = 32 * 1024 * 1024
const MAX_PARTS = 256
const HP = 'http://www.hancom.co.kr/hwpml/2011/paragraph'
const HH = 'http://www.hancom.co.kr/hwpml/2011/head'
const OPF = 'http://www.idpf.org/2007/opf/'

function parseXml(xml, name) {
  const roots = []
  const stack = []
  const nodes = []
  const parser = new SaxesParser({ xmlns: true })
  parser.on('doctype', () => {
    throw new Error(`${name}: DOCTYPE is not allowed`)
  })
  parser.on('error', (error) => {
    throw new Error(`${name}: ${error.message}`)
  })
  parser.on('opentag', (tag) => {
    if (nodes.length >= 100_000 || stack.length >= 128)
      throw new Error(`${name}: XML complexity limit`)
    const node = {
      local: tag.local,
      uri: tag.uri,
      attrs: Object.fromEntries(Object.values(tag.attributes).map((a) => [a.local, a.value])),
      children: [],
    }
    nodes.push(node)
    if (stack.length) stack.at(-1).children.push(node)
    else roots.push(node)
    stack.push(node)
  })
  parser.on('closetag', () => stack.pop())
  parser.write(xml).close()
  if (roots.length !== 1) throw new Error(`${name}: expected one root element`)
  return { root: roots[0], nodes }
}

/** Inspect output from any exporter; no assumptions about its internal object model. */
export function reviewHwpx(bytes) {
  const errors = []
  const fail = (message) => errors.push(message)
  const result = {
    structuralChecksPassed: false,
    hancomOpenTest: 'not-performed',
    layoutCompatibility: 'not-established',
    parts: [],
    errors,
  }
  try {
    if (
      !(bytes instanceof Uint8Array) ||
      bytes.byteLength > MAX_ARCHIVE_BYTES ||
      bytes.byteLength < 38
    ) {
      throw new Error('Archive is empty, invalid, or exceeds the input limit')
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    if (view.getUint32(0, true) !== 0x04034b50) throw new Error('Missing ZIP local header')
    const firstNameLength = view.getUint16(26, true)
    const firstName = strFromU8(bytes.subarray(30, 30 + firstNameLength))
    if (firstName !== 'mimetype' || view.getUint16(8, true) !== 0) {
      fail('The first ZIP entry must be uncompressed mimetype')
    }
    if (view.getUint16(6, true) & 1) fail('Encrypted ZIP entries are unsupported')
    let totalBytes = 0
    const names = new Set()
    const parts = unzipSync(bytes, {
      filter(part) {
        totalBytes += part.originalSize
        if (names.has(part.name)) throw new Error(`Duplicate package path: ${part.name}`)
        names.add(part.name)
        if (
          names.size > MAX_PARTS ||
          totalBytes > MAX_TOTAL_BYTES ||
          part.originalSize > MAX_PART_BYTES
        ) {
          throw new Error('Uncompressed package limit exceeded')
        }
        if (
          part.name.startsWith('/') ||
          part.name.includes('\\') ||
          part.name.split('/').some((p) => p === '..')
        ) {
          throw new Error(`Unsafe package path: ${part.name}`)
        }
        return true
      },
    })
    result.parts = Object.keys(parts)
    if (!parts.mimetype || strFromU8(parts.mimetype) !== 'application/hwp+zip')
      fail('Incorrect HWPX mimetype')
    const required = [
      'version.xml',
      'settings.xml',
      'META-INF/container.xml',
      'META-INF/manifest.xml',
      'Contents/content.hpf',
      'Contents/header.xml',
      'Contents/section0.xml',
    ]
    for (const name of required) if (!parts[name]) fail(`Missing package part: ${name}`)
    if (errors.length) return result
    const documents = new Map()
    for (const [name, data] of Object.entries(parts)) {
      if (/\.(xml|hpf)$/i.test(name))
        documents.set(name, parseXml(new TextDecoder('utf-8', { fatal: true }).decode(data), name))
    }
    const header = documents.get('Contents/header.xml')
    const packageDoc = documents.get('Contents/content.hpf')
    const sections = [...documents].filter(([name]) => /^Contents\/section\d+\.xml$/.test(name))
    if (Number(header.root.attrs.secCnt) !== sections.length)
      fail('Header section count does not match package sections')
    const manifest = packageDoc.nodes.filter((n) => n.uri === OPF && n.local === 'item')
    const manifestIds = new Map()
    for (const item of manifest) {
      if (!item.attrs.id || manifestIds.has(item.attrs.id))
        fail(`Duplicate/empty manifest id: ${item.attrs.id}`)
      manifestIds.set(item.attrs.id, item.attrs.href)
      if (!parts[item.attrs.href]) fail(`Missing manifest target: ${item.attrs.href}`)
    }
    for (const item of packageDoc.nodes.filter((n) => n.uri === OPF && n.local === 'itemref')) {
      if (!manifestIds.has(item.attrs.idref)) fail(`Dangling spine id: ${item.attrs.idref}`)
    }
    const idSets = Object.fromEntries(
      ['charPr', 'paraPr', 'style', 'borderFill', 'tabPr'].map((kind) => {
        const nodes = header.nodes.filter((n) => n.uri === HH && n.local === kind)
        const ids = new Set(nodes.map((n) => n.attrs.id))
        if (ids.size !== nodes.length || ids.has(undefined)) fail(`Duplicate/empty ${kind} id`)
        return [kind, ids]
      }),
    )
    for (const [name, document] of documents) {
      for (const node of document.nodes) {
        for (const kind of ['charPr', 'paraPr', 'style', 'borderFill', 'tabPr']) {
          const ref = node.attrs[`${kind}IDRef`]
          if (ref !== undefined && !idSets[kind].has(ref))
            fail(`${name}: dangling ${kind}IDRef=${ref}`)
        }
        if (
          node.attrs.binaryItemIDRef !== undefined &&
          !manifestIds.has(node.attrs.binaryItemIDRef)
        ) {
          fail(`${name}: dangling binaryItemIDRef=${node.attrs.binaryItemIDRef}`)
        }
      }
    }
    for (const [name, section] of sections) {
      const page = section.nodes.find((n) => n.uri === HP && n.local === 'pagePr')
      if (!page || !(Number(page.attrs.width) > 0) || !(Number(page.attrs.height) > 0))
        fail(`${name}: explicit page dimensions are missing`)
      if (!section.nodes.some((n) => n.uri === HP && n.local === 'p'))
        fail(`${name}: section has no paragraph`)
      for (const table of section.nodes.filter((n) => n.uri === HP && n.local === 'tbl')) {
        const rows = table.children.filter((n) => n.uri === HP && n.local === 'tr')
        if (Number(table.attrs.rowCnt) !== rows.length) fail(`${name}: table row count mismatch`)
        for (const [r, row] of rows.entries()) {
          const cells = row.children.filter((n) => n.uri === HP && n.local === 'tc')
          for (const [c, cell] of cells.entries()) {
            const address = cell.children.find((n) => n.local === 'cellAddr')
            const span = cell.children.find((n) => n.local === 'cellSpan')
            const subList = cell.children.find((n) => n.local === 'subList')
            if (
              !address ||
              Number(address.attrs.rowAddr) !== r ||
              Number(address.attrs.colAddr) !== c
            )
              fail(`${name}: missing/incorrect cell address at ${r},${c}`)
            if (!span || !(Number(span.attrs.rowSpan) >= 1) || !(Number(span.attrs.colSpan) >= 1))
              fail(`${name}: missing cell span at ${r},${c}`)
            if (!subList || !subList.children.some((n) => n.local === 'p'))
              fail(`${name}: missing cell paragraph at ${r},${c}`)
          }
        }
      }
    }
    result.structuralChecksPassed = errors.length === 0
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
  return result
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) {
    console.error('Usage: node tools/hwpx-structural-review.mjs <generated.hwpx>')
    process.exitCode = 2
  } else {
    try {
      const result = reviewHwpx(new Uint8Array(await readFile(process.argv[2])))
      console.log(JSON.stringify(result, null, 2))
      if (!result.structuralChecksPassed) process.exitCode = 1
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    }
  }
}
