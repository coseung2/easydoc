import { open, unlink } from 'node:fs/promises'
import { join } from 'node:path'

/** Same filename policy on every OS; Windows reserved devices remain reserved with extensions. */
export function generatedFileStem(title: string): string {
  // eslint-disable-next-line no-control-regex
  const characters = Array.from(
    String(title ?? '')
      .replace(/[/\\:*?"<>|\u0000-\u001f]/g, '_')
      .trim(),
  )
    .slice(0, 80)
  // Reserve space for a collision suffix and extension on 255-byte filesystems.
  let stem = ''
  for (const character of characters) {
    if (Buffer.byteLength(stem + character, 'utf8') > 220) break
    stem += character
  }
  const clean = stem.replace(/[ .]+$/, '')
  if (!clean || clean === '.' || clean === '..') return 'Untitled'
  return /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(clean) ? `_${clean}` : clean
}

/** Exclusive creation closes the exists-then-write race and never follows an existing symlink. */
export async function writeGeneratedFile(
  directory: string,
  title: string,
  extension: string,
  bytes: string | Uint8Array,
): Promise<string> {
  if (!/^[a-z0-9]{1,8}$/.test(extension)) throw new Error('Invalid generated file extension.')
  const stem = generatedFileStem(title)
  for (let i = 0; i < 1000; i++) {
    const path = join(directory, `${stem}${i ? ` (${i})` : ''}.${extension}`)
    let file
    try {
      file = await open(path, 'wx')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
      throw error
    }
    try {
      await file.writeFile(bytes)
      await file.close()
      return path
    } catch (error) {
      await file.close().catch(() => {})
      await unlink(path).catch(() => {})
      throw error
    }
  }
  throw new Error('Too many generated files with the same name.')
}
