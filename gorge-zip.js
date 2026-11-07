/**
 * gorge-zip.js — package a Dremu chart project as one shareable `.zip`.
 *
 * A chart project is a directory of `.g` staff files plus the assets they
 * reference. This module turns the **live** Host model (including edits that
 * were not written to disk yet) into a ZIP buffer:
 *
 *   <project>/
 *     <Staff>.g            every staff, serialised from the model
 *     <asset>              referenced audio/images (or all, or none)
 *     README.md            copied when the project has one
 *
 * The default asset policy is `referenced`: an asset is packed when its file
 * name (or its stem, for `image:<name>` storyboard references) occurs in any
 * serialised staff text, or when an audio period points at it. Unreferenced
 * files (an alternate take, an unused background) are reported in `skipped`
 * instead of bloating the package. Pass `{ assets: 'all' }` for a full folder
 * copy and `{ assets: 'none' }` for chart files only.
 *
 * The writer is dependency-free (Node builtins only) and supports the subset
 * of the ZIP format a chart package needs: store/deflate entries, UTF-8 names,
 * local headers, a central directory and the EOCD record. ZIP64 (entries over
 * 4 GiB, more than 65 535 files) is refused with a readable error instead of
 * producing a corrupt archive.
 *
 * @module gorge-zip
 */

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { promisify } from 'node:util'

import { serializeGorgeFile } from './gorge-codec.js'

const deflateRaw = promisify(zlib.deflateRaw)

// ---------------------------------------------------------------------------
// 01 · ZIP primitives
// ---------------------------------------------------------------------------

const LOCAL_HEADER_SIGNATURE = 0x04034b50
const CENTRAL_HEADER_SIGNATURE = 0x02014b50
const EOCD_SIGNATURE = 0x06054b50
/** General-purpose bit 11: entry names are UTF-8. */
const UTF8_NAME_FLAG = 0x0800
const METHOD_STORE = 0
const METHOD_DEFLATE = 8
const MAX_UINT32 = 0xffffffff
const MAX_ENTRIES = 0xffff
/** Extensions that are already compressed: storing them beats deflating. */
const STORE_EXTENSIONS = new Set([
  '.mp3',
  '.flac',
  '.ogg',
  '.m4a',
  '.aac',
  '.opus',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.zip',
  '.mp4',
  '.webm',
  '.avi',
  '.mov',
  '.7z',
  '.rar',
])

/** CRC-32 lookup table (IEEE polynomial, as used by ZIP). */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

/**
 * CRC-32 of a buffer (the checksum stored in ZIP headers).
 *
 * @param {Buffer|Uint8Array} buffer
 * @returns {number} unsigned 32-bit checksum
 */
export function crc32(buffer) {
  let crc = 0xffffffff
  for (let index = 0; index < buffer.length; index += 1) {
    crc = CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** MS-DOS date/time fields (clamped to 1980 when the timestamp predates it). */
function dosDateTime(value) {
  const date = value instanceof Date && Number.isFinite(value.getTime()) ? value : new Date()
  const year = date.getFullYear()
  if (year < 1980) return { time: 0, date: (1 << 5) | 1 }
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((Math.min(year, 2107) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  }
}

/** Forward-slash entry name with traversal segments rejected. */
function normalizeEntryName(name) {
  const normalized = String(name === undefined || name === null ? '' : name)
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
  if (normalized.length === 0) throw new Error('zip entry has an empty name')
  for (const segment of normalized.split('/')) {
    if (segment === '.' || segment === '..') throw new Error(`unsafe zip entry name: ${normalized}`)
  }
  return normalized
}

/** True when an entry name should be deflated rather than stored. */
function shouldDeflate(name) {
  if (name.endsWith('/')) return false
  return !STORE_EXTENSIONS.has(path.extname(name).toLowerCase())
}

/**
 * Build one ZIP archive from prepared entries.
 *
 * Each entry is `{ name, data, mtime?, compress? }` where `data` is a Buffer
 * (or something `Buffer.from` accepts). Directories are entries whose name
 * ends with `/` and carry no data. Deflating runs asynchronously so a large
 * audio file does not block the Host.
 *
 * @param {{name:string, data?:Buffer|string, mtime?:Date, compress?:boolean}[]} entries
 * @returns {Promise<Buffer>} the complete `.zip` bytes
 */
export async function createZipBuffer(entries) {
  if (!Array.isArray(entries)) throw new TypeError('entries must be an array')
  if (entries.length > MAX_ENTRIES) {
    throw new Error(`too many files for a ZIP archive (${entries.length}, limit ${MAX_ENTRIES})`)
  }
  const localParts = []
  const centralParts = []
  const records = []
  let offset = 0
  for (const entry of entries) {
    const name = normalizeEntryName(entry && entry.name)
    const nameBuffer = Buffer.from(name, 'utf8')
    const isDirectory = name.endsWith('/')
    const data = isDirectory
      ? Buffer.alloc(0)
      : Buffer.isBuffer(entry.data)
        ? entry.data
        : Buffer.from(entry.data === undefined || entry.data === null ? '' : String(entry.data), 'utf8')
    const compress = isDirectory ? false : entry.compress === undefined ? shouldDeflate(name) : entry.compress === true
    let method = METHOD_STORE
    let body = data
    if (compress && data.length > 0) {
      const deflated = await deflateRaw(data, { level: 6 })
      // Storing a slightly larger "compressed" body only costs space.
      if (deflated.length < data.length) {
        method = METHOD_DEFLATE
        body = deflated
      }
    }
    const stamp = dosDateTime(entry.mtime)
    const checksum = crc32(data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(LOCAL_HEADER_SIGNATURE, 0)
    local.writeUInt16LE(20, 4) // version needed to extract (2.0)
    local.writeUInt16LE(UTF8_NAME_FLAG, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(stamp.time, 10)
    local.writeUInt16LE(stamp.date, 12)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuffer.length, 26)
    local.writeUInt16LE(0, 28) // extra field length

    localParts.push(local, nameBuffer, body)
    records.push({ name, nameBuffer, method, stamp, checksum, compressed: body.length, size: data.length, offset, isDirectory })
    offset += local.length + nameBuffer.length + body.length
    if (offset > MAX_UINT32) {
      throw new Error('the export is larger than 4 GiB, which this ZIP writer does not support')
    }
  }

  const centralDirectoryOffset = offset
  for (const record of records) {
    const header = Buffer.alloc(46)
    header.writeUInt32LE(CENTRAL_HEADER_SIGNATURE, 0)
    header.writeUInt16LE(0x031e, 4) // made by: UNIX (3), spec 3.0
    header.writeUInt16LE(20, 6) // version needed
    header.writeUInt16LE(UTF8_NAME_FLAG, 8)
    header.writeUInt16LE(record.method, 10)
    header.writeUInt16LE(record.stamp.time, 12)
    header.writeUInt16LE(record.stamp.date, 14)
    header.writeUInt32LE(record.checksum, 16)
    header.writeUInt32LE(record.compressed, 20)
    header.writeUInt32LE(record.size, 24)
    header.writeUInt16LE(record.nameBuffer.length, 28)
    header.writeUInt16LE(0, 30) // extra field length
    header.writeUInt16LE(0, 32) // comment length
    header.writeUInt16LE(0, 34) // disk number start
    header.writeUInt16LE(0, 36) // internal attributes
    header.writeUInt32LE(record.isDirectory ? ((0o40755 << 16) | 0x10) >>> 0 : (0o100644 << 16) >>> 0, 38)
    header.writeUInt32LE(record.offset, 42)
    centralParts.push(header, record.nameBuffer)
    offset += header.length + record.nameBuffer.length
    if (offset > MAX_UINT32) {
      throw new Error('the export is larger than 4 GiB, which this ZIP writer does not support')
    }
  }

  const centralDirectorySize = offset - centralDirectoryOffset
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(EOCD_SIGNATURE, 0)
  eocd.writeUInt16LE(0, 4) // this disk
  eocd.writeUInt16LE(0, 6) // disk with the central directory
  eocd.writeUInt16LE(records.length, 8)
  eocd.writeUInt16LE(records.length, 10)
  eocd.writeUInt32LE(centralDirectorySize, 12)
  eocd.writeUInt32LE(centralDirectoryOffset, 16)
  eocd.writeUInt16LE(0, 20) // comment length

  return Buffer.concat([...localParts, ...centralParts, eocd])
}

// ---------------------------------------------------------------------------
// 02 · Export plan (what goes into the package)
// ---------------------------------------------------------------------------

/**
 * Make a value safe to use as a single path segment / download file name.
 * Empty results fall back to `fallback`; control characters and characters
 * Windows/macOS reject become `_`.
 *
 * @param {string} value
 * @param {string} [fallback]
 * @returns {string}
 */
export function sanitizeExportName(value, fallback = 'chart') {
  const raw = typeof value === 'string' ? path.basename(value.trim()) : ''
  const cleaned = raw
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_')
    .replace(/^\.+/, '')
    .replace(/\.+$/, '')
    .trim()
  return cleaned.length > 0 ? cleaned : fallback
}

/** `fs.statSync` that only reports regular files (null otherwise). */
function fileStat(target) {
  try {
    const stats = fs.statSync(target)
    return stats.isFile() ? stats : null
  } catch (error) {
    return null
  }
}

/** True for a plain file name (no directory part, not hidden, not empty). */
function isPlainFileName(name) {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.charAt(0) !== '.' &&
    name.indexOf('\\') === -1 &&
    name.indexOf('\u0000') === -1 &&
    path.basename(name) === name &&
    name !== '.' &&
    name !== '..'
  )
}

/** Storyboard images are referenced as `image:<asset name>` without extension. */
function assetReferenceNeedles(name) {
  const base = path.basename(name)
  const extension = path.extname(base)
  const stem = extension.length > 0 ? base.slice(0, -extension.length) : base
  const needles = new Set([base])
  if (stem.length >= 2) {
    needles.add(stem)
    needles.add(`image:${stem}`)
    needles.add(`image:${base}`)
  }
  return [...needles]
}

/** Every file an audio period (`@Song` clip) points at, as plain names. */
function audioClipNames(project) {
  const names = new Set()
  const clips = Array.isArray(project.audioPeriods) ? project.audioPeriods : []
  for (const clip of clips) {
    if (!clip || typeof clip !== 'object') continue
    for (const key of ['file', 'relativePath']) {
      if (typeof clip[key] === 'string' && clip[key].length > 0) names.add(path.basename(clip[key]))
    }
  }
  if (project.audio && typeof project.audio.file === 'string' && project.audio.file.length > 0) {
    names.add(path.basename(project.audio.file))
  }
  return names
}

/**
 * Plan an export without reading asset bytes: serialise every staff, decide
 * which assets are referenced, and stat the files that will be packed.
 *
 * Returns `{ root, filename, items, skipped, counts, bytes }` where each item
 * is either `{ kind: 'text', name, text, mtime, bytes }` or
 * `{ kind: 'file', name, absolute, mtime, bytes }`. The plan is synchronous,
 * so the staff snapshot is consistent even though `buildProjectZip` reads the
 * asset files asynchronously afterwards.
 *
 * @param {object} project  internal Host project model (`store.view().project`).
 * @param {{assets?:'referenced'|'all'|'none', root?:string}} [options]
 * @returns {{root:string, filename:string, items:object[], skipped:{name:string, reason:string}[],
 *            counts:{staffs:number, assets:number, readme:number}, bytes:number}}
 */
export function collectProjectExport(project, options = {}) {
  if (!project || typeof project !== 'object') throw new Error('no project to export')
  const opts = options && typeof options === 'object' ? options : {}
  const assetPolicy = opts.assets === 'all' || opts.assets === 'none' ? opts.assets : 'referenced'
  const projectDir = path.resolve(project.dir || '.')
  const root = sanitizeExportName(opts.root || path.basename(projectDir), 'chart')
  const now = new Date()
  const items = []
  const skipped = []
  const seenNames = new Set()
  const staffTexts = []
  const counts = { staffs: 0, assets: 0, readme: 0 }

  function pushItem(item) {
    if (seenNames.has(item.name)) {
      skipped.push({ name: item.name, reason: 'duplicate entry name' })
      return
    }
    seenNames.add(item.name)
    items.push(item)
  }

  // The archive starts with the project folder so unzipping never scatters
  // staffs into the user's current directory.
  pushItem({ kind: 'text', name: `${root}/`, text: '', mtime: now, bytes: 0 })

  // Staff files: serialise the live model, so unsaved edits are included and
  // files that were removed in this session are absent.
  const staffs = Array.isArray(project.staffs) ? project.staffs : []
  for (const staff of staffs) {
    if (!staff || typeof staff !== 'object') continue
    let text
    try {
      if (!staff._staffFile) throw new Error('the staff was not parsed from a .g file')
      text = serializeGorgeFile(staff._staffFile)
    } catch (error) {
      skipped.push({ name: staff.id || '(staff)', reason: `cannot serialise: ${errorMessage(error)}` })
      continue
    }
    const fileName = isPlainFileName(staff.id) ? staff.id : sanitizeExportName(staff.id, 'Staff.g')
    const source = path.join(projectDir, fileName)
    const stats = fileStat(source)
    pushItem({
      kind: 'text',
      name: `${root}/${fileName}`,
      text,
      mtime: stats ? stats.mtime : now,
      bytes: Buffer.byteLength(text, 'utf8'),
    })
    staffTexts.push(text)
    counts.staffs += 1
  }

  // Reference corpus: every asset name that appears in a staff (plus the
  // `@Song` clip paths, which live in the audio staff's return value and are
  // therefore already in the corpus, but keep the model as a second source).
  // Matching is case-insensitive because macOS/Windows project folders are.
  const corpus = staffTexts.join('\n').toLowerCase()
  const clipNames = audioClipNames(project)
  const clipNamesLower = new Set([...clipNames].map((name) => name.toLowerCase()))
  const isReferenced = (name) => {
    if (clipNamesLower.has(path.basename(name).toLowerCase())) return true
    for (const needle of assetReferenceNeedles(name)) {
      if (needle.length >= 2 && corpus.indexOf(needle.toLowerCase()) !== -1) return true
    }
    return false
  }

  // Assets: everything the model knows about, including audio imported for a
  // clip that is not in `assets` yet.
  const knownAssets = new Set()
  const assets = project.assets && typeof project.assets === 'object' ? project.assets : {}
  for (const list of [assets.images, assets.audio]) {
    if (!Array.isArray(list)) continue
    for (const name of list) if (isPlainFileName(name)) knownAssets.add(name)
  }
  for (const name of clipNames) if (isPlainFileName(name)) knownAssets.add(name)

  for (const name of [...knownAssets].sort()) {
    const entryName = `${root}/${name}`
    if (assetPolicy === 'none') {
      skipped.push({ name: entryName, reason: 'assets disabled for this export' })
      continue
    }
    if (assetPolicy === 'referenced' && !isReferenced(name)) {
      skipped.push({ name: entryName, reason: 'not referenced by the chart' })
      continue
    }
    const absolute = path.join(projectDir, name)
    if (path.dirname(absolute) !== projectDir) {
      skipped.push({ name: entryName, reason: 'asset is outside the project directory' })
      continue
    }
    const stats = fileStat(absolute)
    if (!stats) {
      skipped.push({ name: entryName, reason: 'file is missing' })
      continue
    }
    pushItem({ kind: 'file', name: entryName, absolute, mtime: stats.mtime, bytes: stats.size })
    counts.assets += 1
  }

  // README, if the project carries one.
  for (const candidate of ['README.md', 'readme.md', 'README.MD', 'README.txt', 'readme.txt']) {
    const absolute = path.join(projectDir, candidate)
    const stats = fileStat(absolute)
    if (!stats) continue
    pushItem({ kind: 'file', name: `${root}/${candidate}`, absolute, mtime: stats.mtime, bytes: stats.size })
    counts.readme += 1
    break
  }

  if (counts.staffs === 0) throw new Error('the project has no .g staff files to export')
  let bytes = 0
  for (const item of items) bytes += item.bytes
  return { root, filename: `${root}.zip`, items, skipped, counts, bytes }
}

/** Readable message for an unknown thrown value. */
function errorMessage(error) {
  return error && typeof error.message === 'string' ? error.message : String(error)
}

// ---------------------------------------------------------------------------
// 03 · Build the package
// ---------------------------------------------------------------------------

/**
 * Build the chart package for a project.
 *
 * @param {object} project  internal Host project model.
 * @param {{assets?:'referenced'|'all'|'none', root?:string}} [options]
 * @returns {Promise<{buffer:Buffer, filename:string, root:string,
 *          entries:{name:string, bytes:number}[], skipped:{name:string, reason:string}[],
 *          counts:{staffs:number, assets:number, readme:number}, bytes:number}>}
 */
export async function buildProjectZip(project, options = {}) {
  const plan = collectProjectExport(project, options)
  const zipEntries = []
  const entries = []
  for (const item of plan.items) {
    let data
    if (item.kind === 'text') {
      data = Buffer.from(item.text, 'utf8')
    } else {
      try {
        data = await fs.promises.readFile(item.absolute)
      } catch (error) {
        plan.skipped.push({ name: item.name, reason: `cannot read: ${errorMessage(error)}` })
        continue
      }
    }
    zipEntries.push({ name: item.name, data, mtime: item.mtime })
    entries.push({ name: item.name, bytes: data.length })
  }
  const buffer = await createZipBuffer(zipEntries)
  return {
    buffer,
    filename: plan.filename,
    root: plan.root,
    entries,
    skipped: plan.skipped,
    counts: plan.counts,
    bytes: plan.bytes,
  }
}
