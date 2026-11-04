#!/usr/bin/env node
/**
 * tests/model.test.mjs — acceptance tests for `dremu-model.js` (plain Node,
 * `node:assert/strict`, no dependencies, no test runner).
 *
 * Run:  node tests/model.test.mjs
 * Exit: 0 when every check passes, 1 otherwise (a short summary is printed).
 *
 * Coverage (the five acceptance criteria of task-2 plus safety net):
 *   1. loadProject('/Users/daxingyi/Music/DremuTest'): 5 staffs, 20/11/1/1/0
 *      periods per staff, sane absolute element times, audio probe.
 *   2. copy the project to a temp dir -> load -> applyOps(no-op) -> saveProject
 *      with no change writes NOTHING, then a forced save rewrites every `.g`
 *      BYTE-IDENTICALLY (the CRLF DremuTest project included), keeps `.g.bak`
 *      backups, and reloads to identical element data.
 *   3. createElement for every catalog type -> serialize into a temp staff ->
 *      re-parse -> identical fields (and byte-stable second serialization).
 *   4. applyOps add/patch/remove/duplicate/setMeta/setStaffName/setPeriodConfig
 *      on a copy -> save -> reload preserves the change; errors/unknown ops are
 *      reported, never thrown.
 *   5. probeAudioFile on Song.wav returns the true duration.
 *
 * NOTE: Song.wav is 32-bit IEEE-float stereo 44.1 kHz (fmt tag 3, byteRate
 * 352800), so its real duration is ~130.74 s, not the ~261 s that 16-bit maths
 * would give. The probe reports the true duration.
 *
 * The real corpus is READ-ONLY: everything that writes goes to os.tmpdir()
 * copies, and the suite re-hashes the corpus at the end to prove it.
 */

import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  CATALOG,
  applyOps,
  createElement,
  createEmptyProject,
  elementTiming,
  evaluateCurve,
  loadProject,
  probeAudioFile,
  projectToWire,
  saveProject,
  validateProject,
} from '../dremu-model.js'
import { parseGorgeFile, serializeGorgeFile } from '../gorge-codec.js'

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CORPUS_DIR = '/Users/daxingyi/Music/DremuTest'
const CHART_ROOT = '/Users/daxingyi/Music/Chart'
const CHART2_DIR = path.join(CHART_ROOT, 'Chart 2')

let passCount = 0
const failures = []
let currentSection = ''

function section(title) {
  currentSection = title
  console.log(`\n— ${title}`)
}

/** Run one synchronous check; failures are collected, not thrown. */
function test(name, fn) {
  try {
    fn()
    passCount += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    failures.push({ section: currentSection, name, error })
    console.log(`  FAIL ${name}: ${error && error.message ? error.message : error}`)
  }
}

const tempDirs = []
function makeTemp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function cleanupTempDirs() {
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }
}

/** Copy every top-level `*.g` from `srcDir` to `destDir`; returns the names. */
function copyStaffFiles(srcDir, destDir) {
  const names = fs
    .readdirSync(srcDir)
    .filter((name) => name.endsWith('.g'))
    .sort()
  for (const name of names) fs.copyFileSync(path.join(srcDir, name), path.join(destDir, name))
  return names
}

/** Copy every top-level file matching `filter` (assets included). */
function copyProjectFiles(srcDir, destDir, filter) {
  const names = fs
    .readdirSync(srcDir)
    .filter((name) => (filter ? filter(name) : true))
    .sort()
  for (const name of names) fs.copyFileSync(path.join(srcDir, name), path.join(destDir, name))
  return names
}

function hashFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

/** Wire project without the revision/dirty envelope, as canonical JSON. */
function wireJson(project, options = {}) {
  const wire = projectToWire(project, options)
  return JSON.stringify(wire.project)
}

function staffById(project, id) {
  const staff = (project.staffs || []).find((item) => item.id === id)
  assert.ok(staff, `staff ${id} exists`)
  return staff
}

function periodById(staff, id) {
  const period = (staff.periods || []).find((item) => item.id === id)
  assert.ok(period, `period ${id} exists in ${staff.id}`)
  return period
}

function allElements(project) {
  const out = []
  for (const staff of project.staffs || []) {
    for (const period of staff.periods || []) for (const element of period.elements || []) out.push({ staff, period, element })
  }
  return out
}

function elementById(project, id) {
  const found = allElements(project).find((item) => item.element.id === id)
  assert.ok(found, `element ${id} exists`)
  return found
}

function catalogEntry(type) {
  return CATALOG.elements.find((entry) => entry.type === type) || null
}

/** Recursively reject functions/undefined in catalog data (must stay JSON-safe). */
function assertJsonSafe(value, trail = 'catalog') {
  if (value === undefined) assert.fail(`${trail} is undefined (not JSON-safe)`)
  if (typeof value === 'function') assert.fail(`${trail} is a function (not JSON-safe)`)
  if (value === null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonSafe(item, `${trail}[${index}]`))
    return
  }
  for (const key of Object.keys(value)) assertJsonSafe(value[key], `${trail}.${key}`)
}

process.on('exit', cleanupTempDirs)

// ---------------------------------------------------------------------------
// Corpus availability
// ---------------------------------------------------------------------------

if (!fs.existsSync(CORPUS_DIR) || !fs.existsSync(CHART2_DIR)) {
  console.log(`SKIP: chart corpus not found (${CORPUS_DIR} / ${CHART2_DIR})`)
  process.exit(0)
}

// Snapshot the read-only corpus so the suite can prove it never wrote there.
const CORPUS_SNAPSHOT = new Map()
for (const name of fs.readdirSync(CORPUS_DIR).filter((n) => n.endsWith('.g'))) CORPUS_SNAPSHOT.set(path.join(CORPUS_DIR, name), hashFile(path.join(CORPUS_DIR, name)))

// ===========================================================================
// A. CATALOG
// ===========================================================================

section('A. CATALOG')

test('is JSON-serialisable data (no functions, no undefined)', () => {
  assertJsonSafe(CATALOG)
  assert.doesNotThrow(() => JSON.stringify(CATALOG))
})

test('has the contract shape: version/elements/valueTypes/palettes/curveKinds', () => {
  assert.equal(CATALOG.version, 1)
  assert.ok(Array.isArray(CATALOG.elements))
  assert.equal(CATALOG.elements.length, 8, 'eight corpus element types')
  assert.ok(CATALOG.valueTypes && typeof CATALOG.valueTypes === 'object')
  assert.ok(Object.keys(CATALOG.valueTypes).length >= 14)
  assert.ok(CATALOG.palettes && Array.isArray(CATALOG.palettes.noteTypes) && Array.isArray(CATALOG.palettes.laneTypes))
  assert.ok(CATALOG.curveKinds && CATALOG.curveKinds.CubicHermiteSpline)
  assert.deepEqual(CATALOG.curveKinds.CubicHermiteSpline.returns, 'number')
  assert.deepEqual(CATALOG.curveKinds.LerpColorCurve.returns, 'color')
})

test('every element entry has type/shortName/category/group/color/timing/fields', () => {
  const categories = new Set(['note', 'hold', 'lane', 'inner', 'other'])
  const timingFields = new Set(['hitTime', 'generateTime', 'startMoment'])
  for (const entry of CATALOG.elements) {
    for (const key of ['type', 'shortName', 'category', 'group', 'color', 'timing', 'fields']) assert.ok(entry[key] !== undefined, `${entry.type}.${key}`)
    assert.match(entry.type, /^[A-Za-z][\w.]*$/)
    assert.equal(entry.shortName, entry.type.split('.').pop())
    assert.ok(categories.has(entry.category), `${entry.type} category ${entry.category}`)
    assert.match(entry.color, /^#[0-9a-f]{6}$/i)
    assert.ok(Array.isArray(entry.fields) && entry.fields.length > 0)
    assert.ok(timingFields.has(entry.timing.start), `${entry.type} timing.start ${entry.timing.start}`)
    const names = new Set()
    for (const field of entry.fields) {
      assert.ok(typeof field.name === 'string' && field.name.length > 0)
      assert.ok(typeof field.type === 'string' && field.type.length > 0)
      assert.ok(typeof field.label === 'string' && field.label.length > 0, `${entry.type}.${field.name} needs a Chinese label`)
      assert.ok(!names.has(field.name), `${entry.type} duplicate field ${field.name}`)
      names.add(field.name)
    }
    if (entry.timing.duration !== null) assert.ok(names.has(entry.timing.duration), `${entry.type} timing.duration in fields`)
    if (entry.timing.lane !== null) assert.ok(names.has(entry.timing.lane), `${entry.type} timing.lane in fields`)
  }
})

test('palettes reference catalog types exactly once', () => {
  const paletteTypes = [
    ...CATALOG.palettes.noteTypes,
    ...CATALOG.palettes.laneTypes,
    ...CATALOG.palettes.storyboardTypes,
    ...CATALOG.palettes.innerTypes,
  ].sort()
  const elementTypes = CATALOG.elements.map((entry) => entry.type).sort()
  assert.deepEqual(paletteTypes, elementTypes)
  assert.deepEqual(CATALOG.elements.map((entry) => entry.type).sort(), CATALOG.palettes.allTypes.slice().sort())
})

test('typeAliases resolve every accepted spelling to a canonical catalog type', () => {
  const canonical = new Set(CATALOG.elements.map((entry) => entry.type))
  for (const entry of CATALOG.elements) {
    for (const spelling of [entry.type, entry.shortName, entry.shortName.replace(/^Dremu/, ''), entry.group + '.' + entry.shortName]) {
      if (!spelling) continue
      assert.ok(canonical.has(spelling === entry.type ? CATALOG.typeAliases[spelling] || spelling : CATALOG.typeAliases[spelling]), `alias ${spelling}`)
    }
  }
  assert.equal(CATALOG.typeAliases.Tap, 'Dremu.DremuTap')
  assert.equal(CATALOG.typeAliases.Image, 'DeentyStoryboard.Image')
})

test('composite value types expose fields with labels (generic inspector data)', () => {
  for (const typeName of ['VariableFloat', 'Vector2', 'ColorArgb', 'LinearCurve', 'CubicHermiteSpline', 'LinearFunctionCurve', 'ConstantFunctionCurve', 'PiecewiseFunctionCurve', 'FunctionPiece', 'LerpColorCurve', 'AxialSymmetricFunctionCurve', 'PeriodicFunctionCurve', 'AdditionFunctionCurve', 'CompositeFunctionCurve', 'PeriodConfig', 'WavAudioAsset']) {
    const valueType = CATALOG.valueTypes[typeName]
    assert.ok(valueType, `valueTypes.${typeName}`)
    assert.ok(valueType.fields && Object.keys(valueType.fields).length > 0, `${typeName}.fields`)
    for (const key of Object.keys(valueType.fields)) assert.ok(valueType.fields[key].label, `${typeName}.${key}.label`)
  }
  assert.equal(CATALOG.valueTypes.ColorArgb.fields.a.default, 1)
  assert.equal(CATALOG.valueTypes.PeriodConfig.fields.timeOffset.type, 'number')
})

test('engine defaults from the format spec are encoded (docs/gorge-format-spec.md §C/D)', () => {
  assert.equal(CATALOG.valueTypes.ColorArgb.fields.r.default, 1, 'ColorArgb channels default to 1')
  assert.equal(CATALOG.valueTypes.LinearFunctionCurve.fields.k.default, 0)
  assert.equal(CATALOG.valueTypes.LinearCurve.fields.timeEnd.default, 1)
  assert.equal(CATALOG.valueTypes.LinearCurve.fields.valueEnd.default, 1)
  assert.equal(CATALOG.valueTypes.CubicHermiteSpline.fields.endPoint.default.t, 'obj')
  assert.equal(CATALOG.valueTypes.CubicHermiteSpline.fields.startWeight.default, 0.33333)
  assert.equal(CATALOG.valueTypes.PeriodConfig.fields.minLength.default, 10)
  const note = catalogEntry('Dremu.DremuTap')
  assert.equal(note.fields.find((field) => field.name === 'leadTime').default, 1.5)
  assert.equal(note.fields.find((field) => field.name === 'lagTime').default, 1.5)
  assert.equal(note.fields.find((field) => field.name === 'positionZ').default, -2)
  const hold = catalogEntry('Dremu.DremuHold')
  assert.equal(hold.fields.find((field) => field.name === 'holdTime').default, 1)
  assert.ok(hold.fields.some((field) => field.name === 'truncation'))
  const lane = catalogEntry('Dremu.DremuMainLane')
  assert.equal(lane.fields.find((field) => field.name === 'keepTime').default, 10)
  assert.equal(lane.fields.find((field) => field.name === 'evaluateDelta').default, 0.01)
  const image = catalogEntry('DeentyStoryboard.Image')
  const positionMode = image.fields.find((field) => field.name === 'positionMode')
  assert.equal(positionMode.default.path, 'DeentyStoryboard.ImagePositionMode.ScreenX')
  assert.ok(image.fields.some((field) => field.name === 'useChartTime'))
})

test('pointCount is declared as an int field (bare integer on disk)', () => {
  const lane = catalogEntry('Dremu.DremuMainLane')
  const pointCount = lane.fields.find((field) => field.name === 'pointCount')
  assert.ok(pointCount)
  assert.equal(pointCount.type, 'int')
})

// ===========================================================================
// B. probeAudioFile
// ===========================================================================

section('B. probeAudioFile')

test('Song.wav: true duration ~130.74 s, 44100 Hz, 2 ch, wav (32-bit float file)', () => {
  const result = probeAudioFile(path.join(CORPUS_DIR, 'Song.wav'))
  assert.equal(result.format, 'wav')
  assert.equal(result.sampleRate, 44100)
  assert.equal(result.channels, 2)
  assert.ok(result.duration !== null, 'duration is measured')
  // 46123952 data bytes / 352800 bytes-per-second = 130.736825...
  assert.ok(Math.abs(result.duration - 130.7368) < 0.01, `duration ${result.duration}`)
})

test('missing / unknown files return nulls and never throw', () => {
  const missing = probeAudioFile(path.join(os.tmpdir(), 'definitely-not-here-000.wav'))
  assert.deepEqual(missing, { duration: null, sampleRate: null, channels: null, format: 'wav' })
  const junkDir = makeTemp('dremu-probe-')
  const junk = path.join(junkDir, 'junk.mp3')
  fs.writeFileSync(junk, crypto.randomBytes(256))
  const parsed = probeAudioFile(junk)
  assert.equal(parsed.format, 'mp3')
  assert.equal(parsed.duration, null)
  const txt = path.join(junkDir, 'junk.txt')
  fs.writeFileSync(txt, 'hello')
  assert.deepEqual(probeAudioFile(txt), { duration: null, sampleRate: null, channels: null, format: 'txt' })
  assert.doesNotThrow(() => probeAudioFile(''))
  assert.doesNotThrow(() => probeAudioFile(null))
})

// ===========================================================================
// C. loadProject on the real DremuTest project (acceptance 1)
// ===========================================================================

section('C. loadProject(DremuTest)')

const dremuTest = loadProject(CORPUS_DIR)

test('loads 5 staffs with the corpus kinds and period counts', () => {
  assert.equal(dremuTest.warnings.length, 0, `warnings: ${JSON.stringify(dremuTest.warnings)}`)
  assert.equal(dremuTest.staffs.length, 5)
  const byId = new Map(dremuTest.staffs.map((staff) => [staff.id, staff]))
  assert.deepEqual([...byId.keys()], ['DeentyStoryboardStaff.g', 'DremuStaff.g', 'DremuStaff1.g', 'DremuStaff2.g', 'Song.g'])
  assert.equal(byId.get('DeentyStoryboardStaff.g').kind, 'storyboard')
  assert.equal(byId.get('DremuStaff.g').kind, 'chart')
  assert.equal(byId.get('DremuStaff1.g').kind, 'chart')
  assert.equal(byId.get('DremuStaff2.g').kind, 'chart')
  assert.equal(byId.get('Song.g').kind, 'audio')
  assert.equal(byId.get('Song.g').periods.length, 0)
  assert.equal(byId.get('DremuStaff.g').periods.length, 1)
  assert.equal(byId.get('DeentyStoryboardStaff.g').periods.length, 1)
  assert.equal(byId.get('DremuStaff1.g').periods.length, 20)
  assert.equal(byId.get('DremuStaff2.g').periods.length, 11)
  const counts = (staff) => staff.periods.reduce((total, period) => total + period.elements.length, 0)
  assert.equal(counts(byId.get('DremuStaff.g')), 11)
  assert.equal(counts(byId.get('DeentyStoryboardStaff.g')), 8)
  assert.equal(counts(byId.get('DremuStaff1.g')), 219)
  assert.equal(counts(byId.get('DremuStaff2.g')), 268)
})

test('periods are sorted by timeOffset and keep the expected absolute times', () => {
  const staff1 = staffById(dremuTest, 'DremuStaff1.g')
  const offsets = staff1.periods.map((period) => period.timeOffset)
  assert.deepEqual(offsets, offsets.slice().sort((a, b) => a - b), 'periods sorted by timeOffset')
  assert.equal(staff1.periods[0].method, 'Period')
  assert.equal(staff1.periods[0].timeOffset, 0)
  assert.equal(staff1.periods[0].minLength, 10)
  // Period19 in the file is the only one with a non-null minLength 0.6315789.
  assert.ok(staff1.periods.some((period) => period.minLength === 0.6315789))
  // DremuStaff.g has timeOffset 1.0; its first lane starts at 1.0.
  const laneStaff = staffById(dremuTest, 'DremuStaff.g')
  assert.equal(laneStaff.periods[0].timeOffset, 1)
  assert.equal(laneStaff.periods[0].elements[0].type, 'Dremu.DremuMainLane')
  assert.equal(laneStaff.periods[0].elements[0].start, 1)
  // Storyboard offset is negative; first image starts at the period offset.
  const storyboard = staffById(dremuTest, 'DeentyStoryboardStaff.g')
  assert.equal(storyboard.periods[0].timeOffset, -0.2631579)
  const firstImage = storyboard.periods[0].elements[0]
  assert.equal(firstImage.type, 'DeentyStoryboard.Image')
  assert.equal(firstImage.start, -0.263158)
  assert.equal(firstImage.duration, 22.73684)
})

test('all derived element timing is sane and every element type resolves', () => {
  const catalogTypes = new Set(CATALOG.elements.map((entry) => entry.type))
  const categories = new Set(['note', 'hold', 'lane', 'inner', 'other'])
  for (const { staff, period, element } of allElements(dremuTest)) {
    assert.ok(catalogTypes.has(element.type), `${element.id} type ${element.type}`)
    assert.ok(Number.isFinite(element.start), `${element.id} start`)
    assert.ok(element.start >= -5 && element.start <= 300, `${element.id} start ${element.start}`)
    if (element.duration !== null) assert.ok(element.duration >= 0 && Number.isFinite(element.duration), `${element.id} duration`)
    assert.ok(categories.has(element.category), `${element.id} category`)
    if (element.category === 'note' || element.category === 'hold') assert.equal(typeof element.lane, 'string')
    if (element.category === 'lane') assert.equal(element.lane, element.fields.name)
    assert.equal(element.start, elementTiming(element, period).start)
    void staff
  }
})

test('audio asset is resolved (absolute path, name, offset, probed duration)', () => {
  const audio = dremuTest.audio
  assert.ok(audio && typeof audio === 'object')
  assert.ok(path.isAbsolute(audio.file))
  assert.ok(audio.file.endsWith(`${path.sep}Song.wav`))
  assert.equal(audio.name, 'Song')
  assert.equal(audio.offset, 0.373, 'Song.g PeriodConfig.timeOffset')
  assert.ok(Math.abs(audio.duration - 130.7368) < 0.01)
})

test('tempo default, form, title, duration = max(element end, audio end)', () => {
  assert.deepEqual(dremuTest.tempo, { bpm: 120, offset: 0 })
  assert.equal(dremuTest.form, 'Dremu')
  assert.equal(dremuTest.title, 'DremuTest')
  let lastEnd = 0
  for (const { element } of allElements(dremuTest)) lastEnd = Math.max(lastEnd, element.start + (element.duration || 0))
  const audioEnd = dremuTest.audio.duration + dremuTest.audio.offset
  assert.ok(Math.abs(dremuTest.duration - Math.max(lastEnd, audioEnd)) < 1e-6, `duration ${dremuTest.duration}`)
  assert.ok(dremuTest.duration >= 137 && dremuTest.duration <= 140, `project duration ${dremuTest.duration}`)
  assert.equal(dremuTest.dirty, false)
})

test('element ids are globally unique, deterministic and documented by scheme', () => {
  const ids = allElements(dremuTest).map(({ element }) => element.id)
  assert.equal(new Set(ids).size, ids.length, 'element ids are project-wide unique')
  for (const id of ids) assert.match(id, /^.+\.g:p\d+:e\d+$/)
  // Reloading the same directory gives exactly the same ids (position-derived).
  const again = loadProject(CORPUS_DIR)
  assert.deepEqual(allElements(again).map(({ element }) => element.id), ids)
  assert.deepEqual(again.warnings, dremuTest.warnings)
})

test('CRLF staffs stay CRLF in their parsed StaffFile; LF chart files stay LF', () => {
  const crlfStaff = staffById(dremuTest, 'DremuStaff1.g')
  assert.equal(crlfStaff._staffFile.eol, '\r\n')
  assert.equal(serializeGorgeFile(crlfStaff._staffFile), crlfStaff._origText)
  const chart2 = loadProject(CHART2_DIR)
  const chartStaff = chart2.staffs.find((staff) => staff.kind === 'chart')
  assert.equal(chartStaff._staffFile.eol, '\n')
})

test('loadProject never throws for a missing directory or a bad file', () => {
  const missing = loadProject(path.join(os.tmpdir(), `dremu-missing-${Date.now()}`))
  assert.equal(missing.staffs.length, 0)
  assert.ok(missing.warnings.length >= 1)
  const dir = makeTemp('dremu-badstaff-')
  fs.writeFileSync(path.join(dir, 'Broken.g'), 'this is not a gorge file')
  fs.writeFileSync(path.join(dir, 'Good.g'), '[ string form = "Dremu" ]\n@ElementStaff\nclass Good\n{\n}\n')
  const project = loadProject(dir)
  assert.ok(project.warnings.some((warning) => /Broken\.g/.test(warning)))
  assert.equal(project.staffs.length, 1)
  assert.equal(project.staffs[0].id, 'Good.g')
})

// ===========================================================================
// D. load -> save fidelity (acceptance 2, the critical CRLF test)
// ===========================================================================

section('D. load -> save byte-identical (temp copy of DremuTest, CRLF project)')

const fidelityDir = makeTemp('dremu-fidelity-')
const fidelityNames = copyStaffFiles(CORPUS_DIR, fidelityDir)

test('a clean load + no-op applyOps + unchanged save writes NOTHING', () => {
  const project = loadProject(fidelityDir)
  const wireBefore = wireJson(project, { rev: 1 })
  const noop = applyOps(project, [])
  assert.deepEqual(noop, { changed: false, errors: [], created: [] })
  const result = saveProject(project)
  assert.deepEqual(result, { written: [], errors: [] })
  assert.equal(wireJson(project, { rev: 1 }), wireBefore, 'no-op apply does not change the wire')
  const backups = fs.readdirSync(fidelityDir).filter((name) => name.endsWith('.bak'))
  assert.deepEqual(backups, [], 'no .bak for an unchanged save')
  assert.equal(project.dirty, false)
})

test('a forced save rewrites every .g BYTE-IDENTICALLY (CRLF included)', () => {
  const project = loadProject(fidelityDir)
  const before = wireJson(project, { rev: 2 })
  const result = saveProject(project, { force: true })
  assert.deepEqual(result.errors, [])
  assert.equal(result.written.length, fidelityNames.length)
  for (const name of fidelityNames) {
    const sourceBytes = fs.readFileSync(path.join(CORPUS_DIR, name))
    const writtenBytes = fs.readFileSync(path.join(fidelityDir, name))
    assert.ok(sourceBytes.equals(writtenBytes), `${name} must be byte-identical (${sourceBytes.length} vs ${writtenBytes.length} bytes)`)
    const backupBytes = fs.readFileSync(path.join(fidelityDir, name + '.bak'))
    assert.ok(sourceBytes.equals(backupBytes), `${name}.bak holds the pre-save bytes`)
  }
  assert.equal(project.dirty, false)
  assert.equal(wireJson(project, { rev: 2 }), before, 'forced save does not change element data')
})

test('the rewritten project reloads to identical element data and ids', () => {
  const project = loadProject(fidelityDir)
  const reloaded = loadProject(fidelityDir)
  assert.equal(reloaded.staffs.length, 5)
  assert.deepEqual(allElements(reloaded).map(({ element }) => element.id), allElements(project).map(({ element }) => element.id))
  assert.equal(wireJson(reloaded, { rev: 3 }), wireJson(project, { rev: 3 }))
})

test('a subsequent save is a no-op again (dirty stays false, no writes)', () => {
  const project = loadProject(fidelityDir)
  assert.deepEqual(saveProject(project), { written: [], errors: [] })
  assert.deepEqual(saveProject(project), { written: [], errors: [] })
})

test('CRLF bytes are preserved by serializeGorgeFile for every corpus staff', () => {
  for (const name of fidelityNames) {
    const text = fs.readFileSync(path.join(CORPUS_DIR, name), 'utf8')
    assert.equal(serializeGorgeFile(parseGorgeFile(text)), text, `${name} codec round-trip`)
  }
})

// ===========================================================================
// E. createElement round-trip for every catalog type (acceptance 3)
// ===========================================================================

section('E. createElement -> serialize -> re-parse')

test('every catalog element type round-trips identically through a temp staff', () => {
  const project = createEmptyProject(makeTemp('dremu-create-'), 'Create Test')
  const staff = project.staffs[0]
  const items = staff._staffFile.members[0].chartArray.items
  const created = []
  for (const entry of CATALOG.elements) {
    const value = createElement(entry.type, { start: 1.25, lane: 'LaneA' })
    assert.equal(value.t, 'obj')
    assert.equal(value.type, entry.type, 'createElement returns the canonical type')
    items.push(value)
    created.push(value)
  }
  const text = serializeGorgeFile(staff._staffFile)
  const reparsed = parseGorgeFile(text)
  const backItems = reparsed.members[0].chartArray.items
  assert.equal(backItems.length, created.length)
  for (let i = 0; i < created.length; i += 1) {
    assert.equal(backItems[i].t, 'obj')
    assert.equal(backItems[i].type, created[i].type)
    assert.deepEqual(backItems[i].fields, created[i].fields, `${created[i].type} fields lost in round-trip`)
  }
  assert.equal(serializeGorgeFile(reparsed), text, 'serialisation is byte-stable after re-parse')
})

test('createElement fills the timing/lane fields from options', () => {
  const tap = createElement('DremuTap', { start: 2.5, lane: 'Main1' })
  assert.equal(tap.fields.hitTime, 2.5)
  assert.equal(tap.fields.laneName, 'Main1')
  const lane = createElement('MainLane', { start: 3, lane: 'MyLane' })
  assert.equal(lane.fields.generateTime, 3)
  assert.equal(lane.fields.name, 'MyLane')
  const hold = createElement('Hold', { start: 1, lane: 'Main1', duration: 2.5 })
  assert.equal(hold.fields.hitTime, 1)
  assert.equal(hold.fields.holdTime, 2.5)
  const image = createElement('Image', { start: 4 })
  assert.equal(image.fields.startMoment, 4)
  assert.equal(image.fields.positionMode.t, 'ref')
})

test('createElement rejects unknown types (programmer error)', () => {
  assert.throws(() => createElement('Nope.Nope'), /unknown element type/)
})

test('elements created via applyOps also round-trip through save + reload', () => {
  const dir = makeTemp('dremu-create-save-')
  const project = createEmptyProject(dir, 'Ops Create')
  const added = CATALOG.elements.map((entry, index) => ({ op: 'add', staffId: 'DremuStaff.g', periodId: 'p0', element: { id: `made-${index}`, type: entry.type, fields: { ...(index === 6 ? { hitTime: 0.5 } : {}) } } }))
  const result = applyOps(project, added)
  assert.deepEqual(result.errors, [])
  assert.equal(result.created.length, CATALOG.elements.length)
  const saved = saveProject(project)
  assert.deepEqual(saved.errors, [])
  const reloaded = loadProject(dir)
  const wire = projectToWire(reloaded, { rev: 1 })
  const staffWire = wire.project.staffs.find((staff) => staff.kind === 'chart')
  assert.equal(staffWire.periods[0].elements.length, CATALOG.elements.length)
  for (let i = 0; i < CATALOG.elements.length; i += 1) assert.equal(staffWire.periods[0].elements[i].type, CATALOG.elements[i].type)
})

// ===========================================================================
// F. applyOps mutations on a copy of Chart 2 (acceptance 4)
// ===========================================================================

section('F. applyOps add/patch/remove/duplicate/setMeta/setStaffName/setPeriodConfig on a copy')

const opsDir = makeTemp('dremu-ops-')
const opsNames = copyStaffFiles(CHART2_DIR, opsDir)
assert.ok(opsNames.includes('DremuStaff.g'))

test('a mutation batch applies in order, saves, and reloads with the changes', () => {
  const project = loadProject(opsDir)
  const staff = staffById(project, 'DremuStaff.g')
  const period = periodById(staff, 'p0')
  const originalElements = period.elements.length
  assert.equal(originalElements, 3)
  const firstId = period.elements[0].id
  const beforeText = fs.readFileSync(path.join(CHART2_DIR, 'DremuStaff.g'), 'utf8')
  const originalBytes = fs.readFileSync(path.join(CHART2_DIR, 'DremuStaff.g'))

  const result = applyOps(project, [
    { op: 'add', staffId: 'DremuStaff.g', periodId: 'p0', element: { id: 'test-add-1', type: 'Dremu.DremuTap', fields: { laneName: 'mainLine01', hitTime: 3.5 } } },
    { op: 'patch', elementId: 'test-add-1', path: ['hitTime'], value: 4.25 },
    { op: 'add', staffId: 'DremuStaff.g', element: { type: 'Hold', start: 9.5, fields: { laneName: 'mainLine01' } } },
    { op: 'duplicate', elementId: 'test-add-1', newId: 'test-dup-1', timeShift: 2 },
    { op: 'patch', elementId: firstId, path: [], value: { name: 'renamedLane', laneLines: { t: 'arr', type: 'FunctionCurve', items: [{ t: 'obj', type: 'ConstantFunctionCurve', fields: { value: 0 } }] } } },
    { op: 'setStaffName', staffId: 'DremuStaff.g', displayName: '测试谱表' },
    { op: 'setPeriodConfig', staffId: 'DremuStaff.g', periodId: 'p0', fields: { minLength: 12 } },
    { op: 'setMeta', tempo: { bpm: 150, offset: 0.5 }, title: 'Edited Title' },
    { op: 'remove', elementId: 'test-dup-1' },
    // The following must be reported but must not abort the batch above.
    { op: 'add', staffId: 'DremuStaff.g', periodId: 'p0', element: { type: 'Not.A.Type' } },
    { op: 'patch', elementId: 'missing-id', path: ['hitTime'], value: 0 },
    { op: 'patch', elementId: 'test-add-1', path: ['no', 'such', 'path'], value: 1 },
    { op: 'remove', elementId: 'missing-id' },
    { op: 'bogus-op' },
    { op: 'patch', elementId: 'test-add-1', path: ['hitTime'], value: 5, extraKey: true },
  ])
  assert.equal(result.changed, true)
  assert.equal(result.created.length, 3, `created: ${JSON.stringify(result.created)}`)
  assert.deepEqual(result.created.map((item) => item.elementId), ['test-add-1', result.created[1].elementId, 'test-dup-1'])
  assert.equal(result.created[1].periodId, 'p0')
  assert.ok(result.errors.length >= 6, `expected reported errors, got ${JSON.stringify(result.errors)}`)
  assert.ok(result.errors.some((error) => /unknown element type/.test(error)))
  assert.ok(result.errors.some((error) => /unknown element "missing-id"/.test(error)))
  assert.ok(result.errors.some((error) => /unsupported op/.test(error)))
  assert.ok(result.errors.some((error) => /unknown key/.test(error)))
  assert.ok(result.errors.some((error) => /not found/.test(error)))
  // Prefix semantics: everything before the bad ops applied.
  assert.equal(period.elements.length, originalElements + 2) // +tap, +hold, duplicate removed
  const added = period.elements.find((element) => element.id === 'test-add-1')
  assert.ok(added)
  // The last patch also carries an unknown key: it is reported in errors but its
  // known parts still apply (tolerant handling), so hitTime ends up 5.
  assert.equal(added.fields.hitTime, 5, 'patch applied and re-patched')
  assert.equal(added.start, 5)
  const hold = period.elements[period.elements.length - 1]
  assert.equal(hold.type, 'Dremu.DremuHold')
  assert.equal(hold.start, 9.5)
  assert.equal(hold.duration, 1)
  assert.equal(period.elements[0].fields.name, 'renamedLane', 'path [] replaces the whole fields map')
  assert.equal(period.minLength, 12)
  assert.deepEqual(project.tempo, { bpm: 150, offset: 0.5 })
  assert.equal(project.title, 'Edited Title')
  assert.equal(project.dirty, true)
  assert.ok(fs.readFileSync(path.join(opsDir, 'DremuStaff.g'), 'utf8') === beforeText, 'nothing written before save')

  // Save: only the changed staff file is rewritten; the .bak keeps the original.
  const saved = saveProject(project)
  assert.deepEqual(saved.errors, [])
  assert.deepEqual(saved.written.map((file) => path.basename(file)), ['DremuStaff.g'])
  assert.ok(fs.readFileSync(path.join(opsDir, 'DremuStaff.g.bak')).equals(originalBytes), '.bak keeps the pre-session bytes')
  assert.equal(project.dirty, false)

  // Reload: the changes are persisted and element ids are re-derived by position.
  const reloaded = loadProject(opsDir)
  const reloadedStaff = staffById(reloaded, 'DremuStaff.g')
  const reloadedPeriod = periodById(reloadedStaff, 'p0')
  assert.equal(reloadedStaff.displayName, '测试谱表', 'setStaffName edit reloaded')
  assert.equal(reloadedPeriod.minLength, 12, 'PeriodConfig edit reloaded')
  assert.equal(reloadedPeriod.elements.length, 5, 'add/duplicate/remove survived save/reload')
  assert.deepEqual(
    reloadedPeriod.elements.map((element) => element.start).sort((a, b) => a - b),
    [0, 2.842105, 5, 7.31579, 9.5],
  )
  assert.deepEqual(
    reloadedPeriod.elements.map((element) => element.id),
    reloadedPeriod.elements.map((element, index) => `DremuStaff.g:p0:e${index}`),
    'ids follow the deterministic position rule after reload',
  )
  const reloadedHold = reloadedPeriod.elements.find((element) => element.type === 'Dremu.DremuHold')
  assert.ok(reloadedHold)
  assert.equal(reloadedHold.duration, 1)
  const reloadedTap = reloadedPeriod.elements.find((element) => element.start === 5)
  assert.ok(reloadedTap)
  assert.equal(reloadedTap.fields.hitTime, 5)
  const text = fs.readFileSync(path.join(opsDir, 'DremuStaff.g'), 'utf8')
  assert.ok(text.includes('测试谱表'))
  assert.ok(/minLength : 12\.0/.test(text))
  assert.ok(/DremuHold/.test(text))
  // Another save is a no-op.
  assert.deepEqual(saveProject(reloaded), { written: [], errors: [] })
})

test('save writes ONLY the changed staff file, atomically, with a .bak', () => {
  const dir = makeTemp('dremu-write-')
  copyStaffFiles(CHART2_DIR, dir)
  const project = loadProject(dir)
  const staff = staffById(project, 'DremuStaff.g')
  const elementId = staff.periods[0].elements[1].id
  const before = fs.readFileSync(path.join(dir, 'DremuStaff.g'))
  assert.deepEqual(applyOps(project, [{ op: 'patch', elementId, path: ['hitTime'], value: 6.5 }]).errors, [])
  const result = saveProject(project)
  assert.deepEqual(result.errors, [])
  assert.deepEqual(result.written.map((file) => path.basename(file)), ['DremuStaff.g'])
  const after = fs.readFileSync(path.join(dir, 'DremuStaff.g'))
  assert.ok(!before.equals(after), 'changed file was rewritten')
  assert.ok(before.equals(fs.readFileSync(path.join(dir, 'DremuStaff.g.bak'))), '.bak keeps the pre-session bytes')
  const untouched = fs.readFileSync(path.join(CHART2_DIR, 'AudioStaff.g'))
  assert.ok(untouched.equals(fs.readFileSync(path.join(dir, 'AudioStaff.g'))), 'unchanged staff file not rewritten')
  assert.ok(!fs.existsSync(path.join(dir, 'AudioStaff.g.bak')), 'no .bak for untouched files')
  assert.equal(project.dirty, false)
})

test('patch paths navigate typed value trees (color points, nested fields)', () => {
  const dir = makeTemp('dremu-patch-')
  copyStaffFiles(CORPUS_DIR, dir)
  const project = loadProject(dir)
  const tap = allElements(project).find(({ element }) => element.type === 'Dremu.DremuTap')
  assert.ok(tap, 'corpus has a tap')
  const { element } = tap
  // Remember the position so the check still works after ids are re-derived.
  const staffId = tap.staff.id
  const periodId = tap.period.id
  const elementIndex = tap.period.elements.indexOf(element)
  const path = ['color', 'fields', 'colorPoints', 'items', 0, 'fields', 'r']
  assert.deepEqual(applyOps(project, [{ op: 'patch', elementId: element.id, path, value: 0.5 }]).errors, [])
  let current = element.fields
  for (const segment of path) current = Array.isArray(current) ? current[Number(segment)] : current[segment]
  assert.equal(current, 0.5)
  const saveResult = saveProject(project)
  assert.deepEqual(saveResult.errors, [])
  const reloaded = loadProject(dir)
  const sameElement = periodById(staffById(reloaded, staffId), periodId).elements[elementIndex]
  assert.equal(sameElement.fields.color.fields.colorPoints.items[0].fields.r, 0.5, 'nested patch persisted to disk')
})

test('applyOps is total: bad inputs return errors, never throw', () => {
  const project = createEmptyProject(makeTemp('dremu-total-'))
  for (const ops of [null, 'nope', 42, [null], [{}], [{ op: 7 }]]) {
    let result
    assert.doesNotThrow(() => {
      result = applyOps(project, ops)
    })
    assert.equal(result.changed, false)
    assert.ok(result.errors.length >= 1)
    assert.ok(Array.isArray(result.created))
  }
  assert.doesNotThrow(() => applyOps(null, []))
  assert.equal(applyOps(null, []).changed, false)
})

test('add without periodId picks the period containing element.start', () => {
  const dir = makeTemp('dremu-periods-')
  const project = createEmptyProject(dir, 'Periods')
  assert.deepEqual(applyOps(project, [{ op: 'setPeriodConfig', periodId: 'p0', fields: { minLength: 10 } }]).errors, [])
  const alloc = applyOps(project, [{ op: 'add', staffId: 'DremuStaff.g', element: { type: 'Tap', start: 9, fields: { laneName: 'Main1' } } }])
  assert.deepEqual(alloc.errors, [])
  const staff = staffById(project, 'DremuStaff.g')
  assert.equal(staff.periods.length, 1, 'single bounded period contains 9')
  const first = staff.periods[0]
  assert.equal(first.elements.length, 1)
  assert.equal(first.elements[0].start, 9)
  // A staff with no periods gets one allocated at the requested absolute time.
  const bare = createEmptyProject(makeTemp('dremu-periods2-'))
  bare.staffs[0].periods = []
  bare.staffs[0]._staffFile.members = []
  const allocated = applyOps(bare, [{ op: 'add', staffId: 'DremuStaff.g', element: { type: 'Tap', start: 12.5, fields: { laneName: 'Main1' } } }])
  assert.deepEqual(allocated.errors, [])
  assert.equal(bare.staffs[0].periods.length, 1)
  assert.equal(bare.staffs[0].periods[0].timeOffset, 12.5)
  assert.equal(bare.staffs[0].periods[0].elements[0].start, 12.5)
})

test('duplicate honours newId/timeShift and remove shrinks the chart array', () => {
  const dir = makeTemp('dremu-dupe-')
  const project = createEmptyProject(dir, 'Dupe')
  applyOps(project, [{ op: 'add', staffId: 'DremuStaff.g', element: { id: 'orig-1', type: 'Tap', start: 1, fields: { laneName: 'Main1', hitTime: 1 } } }])
  const staff = staffById(project, 'DremuStaff.g')
  assert.equal(staff.periods[0].elements.length, 1)
  const dup = applyOps(project, [{ op: 'duplicate', elementId: 'orig-1', newId: 'copy-1', timeShift: 0.5 }])
  assert.deepEqual(dup.created, [{ elementId: 'copy-1', staffId: 'DremuStaff.g', periodId: 'p0' }])
  assert.equal(staff.periods[0].elements.length, 2)
  assert.equal(staff.periods[0].elements[1].fields.hitTime, 1.5)
  assert.equal(staff.periods[0].elements[1].start, 1.5)
  assert.deepEqual(applyOps(project, [{ op: 'remove', elementId: 'orig-1' }]).errors, [])
  assert.equal(staff.periods[0].elements.length, 1)
  assert.equal(staff.periods[0].elements[0].id, 'copy-1')
  assert.equal(staff._staffFile.members[0].chartArray.items.length, 1, 'backing chart array shrinks too')
  const saved = saveProject(project)
  assert.deepEqual(saved.errors, [])
  const reloaded = loadProject(dir)
  const chartStaff = reloaded.staffs.find((item) => item.kind === 'chart')
  assert.equal(chartStaff.periods[0].elements.length, 1)
  assert.equal(chartStaff.periods[0].elements[0].fields.hitTime, 1.5)
})

test('setPeriodConfig.timeOffset moves the period and all its absolute element times', () => {
  const dir = makeTemp('dremu-offset-')
  const project = createEmptyProject(dir, 'Offset')
  applyOps(project, [{ op: 'add', staffId: 'DremuStaff.g', element: { type: 'Tap', start: 2, fields: { laneName: 'Main1' } } }])
  const staff = staffById(project, 'DremuStaff.g')
  assert.equal(staff.periods[0].elements[0].start, 2)
  assert.deepEqual(applyOps(project, [{ op: 'setPeriodConfig', periodId: 'p0', staffId: 'DremuStaff.g', fields: { timeOffset: 10 } }]).errors, [])
  const wire = projectToWire(project, { rev: 1 })
  const chartStaff = wire.project.staffs.find((item) => item.kind === 'chart')
  assert.equal(chartStaff.periods[0].timeOffset, 10)
  assert.equal(chartStaff.periods[0].elements[0].start, 12, 'absolute start includes the new offset')
  assert.equal(chartStaff.periods[0].elements[0].fields.hitTime, 2, 'relative time field unchanged')
})

// ===========================================================================
// G. elementTiming
// ===========================================================================

section('G. elementTiming')

test('notes: absolute start = period.timeOffset + hitTime, duration for holds only', () => {
  assert.deepEqual(elementTiming({ type: 'Dremu.DremuTap', fields: { hitTime: 2.842105, laneName: 'Main1' } }, { timeOffset: 10 }), {
    start: 12.842105,
    duration: null,
    lane: 'Main1',
    category: 'note',
  })
  assert.deepEqual(elementTiming({ type: 'Dremu.DremuHold', fields: { hitTime: 1, holdTime: 0.2105263, laneName: 'L' } }, { timeOffset: 0 }), {
    start: 1,
    duration: 0.210526,
    lane: 'L',
    category: 'hold',
  })
})

test('lanes: generateTime/keepTime/name', () => {
  const lane = elementTiming({ type: 'Dremu.DremuMainLane', fields: { name: 'ArtLine1', generateTime: 3, keepTime: 1.052632 } }, { timeOffset: -1 })
  assert.deepEqual(lane, { start: 2, duration: 1.052632, lane: 'ArtLine1', category: 'lane' })
  const guide = elementTiming({ type: 'Dremu.DremuGuideLane', fields: { name: 'Guide1', generateTime: 0.5, keepTime: 1.25 } }, 5)
  assert.deepEqual(guide, { start: 5.5, duration: 1.25, lane: 'Guide1', category: 'lane' })
})

test('missing duration fields fall back to the engine defaults', () => {
  // DremuStaff1.g period 1 defines two MainLanes without an explicit keepTime.
  const laneStaff = staffById(dremuTest, 'DremuStaff1.g')
  const laneWithoutKeep = laneStaff.periods[1].elements.find((element) => element.category === 'lane' && element.fields.keepTime === undefined)
  assert.ok(laneWithoutKeep, 'corpus has a lane without keepTime')
  assert.equal(elementTiming(laneWithoutKeep, laneStaff.periods[1]).duration, 10, 'lane keepTime default 10.0')
  assert.equal(elementTiming({ type: 'Dremu.DremuHold', fields: { hitTime: 0, laneName: 'L' } }, 0).duration, 1, 'holdTime default 1.0')
  assert.equal(elementTiming({ type: 'DeentyStoryboard.Image', fields: { startMoment: 0 } }, 0).duration, 1, 'image keepTime default 1.0')
})

test('storyboard images: startMoment (default 0) + keepTime', () => {
  const image = elementTiming({ type: 'DeentyStoryboard.Image', fields: { startMoment: 21.47368, keepTime: 21.47368 } }, { timeOffset: -0.2631579 })
  assert.equal(image.start, 21.210522)
  assert.equal(image.duration, 21.47368)
  assert.equal(image.lane, null)
  assert.equal(image.category, 'other')
  assert.equal(elementTiming({ type: 'Image', fields: { keepTime: 5 } }, { timeOffset: 0 }).start, 0)
})

test('hold inner notes are relative to the owning hold (parentStart)', () => {
  const note = elementTiming({ type: 'Dremu.DremuHoldInnerNote', fields: { hitTime: 0.5 } }, { timeOffset: 100 }, { parentStart: 5 })
  assert.equal(note.start, 5.5)
  assert.equal(note.duration, null)
  assert.equal(note.category, 'inner')
})

test('fallbacks: unknown types, expr values, rounding', () => {
  assert.equal(elementTiming({ type: 'X.Unknown', fields: { startMoment: 3 } }, { timeOffset: 10 }).start, 13)
  assert.equal(elementTiming({ type: 'X.Unknown', fields: { hitTime: 3 } }, { timeOffset: 10 }).start, 13)
  assert.equal(elementTiming({ type: 'X.Unknown', fields: { generateTime: 3 } }, { timeOffset: 10 }).start, 13)
  assert.equal(elementTiming({ type: 'Dremu.DremuTap', fields: { hitTime: { t: 'expr', src: '(1.0/0.0)', special: 'Infinity' } } }, { timeOffset: 7 }).start, 7)
  assert.equal(elementTiming({ type: 'Dremu.DremuTap', fields: { hitTime: 1 / 3 } }, { timeOffset: 0 }).start, 0.333333)
})

// ===========================================================================
// H. evaluateCurve
// ===========================================================================

section('H. evaluateCurve')

const curve = (type, fields) => ({ t: 'obj', type: `GorgeFramework.${type}`, fields })

test('scalar curves evaluate per the documented maths', () => {
  assert.equal(evaluateCurve(curve('ConstantFunctionCurve', { value: 3 }), 42), 3)
  assert.equal(evaluateCurve(curve('LinearFunctionCurve', { k: 2, b: 1 }), 3), 7)
  assert.equal(evaluateCurve(curve('LinearCurve', { timeStart: 0, valueStart: 0, timeEnd: 2, valueEnd: 4 }), 1), 2)
  assert.equal(evaluateCurve(curve('LinearCurve', { timeStart: 0, valueStart: 0, timeEnd: 2, valueEnd: 4 }), 5), 4, 'clamped after timeEnd')
  assert.equal(evaluateCurve(curve('LinearCurve', { timeStart: 2, valueStart: 9, timeEnd: 2, valueEnd: 3 }), 2), 3, 'degenerate range')
  // Engine defaults are the identity ramp (valueStart 0, valueEnd 1).
  assert.equal(evaluateCurve(curve('LinearCurve', { timeStart: 0, timeEnd: 0.5 }), 0.25), 0.5)
  assert.equal(evaluateCurve(curve('CubicHermiteSpline', { startPoint: { t: 'obj', type: 'GorgeFramework.Vector2', fields: { x: 0, y: 0 } }, endPoint: { t: 'obj', type: 'GorgeFramework.Vector2', fields: { x: 1, y: 1 } } }), 0), 0)
  assert.equal(evaluateCurve(curve('CubicHermiteSpline', { startPoint: { t: 'obj', type: 'GorgeFramework.Vector2', fields: { x: 0, y: 0 } }, endPoint: { t: 'obj', type: 'GorgeFramework.Vector2', fields: { x: 1, y: 1 } } }), 1), 1)
  assert.equal(evaluateCurve(curve('CubicHermiteSpline', { startPoint: { t: 'obj', type: 'GorgeFramework.Vector2', fields: { x: 0, y: 0 } }, endPoint: { t: 'obj', type: 'GorgeFramework.Vector2', fields: { x: 1, y: 1 } } }), 0.5), 0.5)
  // Clamped flat outside the point range, and a non-classic weight changes the
  // curve shape (Unity weighted-tangent solver).
  const plainSpline = curve('CubicHermiteSpline', {
    startPoint: { t: 'obj', type: 'GorgeFramework.Vector2', fields: { x: 0, y: 0 } },
    endPoint: { t: 'obj', type: 'GorgeFramework.Vector2', fields: { x: 1, y: 1 } },
  })
  assert.equal(evaluateCurve(plainSpline, -2), 0, 'clamped before startPoint.x')
  assert.equal(evaluateCurve(plainSpline, 8), 1, 'clamped after endPoint.x')
  const weightedSpline = curve('CubicHermiteSpline', {
    startPoint: { t: 'obj', type: 'GorgeFramework.Vector2', fields: { x: 0, y: 0 } },
    startTangent: 2,
    startWeight: 0.9,
    endPoint: { t: 'obj', type: 'GorgeFramework.Vector2', fields: { x: 1, y: 1 } },
    endWeight: 0.1,
  })
  const weightedMid = evaluateCurve(weightedSpline, 0.5)
  assert.ok(Number.isFinite(weightedMid) && weightedMid > 0.5, `weighted tangent lifts the midpoint (${weightedMid})`)
  assert.equal(evaluateCurve(weightedSpline, 0), 0)
  assert.equal(evaluateCurve(weightedSpline, 1), 1)
})

test('composite curves: piecewise, axial, periodic, addition, composite', () => {
  const constant = (value) => curve('ConstantFunctionCurve', { value })
  const linear = curve('LinearFunctionCurve', { k: 1, b: 0 })
  const piecewise = curve('PiecewiseFunctionCurve', {
    functionPieces: {
      t: 'arr',
      type: 'GorgeFramework.FunctionPiece',
      items: [
        { t: 'obj', type: 'GorgeFramework.FunctionPiece', fields: { functionCurve: constant(-1), startX: 0, endX: 1 } },
        { t: 'obj', type: 'GorgeFramework.FunctionPiece', fields: { functionCurve: constant(1), startX: 1, endX: 2 } },
      ],
    },
  })
  assert.equal(evaluateCurve(piecewise, 0.5), -1)
  assert.equal(evaluateCurve(piecewise, 1.5), 1)
  assert.equal(evaluateCurve(piecewise, 9), 0, 'outside all pieces: 0 (engine)')
  assert.equal(evaluateCurve(curve('AxialSymmetricFunctionCurve', { functionCurve: linear, axis: 2, keepLeft: false }), 1), 3)
  assert.equal(evaluateCurve(curve('AxialSymmetricFunctionCurve', { functionCurve: linear, axis: 2, keepLeft: true }), 2.5), 1.5)
  assert.equal(evaluateCurve(curve('PeriodicFunctionCurve', { functionCurve: linear, startX: 0, endX: 2 }), 5), 1)
  assert.equal(evaluateCurve(curve('AdditionFunctionCurve', { firstFunctionCurve: constant(2), secondFunctionCurve: linear }), 3), 5)
  assert.equal(evaluateCurve(curve('CompositeFunctionCurve', { outerFunctionCurve: curve('LinearFunctionCurve', { k: 2, b: 0 }), innerFunctionCurve: constant(3) }), 0), 6)
})

test('VariableFloat adds the variation curve to baseValue', () => {
  assert.equal(evaluateCurve(curve('VariableFloat', { baseValue: 2 }), 5), 2)
  assert.equal(evaluateCurve(curve('VariableFloat', { baseValue: 2, variationCurve: curve('ConstantFunctionCurve', { value: -0.5 }) }), 5), 1.5)
})

test('LerpColorCurve returns an interpolated {r,g,b,a}', () => {
  const noAlpha = (r, g, b) => ({ t: 'obj', type: 'GorgeFramework.ColorArgb', fields: { r, g, b } })
  const colored = curve('LerpColorCurve', {
    colorPoints: { t: 'arr', type: 'GorgeFramework.ColorArgb', items: [noAlpha(0, 0, 0), noAlpha(1, 1, 1)] },
    progressCurve: curve('LinearFunctionCurve', { k: 1, b: 0 }),
  })
  const middle = evaluateCurve(colored, 0.5)
  assert.ok(Math.abs(middle.r - 0.5) < 1e-9 && Math.abs(middle.g - 0.5) < 1e-9 && Math.abs(middle.b - 0.5) < 1e-9)
  assert.equal(middle.a, 1, 'missing alpha defaults to 1')
  const single = evaluateCurve(curve('LerpColorCurve', { colorPoints: { t: 'arr', type: 'GorgeFramework.ColorArgb', items: [noAlpha(1, 0, 0)] } }), 0.9)
  assert.deepEqual(single, { r: 1, g: 0, b: 0, a: 1 })
  // No progress curve => the first stop; empty stops => engine white.
  const noProgress = curve('LerpColorCurve', { colorPoints: { t: 'arr', type: 'GorgeFramework.ColorArgb', items: [noAlpha(0.25, 0.5, 0.75), noAlpha(1, 1, 1)] } })
  assert.deepEqual(evaluateCurve(noProgress, 0.9), { r: 0.25, g: 0.5, b: 0.75, a: 1 })
  assert.deepEqual(evaluateCurve(curve('LerpColorCurve', { colorPoints: { t: 'arr', type: 'GorgeFramework.ColorArgb', items: [] } }), 0), { r: 1, g: 1, b: 1, a: 1 })
})

test('unknown values return null; raw numbers pass through', () => {
  assert.equal(evaluateCurve(null, 0), null)
  assert.equal(evaluateCurve({ t: 'ref', path: 'X.Y' }, 0), null)
  assert.equal(evaluateCurve(curve('NotACurve', {}), 0), null)
  assert.equal(evaluateCurve(5, 0), 5)
})

// ===========================================================================
// I. projectToWire
// ===========================================================================

section('I. projectToWire')

test('wire state has the contract shape and exact staff/period/element keys', () => {
  const wire = projectToWire(dremuTest, { rev: 11 })
  assert.deepEqual(Object.keys(wire).sort(), ['catalog', 'dirty', 'project', 'rev'])
  assert.equal(wire.rev, 11)
  assert.equal(wire.dirty, false)
  assert.equal(wire.catalog, CATALOG)
  const project = wire.project
  assert.deepEqual(Object.keys(project).sort(), ['assets', 'audio', 'dir', 'duration', 'form', 'id', 'staffs', 'tempo', 'title', 'warnings'])
  assert.ok(path.isAbsolute(project.dir))
  assert.deepEqual(Object.keys(project.tempo).sort(), ['bpm', 'offset'])
  assert.deepEqual(Object.keys(project.audio).sort(), ['duration', 'file', 'name', 'offset'])
  assert.ok(path.isAbsolute(project.audio.file))
  for (const staff of project.staffs) {
    assert.deepEqual(Object.keys(staff).sort(), ['className', 'displayName', 'file', 'form', 'id', 'kind', 'periods'])
    for (const period of staff.periods) {
      assert.deepEqual(Object.keys(period).sort(), ['elements', 'id', 'method', 'minLength', 'timeOffset'])
      for (const element of period.elements) {
        assert.deepEqual(Object.keys(element).sort(), ['category', 'duration', 'fields', 'id', 'lane', 'start', 'type'])
        assert.equal(typeof element.start, 'number')
        assert.ok(element.duration === null || typeof element.duration === 'number')
      }
    }
  }
  assert.ok(!JSON.stringify(project).includes('"_staffFile"'))
  assert.ok(!JSON.stringify(project).includes('"_origText"'))
})

test('dirty/rev overrides work and the wire is isolated from the model', () => {
  const wire = projectToWire(dremuTest, { rev: 3, dirty: true })
  assert.equal(wire.dirty, true, 'Host dirty flag overrides the model flag')
  assert.equal(wire.rev, 3)
  const element = wire.project.staffs.find((staff) => staff.kind === 'chart').periods[0].elements[0]
  const nameBefore = element.fields.name
  element.fields.name = 'mutated-wire-only'
  const wire2 = projectToWire(dremuTest, { rev: 4 })
  assert.equal(wire2.project.staffs.find((staff) => staff.kind === 'chart').periods[0].elements[0].fields.name, nameBefore)
})

// ===========================================================================
// J. validateProject
// ===========================================================================

section('J. validateProject')

test('returns advisory issues with a stable shape', () => {
  const issues = validateProject(dremuTest)
  assert.ok(Array.isArray(issues))
  const levels = new Set(['error', 'warning', 'info'])
  for (const issue of issues) {
    assert.ok(levels.has(issue.level), `level ${issue.level}`)
    assert.ok(typeof issue.code === 'string' && issue.code.length > 0)
    assert.ok(typeof issue.message === 'string' && issue.message.length > 0)
  }
  assert.ok(!issues.some((issue) => issue.code === 'unknown-element-type'), 'no unknown element types in the corpus')
  assert.ok(!issues.some((issue) => issue.level === 'error' || issue.level === 'warning'), `real corpus validates clean: ${JSON.stringify(issues.slice(0, 5))}`)
})

test('detects unknown lanes, duplicate ids, empty periods and missing audio files', () => {
  const dir = makeTemp('dremu-validate-')
  const project = createEmptyProject(dir, 'Validate')
  assert.ok(validateProject(project).some((issue) => issue.code === 'empty-period'))
  applyOps(project, [{ op: 'add', staffId: 'DremuStaff.g', element: { id: 'v1', type: 'Tap', start: 1, fields: { laneName: 'NoSuchLane' } } }])
  const issues = validateProject(project)
  assert.ok(issues.some((issue) => issue.code === 'unknown-lane'))
  const staff = staffById(project, 'DremuStaff.g')
  staff.periods[0].elements.push({ ...staff.periods[0].elements[0], id: 'v1' }) // duplicate id
  assert.ok(validateProject(project).some((issue) => issue.code === 'duplicate-element-id'))
  project.audio = { file: path.join(dir, 'nope.wav'), name: 'x', duration: null, offset: 0 }
  assert.ok(validateProject(project).some((issue) => issue.code === 'missing-audio'))
  assert.doesNotThrow(() => validateProject(null))
  assert.ok(validateProject(null).some((issue) => issue.code === 'no-project'))
})

// ===========================================================================
// K. createEmptyProject
// ===========================================================================

section('K. createEmptyProject + first save')

test('starts with one chart staff/period and is savable + reloadable', () => {
  const dir = path.join(makeTemp('dremu-empty-'), 'nested-project')
  const project = createEmptyProject(dir, 'My Chart')
  assert.equal(project.title, 'My Chart')
  assert.equal(project.dir, path.resolve(dir))
  assert.equal(project.form, 'Dremu')
  assert.equal(project.staffs.length, 1)
  const staff = project.staffs[0]
  assert.equal(staff.id, 'DremuStaff.g')
  assert.equal(staff.kind, 'chart')
  assert.equal(staff.periods.length, 1)
  assert.equal(staff.periods[0].timeOffset, 0)
  assert.equal(project.dirty, true)
  assert.ok(!fs.existsSync(dir), 'nothing written before save')
  const saved = saveProject(project)
  assert.deepEqual(saved.errors, [])
  assert.equal(saved.written.length, 1)
  assert.ok(fs.existsSync(staff.file))
  assert.equal(project.dirty, false)
  const reloaded = loadProject(dir)
  assert.equal(reloaded.staffs.length, 1)
  assert.equal(reloaded.staffs[0].periods.length, 1)
  assert.equal(reloaded.staffs[0].periods[0].elements.length, 0)
  assert.equal(reloaded.title, 'nested-project', 'title is the directory basename on reload')
  assert.deepEqual(saveProject(reloaded), { written: [], errors: [] })
})

// ===========================================================================
// L. save safety
// ===========================================================================

section('L. saveProject safety')

test('refuses to write outside the project directory', () => {
  const dir = makeTemp('dremu-safe-')
  const project = createEmptyProject(dir, 'Safe')
  const outside = path.join(os.tmpdir(), `dremu-escape-${process.pid}-${Date.now()}.g`)
  try {
    fs.rmSync(outside, { force: true })
  } catch {
    /* ignore */
  }
  project.staffs[0].file = outside
  const result = saveProject(project)
  assert.equal(result.written.length, 0)
  assert.ok(result.errors.some((error) => /outside the project directory/.test(error)))
  assert.ok(!fs.existsSync(outside), 'no file escaped the project directory')
})

test('a serialisation failure is reported and never loses the file on disk', () => {
  const dir = makeTemp('dremu-serialise-')
  const project = createEmptyProject(dir, 'Serialise')
  const staff = project.staffs[0]
  assert.deepEqual(saveProject(project).errors, [])
  const textBefore = fs.readFileSync(staff.file, 'utf8')
  // Corrupt the in-memory tree: the codec writer throws on unknown value tags.
  staff._staffFile.members[0].chartArray.items.push({ t: 'bogus' })
  project.dirty = true
  const result = saveProject(project)
  assert.ok(result.errors.some((error) => /cannot serialise/.test(error)), JSON.stringify(result.errors))
  assert.equal(fs.readFileSync(staff.file, 'utf8'), textBefore, 'file on disk untouched after a failed serialisation')
  assert.equal(project.dirty, true, 'project remains dirty so the user can fix/save again')
})

test('a write failure is reported per file (never throws)', () => {
  const project = createEmptyProject(makeTemp('dremu-writefail-'), 'Write Fail')
  // Turn the project directory path into a file so mkdir/write cannot succeed.
  const blocked = path.join(makeTemp('dremu-blocked-'), 'project-file')
  fs.writeFileSync(blocked, 'not a directory')
  project.dir = blocked
  project.staffs[0].file = path.join(blocked, 'DremuStaff.g')
  let result
  assert.doesNotThrow(() => {
    result = saveProject(project)
  })
  assert.ok(result.errors.length >= 1)
  assert.equal(result.written.length, 0)
})

// ===========================================================================
// M. Determinism & corpus read-only proof
// ===========================================================================

section('M. determinism + read-only corpus')

test('two loads of the same project are byte-for-byte deterministic', () => {
  const first = loadProject(CORPUS_DIR)
  const second = loadProject(CORPUS_DIR)
  assert.equal(wireJson(first, { rev: 0 }), wireJson(second, { rev: 0 }))
  for (const staff of first.staffs) assert.equal(staff._origText, serializeGorgeFile(staff._staffFile))
})

test('the suite never mutated the read-only corpus directory', () => {
  for (const [file, expectedHash] of CORPUS_SNAPSHOT) {
    assert.ok(fs.existsSync(file), `${file} still exists`)
    assert.equal(hashFile(file), expectedHash, `${path.basename(file)} unchanged`)
  }
  const strayBackups = fs.readdirSync(CORPUS_DIR).filter((name) => name.endsWith('.bak'))
  assert.deepEqual(strayBackups, [], 'no .bak files leaked into the corpus')
})

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

cleanupTempDirs()
console.log('')
if (failures.length === 0) {
  console.log(`PASS ${passCount}/${passCount} model checks`)
  process.exitCode = 0
} else {
  console.log(`FAIL ${failures.length} of ${passCount + failures.length} model checks`)
  for (const failure of failures) {
    console.log(`\n[${failure.section}] ${failure.name}`)
    console.log(String((failure.error && failure.error.stack) || failure.error))
  }
  process.exitCode = 1
}
