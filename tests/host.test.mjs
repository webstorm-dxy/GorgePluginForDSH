// Hermetic tests for the Dremu chart studio Host half (index.js).
//
// Everything runs against temp directories under os.tmpdir(): the real chart
// corpus is COPIED before use and never written to. HTTP handlers are driven
// with fake Node `req`/`res` objects, so no socket is opened.
//
// Run from the plugin directory: `node tests/host.test.mjs` (exit 0 = pass).
//
// The script intentionally avoids node:test so it behaves identically in any
// Node version the Host ships with.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'

import {
  Config,
  DEFAULT_STATE_PATH,
  ENDPOINTS,
  apply,
  createEditHandler,
  createEventsHandler,
  createFileHandler,
  createHandlers,
  createImportAudioHandler,
  createOpenHandler,
  createProjectsHandler,
  createReloadHandler,
  createSaveHandler,
  createStateHandler,
  createStore,
  createTools,
  inject as pluginInject,
  isLocalRequest,
  jsonResponse,
  normalizeConfig,
  parseRangeHeader,
  resolveProjectDirectory,
  resolveProjectFile,
  scanProjectRoot,
  workspaceSummary,
} from '../index.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The real, read-only chart corpus. It is always copied before use. */
const FIXTURE_SOURCE = '/Users/daxingyi/Music/DremuTest'
const HOST = '127.0.0.1:58767'
const SAME_ORIGIN_HEADERS = { host: HOST, origin: `http://${HOST}` }
const SILENT_LOGGER = { warn() {} }
const HERE = path.dirname(fileURLToPath(import.meta.url))

const cleanups = []
const tempDirectories = []

process.on('exit', () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      cleanup()
    } catch {
      /* cleanup must never mask the test result */
    }
  }
  for (const directory of tempDirectories.splice(0).reverse()) {
    try {
      fs.rmSync(directory, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }
})

/** Create (and auto-remove) a temp directory. */
function tempDir(prefix = 'gorge-chart-host-') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirectories.push(directory)
  return directory
}

/** Copy the real Dremu test project into a fresh temp root. */
function copyFixture() {
  if (!fs.existsSync(FIXTURE_SOURCE)) {
    throw new Error(`test fixture missing: ${FIXTURE_SOURCE}`)
  }
  const root = tempDir('gorge-chart-fixture-')
  const project = path.join(root, 'DremuTest')
  fs.cpSync(FIXTURE_SOURCE, project, { recursive: true })
  return { root, project }
}

/** One shared read-mostly copy: tests that write to project files copy again. */
let sharedFixture = null
function fixture() {
  if (sharedFixture === null) sharedFixture = copyFixture()
  return sharedFixture
}

/** Fresh copy for tests that must write into the project directory. */
function freshFixture() {
  return copyFixture()
}

// ---------------------------------------------------------------------------
// Fake HTTP transport
// ---------------------------------------------------------------------------

/** Minimal IncomingMessage stand-in. */
class MockRequest extends EventEmitter {
  constructor({ method = 'GET', url = '/', headers = {}, remoteAddress = '127.0.0.1', body = null } = {}) {
    super()
    this.method = method
    this.url = url
    this.headers = headers
    this.socket = { remoteAddress }
    this.rawBody = body
  }

  async *[Symbol.asyncIterator]() {
    if (this.rawBody === null || this.rawBody === undefined) return
    yield Buffer.isBuffer(this.rawBody) ? this.rawBody : Buffer.from(this.rawBody)
  }
}

/** Minimal ServerResponse stand-in that records status, headers, and bytes. */
class MockResponse extends EventEmitter {
  constructor() {
    super()
    this.statusCode = 0
    this.headers = {}
    this.chunks = []
    this.ended = false
    this.headersSent = false
  }

  writeHead(status, headers = {}) {
    this.statusCode = status
    Object.assign(this.headers, headers)
    this.headersSent = true
    return this
  }

  write(chunk) {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
    return true
  }

  end(chunk) {
    if (chunk !== undefined) this.write(chunk)
    if (!this.ended) {
      this.ended = true
      this.emit('finish')
    }
    return this
  }

  get text() {
    return Buffer.concat(this.chunks).toString('utf8')
  }

  json() {
    return JSON.parse(this.text)
  }
}

/** Loopback, same-origin request. */
function localRequest(overrides = {}) {
  return new MockRequest({ headers: { ...SAME_ORIGIN_HEADERS }, ...overrides })
}

/** Loopback request carrying a JSON body. */
function localJsonRequest(url, body, overrides = {}) {
  const raw = JSON.stringify(body)
  return new MockRequest({
    method: 'POST',
    url,
    headers: { ...SAME_ORIGIN_HEADERS, 'content-type': 'application/json' },
    body: raw,
    ...overrides,
  })
}

/** Invoke one handler and return the fake response. */
async function callHandler(handler, req) {
  const res = new MockResponse()
  await handler(req, res)
  return res
}

/** Wait until a streaming file response has finished. */
async function waitForEnd(res) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (res.ended) return res
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('response did not finish')
}

/** Fake Cordis host capturing tools, routes, prompt contexts, and disposers. */
function createFakeHost(options = {}) {
  const present = new Set(options.present || ['tools', 'webServer', 'systemPrompt', 'workingDirectory', 'skills'])
  const tools = new Map()
  const routes = new Map()
  const contexts = new Map()
  const skillProviders = new Map()
  const disposers = []

  function makeContext() {
    return {
      logger: SILENT_LOGGER,
      tools: {
        register(definition) {
          tools.set(definition.name, definition)
          return () => tools.delete(definition.name)
        },
      },
      effect(execute) {
        const dispose = execute()
        if (typeof dispose === 'function') disposers.push(dispose)
        return dispose
      },
      inject(dependencies, callback) {
        const names = Array.isArray(dependencies) ? dependencies : Object.keys(dependencies)
        const child = makeContext()
        if (names.includes('webServer') && present.has('webServer')) {
          child.webServer = {
            register(route) {
              routes.set(route.path, route)
              return () => routes.delete(route.path)
            },
          }
        } else if (names.includes('systemPrompt') && present.has('systemPrompt')) {
          child.systemPrompt = {
            context(entry) {
              contexts.set(entry.name, entry)
              return () => contexts.delete(entry.name)
            },
          }
        } else if (names.includes('workingDirectory') && present.has('workingDirectory')) {
          child.workingDirectory = {
            get() {
              return options.workingDirectory || process.cwd()
            },
          }
        } else if (names.includes('skills') && present.has('skills')) {
          child.skills = {
            registerProvider(create) {
              const provider = create({ signal: new AbortController().signal, invalidate() {} })
              skillProviders.set(provider.name, provider)
              return () => skillProviders.delete(provider.name)
            },
          }
        } else {
          return
        }
        callback(child)
      },
    }
  }

  return {
    ctx: makeContext(),
    tools,
    routes,
    contexts,
    skillProviders,
    dispose() {
      for (const dispose of disposers.splice(0).reverse()) {
        try {
          dispose()
        } catch {
          /* disposal must not mask assertions */
        }
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Store / wire helpers
// ---------------------------------------------------------------------------

/** Store with an isolated recovery snapshot; closed automatically. */
function createTestStore(options = {}) {
  const stateDirectory = tempDir('gorge-chart-state-')
  const store = createStore({
    statePath: path.join(stateDirectory, 'state', 'project.json'),
    projectRoot: options.projectRoot || stateDirectory,
    autoSave: options.autoSave === true,
    persistDebounceMs: 60_000, // tests flush explicitly; never race the debounce
    autoSaveDelayMs: 60_000,
    scanCacheMs: 0,
    resume: options.resume === true,
    logger: SILENT_LOGGER,
    ...(options.create || {}),
  })
  cleanups.push(() => {
    try {
      store.close()
    } catch {
      /* already closed */
    }
  })
  return { store, statePath: path.join(stateDirectory, 'state', 'project.json') }
}

/** Store opened on a fixture copy. */
function openedStore(fixtureValue = fixture(), options = {}) {
  const { store } = createTestStore({ projectRoot: fixtureValue.root, ...options })
  store.open(fixtureValue.project)
  return store
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Every wire element as `{ staff, period, element }`. */
function* wireElements(state) {
  for (const staff of (state.project && state.project.staffs) || []) {
    for (const period of staff.periods || []) {
      for (const element of period.elements || []) yield { staff, period, element }
    }
  }
}

/** First element matching a predicate (default: one with a numeric hitTime). */
function findElement(state, predicate = (element) => isPlainObject(element.fields) && typeof element.fields.hitTime === 'number') {
  for (const entry of wireElements(state)) if (predicate(entry.element)) return entry
  return null
}

function findElementById(state, elementId) {
  for (const entry of wireElements(state)) if (entry.element.id === elementId) return entry
  return null
}

/** Number of wire elements in the open project. */
function countElements(state) {
  let total = 0
  for (const _entry of wireElements(state)) total += 1
  return total
}

/** True when a path stays inside the project directory (symlink-aware). */
function insideProject(candidate, project) {
  if (typeof candidate !== 'string' || candidate.length === 0) return false
  if (candidate === project || candidate.startsWith(project + path.sep)) return true
  try {
    const realProject = fs.realpathSync(project)
    const realCandidate = fs.realpathSync(candidate)
    return realCandidate === realProject || realCandidate.startsWith(realProject + path.sep)
  } catch {
    return false
  }
}

/** Patch op for one element field (the client's op shape: array path). */
function patchOp(elementId, fieldPath, value) {
  return { op: 'patch', elementId, path: Array.isArray(fieldPath) ? fieldPath : [fieldPath], value }
}

// ---------------------------------------------------------------------------
// Tiny test runner
// ---------------------------------------------------------------------------

const tests = []
function test(name, execute) {
  tests.push({ name, execute })
}

function indent(text) {
  return String(text)
    .split('\n')
    .map((line) => `       ${line}`)
    .join('\n')
}

async function run() {
  let passed = 0
  const failures = []
  for (const { name, execute } of tests) {
    try {
      await execute()
      passed += 1
      console.log(`ok   ${name}`)
    } catch (error) {
      failures.push({ name, error })
      console.log(`FAIL ${name}`)
      console.log(indent((error && error.stack) || error))
    }
  }
  console.log('')
  if (failures.length === 0) {
    console.log(`PASS ${passed}/${tests.length} tests`)
    process.exitCode = 0
  } else {
    console.log(`FAIL ${failures.length}/${tests.length} tests (${passed} passed)`)
    for (const failure of failures) console.log(`  - ${failure.name}`)
    process.exitCode = 1
  }
}

// ---------------------------------------------------------------------------
// Configuration and exports
// ---------------------------------------------------------------------------

test('config: zero-config defaults and Standard Schema', () => {
  const config = normalizeConfig({})
  assert.equal(config.projectRoot, path.join(os.homedir(), 'Music'))
  assert.equal(config.autoSave, true)
  assert.equal(config.locale, 'zh')

  const configured = normalizeConfig({ projectRoot: '/tmp/charts', autoSave: false, locale: 'en' })
  assert.equal(configured.projectRoot, path.resolve('/tmp/charts'))
  assert.equal(configured.autoSave, false)
  assert.equal(configured.locale, 'en')
  assert.equal(normalizeConfig({ locale: 'de' }).locale, 'zh', 'unknown locale falls back to zh')
  assert.equal(normalizeConfig(null).projectRoot, path.join(os.homedir(), 'Music'))

  // `Config` is a Standard-Schema compatible callable: the loader validates a
  // row's config through `Config['~standard'].validate`.
  assert.equal(typeof Config, 'function', 'Config is callable like a Schemastery schema')
  assert.equal(typeof Config['~standard'].validate, 'function')
  assert.deepEqual(Config['~standard'].validate({ locale: 'en' }).value.locale, 'en')
  assert.deepEqual(Config({ autoSave: false }).autoSave, false)

  // Regression guard (desktop boot crash, 2026-11-03/04): `dsh-settings` treats
  // every runtime `Config` with a `toJSON` method as a live Schemastery schema,
  // then reads `schema.meta.volatile` while describing namespaces. A lookalike
  // `toJSON()` made `settings/describe` throw a TypeError, which failed the
  // welcome RPC ("desktop welcome: Web RPC failed") and aborted startup.
  // `Config` must stay Standard-Schema-only.
  assert.equal(Config.meta, undefined)
  assert.equal('toJSON' in Config, false, 'Config must not pose as a Schemastery schema')
  const settingsSchema = (runtime) =>
    runtime.Config !== undefined && 'toJSON' in runtime.Config ? runtime.Config : undefined
  assert.equal(settingsSchema({ Config }), undefined, 'the plugin is skipped by Settings forms, not probed')

  assert.ok(DEFAULT_STATE_PATH.endsWith(path.join('state', 'project.json')))
})

test('exports: inject declaration and endpoint table', () => {
  assert.deepEqual(pluginInject, ['tools'])
  assert.deepEqual(Object.keys(ENDPOINTS).sort(), ['edit', 'events', 'file', 'importAudio', 'open', 'projects', 'reload', 'save', 'state'])
  for (const routePath of Object.values(ENDPOINTS)) {
    assert.ok(routePath.startsWith('/plugins/gorge-chart/'), `${routePath} must live under /plugins/gorge-chart/`)
  }
})

test('http: local-only guard and no-store JSON responses', () => {
  assert.equal(isLocalRequest(localRequest()), true)
  assert.equal(isLocalRequest(localRequest({ headers: { host: HOST, origin: 'http://evil.example' } })), false)
  assert.equal(isLocalRequest(localRequest({ headers: { host: 'evil.example:1234' } })), false)
  assert.equal(isLocalRequest(localRequest({ remoteAddress: '10.1.2.3' })), false)
  assert.equal(isLocalRequest(new MockRequest({ remoteAddress: '::1', headers: { host: 'localhost:58767' } })), true)

  const res = new MockResponse()
  jsonResponse(res, 200, { ok: true })
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['cache-control'], 'no-store')
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8')
  assert.deepEqual(res.json(), { ok: true })
})

// ---------------------------------------------------------------------------
// Store: state shape and opening
// ---------------------------------------------------------------------------

test('store: no project open yields a null-project state', () => {
  const { store } = createTestStore()
  const state = store.state()
  assert.equal(state.ok, true)
  assert.equal(state.project, null)
  assert.equal(state.openPath, null)
  assert.equal(state.dirty, false)
  assert.ok(Number.isFinite(state.rev) && state.rev >= 1)
  assert.ok(Array.isArray(state.recent))
  assert.ok(isPlainObject(state.catalog), 'catalog is always present')
  assert.ok(Array.isArray(state.catalog.elements))
  assert.deepEqual(store.projects(), [])
})

test('store: opens a temp copy of DremuTest and produces the documented wire shape', () => {
  const copy = copyFixture()
  const store = openedStore(copy)
  const state = store.state()
  const project = state.project
  assert.ok(project, 'project must be present after open')
  assert.equal(state.openPath, copy.project)
  assert.equal(state.dirty, false)
  assert.ok(state.rev >= 1)

  assert.equal(typeof project.id, 'string')
  assert.equal(typeof project.title, 'string')
  assert.equal(typeof project.form, 'string')
  assert.ok(Array.isArray(project.staffs) && project.staffs.length > 0)
  assert.ok(isPlainObject(project.tempo))
  assert.ok(Number.isFinite(Number(project.tempo.bpm)))
  assert.ok(Number.isFinite(Number(project.duration)) && Number(project.duration) >= 0)
  assert.ok(isPlainObject(project.assets) && Array.isArray(project.assets.images))
  assert.ok(project.audio === null || (isPlainObject(project.audio) && typeof project.audio.file === 'string'))

  assert.equal(project.staffs.length, 5, 'DremuTest declares five staffs')
  const staffById = new Map(project.staffs.map((staff) => [staff.id, staff]))
  assert.equal(staffById.get('DremuStaff1.g').periods.length, 20)
  assert.equal(staffById.get('DremuStaff2.g').periods.length, 11)
  assert.equal(staffById.get('Song.g').kind, 'audio')
  assert.equal(project.title, 'DremuTest')
  assert.deepEqual(project.warnings, [])
  assert.ok(project.audio, 'the audio staff produces the project audio')
  assert.ok(path.isAbsolute(project.audio.file), 'the audio file path is absolute for /file')
  assert.ok(project.audio.file.endsWith('Song.wav'))
  assert.ok(Number.isFinite(project.audio.duration) && project.audio.duration > 0)
  assert.ok(project.duration > project.audio.duration, 'the project covers the last element after the audio')

  const kinds = new Set(project.staffs.map((staff) => staff.kind))
  assert.ok(kinds.has('chart'), 'DremuTest contains chart staffs')
  assert.ok(kinds.has('audio'), 'DremuTest contains an audio staff')
  const chartStaff = project.staffs.find((staff) => staff.kind === 'chart')
  assert.equal(typeof chartStaff.id, 'string')
  assert.equal(typeof chartStaff.file, 'string')
  assert.ok(insideProject(chartStaff.file, copy.project), 'staff files are absolute paths inside the project')
  assert.ok(Array.isArray(chartStaff.periods) && chartStaff.periods.length > 0)
  const period = chartStaff.periods[0]
  assert.equal(typeof period.id, 'string')
  assert.equal(typeof period.method, 'string')
  assert.ok(Number.isFinite(Number(period.timeOffset)))
  assert.ok(Array.isArray(period.elements) && period.elements.length > 0)
  const element = period.elements[0]
  assert.equal(typeof element.id, 'string')
  assert.equal(typeof element.type, 'string')
  assert.ok(isPlainObject(element.fields))
  assert.ok(Number.isFinite(Number(element.start)))
  assert.equal(typeof element.category, 'string')

  assert.equal(countElements(state), countElements(store.state()), 'wire state is cached and stable')
  assert.ok(state.catalog.elements.length > 0)
  assert.ok(store.view().openPath === copy.project)
  assert.ok(store.view().project !== null)
})

test('store: edits and saves a second corpus project without changing its LF endings', () => {
  const source = '/Users/daxingyi/Music/Chart/Chart 2'
  assert.ok(fs.existsSync(source), `second corpus project missing: ${source}`)
  const root = tempDir('gorge-chart-lf-')
  const project = path.join(root, 'Chart 2')
  fs.cpSync(source, project, { recursive: true })
  const { store } = createTestStore({ projectRoot: root })
  store.open(project)
  const state = store.state()
  assert.equal(state.project.staffs.length, 2)
  assert.equal(state.project.staffs.find((staff) => staff.kind === 'audio').id, 'AudioStaff.g')
  const target = findElement(state)
  assert.ok(target, 'the LF corpus chart has a timed element')
  const staffFile = target.staff.file
  const nextHitTime = Math.round((target.element.fields.hitTime + 0.25) * 1e6) / 1e6
  assert.equal(store.applyOps(state.rev, [patchOp(target.element.id, 'hitTime', nextHitTime)]).ok, true)

  const saved = store.save()
  assert.equal(saved.ok, true)
  assert.ok(saved.written.length > 0)
  const savedText = fs.readFileSync(staffFile, 'utf8')
  assert.equal(savedText.includes('\r'), false, 'a LF project keeps LF endings after save')
  assert.ok(savedText.includes(`hitTime : ${nextHitTime}`), 'the edited field is in the saved text')

  const reopened = openedStore({ root, project })
  assert.equal(findElementById(reopened.state(), target.element.id).element.fields.hitTime, nextHitTime)
})

test('store: scans the project root for openable projects', () => {
  const copy = copyFixture()
  const store = openedStore(copy)
  const projects = store.projects(true)
  const found = projects.find((entry) => entry.dir === copy.project)
  assert.ok(found, 'the copied project is listed under its root')
  assert.equal(found.chartFiles >= 1, true)
  assert.equal(typeof found.name, 'string')
  assert.equal(found.title, found.name, 'project entries carry the client display title')
  assert.equal(found.staffs, found.chartFiles, 'project entries carry the staff count the client shows')
  assert.equal(typeof found.relative, 'string')
  assert.equal(typeof found.images, 'number')

  const viaScan = scanProjectRoot(copy.root)
  assert.deepEqual(
    viaScan.map((entry) => entry.dir),
    projects.map((entry) => entry.dir),
  )
  assert.deepEqual(scanProjectRoot(path.join(copy.root, 'does-not-exist')), [])
})

test('store: resolves project directories by absolute path and by name', () => {
  const copy = copyFixture()
  const absolute = resolveProjectDirectory(copy.project, { projectRoot: copy.root })
  assert.equal(absolute, path.resolve(copy.project))
  const byName = resolveProjectDirectory('DremuTest', { projectRoot: copy.root, cwd: os.tmpdir() })
  assert.equal(byName, path.resolve(copy.project))
  assert.throws(() => resolveProjectDirectory('NoSuchProject', { projectRoot: copy.root }), /not found/)
  assert.throws(() => resolveProjectDirectory(''), /required/)
})

// ---------------------------------------------------------------------------
// Store: edits, revisions, dirty flag
// ---------------------------------------------------------------------------

test('store: edit ops round-trip, bump rev, and set dirty', () => {
  const copy = copyFixture()
  const store = openedStore(copy)
  const before = store.state()
  const target = findElement(before)
  assert.ok(target, 'fixture has at least one element with a numeric hitTime field')
  const elementId = target.element.id
  const previousHitTime = target.element.fields.hitTime
  const nextHitTime = Math.round((previousHitTime + 0.25) * 1e6) / 1e6
  const baseRev = before.rev

  const seen = []
  const unsubscribe = store.subscribe((rev, dirty) => seen.push({ rev, dirty }))
  const outcome = store.applyOps(baseRev, [patchOp(elementId, 'hitTime', nextHitTime)])
  unsubscribe()

  assert.equal(outcome.ok, true)
  assert.equal(outcome.changed, true)
  assert.equal(outcome.rev, baseRev + 1)
  assert.equal(outcome.dirty, true)
  assert.equal(store.view().rev, baseRev + 1)
  assert.equal(store.view().dirty, true)
  assert.deepEqual(seen, [{ rev: baseRev + 1, dirty: true }])
  assert.equal(store.view().pendingOps, 1)

  const after = store.state()
  assert.equal(after.rev, baseRev + 1)
  assert.equal(after.dirty, true)
  const updated = findElementById(after, elementId)
  assert.ok(updated, 'the patched element is still present')
  assert.equal(updated.element.fields.hitTime, nextHitTime)
  assert.ok(Math.abs(updated.element.start - (target.element.start + 0.25)) < 0.05, 'element start follows hitTime')
})

test('store: several accepted edits keep incrementing the revision', () => {
  const copy = copyFixture()
  const store = openedStore(copy)
  const startRev = store.view().rev
  const elements = [...wireElements(store.state())].filter(
    (entry) => isPlainObject(entry.element.fields) && typeof entry.element.fields.hitTime === 'number',
  )
  assert.ok(elements.length >= 2, 'fixture has several timed elements')
  for (let index = 0; index < 2; index += 1) {
    const element = elements[index].element
    const result = store.applyOps(store.view().rev, [patchOp(element.id, 'hitTime', 1 + index)])
    assert.equal(result.ok, true)
    assert.equal(result.changed, true)
  }
  assert.equal(store.view().rev, startRev + 2)
  assert.equal(store.view().undoCount, 2)
})

test('store: setMeta and add/remove ops round-trip with created descriptors', () => {
  const copy = copyFixture()
  const store = openedStore(copy)
  const state = store.state()
  const staff = state.project.staffs.find((entry) => entry.kind === 'chart' && entry.periods.length > 0)
  assert.ok(staff, 'a chart staff is available')
  const period = staff.periods[0]

  const meta = store.applyOps(state.rev, [{ op: 'setMeta', tempo: { bpm: 150, offset: 0.5 }, title: 'Host Test' }])
  assert.equal(meta.ok, true)
  assert.equal(meta.changed, true)
  const afterMeta = store.state()
  assert.equal(afterMeta.project.tempo.bpm, 150)
  assert.equal(afterMeta.project.title, 'Host Test')

  const added = store.applyOps(store.view().rev, [
    {
      op: 'add',
      staffId: staff.id,
      periodId: period.id,
      element: { type: 'Dremu.DremuTap', fields: { laneName: 'mainLine01', hitTime: 1.234 } },
    },
  ])
  assert.equal(added.ok, true)
  assert.equal(added.changed, true)
  assert.ok(Array.isArray(added.created) && added.created.length === 1, 'add reports the created element')
  const created = added.created[0]
  assert.equal(created.staffId, staff.id)
  assert.equal(created.periodId, period.id)
  assert.equal(typeof created.elementId, 'string')
  const found = findElementById(store.state(), created.elementId)
  assert.ok(found, 'the created element is in the wire project')
  assert.equal(found.element.type, 'Dremu.DremuTap')
  assert.equal(found.element.lane, 'mainLine01')
  assert.equal(found.element.fields.hitTime, 1.234)

  const removed = store.applyOps(store.view().rev, [{ op: 'remove', elementId: created.elementId }])
  assert.equal(removed.ok, true)
  assert.equal(removed.changed, true)
  assert.equal(findElementById(store.state(), created.elementId), null)
})

test('store: addStaff writes a new staff file and removeStaff deletes it', () => {
  const copy = freshFixture()
  const store = openedStore(copy)
  const startRev = store.view().rev
  const added = store.applyOps(store.view().rev, [
    {
      op: 'addStaff',
      kind: 'chart',
      displayName: 'Host Staff',
      className: 'HostStaff',
      fileName: 'HostStaff.g',
    },
    {
      op: 'add',
      staffId: 'HostStaff.g',
      periodId: 'p0',
      element: { id: 'host-note', type: 'Dremu.DremuTap', fields: { laneName: 'mainLine01', hitTime: 3 } },
    },
  ])
  assert.equal(added.ok, true)
  assert.equal(added.changed, true)
  assert.deepEqual(added.created[0], { staffId: 'HostStaff.g', kind: 'staff', staffKind: 'chart' })
  assert.equal(store.view().rev, startRev + 1)
  const wireStaff = store.state().project.staffs.find((staff) => staff.id === 'HostStaff.g')
  assert.ok(wireStaff, 'the new staff is in the wire state')
  assert.equal(wireStaff.periods[0].elements[0].type, 'Dremu.DremuTap')

  const saved = store.save()
  assert.equal(saved.ok, true)
  const createdFile = path.join(copy.project, 'HostStaff.g')
  assert.ok(fs.existsSync(createdFile), 'addStaff is written by save')
  assert.ok(saved.written.some((file) => file.endsWith('HostStaff.g')))
  const text = fs.readFileSync(createdFile, 'utf8')
  assert.ok(/class HostStaff/.test(text))
  assert.ok(/DremuTap/.test(text))

  const removed = store.applyOps(store.view().rev, [{ op: 'removeStaff', staffId: 'HostStaff.g' }])
  assert.equal(removed.ok, true)
  assert.equal(removed.changed, true)
  assert.equal(store.state().project.staffs.some((staff) => staff.id === 'HostStaff.g'), false)
  assert.ok(!fs.existsSync(createdFile), 'removeStaff deletes the file it created')
  assert.equal(store.save().ok, true)

  const reopened = openedStore(copy)
  assert.equal(reopened.state().project.staffs.some((staff) => staff.id === 'HostStaff.g'), false)
  assert.ok(!fs.existsSync(createdFile), 'reload does not resurrect the removed staff')
})

test('store: removeStaff deleteFile deletes a fixture staff from disk and survives reopen', () => {
  const copy = freshFixture()
  const store = openedStore(copy)
  const target = 'DremuStaff1.g'
  const file = path.join(copy.project, target)
  assert.ok(fs.existsSync(file), 'fixture staff missing')
  fs.writeFileSync(file + '.bak', 'previous bytes')

  const refused = store.applyOps(store.view().rev, [{ op: 'removeStaff', staffId: target }])
  assert.equal(refused.changed, false)
  assert.ok(refused.errors.some((error) => /deleteFile:true/.test(error)))
  assert.ok(fs.existsSync(file), 'a disk staff is not deleted without the explicit flag')

  const removed = store.applyOps(store.view().rev, [{ op: 'removeStaff', staffId: target, deleteFile: true }])
  assert.equal(removed.ok, true)
  assert.equal(removed.changed, true)
  assert.equal(store.state().project.staffs.some((staff) => staff.id === target), false)
  assert.ok(!fs.existsSync(file), 'the staff file is deleted')
  assert.ok(!fs.existsSync(file + '.bak'), 'the .bak backup is deleted too')
  assert.equal(store.save().ok, true)

  const reopened = openedStore(copy)
  assert.equal(reopened.state().project.staffs.some((staff) => staff.id === target), false)
  assert.ok(!fs.existsSync(file), 'reopening does not resurrect the deleted staff')
})

test('store: autoSave persists edits after the debounce and clears dirty', async () => {
  const copy = freshFixture()
  const { store } = createTestStore({ projectRoot: copy.root, autoSave: true, create: { autoSaveDelayMs: 25 } })
  store.open(copy.project)
  const target = findElement(store.state())
  const staffFile = target.staff.file
  const beforeText = fs.readFileSync(staffFile, 'utf8')
  const nextHitTime = Math.round((target.element.fields.hitTime + 0.25) * 1e6) / 1e6
  assert.equal(store.applyOps(store.view().rev, [patchOp(target.element.id, 'hitTime', nextHitTime)]).ok, true)
  assert.equal(store.view().dirty, true)

  let saved = false
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (store.view().dirty === false) {
      saved = true
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.equal(saved, true, 'the debounced automatic save clears the dirty flag')
  assert.equal(store.view().pendingOps, 0)
  assert.notEqual(fs.readFileSync(staffFile, 'utf8'), beforeText, 'the automatic save wrote the staff file')
})

test('store: a stale baseRev is rejected without touching the project', () => {
  const copy = copyFixture()
  const store = openedStore(copy)
  const first = store.state()
  const target = findElement(first)
  const edited = store.applyOps(first.rev, [patchOp(target.element.id, 'hitTime', 3.5)])
  assert.equal(edited.ok, true)

  const staleRev = first.rev
  const before = store.state()
  const stale = store.applyOps(staleRev, [patchOp(target.element.id, 'hitTime', 9.9)])
  assert.equal(stale.ok, false)
  assert.equal(stale.conflict, true)
  assert.equal(stale.rev, before.rev)
  assert.equal(stale.dirty, true)
  const after = store.state()
  assert.equal(after.rev, before.rev, 'a rejected edit never bumps the revision')
  assert.equal(findElementById(after, target.element.id).element.fields.hitTime, 3.5)
})

test('store: invalid edit input is reported, not thrown', () => {
  const copy = copyFixture()
  const store = openedStore(copy)
  assert.equal(store.applyOps(store.view().rev, []).ok, false)
  assert.equal(store.applyOps(store.view().rev, 'nope').ok, false)
  assert.equal(store.applyOps('nope', [patchOp('x', 'hitTime', 1)]).ok, false)
  assert.equal(store.applyOps(store.view().rev, [patchOp('missing:element', 'hitTime', 1)]).ok, true)
  const missingStore = createTestStore().store
  assert.equal(missingStore.applyOps(1, [patchOp('x', 'hitTime', 1)]).ok, false)
})

// ---------------------------------------------------------------------------
// Store: persistence, save, reload, recovery
// ---------------------------------------------------------------------------

test('store: save writes the project and a reloaded store reads the same data', () => {
  const copy = freshFixture()
  const { store } = createTestStore({ projectRoot: copy.root })
  store.open(copy.project)
  const target = findElement(store.state())
  assert.ok(target)
  const elementId = target.element.id
  const newHitTime = Math.round((target.element.fields.hitTime + 0.5) * 1e6) / 1e6
  assert.equal(store.applyOps(store.view().rev, [patchOp(elementId, 'hitTime', newHitTime)]).ok, true)

  const staffFile = target.staff.file
  const beforeText = fs.readFileSync(staffFile, 'utf8')
  const saved = store.save()
  assert.equal(saved.ok, true)
  assert.ok(saved.written.length > 0, 'save reports the written staff files')
  assert.equal(saved.errors.length, 0)
  assert.equal(saved.dirty, false)
  assert.equal(store.view().dirty, false)
  assert.equal(store.view().pendingOps, 0)
  for (const written of saved.written) {
    assert.ok(path.isAbsolute(written) && insideProject(written, copy.project), `${written} must be inside the project`)
  }
  assert.notEqual(fs.readFileSync(staffFile, 'utf8'), beforeText, 'the edited staff file changed on disk')

  // Re-read through an independent store: the whole patched staff survives.
  const reopen = openedStore(copy)
  const reloaded = reopen.state()
  assert.equal(reloaded.dirty, false)
  const reloadedStaff = reloaded.project.staffs.find((staff) => staff.id === target.staff.id)
  assert.ok(reloadedStaff, 'the patched staff is present after reload')
  assert.deepEqual(
    reloadedStaff.periods.map((period) => period.elements),
    store.state().project.staffs.find((staff) => staff.id === target.staff.id).periods.map((period) => period.elements),
    'every element field of the saved staff round-trips through the codec unchanged',
  )
  const element = findElementById(reloaded, elementId)
  assert.ok(element, 'element ids are stable across save/reload')
  assert.equal(element.element.fields.hitTime, newHitTime)
})

test('store: reload discards unsaved edits and bumps the revision', () => {
  const copy = copyFixture()
  const store = openedStore(copy)
  const first = store.state()
  const target = findElement(first)
  const original = target.element.fields.hitTime
  assert.equal(store.applyOps(first.rev, [patchOp(target.element.id, 'hitTime', original + 1)]).ok, true)
  const revBeforeReload = store.view().rev
  const result = store.reload()
  assert.equal(result.ok, true)
  assert.equal(result.rev, revBeforeReload + 1)
  assert.equal(result.dirty, false)
  assert.equal(store.view().dirty, false)
  const element = findElementById(store.state(), target.element.id)
  assert.equal(element.element.fields.hitTime, original, 'reload restores the on-disk value')
})

test('store: recovery snapshot resumes the last project and unsaved edits', () => {
  const copy = copyFixture()
  const first = createTestStore({ projectRoot: copy.root })
  first.store.open(copy.project)
  const target = findElement(first.store.state())
  const elementId = target.element.id
  const newHitTime = Math.round((target.element.fields.hitTime + 0.75) * 1e6) / 1e6
  assert.equal(first.store.applyOps(first.store.view().rev, [patchOp(elementId, 'hitTime', newHitTime)]).ok, true)
  first.store.flush()

  const raw = JSON.parse(fs.readFileSync(first.statePath, 'utf8'))
  assert.equal(raw.openPath, copy.project)
  assert.equal(raw.dirty, true)
  assert.ok(raw.rev >= 1)
  assert.ok(Array.isArray(raw.pendingBatches) && raw.pendingBatches.length === 1, 'accepted ops are persisted for replay')

  // Simulate a Host restart: a new store with the same snapshot path resumes.
  const second = createTestStore({
    projectRoot: copy.root,
    resume: true,
    create: { statePath: first.statePath },
  })
  const resumed = second.store.view()
  assert.equal(resumed.openPath, copy.project)
  assert.equal(resumed.dirty, true)
  const replayed = findElementById(second.store.state(), elementId)
  assert.ok(replayed, 'the recovered project is readable')
  assert.equal(replayed.element.fields.hitTime, newHitTime, 'unsaved edits are replayed on resume')

  // Saving clears the pending ops, and a third boot resumes clean.
  assert.equal(second.store.save().ok, true)
  second.store.flush()
  const third = createTestStore({
    projectRoot: copy.root,
    resume: true,
    create: { statePath: first.statePath },
  })
  assert.equal(third.store.view().openPath, copy.project)
  assert.equal(third.store.view().dirty, false)
  assert.equal(third.store.view().pendingOps, 0)
})

// ---------------------------------------------------------------------------
// Store: file containment and Range parsing
// ---------------------------------------------------------------------------

test('files: path containment rejects traversal, absolute escapes, and symlink escapes', () => {
  const copy = copyFixture()
  const image = path.join(copy.project, 'Background1.png')
  assert.ok(fs.existsSync(image))

  const inside = resolveProjectFile(copy.project, 'Background1.png')
  assert.equal(inside.ok, true)
  assert.equal(inside.abs, fs.realpathSync(image))
  assert.equal(inside.contentType, 'image/png')

  const absoluteInside = resolveProjectFile(copy.project, image)
  assert.equal(absoluteInside.ok, true, 'absolute paths inside the project are allowed')

  const traversal = resolveProjectFile(copy.project, '../../etc/passwd')
  assert.equal(traversal.ok, false)
  assert.equal(traversal.status, 403)

  const absoluteEscape = resolveProjectFile(copy.project, '/etc/passwd')
  assert.equal(absoluteEscape.ok, false)
  assert.equal(absoluteEscape.status, 403)

  const missing = resolveProjectFile(copy.project, 'nope.png')
  assert.equal(missing.ok, false)
  assert.equal(missing.status, 404)

  const noProject = resolveProjectFile('', 'x.png')
  assert.equal(noProject.ok, false)
  assert.equal(noProject.status, 409)

  const link = path.join(copy.project, 'escape.png')
  try {
    fs.symlinkSync('/etc/passwd', link)
    const symlinkEscape = resolveProjectFile(copy.project, 'escape.png')
    assert.equal(symlinkEscape.ok, false)
    assert.equal(symlinkEscape.status, 403)
  } finally {
    try {
      fs.unlinkSync(link)
    } catch {
      /* already removed */
    }
  }
})

test('files: Range parsing covers full, partial, suffix, and invalid ranges', () => {
  assert.equal(parseRangeHeader(undefined, 100), null)
  assert.equal(parseRangeHeader('', 100), null)
  assert.equal(parseRangeHeader('items=0-1', 100), null, 'unknown units are ignored')
  assert.deepEqual(parseRangeHeader('bytes=0-9', 100), { start: 0, end: 9 })
  assert.deepEqual(parseRangeHeader('bytes=90-', 100), { start: 90, end: 99 })
  assert.deepEqual(parseRangeHeader('bytes=-10', 100), { start: 90, end: 99 })
  assert.deepEqual(parseRangeHeader('bytes=50-999', 100), { start: 50, end: 99 })
  assert.equal(parseRangeHeader('bytes=0-1,5-6', 100), 'invalid', 'multipart ranges are unsupported')
  assert.equal(parseRangeHeader('bytes=100-', 100), 'invalid')
  assert.equal(parseRangeHeader('bytes=5-1', 100), 'invalid')
  assert.equal(parseRangeHeader('bytes=-0', 100), 'invalid')
  assert.equal(parseRangeHeader('bytes=abc', 100), 'invalid')
})

// ---------------------------------------------------------------------------
// HTTP handlers
// ---------------------------------------------------------------------------

test('handler state: GET returns the documented state and rejects other peers/methods', async () => {
  const copy = copyFixture()
  const store = openedStore(copy)
  const handler = createStateHandler(store)

  const res = await callHandler(handler, localRequest({ url: ENDPOINTS.state }))
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['cache-control'], 'no-store')
  const body = res.json()
  for (const key of ['rev', 'dirty', 'project', 'catalog', 'openPath', 'recent', 'projects']) {
    assert.ok(Object.prototype.hasOwnProperty.call(body, key), `state must expose ${key}`)
  }
  assert.equal(body.openPath, copy.project)
  assert.ok(Array.isArray(body.projects) && body.projects.some((entry) => entry.dir === copy.project))
  assert.ok(body.project && Array.isArray(body.project.staffs))

  const forbidden = await callHandler(handler, localRequest({ url: ENDPOINTS.state, remoteAddress: '10.9.9.9' }))
  assert.equal(forbidden.statusCode, 403)
  const wrongMethod = await callHandler(handler, localRequest({ method: 'POST', url: ENDPOINTS.state }))
  assert.equal(wrongMethod.statusCode, 405)
})

test('handler edit: accepts an op batch and returns the compact revision result', async () => {
  const copy = copyFixture()
  const store = openedStore(copy)
  const handler = createEditHandler(store)
  const state = store.state()
  const target = findElement(state)
  const nextHitTime = Math.round((target.element.fields.hitTime + 0.25) * 1e6) / 1e6

  const res = await callHandler(
    handler,
    localJsonRequest(ENDPOINTS.edit, { baseRev: state.rev, ops: [patchOp(target.element.id, 'hitTime', nextHitTime)] }),
  )
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.rev, state.rev + 1)
  assert.equal(body.dirty, true)
  assert.equal(body.changed, true)
  assert.equal(body.errors, undefined, 'a clean edit reports no errors')
  assert.equal(body.project, undefined, 'edit responses stay compact (no full project)')
  assert.equal(store.view().dirty, true)
  assert.equal(findElementById(store.state(), target.element.id).element.fields.hitTime, nextHitTime)

  const badRev = await callHandler(
    handler,
    localJsonRequest(ENDPOINTS.edit, { baseRev: 'nope', ops: [patchOp(target.element.id, 'hitTime', 1)] }),
  )
  assert.equal(badRev.statusCode, 400)

  const emptyOps = await callHandler(handler, localJsonRequest(ENDPOINTS.edit, { baseRev: body.rev, ops: [] }))
  assert.equal(emptyOps.statusCode, 400)

  const noBody = await callHandler(handler, localRequest({ method: 'POST', url: ENDPOINTS.edit }))
  assert.equal(noBody.statusCode, 400)

  const forbidden = await callHandler(
    handler,
    localJsonRequest(ENDPOINTS.edit, { baseRev: body.rev, ops: [] }, { remoteAddress: '10.0.0.5' }),
  )
  assert.equal(forbidden.statusCode, 403)
})

test('handler edit: a stale baseRev answers 409 with the current revision', async () => {
  const copy = copyFixture()
  const store = openedStore(copy)
  const handler = createEditHandler(store)
  const first = store.state()
  const target = findElement(first)
  const accepted = await callHandler(
    handler,
    localJsonRequest(ENDPOINTS.edit, { baseRev: first.rev, ops: [patchOp(target.element.id, 'hitTime', 2.5)] }),
  )
  assert.equal(accepted.statusCode, 200)

  const stale = await callHandler(
    handler,
    localJsonRequest(ENDPOINTS.edit, { baseRev: first.rev, ops: [patchOp(target.element.id, 'hitTime', 3.5)] }),
  )
  assert.equal(stale.statusCode, 409)
  const body = stale.json()
  assert.equal(body.conflict, true)
  assert.equal(body.rev, first.rev + 1)
  assert.equal(body.dirty, true)
  assert.equal(findElementById(store.state(), target.element.id).element.fields.hitTime, 2.5)
})

test('handler events: SSE sends the current revision then every accepted edit', async () => {
  const copy = copyFixture()
  const store = openedStore(copy)
  const handler = createEventsHandler(store)
  const req = localRequest({ url: ENDPOINTS.events })
  const res = new MockResponse()
  handler(req, res)

  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['content-type'], 'text/event-stream; charset=utf-8')
  assert.equal(res.headers['cache-control'], 'no-store')
  assert.ok(res.text.includes('retry: 2000'))
  const initial = res.text
    .split('\n\n')
    .filter((frame) => frame.startsWith('data: '))
    .map((frame) => JSON.parse(frame.slice('data: '.length)))
  assert.equal(initial.length, 1)
  assert.equal(initial[0].rev, store.view().rev)
  assert.equal(initial[0].dirty, false)

  const target = findElement(store.state())
  assert.equal(store.applyOps(store.view().rev, [patchOp(target.element.id, 'hitTime', 1.25)]).ok, true)
  const frames = res.text
    .split('\n\n')
    .filter((frame) => frame.startsWith('data: '))
    .map((frame) => JSON.parse(frame.slice('data: '.length)))
  assert.equal(frames.length, 2)
  assert.equal(frames[1].rev, store.view().rev)
  assert.equal(frames[1].dirty, true)

  res.emit('close')
  const countAfterClose = frames.length
  assert.equal(store.applyOps(store.view().rev, [patchOp(target.element.id, 'hitTime', 1.5)]).ok, true)
  const framesAfterClose = res.text.split('\n\n').filter((frame) => frame.startsWith('data: ')).length
  assert.equal(framesAfterClose, countAfterClose, 'closing the SSE request unsubscribes')
})

test('handler file: serves project files with Range support and strict containment', async () => {
  const copy = copyFixture()
  const store = openedStore(copy)
  const handler = createFileHandler(store, { logger: SILENT_LOGGER })
  const audio = path.join(copy.project, 'Song.wav')
  const audioSize = fs.statSync(audio).size

  // Audio range (what <audio> seeking sends).
  const rangeRes = new MockResponse()
  handler(
    new MockRequest({
      method: 'GET',
      url: `/plugins/gorge-chart/file?path=${encodeURIComponent('Song.wav')}`,
      headers: { ...SAME_ORIGIN_HEADERS, range: 'bytes=0-99' },
    }),
    rangeRes,
  )
  await waitForEnd(rangeRes)
  assert.equal(rangeRes.statusCode, 206)
  assert.equal(rangeRes.headers['accept-ranges'], 'bytes')
  assert.equal(rangeRes.headers['content-range'], `bytes 0-99/${audioSize}`)
  assert.equal(rangeRes.headers['content-type'], 'audio/wav')
  assert.equal(rangeRes.headers['cache-control'], 'no-store')
  assert.equal(rangeRes.headers['content-length'], 100)
  assert.equal(Buffer.concat(rangeRes.chunks).length, 100)
  assert.deepEqual(Buffer.concat(rangeRes.chunks), fs.readFileSync(audio).subarray(0, 100))

  // Full image body by absolute path (the client sends absolute asset paths).
  const image = path.join(copy.project, 'Background1.png')
  const imageBytes = fs.readFileSync(image)
  const imageRes = new MockResponse()
  handler(
    new MockRequest({
      method: 'GET',
      url: `/plugins/gorge-chart/file?path=${encodeURIComponent(image)}`,
      headers: { ...SAME_ORIGIN_HEADERS },
    }),
    imageRes,
  )
  await waitForEnd(imageRes)
  assert.equal(imageRes.statusCode, 200)
  assert.equal(imageRes.headers['content-type'], 'image/png')
  assert.equal(Number(imageRes.headers['content-length']), imageBytes.length)
  assert.deepEqual(Buffer.concat(imageRes.chunks), imageBytes)

  // Suffix range.
  const suffixRes = new MockResponse()
  handler(
    new MockRequest({
      method: 'GET',
      url: `/plugins/gorge-chart/file?path=${encodeURIComponent('Background1.png')}`,
      headers: { ...SAME_ORIGIN_HEADERS, range: `bytes=-${Math.min(20, imageBytes.length)}` },
    }),
    suffixRes,
  )
  await waitForEnd(suffixRes)
  assert.equal(suffixRes.statusCode, 206)
  const expectedSuffixLength = Math.min(20, imageBytes.length)
  assert.equal(suffixRes.headers['content-range'], `bytes ${imageBytes.length - expectedSuffixLength}-${imageBytes.length - 1}/${imageBytes.length}`)

  // Unsatisfiable range.
  const badRange = new MockResponse()
  handler(
    new MockRequest({
      method: 'GET',
      url: `/plugins/gorge-chart/file?path=${encodeURIComponent('Background1.png')}`,
      headers: { ...SAME_ORIGIN_HEADERS, range: 'bytes=999999-' },
    }),
    badRange,
  )
  assert.equal(badRange.statusCode, 416)
  assert.equal(badRange.headers['content-range'], `bytes */${imageBytes.length}`)

  // Traversal + absolute escape + missing file.
  for (const badPath of ['../../etc/passwd', '/etc/passwd', 'nope.png']) {
    const res = await callHandler(
      handler,
      localRequest({ method: 'GET', url: `/plugins/gorge-chart/file?path=${encodeURIComponent(badPath)}` }),
    )
    assert.ok(res.statusCode === 403 || res.statusCode === 404, `${badPath} must be rejected (${res.statusCode})`)
  }

  // Unknown extension is served with a generic content type.
  const blob = path.join(copy.project, 'payload.bin')
  fs.writeFileSync(blob, Buffer.from([1, 2, 3, 4]))
  const blobRes = new MockResponse()
  handler(
    new MockRequest({
      method: 'GET',
      url: `/plugins/gorge-chart/file?path=${encodeURIComponent('payload.bin')}`,
      headers: { ...SAME_ORIGIN_HEADERS },
    }),
    blobRes,
  )
  await waitForEnd(blobRes)
  assert.equal(blobRes.statusCode, 200)
  assert.equal(blobRes.headers['content-type'], 'application/octet-stream')

  // Non-local peer.
  const forbidden = await callHandler(
    handler,
    localRequest({ method: 'GET', url: `/plugins/gorge-chart/file?path=Song.wav`, remoteAddress: '192.168.1.4' }),
  )
  assert.equal(forbidden.statusCode, 403)

  // Wrong method.
  const wrongMethod = await callHandler(
    handler,
    localRequest({ method: 'POST', url: `/plugins/gorge-chart/file?path=Song.wav` }),
  )
  assert.equal(wrongMethod.statusCode, 405)
})

test('handler import-audio: copies a bounded upload into the project and reports metadata', async () => {
  const copy = copyFixture()
  const store = openedStore(copy)
  const handler = createImportAudioHandler(store)
  const bytes = fs.readFileSync(path.join(HERE, '..', 'demo', 'demo.wav'))
  const upload = await callHandler(
    handler,
    localRequest({
      method: 'POST',
      url: ENDPOINTS.importAudio + '?name=' + encodeURIComponent('导入 音轨.wav'),
      headers: { ...SAME_ORIGIN_HEADERS, 'content-type': 'audio/wav' },
      body: bytes,
    }),
  )
  assert.equal(upload.statusCode, 200)
  const body = upload.json()
  assert.equal(body.ok, true)
  assert.equal(body.file, '导入 音轨.wav')
  assert.ok(fs.existsSync(path.join(copy.project, body.file)), 'the upload lives inside the project')
  assert.ok(body.duration > 0, 'the probe reports the uploaded clip duration')
  assert.equal(typeof body.format, 'string')
  assert.equal(body.bytes, bytes.length)

  // A second upload of the same name gets a unique file.
  const again = await callHandler(
    handler,
    localRequest({
      method: 'POST',
      url: ENDPOINTS.importAudio + '?name=' + encodeURIComponent('导入 音轨.wav'),
      body: bytes,
    }),
  )
  assert.equal(again.statusCode, 200)
  assert.notEqual(again.json().file, body.file)

  // Traversal is reduced to a basename inside the project.
  const traversal = await callHandler(
    handler,
    localRequest({ method: 'POST', url: ENDPOINTS.importAudio + '?name=' + encodeURIComponent('../Escape.wav'), body: bytes }),
  )
  assert.equal(traversal.statusCode, 200)
  assert.equal(traversal.json().file, 'Escape.wav')
  assert.ok(fs.existsSync(path.join(copy.project, 'Escape.wav')))
  assert.ok(!fs.existsSync(path.join(path.dirname(copy.project), 'Escape.wav')))

  // Unsupported types and oversized bodies are refused.
  const exe = await callHandler(
    handler,
    localRequest({ method: 'POST', url: ENDPOINTS.importAudio + '?name=evil.exe', body: Buffer.from('x') }),
  )
  assert.equal(exe.statusCode, 400)
  const tiny = createImportAudioHandler(store, { maxAudioBytes: 16 })
  const tooBig = await callHandler(
    tiny,
    localRequest({ method: 'POST', url: ENDPOINTS.importAudio + '?name=big.wav', body: bytes }),
  )
  assert.equal(tooBig.statusCode, 400)
  assert.match(tooBig.json().error, /too large/)

  // A non-local peer cannot write into the project.
  const remote = await callHandler(
    handler,
    localRequest({
      method: 'POST',
      url: ENDPOINTS.importAudio + '?name=remote.wav',
      remoteAddress: '203.0.113.9',
      body: bytes,
    }),
  )
  assert.equal(remote.statusCode, 403)
  assert.ok(!fs.existsSync(path.join(copy.project, 'remote.wav')))
})

test('handler open/projects/save/reload: full project lifecycle over HTTP', async () => {
  const copy = freshFixture()
  const { store } = createTestStore({ projectRoot: copy.root })
  const openHandler = createOpenHandler(store, { resolveDirectory: () => copy.root })
  const projectsHandler = createProjectsHandler(store)
  const stateHandler = createStateHandler(store)
  const saveHandler = createSaveHandler(store)
  const reloadHandler = createReloadHandler(store)

  const emptyState = await callHandler(stateHandler, localRequest({ url: ENDPOINTS.state }))
  assert.equal(emptyState.json().project, null)

  const projects = await callHandler(projectsHandler, localRequest({ url: ENDPOINTS.projects }))
  assert.equal(projects.statusCode, 200)
  assert.ok(projects.json().projects.some((entry) => entry.dir === copy.project))

  const opened = await callHandler(openHandler, localJsonRequest(ENDPOINTS.open, { dir: copy.project }))
  assert.equal(opened.statusCode, 200)
  const openedBody = opened.json()
  assert.equal(openedBody.openPath, copy.project)
  assert.ok(openedBody.project && openedBody.project.staffs.length > 0)
  assert.ok(Array.isArray(openedBody.projects) && openedBody.projects.length > 0)

  const byName = await callHandler(openHandler, localJsonRequest(ENDPOINTS.open, { dir: 'DremuTest' }))
  assert.equal(byName.statusCode, 200)
  assert.equal(byName.json().openPath, copy.project)

  const missing = await callHandler(openHandler, localJsonRequest(ENDPOINTS.open, { dir: 'NoSuchProject' }))
  assert.equal(missing.statusCode, 404)

  const target = findElement(store.state())
  const edited = await callHandler(
    createEditHandler(store),
    localJsonRequest(ENDPOINTS.edit, {
      baseRev: store.view().rev,
      ops: [patchOp(target.element.id, 'hitTime', target.element.fields.hitTime + 0.5)],
    }),
  )
  assert.equal(edited.statusCode, 200)

  const saveRes = await callHandler(saveHandler, localRequest({ method: 'POST', url: ENDPOINTS.save, headers: SAME_ORIGIN_HEADERS, body: null }))
  assert.equal(saveRes.statusCode, 200)
  const saveBody = saveRes.json()
  assert.equal(saveBody.ok, true)
  assert.ok(saveBody.written.length > 0)
  assert.deepEqual(saveBody.errors, [])
  assert.equal(saveBody.dirty, false)

  const reloadRes = await callHandler(reloadHandler, localRequest({ method: 'POST', url: ENDPOINTS.reload, headers: SAME_ORIGIN_HEADERS, body: null }))
  assert.equal(reloadRes.statusCode, 200)
  assert.equal(reloadRes.json().dirty, false)

  const noProjectStore = createTestStore().store
  const noProjectSave = await callHandler(createSaveHandler(noProjectStore), localRequest({ method: 'POST', url: ENDPOINTS.save }))
  assert.equal(noProjectSave.statusCode, 400)
  const noProjectReload = await callHandler(createReloadHandler(noProjectStore), localRequest({ method: 'POST', url: ENDPOINTS.reload }))
  assert.equal(noProjectReload.statusCode, 400)

  assert.equal(createHandlers(store).length, 9)
})

// ---------------------------------------------------------------------------
// Agent tools
// ---------------------------------------------------------------------------

test('tools: seven tools registered with JSON-Schema parameters', () => {
  const copy = copyFixture()
  const store = openedStore(copy)
  const tools = createTools(store, { logger: SILENT_LOGGER, resolveDirectory: () => copy.root })
  const names = tools.map((definition) => definition.name)
  assert.deepEqual(names, [
    'gorge_project_list',
    'gorge_project_open',
    'gorge_chart_get',
    'gorge_chart_edit',
    'gorge_chart_save',
    'gorge_chart_validate',
    'gorge_element_schema',
  ])
  for (const definition of tools) {
    assert.ok(definition.name.startsWith('gorge_'))
    assert.ok(typeof definition.description === 'string' && definition.description.length > 20)
    assert.equal(definition.parameters.type, 'object')
    assert.equal(definition.parameters.additionalProperties, false)
    assert.equal(typeof definition.execute, 'function')
    assert.deepEqual(definition.output.render(null, { ok: true }), [{ type: 'text', text: JSON.stringify({ ok: true }, null, 2) }])
  }
  const byName = new Map(tools.map((definition) => [definition.name, definition]))
  assert.deepEqual(byName.get('gorge_project_open').parameters.required, ['dir'])
  assert.deepEqual(byName.get('gorge_chart_edit').parameters.required, ['ops'])
  assert.equal(byName.get('gorge_chart_edit').parameters.properties.ops.type, 'array')
  assert.equal(byName.get('gorge_chart_save').parameters.properties && Object.keys(byName.get('gorge_chart_save').parameters.properties).length, 0)
})

test('tools: real project data through gorge_project_list/get/edit/schema/validate', async () => {
  const copy = copyFixture()
  const store = openedStore(copy)
  const tools = createTools(store, { logger: SILENT_LOGGER, resolveDirectory: () => copy.root })
  const byName = new Map(tools.map((definition) => [definition.name, definition]))

  const list = await byName.get('gorge_project_list').execute({})
  assert.equal(list.ok, true)
  assert.equal(list.projectRoot, copy.root)
  assert.ok(list.count >= 1)
  assert.ok(list.projects.some((entry) => entry.dir === copy.project))

  const summary = await byName.get('gorge_chart_get').execute({})
  assert.equal(summary.ok, true)
  assert.equal(summary.openPath, copy.project)
  assert.ok(summary.rev >= 1)
  assert.equal(summary.dirty, false)
  assert.ok(summary.project && typeof summary.project.title === 'string')
  assert.ok(summary.project.staffCount >= 1)
  assert.ok(summary.project.elementCount >= 1)
  assert.ok(Array.isArray(summary.staffs) && summary.staffs.length === summary.project.staffCount)
  assert.ok(Array.isArray(summary.lanes))
  const listed = summary.staffs.reduce(
    (total, staff) => total + (staff.periods || []).reduce((count, period) => count + (period.elements || []).length, 0),
    0,
  )
  assert.equal(listed, Math.min(summary.project.elementCount, 400))
  if (summary.project.elementCount > 400) assert.equal(summary.truncated, true)
  const summaryStaff = summary.staffs.find((staff) => staff.kind === 'chart' && staff.periods.length > 0)
  assert.ok(summaryStaff, 'chart staff is present in the summary')
  assert.ok(Array.isArray(summary.project.audioPeriods) && summary.project.audioPeriods.length >= 1)
  const audioSummary = summary.staffs.find((staff) => staff.kind === 'audio')
  assert.ok(audioSummary, 'audio staff is present in the summary')
  assert.ok(Array.isArray(audioSummary.audioPeriods) && audioSummary.audioPeriods.length >= 1)
  assert.equal(typeof audioSummary.audioPeriods[0].relativePath, 'string')

  const added = await byName.get('gorge_chart_edit').execute({
    ops: [{ op: 'addAudioPeriod', staffId: audioSummary.id, file: 'Song.wav', name: '第二乐段', timeOffset: 200 }],
  })
  assert.equal(added.ok, true)
  assert.equal(added.changed, true)
  const createdAudio = (added.created || []).find((entry) => entry.kind === 'audioPeriod')
  assert.ok(createdAudio, 'addAudioPeriod reports the created period')
  assert.equal(createdAudio.audioPeriodId, 'a1')
  assert.equal(createdAudio.method, 'GetSong1')
  const withAudio = await byName.get('gorge_chart_get').execute({})
  assert.equal(withAudio.project.audioPeriods.length, summary.project.audioPeriods.length + 1)
  assert.ok(withAudio.project.audioPeriods.some((clip) => clip.method === 'GetSong1' && clip.offset === 200))
  const patchedAudio = await byName.get('gorge_chart_edit').execute({
    ops: [{ op: 'patchAudioPeriod', staffId: audioSummary.id, audioPeriodId: createdAudio.audioPeriodId, fields: { timeOffset: 210 } }],
  })
  assert.equal(patchedAudio.ok, true)
  assert.ok((await byName.get('gorge_chart_get').execute({})).project.audioPeriods.some((clip) => clip.offset === 210))
  const removedAudio = await byName.get('gorge_chart_edit').execute({
    ops: [{ op: 'removeAudioPeriod', staffId: audioSummary.id, audioPeriodId: createdAudio.audioPeriodId }],
  })
  assert.equal(removedAudio.ok, true)
  assert.equal((await byName.get('gorge_chart_get').execute({})).project.audioPeriods.length, summary.project.audioPeriods.length)

  const typeEntry = summary.staffs
    .flatMap((staff) => staff.periods)
    .flatMap((period) => period.elements || [])
    .find((element) => typeof element.type === 'string')
  assert.ok(typeEntry, 'summary exposes elements with ids')
  const single = await byName.get('gorge_chart_get').execute({ elementId: typeEntry.id })
  assert.equal(single.ok, true)
  assert.equal(single.element.id, typeEntry.id)
  assert.equal(typeof single.element.staffId, 'string')
  assert.equal(typeof single.element.periodId, 'string')
  assert.ok(isPlainObject(single.element.fields))

  const revBeforeElementEdit = (await byName.get('gorge_chart_get').execute({})).rev
  const patchTarget = [...wireElements(store.state())].find(
    (entry) => isPlainObject(entry.element.fields) && typeof entry.element.fields.hitTime === 'number',
  )
  assert.ok(patchTarget)
  const nextHitTime = Math.round((patchTarget.element.fields.hitTime + 0.25) * 1e6) / 1e6
  const edited = await byName.get('gorge_chart_edit').execute({
    ops: [patchOp(patchTarget.element.id, 'hitTime', nextHitTime)],
  })
  assert.equal(edited.ok, true)
  assert.equal(edited.changed, true)
  assert.equal(edited.rev, revBeforeElementEdit + 1)
  assert.equal(edited.dirty, true)
  const reread = await byName.get('gorge_chart_get').execute({ elementId: patchTarget.element.id })
  assert.equal(reread.element.fields.hitTime, nextHitTime)

  const catalogEntry = summary.project && summary.project.assets ? typeEntry.type : null
  const schemaOne = await byName.get('gorge_element_schema').execute({ type: catalogEntry || 'Dremu.DremuTap' })
  assert.equal(schemaOne.ok, true)
  assert.equal(schemaOne.element.type, catalogEntry || 'Dremu.DremuTap')
  assert.ok(Array.isArray(schemaOne.element.fields) && schemaOne.element.fields.length > 0)
  const schemaAll = await byName.get('gorge_element_schema').execute({})
  assert.equal(schemaAll.ok, true)
  assert.ok(Array.isArray(schemaAll.elements) && schemaAll.elements.length > 0)
  assert.equal(schemaAll.count, schemaAll.elements.length)
  const unknown = await byName.get('gorge_element_schema').execute({ type: 'Nope.Unknown' })
  assert.equal(unknown.ok, false)

  const validation = await byName.get('gorge_chart_validate').execute({})
  assert.equal(validation.ok, true)
  assert.ok(Number.isFinite(validation.issueCount))
  assert.ok(Array.isArray(validation.issues))
  assert.ok(validation.issues.length <= 200)

  const summaryWithLane = await byName.get('gorge_chart_get').execute({ lanes: ['mainLine01'] })
  assert.equal(summaryWithLane.ok, true)
  for (const staff of summaryWithLane.staffs) {
    for (const period of staff.periods) {
      for (const element of period.elements || []) assert.equal(element.lane, 'mainLine01')
    }
  }
  const summaryDetail = await byName.get('gorge_chart_get').execute({ staffId: summaryStaff.id, detail: true })
  assert.equal(summaryDetail.ok, true)
  assert.equal(summaryDetail.staffs.length, 1)
  assert.equal(summaryDetail.staffs[0].id, summaryStaff.id)
  const firstDetailed = summaryDetail.staffs[0].periods.flatMap((period) => period.elements || [])[0]
  if (firstDetailed) assert.ok(isPlainObject(firstDetailed.fields))
})

test('tools: save/open/errors with real data', async () => {
  const copy = freshFixture()
  const { store } = createTestStore({ projectRoot: copy.root })
  const tools = createTools(store, { logger: SILENT_LOGGER, resolveDirectory: () => copy.root })
  const byName = new Map(tools.map((definition) => [definition.name, definition]))

  const opened = await byName.get('gorge_project_open').execute({ dir: copy.project })
  assert.equal(opened.ok, true)
  assert.equal(opened.openPath, copy.project)
  assert.ok(opened.elementCount >= 1)
  assert.ok(Array.isArray(opened.warnings))

  // Edit first: the model only writes staff files whose canonical text changed.
  const target = findElement(store.state())
  const edited = await byName.get('gorge_chart_edit').execute({
    ops: [patchOp(target.element.id, 'hitTime', target.element.fields.hitTime + 0.5)],
  })
  assert.equal(edited.ok, true)
  assert.equal(edited.dirty, true)
  const saved = await byName.get('gorge_chart_save').execute({})
  assert.equal(saved.ok, true)
  assert.ok(saved.written.length > 0, 'a dirty project writes its changed staff files')
  assert.deepEqual(saved.errors, [])
  assert.equal(store.view().dirty, false)

  const noProject = createTestStore().store
  const emptyTools = createTools(noProject, { logger: SILENT_LOGGER, resolveDirectory: () => os.tmpdir() })
  const emptyByName = new Map(emptyTools.map((definition) => [definition.name, definition]))
  for (const name of ['gorge_chart_get', 'gorge_chart_save', 'gorge_chart_validate']) {
    const result = await emptyByName.get(name).execute({})
    assert.equal(result.ok, false, `${name} must report the missing project instead of throwing`)
    assert.equal(typeof result.error, 'string')
  }
  const openMissing = await byName.get('gorge_project_open').execute({ dir: 'does-not-exist' })
  assert.equal(openMissing.ok, false, 'tool errors are returned as results, not thrown')
  assert.equal(typeof openMissing.error, 'string')
})

// ---------------------------------------------------------------------------
// Plugin entry point: tools, routes, prompt context, cleanup
// ---------------------------------------------------------------------------

test('apply: registers seven tools, nine routes, and the prompt context', () => {
  const copy = copyFixture()
  const stateDirectory = tempDir('gorge-chart-apply-')
  const host = createFakeHost()
  apply(host.ctx, {
    projectRoot: copy.root,
    autoSave: false,
    statePath: path.join(stateDirectory, 'state', 'project.json'),
  })

  assert.deepEqual([...host.tools.keys()].sort(), [
    'gorge_chart_edit',
    'gorge_chart_get',
    'gorge_chart_save',
    'gorge_chart_validate',
    'gorge_element_schema',
    'gorge_project_list',
    'gorge_project_open',
  ])
  assert.deepEqual([...host.routes.keys()].sort(), Object.values(ENDPOINTS).sort())
  for (const route of host.routes.values()) assert.equal(route.kind, 'exact')

  const context = host.contexts.get('gorge-chart:workspace')
  assert.ok(context, 'prompt context is registered')
  assert.equal(context.order, 949)
  assert.equal(typeof context.text, 'function')
  assert.ok(context.text().includes('Dremu chart workspace'))

  const skillProvider = host.skillProviders.get('gorge-chart')
  assert.ok(skillProvider, 'bundled skill provider is registered')
  const candidates = skillProvider.list()
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].name, 'dremu-chart-editing')
  assert.equal(candidates[0].rank, 600)
  assert.ok(candidates[0].description.includes('Dremu'))

  host.dispose()
  assert.equal(host.tools.size, 0, 'tool registrations are disposed')
  assert.equal(host.routes.size, 0, 'route registrations are disposed')
  assert.equal(host.contexts.size, 0, 'prompt context is disposed')
  assert.equal(host.skillProviders.size, 0, 'skill provider registrations are disposed')
})

test('apply: tools load without a web server or system prompt', () => {
  const copy = copyFixture()
  const stateDirectory = tempDir('gorge-chart-apply-')
  const host = createFakeHost({ present: ['tools'] })
  apply(host.ctx, {
    projectRoot: copy.root,
    autoSave: false,
    statePath: path.join(stateDirectory, 'state', 'project.json'),
  })
  assert.equal(host.tools.size, 7)
  assert.equal(host.routes.size, 0)
  assert.equal(host.contexts.size, 0)
  assert.equal(host.skillProviders.size, 0, 'no skill registry in this composition')
  host.dispose()
})

test('prompt: workspace summary reports project, staffs, elements, and revision', () => {
  const copy = copyFixture()
  const store = openedStore(copy)
  const summary = workspaceSummary(store)
  assert.ok(summary.includes('Dremu chart workspace'))
  assert.ok(summary.includes(copy.project))
  assert.ok(summary.includes(`rev ${store.view().rev}`))
  assert.ok(summary.includes('gorge_chart_get'))
  assert.ok(summary.includes('gorge_chart_edit'))
  assert.ok(!summary.includes('\n'), 'the prompt context is one line')

  const empty = workspaceSummary(createTestStore().store)
  assert.ok(empty.includes('no project is open'))
  assert.ok(empty.includes('gorge_project_list'))
})

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

run().catch((error) => {
  console.error('test harness crashed:', error)
  process.exitCode = 1
})
