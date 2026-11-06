/**
 * Host half of the Dremu chart studio bundle (`@local/gorge-chart-studio`).
 *
 * One opened Gorge/Dremu chart project lives here and is exposed three ways:
 *   - browser:  GET /plugins/gorge-chart/state, SSE /plugins/gorge-chart/events,
 *               POST /plugins/gorge-chart/{edit,open,save,reload,import-audio},
 *               GET /plugins/gorge-chart/{projects,file}
 *   - model:    gorge_project_list / gorge_project_open / gorge_chart_get /
 *               gorge_chart_edit / gorge_chart_save / gorge_chart_validate /
 *               gorge_element_schema tools
 *   - prompt:   a dynamic one-line workspace summary (`gorge-chart:workspace`)
 *
 * Editing is optimistic: the browser keeps its own copy of the wire project and
 * sends `{ baseRev, ops[] }`; a stale revision is answered with 409 plus the
 * current revision instead of overwriting newer edits. Every accepted edit
 * bumps `rev`, marks the project dirty, notifies SSE subscribers, persists a
 * debounced recovery snapshot, and (when enabled) schedules a debounced
 * automatic save through the chart model, which writes `.g` files atomically
 * and keeps a `.g.bak` of the previous content.
 *
 * Only Node builtins and the shared `./dremu-model.js` module are imported so
 * the half stays loadable in a plain Node test process. Testable internals
 * (store factory, HTTP handler factories, tool factory) are exported alongside
 * `apply`; see tests/host.test.mjs.
 *
 * Sections (search for "NN ·"):
 *   01 constants                 08 browser HTTP handlers
 *   02 shared utilities          09 agent tool schemas
 *   03 local-only HTTP helpers   10 agent tools
 *   04 project discovery         11 dynamic prompt context
 *   05 recovery snapshot         12 plugin configuration
 *   06 project store             13 plugin entry point
 *   07 project file serving
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  CATALOG,
  applyOps as modelApplyOps,
  loadProject,
  probeAudioFile,
  projectToWire,
  saveProject,
  validateProject,
} from './dremu-model.js'
import { registerSkillProvider } from './skills.js'

// ---------------------------------------------------------------------------
// 01 · Constants
// ---------------------------------------------------------------------------

/** Directory this Host half is installed in (the linked bundle directory). */
const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url))
/** Default recovery snapshot location, `<pluginDir>/state/project.json`. */
export const DEFAULT_STATE_PATH = path.join(PLUGIN_DIR, 'state', 'project.json')
/** Default project root when the plugin is configured without one. */
export const DEFAULT_PROJECT_ROOT = path.join(os.homedir(), 'Music')

/** Endpoint paths (all registered as `kind: 'exact'` routes). */
export const ENDPOINTS = {
  state: '/plugins/gorge-chart/state',
  edit: '/plugins/gorge-chart/edit',
  events: '/plugins/gorge-chart/events',
  open: '/plugins/gorge-chart/open',
  save: '/plugins/gorge-chart/save',
  file: '/plugins/gorge-chart/file',
  projects: '/plugins/gorge-chart/projects',
  reload: '/plugins/gorge-chart/reload',
  importAudio: '/plugins/gorge-chart/import-audio',
}

/** Debounce for the recovery snapshot write (`state/project.json`). */
const PERSIST_DEBOUNCE_MS = 300
/** Debounce for automatic chart saves (`dremu-model.saveProject`). */
const AUTO_SAVE_DEBOUNCE_MS = 900
/** Cached project-root scan lifetime for the state/projects endpoints. */
const PROJECT_SCAN_CACHE_MS = 4_000
/** `POST /edit` request body cap. */
const MAX_EDIT_BODY_BYTES = 4 * 1024 * 1024
/** `POST /open|save|reload` request body cap (tiny bodies). */
const MAX_SMALL_BODY_BYTES = 64 * 1024
/** `POST /import-audio` request body cap (one audio file). */
const MAX_AUDIO_BODY_BYTES = 256 * 1024 * 1024
/** Ops accepted in one edit request (client batches, agent batches). */
const MAX_OPS_PER_EDIT = 1_000
/** Accepted edit batches kept for restart recovery. */
const MAX_RECOVERY_OPS = 5_000
/** Recently opened projects remembered for the UI. */
const MAX_RECENT_PROJECTS = 12
/** Element cap inside `gorge_chart_get` results. */
const MAX_TOOL_ELEMENTS = 400
/** Issue cap inside `gorge_chart_validate` results. */
const MAX_TOOL_ISSUES = 200
/** Projects returned by a project-root scan. */
const MAX_PROJECTS = 200
/** Chart project scan depth below the project root. */
const PROJECT_SCAN_DEPTH = 2
/** Dynamic prompt context identity. */
const PROMPT_CONTEXT_NAME = 'gorge-chart:workspace'
const PROMPT_CONTEXT_ORDER = 949

/**
 * Addresses Node reports on a direct loopback connection. The editor endpoints
 * are local-only: the same rule guards the reference plugins' local HTTP
 * surface.
 */
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const LOCAL_HOSTNAMES = ['127.0.0.1', 'localhost', '[::1]']

/** Chart/storyboard file extensions considered project content. */
const CHART_FILE_EXTS = new Set(['.g'])
/** Audio extensions considered project assets. */
const AUDIO_FILE_EXTS = new Set(['.wav', '.mp3', '.ogg', '.m4a', '.flac', '.aac', '.opus'])
/** Image extensions considered project assets. */
const IMAGE_FILE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.svg'])
/** Content types served by `GET /plugins/gorge-chart/file`. */
const MIME_TYPES = {
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.opus': 'audio/opus',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.g': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
}
/** Generic content type for extensionless/unknown project files. */
const GENERIC_CONTENT_TYPE = 'application/octet-stream'
/** Directory names never walked by a project-root scan. */
const SKIP_SCAN_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', 'state', 'dist', 'build'])

/** Plugin inject declaration: every tool registration requires the tool registry. */
export const inject = ['tools']

// ---------------------------------------------------------------------------
// 02 · Small shared utilities
// ---------------------------------------------------------------------------

/** Best-effort logger from the Cordis context; console fallback for bare use. */
function resolveLogger(ctx) {
  const logger = ctx && ctx.logger
  if (logger && typeof logger.warn === 'function') return logger
  return {
    warn(...parts) {
      try {
        console.warn(...parts)
      } catch {
        /* logging must never fail the caller */
      }
    },
  }
}

/** Pick a `{warn}` logger from options, falling back to the console. */
function pickLogger(candidate) {
  if (candidate && typeof candidate.warn === 'function') return candidate
  return resolveLogger(null)
}

/** Write one warning without ever letting the logger throw. */
function warn(logger, message) {
  try {
    logger.warn(message)
  } catch {
    /* ignore */
  }
}

/** Error message for API/tool bodies, never a bare object. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/** True for a plain JSON-object candidate (not null, not an array). */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** True when `target` is `root` or lies below it (both already normalized). */
function isPathInside(root, target) {
  if (typeof root !== 'string' || typeof target !== 'string' || root.length === 0) return false
  if (target === root) return true
  return target.startsWith(root + path.sep)
}

/** `fs.realpathSync` that reports failure as null instead of throwing. */
function safeRealpath(target) {
  try {
    return fs.realpathSync(target)
  } catch {
    return null
  }
}

/** `fs.statSync` that reports failure as null instead of throwing. */
function safeStat(target) {
  try {
    return fs.statSync(target)
  } catch {
    return null
  }
}

/**
 * Throw a Node-style coded error unless `target` is an existing directory.
 * Shared by project opening and project-directory resolution so both report
 * `ENOENT` / `ENOTDIR` identically.
 */
function requireDirectory(target) {
  const stats = safeStat(target)
  if (!stats) {
    const error = new Error(`project directory not found: ${target}`)
    error.code = 'ENOENT'
    throw error
  }
  if (!stats.isDirectory()) {
    const error = new Error(`not a directory: ${target}`)
    error.code = 'ENOTDIR'
    throw error
  }
  return target
}

/** Rounded element duration in seconds, or null for instant elements. */
function elementDuration(element) {
  return element.duration === null || element.duration === undefined ? null : roundNumber(element.duration)
}

/** Staff and element totals of a loaded project (wire or model shape). */
function countProjectElements(project) {
  const staffs = project && Array.isArray(project.staffs) ? project.staffs : []
  let staffCount = 0
  let elementCount = 0
  for (const staff of staffs) {
    staffCount += 1
    for (const period of staff.periods || []) elementCount += (period.elements || []).length
  }
  return { staffCount, elementCount }
}

/** Round a finite number to `digits` decimals; non-numbers become null. */
function roundNumber(value, digits = 6) {
  const number = Number(value)
  if (!Number.isFinite(number)) return null
  const factor = 10 ** digits
  return Math.round(number * factor) / factor
}

/** Defensive copy of a string array, capped and de-duplicated. */
function capStrings(values, limit) {
  const out = []
  const seen = new Set()
  if (!Array.isArray(values)) return out
  for (const value of values) {
    if (typeof value !== 'string') continue
    const text = value.length > 400 ? `${value.slice(0, 397)}...` : value
    if (seen.has(text)) continue
    seen.add(text)
    out.push(text)
    if (out.length >= limit) break
  }
  return out
}

/** Plain JSON copy (tool results must never expose live model objects). */
function jsonClone(value) {
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// 03 · Local-only HTTP helpers (mirrors the MIDI editor plugin's guard)
// ---------------------------------------------------------------------------

/**
 * Whether a request comes from this machine's loopback interface and passed
 * the same-origin header rules. Non-loopback peers are rejected before any
 * project is read or written.
 */
export function isLocalRequest(req) {
  if (!LOOPBACK_ADDRESSES.has(req && req.socket && req.socket.remoteAddress)) return false
  const headers = (req && req.headers) || {}
  if (headers.host) {
    try {
      const host = new URL(`http://${headers.host}`)
      if (host.username || host.password || !LOCAL_HOSTNAMES.includes(host.hostname)) return false
    } catch {
      return false
    }
  }
  if (!headers.origin) return true
  try {
    const origin = new URL(headers.origin)
    return (origin.protocol === 'http:' || origin.protocol === 'https:') && origin.host === headers.host
  } catch {
    return false
  }
}

/**
 * Write one JSON response with the mandatory no-store header.
 *
 * Status-code convention for every JSON endpoint in this plugin: a body is
 * always present, so handlers answer 200 for success and never 204; 400, 403,
 * 404, 405, 409, and 500 carry `{ error }` (the 409 additionally carries
 * `{ conflict: true, rev, dirty }`). `GET /plugins/gorge-chart/file` is the
 * only non-JSON endpoint: 200 for full content, 206 for a Range slice, 416 for
 * an unsatisfiable Range.
 */
export function jsonResponse(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/** Read a bounded request body and parse it as one JSON object. */
async function readJsonBody(req, maxBytes) {
  const chunks = []
  let bytes = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > maxBytes) throw new Error('request body is too large')
    chunks.push(buffer)
  }
  if (bytes === 0) throw new Error('request body is empty')
  let value
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('request body is not valid JSON')
  }
  if (!isPlainObject(value)) throw new Error('request body must be a JSON object')
  return value
}

/** Read a bounded raw request body (audio upload) into one Buffer. */
async function readBinaryBody(req, maxBytes) {
  const chunks = []
  let bytes = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > maxBytes) throw new Error('request body is too large')
    chunks.push(buffer)
  }
  if (bytes === 0) throw new Error('request body is empty')
  return Buffer.concat(chunks)
}

/** Sanitize one uploaded audio file's basename (letters/digits/dot/dash/space). */
function sanitizeUploadName(fileName) {
  const base = path.basename(String(fileName || ''))
  const cleaned = base.replace(/[^\p{L}\p{N}._\- ]+/gu, '_').replace(/^\.+/, '').trim()
  return cleaned.length > 0 ? cleaned : 'audio.wav'
}

/** Unique file name inside `dir` (adds `_1`, `_2`, ... before the extension). */
function uniqueUploadName(dir, fileName) {
  const sanitized = sanitizeUploadName(fileName)
  const extension = path.extname(sanitized)
  const stem = sanitized.slice(0, sanitized.length - extension.length) || 'audio'
  let candidate = sanitized
  let index = 1
  while (fs.existsSync(path.join(dir, candidate))) {
    candidate = `${stem}_${index}${extension}`
    index += 1
  }
  return candidate
}

// ---------------------------------------------------------------------------
// 04 · Project discovery
// ---------------------------------------------------------------------------

/**
 * Scan `root` for Dremu chart projects: directories containing at least one
 * `.g` staff file. Walks `maxDepth` directory levels, skips hidden entries and
 * dependency/build directories, and returns at most `limit` compact entries
 * sorted by name. Never throws: an unreadable root yields an empty list.
 *
 * Entry shape: `{ dir, name, relative, chartFiles, audio, images, modified }`
 * where `audio`/`images` are the first asset filename found (display hints).
 */
export function scanProjectRoot(root, options = {}) {
  let base
  try {
    base = path.resolve(String(root))
  } catch {
    return []
  }
  const maxDepth = Number.isFinite(options.maxDepth) ? Math.max(0, Math.floor(options.maxDepth)) : PROJECT_SCAN_DEPTH
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.floor(options.limit)) : MAX_PROJECTS
  const results = []

  function visit(directory, depth) {
    if (results.length >= limit) return
    let entries
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    let chartFiles = 0
    let audio = null
    let images = 0
    let modified = 0
    const subdirectories = []
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        if (!SKIP_SCAN_DIRS.has(entry.name)) subdirectories.push(full)
        continue
      }
      if (!entry.isFile()) continue // symlinked staffs/assets are not project entries
      const ext = path.extname(entry.name).toLowerCase()
      if (CHART_FILE_EXTS.has(ext)) {
        chartFiles += 1
        const stats = safeStat(full)
        if (stats && stats.mtimeMs > modified) modified = stats.mtimeMs
      } else if (!audio && AUDIO_FILE_EXTS.has(ext)) {
        audio = entry.name
      } else if (IMAGE_FILE_EXTS.has(ext)) {
        images += 1
      }
    }
    if (chartFiles > 0) {
      const name = path.basename(directory)
      results.push({
        dir: directory,
        name,
        title: name,
        relative: path.relative(base, directory) || '.',
        chartFiles,
        staffs: chartFiles,
        audio,
        images,
        modified: modified > 0 ? new Date(modified).toISOString() : null,
      })
    }
    if (depth >= maxDepth) return
    subdirectories.sort((left, right) => left.localeCompare(right))
    for (const subdirectory of subdirectories) visit(subdirectory, depth + 1)
  }

  visit(base, 0)
  results.sort((left, right) => left.name.localeCompare(right.name) || left.dir.localeCompare(right.dir))
  return results.slice(0, limit)
}

/**
 * Resolve a user-supplied project directory to an absolute existing directory.
 *
 * Accepts an absolute path, or a name/directory relative to `projectRoot`
 * (preferred) or the calling session's working directory. Throws an Error
 * carrying a Node-ish `code` (`ENOENT`/`ENOTDIR`) when nothing usable exists.
 */
export function resolveProjectDirectory(input, options = {}) {
  if (typeof input !== 'string' || input.trim().length === 0) {
    throw new Error('a project directory (absolute path or project name) is required')
  }
  const value = input.trim()
  const projectRoot = typeof options.projectRoot === 'string' && options.projectRoot.length > 0 ? path.resolve(options.projectRoot) : null
  const cwd = typeof options.cwd === 'string' && options.cwd.length > 0 ? path.resolve(options.cwd) : process.cwd()
  let candidate
  if (path.isAbsolute(value)) {
    candidate = path.normalize(value)
  } else {
    const underRoot = projectRoot ? path.resolve(projectRoot, value) : null
    const underCwd = path.resolve(cwd, value)
    if (underRoot && safeStat(underRoot)?.isDirectory()) candidate = underRoot
    else if (safeStat(underCwd)?.isDirectory()) candidate = underCwd
    else candidate = underRoot || underCwd
  }
  return requireDirectory(candidate)
}

// ---------------------------------------------------------------------------
// 05 · Recovery snapshot
// ---------------------------------------------------------------------------

/**
 * Read the persisted recovery snapshot. The snapshot is metadata only:
 * `{ version, openPath, rev, dirty, recent, pendingBatches, opsTruncated,
 * savedAt }`. `pendingBatches` holds the op lists accepted since the last
 * successful chart save so a Host restart can replay unsaved agent/client
 * edits on top of the on-disk project (used when autoSave is off).
 *
 * Returns null for a missing or unusable file; never throws.
 */
function readRecoverySnapshot(statePath, logger) {
  let raw
  try {
    raw = fs.readFileSync(statePath, 'utf8')
  } catch (error) {
    if (!error || error.code !== 'ENOENT') {
      warn(logger, `gorge-chart: cannot read recovery snapshot ${statePath}: ${messageOf(error)}`)
    }
    return null
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    warn(logger, `gorge-chart: ignoring invalid recovery snapshot ${statePath}: ${messageOf(error)}`)
    return null
  }
  if (!isPlainObject(parsed)) return null
  const openPath = typeof parsed.openPath === 'string' && parsed.openPath.length > 0 ? parsed.openPath : null
  const rev = Number.isFinite(Number(parsed.rev)) && Number(parsed.rev) >= 1 ? Math.floor(Number(parsed.rev)) : 1
  const dirty = parsed.dirty === true
  const recent = Array.isArray(parsed.recent)
    ? parsed.recent.filter((entry) => typeof entry === 'string' && entry.length > 0).slice(0, MAX_RECENT_PROJECTS)
    : []
  let pendingOpTotal = 0
  const pendingBatches = []
  if (Array.isArray(parsed.pendingBatches)) {
    for (const batch of parsed.pendingBatches) {
      if (!Array.isArray(batch) || batch.length === 0) continue
      pendingOpTotal += batch.length
      if (pendingOpTotal > MAX_RECOVERY_OPS) break
      pendingBatches.push(batch)
    }
  }
  const truncated = parsed.opsTruncated === true || pendingOpTotal > MAX_RECOVERY_OPS
  return { openPath, rev, dirty, recent, pendingBatches, opsTruncated: truncated }
}

// ---------------------------------------------------------------------------
// 06 · Project store
// ---------------------------------------------------------------------------

/**
 * Create the single-project chart store.
 *
 * State: `{ rev, dirty, project, openPath, undoCount, openRealDir }` via
 * `view()`, with `state()` returning the browser wire document. The store:
 *   - opens one project at a time through `loadProject` (never throws on a
 *     single bad staff file: the model reports warnings),
 *   - accepts op batches through `applyOps(baseRev, ops)` with optimistic
 *     concurrency (a stale `baseRev` is reported as `conflict: true`),
 *   - increments `rev`, sets `dirty`, notifies subscribers, and schedules a
 *     debounced `saveProject()` on every accepted mutation (when autoSave is
 *     enabled) plus a debounced recovery snapshot write,
 *   - resumes the last opened project from `<pluginDir>/state/project.json`
 *     when the Host restarts, replaying accepted-but-unsaved ops,
 *   - never throws out of `save()`: model failures are logged and returned as
 *     `errors[]` so a read-only project directory cannot take the Host down.
 *
 * Options: `statePath` (recovery file), `projectRoot`, `autoSave` (default
 * true), `autoSaveDelayMs`, `persistDebounceMs`, `scanCacheMs`, `resume`
 * (default true), `logger` (`{warn}` sink).
 */
export function createStore(options = {}) {
  const logger = pickLogger(options.logger)
  const statePath = path.resolve(
    typeof options.statePath === 'string' && options.statePath.length > 0 ? options.statePath : DEFAULT_STATE_PATH,
  )
  const persistDebounceMs = Number.isFinite(options.persistDebounceMs)
    ? Math.max(0, options.persistDebounceMs)
    : PERSIST_DEBOUNCE_MS
  const autoSaveDelayMs = Number.isFinite(options.autoSaveDelayMs)
    ? Math.max(0, options.autoSaveDelayMs)
    : AUTO_SAVE_DEBOUNCE_MS
  const scanCacheMs = Number.isFinite(options.scanCacheMs) ? Math.max(0, options.scanCacheMs) : PROJECT_SCAN_CACHE_MS
  const autoSave = options.autoSave !== false
  const resumeEnabled = options.resume !== false
  const projectRoot = path.resolve(
    typeof options.projectRoot === 'string' && options.projectRoot.length > 0 ? options.projectRoot : DEFAULT_PROJECT_ROOT,
  )

  const recovered = resumeEnabled ? readRecoverySnapshot(statePath, logger) : null
  let recent = recovered ? recovered.recent.slice() : []
  let rev = recovered ? recovered.rev : 1
  let dirty = false
  let project = null
  let projectDir = null
  let projectRealDir = null
  let undoCount = 0
  let pendingBatches = []
  let recoveryTruncated = false
  let closed = false
  let wireCache = null
  let projectsCache = null
  let saveTimer
  let persistTimer
  let lastPersistError
  let lastWireError
  const listeners = new Set()

  // Resume the last opened project (read-only until an edit happens).
  if (recovered && recovered.openPath) {
    try {
      project = loadProject(recovered.openPath)
      projectDir = path.resolve(recovered.openPath)
      projectRealDir = safeRealpath(projectDir)
      if (recovered.pendingBatches.length > 0 && !recovered.opsTruncated) {
        let replayFailed = false
        for (const batch of recovered.pendingBatches) {
          try {
            modelApplyOps(project, batch)
          } catch (error) {
            replayFailed = true
            warn(
              logger,
              `gorge-chart: cannot replay unsaved edit batch while resuming ${projectDir}: ${messageOf(error)}`,
            )
            break
          }
        }
        if (replayFailed) {
          // The in-memory project may be half-replayed: reload the clean disk
          // state and drop the recovery ops rather than presenting a mixture.
          project = loadProject(recovered.openPath)
          dirty = false
          pendingBatches = []
          recoveryTruncated = true
          warn(logger, `gorge-chart: unsaved edits for ${projectDir} could not be fully recovered; reopened from disk`)
        } else {
          pendingBatches = recovered.pendingBatches.slice()
          dirty = recovered.dirty || pendingBatches.length > 0
        }
      } else {
        dirty = recovered.dirty
      }
    } catch (error) {
      warn(logger, `gorge-chart: cannot resume project ${recovered.openPath}: ${messageOf(error)}`)
      project = null
      projectDir = null
      projectRealDir = null
      dirty = false
      pendingBatches = []
    }
  }
  // Unsaved edits recovered from a previous Host run are written back on the
  // next debounce tick instead of waiting for another edit.
  if (project && dirty) scheduleAutoSave()

  // -- helpers ------------------------------------------------------------

  function pushRecent(directory) {
    const withoutDuplicate = recent.filter((entry) => entry !== directory)
    recent = [directory, ...withoutDuplicate].slice(0, MAX_RECENT_PROJECTS)
  }

  function pendingOpCount() {
    let total = 0
    for (const batch of pendingBatches) total += batch.length
    return total
  }

  function recoveryPayload() {
    return {
      version: 1,
      openPath: projectDir,
      rev,
      dirty,
      recent: recent.slice(),
      pendingBatches,
      opsTruncated: recoveryTruncated,
      savedAt: new Date().toISOString(),
    }
  }

  function persistNow() {
    let tempPath
    try {
      fs.mkdirSync(path.dirname(statePath), { recursive: true })
      const payload = JSON.stringify(recoveryPayload())
      tempPath = `${statePath}.${process.pid}.tmp`
      fs.writeFileSync(tempPath, payload, 'utf8')
      fs.renameSync(tempPath, statePath)
      lastPersistError = undefined
    } catch (error) {
      const message = messageOf(error)
      if (tempPath !== undefined) {
        try {
          fs.unlinkSync(tempPath)
        } catch {
          /* nothing left to clean up */
        }
      }
      // Log once per distinct failure so a read-only directory cannot spam.
      if (message !== lastPersistError) {
        lastPersistError = message
        warn(logger, `gorge-chart: cannot persist recovery snapshot to ${statePath}: ${message}`)
      }
    }
  }

  function clearPersistTimer() {
    if (persistTimer !== undefined) {
      clearTimeout(persistTimer)
      persistTimer = undefined
    }
  }

  function schedulePersist() {
    if (closed || persistTimer !== undefined) return
    persistTimer = setTimeout(() => {
      persistTimer = undefined
      persistNow()
    }, persistDebounceMs)
    if (typeof persistTimer.unref === 'function') persistTimer.unref()
  }

  function clearAutoSaveTimer() {
    if (saveTimer !== undefined) {
      clearTimeout(saveTimer)
      saveTimer = undefined
    }
  }

  function notify() {
    for (const listener of [...listeners]) {
      try {
        listener(rev, dirty)
      } catch (error) {
        warn(logger, `gorge-chart: store subscriber failed: ${messageOf(error)}`)
      }
    }
  }

  /** Wire state from the model, cached until the revision changes. */
  function computeWire() {
    if (!project) return null
    if (wireCache && wireCache.rev === rev) return wireCache.value
    try {
      const wire = projectToWire(project, { rev, dirty })
      wireCache = { rev, value: wire }
      lastWireError = undefined
      return wire
    } catch (error) {
      const message = messageOf(error)
      if (message !== lastWireError) {
        lastWireError = message
        warn(logger, `gorge-chart: cannot build wire state: ${message}`)
      }
      return null
    }
  }

  /** Browser-facing state: wire project + catalog + open/recent metadata. */
  function state() {
    const base = {
      ok: true,
      rev,
      dirty,
      openPath: projectDir,
      recent: recent.slice(),
      projectRoot,
      autoSave,
    }
    if (!project) return { ...base, project: null, catalog: CATALOG }
    const wire = computeWire()
    if (!wire || !wire.project) {
      return { ...base, project: null, catalog: CATALOG, error: 'the project could not be read' }
    }
    return { ...base, project: wire.project, catalog: wire.catalog || CATALOG }
  }

  /** Raw store view (project is the live model object; treat as read-only). */
  function view() {
    return {
      rev,
      dirty,
      project,
      openPath: projectDir,
      openRealDir: projectRealDir,
      undoCount,
      pendingOps: pendingOpCount(),
      autoSave,
      projectRoot,
    }
  }

  /** Write pending chart changes now (manual save + tool). Never throws. */
  function saveNow() {
    clearAutoSaveTimer()
    if (closed) return { ok: false, written: [], errors: ['the store is closed'], rev, dirty, error: 'the store is closed' }
    if (!project) return { ok: false, written: [], errors: [], rev, dirty, error: 'no project is open' }
    let result
    try {
      result = saveProject(project)
    } catch (error) {
      const message = messageOf(error)
      warn(logger, `gorge-chart: save failed for ${projectDir}: ${message}`)
      return { ok: false, written: [], errors: [message], rev, dirty, error: message }
    }
    const written = Array.isArray(result && result.written) ? result.written.map(String) : []
    const errors = Array.isArray(result && result.errors) ? result.errors.map(String) : []
    const wasDirty = dirty
    if (errors.length === 0) {
      dirty = false
      pendingBatches = []
      recoveryTruncated = false
    } else {
      for (const message of errors.slice(0, 5)) warn(logger, `gorge-chart: save error for ${projectDir}: ${message}`)
    }
    schedulePersist()
    if (wasDirty || errors.length > 0) notify()
    return { ok: errors.length === 0, written, errors, rev, dirty }
  }

  function scheduleAutoSave() {
    if (!autoSave || closed || !project || saveTimer !== undefined) return
    saveTimer = setTimeout(() => {
      saveTimer = undefined
      const result = saveNow()
      if (!result.ok) {
        warn(logger, `gorge-chart: automatic save for ${projectDir} did not complete: ${result.errors.join('; ') || result.error || 'unknown error'}`)
      }
    }, autoSaveDelayMs)
    if (typeof saveTimer.unref === 'function') saveTimer.unref()
  }

  /** Derive `created` entries for `add` ops when the model does not report them. */
  function deriveCreated(ops) {
    const created = []
    for (const op of ops) {
      if (!isPlainObject(op) || op.op !== 'add' || !isPlainObject(op.element)) continue
      const elementId = typeof op.element.id === 'string' && op.element.id.length > 0 ? op.element.id : null
      if (elementId === null) continue
      created.push({
        elementId,
        staffId: typeof op.staffId === 'string' ? op.staffId : null,
        periodId: typeof op.periodId === 'string' ? op.periodId : null,
      })
    }
    return created.length > 0 ? created : undefined
  }

  /**
   * Apply one op batch with optimistic concurrency.
   *
   * Returns `{ ok: true, rev, dirty, changed, errors, created? }` for an
   * accepted batch (rev bumped only when the model reports a change),
   * `{ ok: false, conflict: true, rev, dirty }` for a stale `baseRev`, or
   * `{ ok: false, error }` for an unusable request. Never throws.
   */
  function applyOpsNow(baseRev, ops) {
    if (closed) return { ok: false, error: 'the store is closed' }
    if (!project) return { ok: false, error: 'no project is open; open a project first' }
    const expected = Number(baseRev)
    if (!Number.isFinite(expected)) return { ok: false, error: 'baseRev must be a finite number' }
    if (Math.floor(expected) !== rev) return { ok: false, conflict: true, rev, dirty }
    if (!Array.isArray(ops) || ops.length === 0) return { ok: false, error: 'ops must be a non-empty array' }
    if (ops.length > MAX_OPS_PER_EDIT) return { ok: false, error: `too many ops (${ops.length}, limit ${MAX_OPS_PER_EDIT})` }
    let result
    try {
      result = modelApplyOps(project, ops)
    } catch (error) {
      const message = messageOf(error)
      warn(logger, `gorge-chart: edit failed for ${projectDir}: ${message}`)
      return { ok: false, error: message }
    }
    if (!isPlainObject(result)) result = {}
    const errors = Array.isArray(result.errors) ? result.errors.map(String) : []
    // The model contract is `{ changed, errors }`; tolerate a missing flag by
    // treating an error-free batch as changed (the edit was accepted).
    const changed = result.changed === undefined ? errors.length === 0 : result.changed === true
    let created
    if (Array.isArray(result.created)) {
      created = result.created
        .filter((entry) => isPlainObject(entry) && (typeof entry.elementId === 'string' || typeof entry.staffId === 'string'))
        .map((entry) => {
          if (typeof entry.elementId === 'string') {
            return {
              elementId: entry.elementId,
              staffId: typeof entry.staffId === 'string' ? entry.staffId : null,
              periodId: typeof entry.periodId === 'string' ? entry.periodId : null,
            }
          }
          // `addAudioPeriod` reports the new clip (and possibly the audio staff
          // it auto-created) so the client can select/refresh the segment.
          if (entry.kind === 'audioPeriod') {
            return {
              staffId: typeof entry.staffId === 'string' ? entry.staffId : null,
              kind: 'audioPeriod',
              audioPeriodId: typeof entry.audioPeriodId === 'string' ? entry.audioPeriodId : null,
              method: typeof entry.method === 'string' ? entry.method : null,
              file: typeof entry.file === 'string' ? entry.file : null,
              timeOffset: Number.isFinite(entry.timeOffset) ? entry.timeOffset : null,
              imported: entry.imported === true,
            }
          }
          // `addStaff` reports its new staff; keep it distinguishable from an
          // element descriptor so clients can select the created row.
          return {
            staffId: entry.staffId,
            kind: 'staff',
            staffKind: typeof entry.staffKind === 'string' ? entry.staffKind : null,
          }
        })
      if (created.length === 0) created = undefined
    } else if (changed) {
      created = deriveCreated(ops)
    }
    if (!changed) {
      return { ok: true, changed: false, rev, dirty, errors, ...(created === undefined ? {} : { created }) }
    }
    rev += 1
    dirty = true
    undoCount = Math.min(undoCount + 1, 100_000)
    if (!recoveryTruncated) {
      pendingBatches.push(ops)
      if (pendingOpCount() > MAX_RECOVERY_OPS) {
        // Too much unsaved work to replay on restart; keep the on-disk state as
        // the recovery baseline and only warn once.
        recoveryTruncated = true
        pendingBatches = []
        warn(logger, 'gorge-chart: unsaved edit history exceeded the recovery limit; only saved changes will survive a restart')
      }
    }
    wireCache = null
    schedulePersist()
    scheduleAutoSave()
    notify()
    return { ok: true, changed: true, rev, dirty, errors, ...(created === undefined ? {} : { created }) }
  }

  /**
   * Adopt a freshly loaded document: bump the revision (browsers refetch on a
   * revision they did not produce), drop undo/recovery history, and notify.
   */
  function adoptProject(loaded, directory) {
    clearAutoSaveTimer()
    project = loaded
    projectDir = directory
    projectRealDir = safeRealpath(directory)
    rev += 1
    dirty = false
    undoCount = 0
    pendingBatches = []
    recoveryTruncated = false
    wireCache = null
    schedulePersist()
    notify()
  }

  /**
   * Open (or reload) a project directory. Saves the previous project first when
   * it has dirty changes and autoSave is enabled; bumps the revision so the
   * browser knows the document changed and always resets `dirty`.
   */
  function open(targetDir) {
    if (closed) throw new Error('the store is closed')
    if (typeof targetDir !== 'string' || targetDir.trim().length === 0) throw new Error('a project directory is required')
    const directory = requireDirectory(path.resolve(targetDir))
    if (project && dirty && autoSave) saveNow()
    const loaded = loadProject(directory)
    projectsCache = null
    pushRecent(directory)
    adoptProject(loaded, directory)
    return state()
  }

  /** Discard in-memory edits and re-read the open project from disk. */
  function reload() {
    if (closed) return { ok: false, error: 'the store is closed' }
    if (!projectDir) return { ok: false, error: 'no project is open' }
    let loaded
    try {
      loaded = loadProject(projectDir)
    } catch (error) {
      const message = messageOf(error)
      warn(logger, `gorge-chart: reload failed for ${projectDir}: ${message}`)
      return { ok: false, error: message }
    }
    adoptProject(loaded, projectDir)
    return { ok: true, ...state() }
  }

  /** Cached scan of the project root (`force` bypasses the short-lived cache). */
  function projects(force = false) {
    const now = Date.now()
    if (!force && projectsCache && now - projectsCache.at < scanCacheMs) return projectsCache.value.slice()
    let value
    try {
      value = scanProjectRoot(projectRoot)
    } catch (error) {
      warn(logger, `gorge-chart: cannot scan project root ${projectRoot}: ${messageOf(error)}`)
      value = []
    }
    projectsCache = { at: now, value }
    return value.slice()
  }

  /**
   * Resolve a `?path=` value inside the open project directory.
   * See `resolveProjectFile` for the containment rules.
   */
  function resolveFile(requestedPath) {
    if (!projectDir) return { ok: false, status: 409, error: 'no project is open' }
    return resolveProjectFile(projectDir, requestedPath, { realDir: projectRealDir })
  }

  /** Subscribe to revisions; returns an unsubscribe function. */
  function subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('gorge-chart: store.subscribe requires a function')
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }

  /** Flush a pending automatic save and the recovery snapshot right now. */
  function flush() {
    if (saveTimer !== undefined) {
      clearTimeout(saveTimer)
      saveTimer = undefined
      if (project && dirty) {
        const result = saveNow()
        if (!result.ok) warn(logger, `gorge-chart: flush save failed: ${result.errors.join('; ') || result.error || 'unknown error'}`)
      }
    }
    clearPersistTimer()
    persistNow()
  }

  /** Flush, save when autoSave is on, and drop timers/subscribers; idempotent. */
  function close() {
    if (closed) return
    clearAutoSaveTimer()
    clearPersistTimer()
    if (project && dirty && autoSave) {
      const result = saveNow()
      if (!result.ok) warn(logger, `gorge-chart: save on shutdown failed: ${result.errors.join('; ') || result.error || 'unknown error'}`)
    }
    // saveNow() may schedule another snapshot; the shutdown write below is the
    // final one, so drop that timer as well.
    clearPersistTimer()
    persistNow()
    closed = true
    listeners.clear()
  }

  return {
    statePath,
    projectRoot,
    view,
    state,
    wire: computeWire,
    open,
    reload,
    applyOps: applyOpsNow,
    save: saveNow,
    projects,
    resolveFile,
    subscribe,
    flush,
    close,
    get rev() {
      return rev
    },
    get dirty() {
      return dirty
    },
  }
}

// ---------------------------------------------------------------------------
// 07 · Project file serving (`GET /plugins/gorge-chart/file`)
// ---------------------------------------------------------------------------

/** Content type for a file path, generic for unknown/extensionless files. */
export function mimeTypeForPath(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase()
  return MIME_TYPES[ext] || GENERIC_CONTENT_TYPE
}

/**
 * Resolve and validate one project-file request.
 *
 * Containment rules (strict):
 *   - the open project directory is realpath'd; the requested file is
 *     realpath'd too, so symlinks that leave the project are rejected;
 *   - any `..` path segment is rejected outright (403);
 *   - absolute paths are accepted only when they resolve inside the project;
 *   - missing files are 404, directories are 404, unreadable paths 403.
 *
 * Returns `{ ok: true, abs, name, ext, size, mtimeMs, contentType }` or
 * `{ ok: false, status, error }`. Never throws.
 */
export function resolveProjectFile(projectDir, requestedPath, options = {}) {
  if (typeof projectDir !== 'string' || projectDir.length === 0) {
    return { ok: false, status: 409, error: 'no project is open' }
  }
  if (typeof requestedPath !== 'string' || requestedPath.trim().length === 0) {
    return { ok: false, status: 400, error: 'missing path query parameter' }
  }
  // URLSearchParams has already percent-decoded the value; decode a second time
  // only when the raw text still looks encoded (`%2e%2e`), never for a plain
  // filename containing a literal percent sign.
  let decoded = requestedPath.trim()
  if (/%[0-9a-fA-F]{2}/.test(decoded)) {
    try {
      decoded = decodeURIComponent(decoded)
    } catch {
      return { ok: false, status: 400, error: 'invalid path encoding' }
    }
  }
  if (decoded.includes('\0')) return { ok: false, status: 400, error: 'invalid path' }
  const segments = decoded.split(/[\\/]+/).filter((segment) => segment.length > 0 && segment !== '.')
  if (segments.includes('..')) {
    return { ok: false, status: 403, error: 'path escapes the project directory' }
  }
  const rootReal = typeof options.realDir === 'string' && options.realDir.length > 0 ? options.realDir : safeRealpath(projectDir)
  if (!rootReal) return { ok: false, status: 500, error: 'the project directory is not available' }
  let candidate
  try {
    candidate = path.isAbsolute(decoded) ? path.normalize(decoded) : path.resolve(rootReal, decoded)
  } catch {
    return { ok: false, status: 400, error: 'invalid path' }
  }
  const real = safeRealpath(candidate)
  if (!real) {
    const stats = safeStat(candidate)
    if (stats) return { ok: false, status: 403, error: 'cannot resolve file' }
    return { ok: false, status: 404, error: 'file not found' }
  }
  if (!isPathInside(rootReal, real)) {
    return { ok: false, status: 403, error: 'path escapes the project directory' }
  }
  const stats = safeStat(real)
  if (!stats) return { ok: false, status: 404, error: 'file not found' }
  if (!stats.isFile()) return { ok: false, status: 404, error: 'not a file' }
  return {
    ok: true,
    abs: real,
    name: path.basename(real),
    ext: path.extname(real).toLowerCase(),
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    contentType: mimeTypeForPath(real),
  }
}

/**
 * Parse one HTTP `Range` header against a known file size.
 *
 * Returns `null` when the header is absent/unsupported (serve the full body),
 * `{ start, end }` for a satisfiable single byte range, or the string
 * `'invalid'` for an unsatisfiable/multi-range request (answer 416). Byte
 * ranges are inclusive on both ends, matching `Content-Range` semantics.
 */
export function parseRangeHeader(header, size) {
  if (typeof header !== 'string' || header.trim().length === 0) return null
  const match = /^bytes=(.*)$/i.exec(header.trim())
  if (!match) return null // unknown range unit: ignore, serve the whole file
  const spec = match[1].trim()
  if (spec.includes(',')) return 'invalid' // multipart ranges are not needed here
  const parts = /^(\d*)-(\d*)$/.exec(spec)
  if (!parts) return 'invalid'
  const startText = parts[1]
  const endText = parts[2]
  if (startText === '' && endText === '') return 'invalid'
  const total = Number(size)
  if (!Number.isFinite(total) || total <= 0) return 'invalid'
  let start
  let end
  if (startText === '') {
    const suffix = Number(endText)
    if (!Number.isFinite(suffix) || suffix <= 0) return 'invalid'
    start = Math.max(0, total - suffix)
    end = total - 1
  } else {
    start = Number(startText)
    if (!Number.isFinite(start) || start < 0 || start >= total) return 'invalid'
    if (endText === '') {
      end = total - 1
    } else {
      const parsedEnd = Number(endText)
      if (!Number.isFinite(parsedEnd) || parsedEnd < start) return 'invalid'
      end = Math.min(parsedEnd, total - 1)
    }
  }
  return { start, end }
}

/**
 * Stream a resolved project file to a Node response, honoring `Range`.
 *
 * Status: 200 for a full body, 206 with `Content-Range` for a satisfiable
 * range, 416 with `Content-Range: bytes * /size` for an unsatisfiable one.
 * `HEAD` gets the same headers and no body. A read error after the headers are
 * sent destroys the response instead of writing a JSON body on top of bytes.
 */
function serveFile(req, res, file, logger) {
  const headers = {
    'content-type': file.contentType,
    'cache-control': 'no-store',
    'accept-ranges': 'bytes',
    'x-content-type-options': 'nosniff',
    'last-modified': new Date(file.mtimeMs).toUTCString(),
  }
  const range = parseRangeHeader(req.headers && req.headers.range, file.size)
  if (range === 'invalid') {
    res.writeHead(416, {
      ...headers,
      'content-range': `bytes */${file.size}`,
      'content-length': 0,
    })
    res.end()
    return
  }
  let status = 200
  let start = 0
  let end = file.size - 1
  if (range) {
    status = 206
    start = range.start
    end = range.end
    headers['content-range'] = `bytes ${start}-${end}/${file.size}`
  }
  headers['content-length'] = file.size === 0 ? 0 : end - start + 1
  res.writeHead(status, headers)
  if (req.method === 'HEAD' || file.size === 0) {
    res.end()
    return
  }
  const stream = fs.createReadStream(file.abs, { start, end })
  let finished = false
  stream.on('error', (error) => {
    warn(logger, `gorge-chart: cannot stream ${file.abs}: ${messageOf(error)}`)
    if (!finished) {
      finished = true
      try {
        if (typeof res.destroy === 'function') res.destroy()
        else res.end()
      } catch {
        /* the socket is already gone */
      }
    }
  })
  stream.on('data', (chunk) => {
    if (finished) return
    try {
      if (!res.write(chunk) && typeof stream.pause === 'function') {
        stream.pause()
        if (typeof res.once === 'function') res.once('drain', () => stream.resume())
      }
    } catch {
      finished = true
      if (typeof stream.destroy === 'function') stream.destroy()
    }
  })
  stream.on('end', () => {
    if (finished) return
    finished = true
    try {
      res.end()
    } catch {
      /* the client disconnected mid-stream */
    }
  })
}

// ---------------------------------------------------------------------------
// 08 · Browser HTTP handlers
// ---------------------------------------------------------------------------

/** Reject non-local requests and non-matching methods; returns true if handled. */
function guardEndpoint(req, res, methods) {
  if (!isLocalRequest(req)) {
    jsonResponse(res, 403, { error: 'local access only' })
    return true
  }
  if (!methods.includes(req.method)) {
    jsonResponse(res, 405, { error: `method not allowed (expected ${methods.join(', ')})` })
    return true
  }
  return false
}

/**
 * GET `/plugins/gorge-chart/state`
 *
 * Returns `{ rev, dirty, project, catalog, openPath, recent, projects }` (plus
 * `ok`, `projectRoot`, `autoSave`). `project` is the wire document from the
 * chart model; `null` when no project is open (the client then shows the
 * project picker). Always 200 for GET; 403 for non-loopback peers.
 */
export function createStateHandler(store) {
  return async function handleState(req, res) {
    if (guardEndpoint(req, res, ['GET'])) return
    try {
      jsonResponse(res, 200, { ...store.state(), projects: store.projects() })
    } catch (error) {
      jsonResponse(res, 500, { error: messageOf(error) })
    }
  }
}

/**
 * POST `/plugins/gorge-chart/edit`
 *
 * Body `{ baseRev, ops[] }`. On a stale revision answers `409
 * { conflict: true, rev, dirty }` so the client can refetch instead of
 * overwriting newer edits. An accepted batch (changed or not) answers 200
 * `{ rev, dirty, changed, errors?, created? }` — deliberately compact: the
 * client keeps its own optimistic copy and only refetches on an SSE revision
 * it did not produce. 400 for malformed bodies/ops.
 */
export function createEditHandler(store, options = {}) {
  const maxBodyBytes = Number.isFinite(options.maxBodyBytes) ? Math.max(1, options.maxBodyBytes) : MAX_EDIT_BODY_BYTES
  return async function handleEdit(req, res) {
    if (guardEndpoint(req, res, ['POST'])) return
    let body
    try {
      body = await readJsonBody(req, maxBodyBytes)
    } catch (error) {
      jsonResponse(res, 400, { error: messageOf(error) })
      return
    }
    if (!Number.isFinite(Number(body.baseRev))) {
      jsonResponse(res, 400, { error: 'expected { baseRev: number, ops: array }' })
      return
    }
    if (!Array.isArray(body.ops) || body.ops.length === 0) {
      jsonResponse(res, 400, { error: 'expected { baseRev: number, ops: non-empty array }' })
      return
    }
    let outcome
    try {
      outcome = store.applyOps(body.baseRev, body.ops)
    } catch (error) {
      jsonResponse(res, 500, { error: messageOf(error) })
      return
    }
    if (outcome.conflict === true) {
      jsonResponse(res, 409, { conflict: true, rev: outcome.rev, dirty: outcome.dirty })
      return
    }
    if (outcome.ok !== true) {
      jsonResponse(res, Number.isFinite(outcome.status) ? outcome.status : 400, { error: outcome.error || 'edit rejected' })
      return
    }
    const payload = { rev: outcome.rev, dirty: outcome.dirty, changed: outcome.changed === true }
    if (Array.isArray(outcome.errors) && outcome.errors.length > 0) payload.errors = outcome.errors
    if (Array.isArray(outcome.created) && outcome.created.length > 0) payload.created = outcome.created
    jsonResponse(res, 200, payload)
  }
}

/**
 * GET `/plugins/gorge-chart/events` — server-sent revision stream.
 *
 * Sends the standard retry hint, one initial `data: {rev, dirty}` frame with
 * the current state, then one frame per accepted mutation/save; closing the
 * request unsubscribes.
 */
export function createEventsHandler(store) {
  return function handleEvents(req, res) {
    if (guardEndpoint(req, res, ['GET'])) return
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    })
    res.write('retry: 2000\n\n')
    const view = store.view()
    try {
      res.write(`data: ${JSON.stringify({ rev: view.rev, dirty: view.dirty })}\n\n`)
    } catch {
      return
    }
    let closed = false
    let unsubscribe
    function close() {
      if (closed) return
      closed = true
      if (unsubscribe !== undefined) {
        unsubscribe()
        unsubscribe = undefined
      }
    }
    unsubscribe = store.subscribe((rev, dirty) => {
      try {
        res.write(`data: ${JSON.stringify({ rev, dirty })}\n\n`)
      } catch {
        close()
      }
    })
    if (typeof req.on === 'function') req.on('close', close)
    if (res && typeof res.on === 'function') res.on('close', close)
  }
}

/**
 * POST `/plugins/gorge-chart/open` — body `{ dir }` (absolute path, or a
 * project name/dir under the configured project root or the session working
 * directory). Answers 200 with the new state (+ `projects` for the picker),
 * 400 for a malformed body, 404 for a missing directory, 500 when the model
 * cannot read the project.
 */
export function createOpenHandler(store, options = {}) {
  const maxBodyBytes = Number.isFinite(options.maxBodyBytes) ? Math.max(1, options.maxBodyBytes) : MAX_SMALL_BODY_BYTES
  const resolveDirectory = typeof options.resolveDirectory === 'function' ? options.resolveDirectory : () => process.cwd()
  return async function handleOpen(req, res) {
    if (guardEndpoint(req, res, ['POST'])) return
    let body
    try {
      body = await readJsonBody(req, maxBodyBytes)
    } catch (error) {
      jsonResponse(res, 400, { error: messageOf(error) })
      return
    }
    let directory
    try {
      directory = resolveProjectDirectory(body.dir, { projectRoot: store.projectRoot, cwd: resolveDirectory() })
    } catch (error) {
      jsonResponse(res, error && error.code === 'ENOENT' ? 404 : 400, { error: messageOf(error) })
      return
    }
    let snapshot
    try {
      snapshot = store.open(directory)
    } catch (error) {
      jsonResponse(res, 500, { error: messageOf(error) })
      return
    }
    jsonResponse(res, 200, { ...snapshot, projects: store.projects(true) })
  }
}

/**
 * POST `/plugins/gorge-chart/save` — force a synchronous save of the open
 * project. Always answers 200 for an open project: write failures are reported
 * in `errors[]` (the client shows them) because the in-memory document is
 * still valid. 400 when no project is open.
 */
export function createSaveHandler(store) {
  return async function handleSave(req, res) {
    if (guardEndpoint(req, res, ['POST'])) return
    if (!store.view().openPath) {
      jsonResponse(res, 400, { error: 'no project is open' })
      return
    }
    let result
    try {
      result = store.save()
    } catch (error) {
      jsonResponse(res, 500, { error: messageOf(error) })
      return
    }
    jsonResponse(res, 200, {
      ok: result.ok === true,
      written: Array.isArray(result.written) ? result.written : [],
      errors: Array.isArray(result.errors) ? result.errors : [],
      rev: result.rev,
      dirty: result.dirty,
    })
  }
}

/**
 * POST `/plugins/gorge-chart/reload` — discard in-memory edits and re-read the
 * open project from disk. Answers 200 with the new state, 400 when no project
 * is open, 500 when the model cannot read the directory.
 */
export function createReloadHandler(store) {
  return async function handleReload(req, res) {
    if (guardEndpoint(req, res, ['POST'])) return
    if (!store.view().openPath) {
      jsonResponse(res, 400, { error: 'no project is open' })
      return
    }
    let result
    try {
      result = store.reload()
    } catch (error) {
      jsonResponse(res, 500, { error: messageOf(error) })
      return
    }
    if (result.ok !== true) {
      jsonResponse(res, 500, { error: result.error || 'reload failed' })
      return
    }
    const { ok: _accepted, ...rest } = result
    jsonResponse(res, 200, { ...rest, projects: store.projects() })
  }
}

/**
 * POST `/plugins/gorge-chart/import-audio?name=<file>` — copy one uploaded
 * audio file into the open project directory.
 *
 * The browser reads a local `File` and posts its bytes with the original file
 * name; the response is `{ ok, file, absolute, duration, sampleRate, channels,
 * format, bytes }` where `file` is the project-relative name to pass to an
 * `addAudioPeriod` op. Local-only; audio extensions only; 256 MiB cap.
 */
export function createImportAudioHandler(store, options = {}) {
  const maxBytes = Number.isFinite(options.maxAudioBytes) ? Math.max(1, options.maxAudioBytes) : MAX_AUDIO_BODY_BYTES
  return async function handleImportAudio(req, res) {
    if (guardEndpoint(req, res, ['POST'])) return
    const view = store.view()
    if (!view.openPath) {
      jsonResponse(res, 409, { error: 'no project is open' })
      return
    }
    let url
    try {
      url = new URL(req.url || '/', 'http://localhost')
    } catch {
      jsonResponse(res, 400, { error: 'invalid request url' })
      return
    }
    const rawName = url.searchParams.get('name') || req.headers['x-file-name'] || ''
    const fileName = sanitizeUploadName(rawName)
    const extension = path.extname(fileName).toLowerCase()
    if (!AUDIO_FILE_EXTS.has(extension)) {
      jsonResponse(res, 400, { error: `unsupported audio file type "${extension || '(none)'}"` })
      return
    }
    let body
    try {
      body = await readBinaryBody(req, maxBytes)
    } catch (error) {
      jsonResponse(res, 400, { error: messageOf(error) })
      return
    }
    const dir = path.resolve(view.openPath)
    let target
    try {
      target = path.join(dir, uniqueUploadName(dir, fileName))
    } catch (error) {
      jsonResponse(res, 400, { error: messageOf(error) })
      return
    }
    if (!isPathInside(dir, target)) {
      jsonResponse(res, 400, { error: 'invalid file name' })
      return
    }
    const tmp = path.join(dir, `.${path.basename(target)}.${process.pid.toString(36)}${Date.now().toString(36)}.tmp`)
    try {
      fs.writeFileSync(tmp, body)
      fs.renameSync(tmp, target)
    } catch (error) {
      try {
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp)
      } catch {
        /* ignore cleanup failures */
      }
      jsonResponse(res, 500, { error: `cannot write audio file: ${messageOf(error)}` })
      return
    }
    const probe = probeAudioFile(target)
    jsonResponse(res, 200, {
      ok: true,
      file: path.basename(target),
      absolute: target,
      duration: probe.duration,
      sampleRate: probe.sampleRate,
      channels: probe.channels,
      format: probe.format,
      bytes: body.length,
    })
  }
}

/**
 * GET `/plugins/gorge-chart/projects` — scan the configured project root and
 * return `{ projectRoot, count, projects }`. Always 200 (an unreadable root
 * yields an empty list plus a warning in the Host log).
 */
export function createProjectsHandler(store) {
  return async function handleProjects(req, res) {
    if (guardEndpoint(req, res, ['GET'])) return
    try {
      const projects = store.projects()
      jsonResponse(res, 200, { ok: true, projectRoot: store.projectRoot, count: projects.length, projects })
    } catch (error) {
      jsonResponse(res, 500, { error: messageOf(error) })
    }
  }
}

/**
 * GET `/plugins/gorge-chart/file?path=…` — raw project file (audio, images,
 * staff text) with HTTP Range support for audio seeking.
 *
 * `path` may be relative to the open project directory or the absolute path of
 * a file inside it (the client sends absolute asset paths). Containment is
 * enforced on real paths (see `resolveProjectFile`): traversal, absolute
 * escapes, and symlink escapes answer 403; missing files 404; no open project
 * 409; unsatisfiable ranges 416. Full content is 200, a byte range 206 with
 * `Content-Range` and `Accept-Ranges: bytes`.
 */
export function createFileHandler(store, options = {}) {
  const logger = pickLogger(options.logger)
  return function handleFile(req, res) {
    if (!isLocalRequest(req)) {
      jsonResponse(res, 403, { error: 'local access only' })
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      jsonResponse(res, 405, { error: 'method not allowed (expected GET, HEAD)' })
      return
    }
    let url
    try {
      url = new URL(req.url || '/', 'http://localhost')
    } catch {
      jsonResponse(res, 400, { error: 'invalid request url' })
      return
    }
    const requested = url.searchParams.get('path') ?? url.searchParams.get('file') ?? ''
    let file
    try {
      file = store.resolveFile(requested)
    } catch (error) {
      jsonResponse(res, 500, { error: messageOf(error) })
      return
    }
    if (!file || file.ok !== true) {
      jsonResponse(res, Number.isFinite(file && file.status) ? file.status : 400, {
        error: (file && file.error) || 'cannot serve file',
      })
      return
    }
    try {
      serveFile(req, res, file, logger)
    } catch (error) {
      warn(logger, `gorge-chart: cannot serve ${file.abs}: ${messageOf(error)}`)
      if (!res.headersSent) jsonResponse(res, 500, { error: messageOf(error) })
    }
  }
}

/**
 * All HTTP handlers as `{ path, handler }` pairs, in registration order.
 * `options` is forwarded (logger, resolveDirectory, body caps).
 */
export function createHandlers(store, options = {}) {
  return [
    { path: ENDPOINTS.state, handler: createStateHandler(store) },
    { path: ENDPOINTS.edit, handler: createEditHandler(store, options) },
    { path: ENDPOINTS.events, handler: createEventsHandler(store) },
    { path: ENDPOINTS.open, handler: createOpenHandler(store, options) },
    { path: ENDPOINTS.save, handler: createSaveHandler(store) },
    { path: ENDPOINTS.file, handler: createFileHandler(store, options) },
    { path: ENDPOINTS.projects, handler: createProjectsHandler(store) },
    { path: ENDPOINTS.reload, handler: createReloadHandler(store) },
    { path: ENDPOINTS.importAudio, handler: createImportAudioHandler(store, options) },
  ]
}

// ---------------------------------------------------------------------------
// 09 · Agent tool schemas (raw JSON Schema, exactly as documented)
// ---------------------------------------------------------------------------

const NUM = { type: 'number' }

/**
 * One edit operation. The model owns the exact semantics; this schema mirrors
 * the op shapes the client sends:
 *   { op:'patch', elementId, path, value }
 *   { op:'add', staffId, periodId?, element:{ id?, type, fields? } }
 *   { op:'remove', elementId }
 *   { op:'duplicate', elementId, newId?, timeShift? }
 *   { op:'setMeta', tempo?, title? }
 *   { op:'setStaffName', staffId, displayName }
 *   { op:'setPeriodConfig', periodId, fields }
 *   { op:'addStaff', kind?, form?, displayName?, className?, fileName?, timeOffset?, minLength? }
 *   { op:'removeStaff', staffId, deleteFile? }
 *   { op:'addAudioPeriod', staffId?, file?, sourcePath?, name?, timeOffset?, method? }
 *   { op:'patchAudioPeriod', staffId?, audioPeriodId, fields }
 *   { op:'removeAudioPeriod', staffId?, audioPeriodId }
 */
const OP_SCHEMA = {
  type: 'object',
  required: ['op'],
  additionalProperties: true,
  properties: {
    op: {
      type: 'string',
      enum: [
        'patch',
        'add',
        'remove',
        'duplicate',
        'setMeta',
        'setStaffName',
        'setPeriodConfig',
        'addStaff',
        'removeStaff',
        'addAudioPeriod',
        'patchAudioPeriod',
        'removeAudioPeriod',
      ],
      description: 'Operation kind.',
    },
    elementId: { type: 'string', description: 'Opaque element id from gorge_chart_get (stable across edits).' },
    path: {
      type: 'array',
      description: 'Field path segments inside the element fields ([] replaces the whole field map).',
      items: { anyOf: [{ type: 'string' }, { type: 'number' }] },
    },
    value: { description: 'New value for patch (typed value tree from gorge_chart_get).' },
    staffId: { type: 'string', description: 'Staff id = file basename, e.g. DremuStaff1.g.' },
    periodId: { type: 'string', description: 'Target period id; omit to let the model pick by time.' },
    element: {
      type: 'object',
      required: ['type'],
      additionalProperties: true,
      properties: {
        id: { type: 'string', description: 'Optional client-generated element id.' },
        type: { type: 'string', description: 'Element type, e.g. Dremu.DremuTap.' },
        fields: { type: 'object', description: 'Initial field map; defaults come from gorge_element_schema.' },
      },
    },
    newId: { type: 'string', description: 'Id for the duplicated element (optional).' },
    timeShift: { type: 'number', description: 'Seconds to shift the duplicate by.' },
    tempo: { type: 'object', additionalProperties: true, properties: { bpm: NUM, offset: NUM } },
    title: { type: 'string' },
    displayName: { type: 'string' },
    fields: { type: 'object', description: 'Field map for setPeriodConfig / patchAudioPeriod.' },
    kind: { type: 'string', enum: ['chart', 'storyboard', 'audio'], description: 'addStaff: staff kind.' },
    form: { type: 'string', description: 'addStaff: Gorge form ("Dremu" or "DeentyStoryboard").' },
    className: { type: 'string', description: 'addStaff: class name; defaults to a unique generated name.' },
    fileName: { type: 'string', description: 'addStaff: file basename ending in .g; defaults to <className>.g.' },
    timeOffset: { type: 'number', description: 'addStaff/addAudioPeriod: start in seconds (default 0).' },
    minLength: { oneOf: [{ type: 'number' }, { type: 'null' }], description: 'addStaff: period length in seconds (default open-ended).' },
    file: {
      type: 'string',
      description:
        'addAudioPeriod/patchAudioPeriod: project-relative audio path (e.g. "Song.wav"); an absolute path imports that file into the project.',
    },
    sourcePath: {
      type: 'string',
      description: 'addAudioPeriod/patchAudioPeriod: external audio file to copy into the project before referencing it.',
    },
    name: { type: 'string', description: 'addAudioPeriod: asset name shown in the editor (default: file basename).' },
    method: { type: 'string', description: 'addAudioPeriod: @Song method name (default: unique GetSong / GetSong1 ...).' },
    audioPeriodId: { type: 'string', description: 'patchAudioPeriod/removeAudioPeriod: id such as "a0" (from gorge_chart_get).' },
    deleteFile: {
      type: 'boolean',
      description:
        'removeStaff: also delete a staff that was loaded from disk (removes its .g and .bak). Created-in-session staffs do not need it. Permanent — confirm with the user first.',
    },
  },
}

const TOOL_PARAMETERS = {
  project_list: {
    type: 'object',
    additionalProperties: false,
    properties: {
      refresh: { type: 'boolean', description: 'Rescan the project root instead of using the short-lived cache.' },
    },
  },
  project_open: {
    type: 'object',
    required: ['dir'],
    additionalProperties: false,
    properties: {
      dir: {
        type: 'string',
        description: 'Absolute project directory, or a project name/dir relative to the project root or session directory.',
      },
    },
  },
  chart_get: {
    type: 'object',
    additionalProperties: false,
    properties: {
      staffId: { type: 'string', description: 'Only inspect this staff (file basename).' },
      elementId: {
        type: 'string',
        description: 'Return this one element with its full field tree instead of the chart summary.',
      },
      lanes: { type: 'array', items: { type: 'string' }, description: 'Only elements on these lanes.' },
      detail: { type: 'boolean', description: 'Include each element field map in the summary (default false).' },
    },
  },
  chart_edit: {
    type: 'object',
    required: ['ops'],
    additionalProperties: false,
    properties: {
      ops: { type: 'array', minItems: 1, description: 'Operations to apply atomically, in order.', items: OP_SCHEMA },
    },
  },
  chart_save: { type: 'object', additionalProperties: false, properties: {} },
  chart_validate: { type: 'object', additionalProperties: false, properties: {} },
  element_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      type: {
        type: 'string',
        description: 'Element type (e.g. Dremu.DremuTap) or short name (Tap). Omit for the type index.',
      },
    },
  },
}

/** Model-facing rendering shared by every tool: pretty canonical JSON text. */
const TOOL_OUTPUT = {
  schema: {},
  render(_args, value) {
    return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
  },
}

// ---------------------------------------------------------------------------
// 10 · Agent tools
// ---------------------------------------------------------------------------

/** Compact one-element view for `gorge_chart_get`. */
function compactElement(element, detail) {
  const view = {
    id: element.id,
    type: element.type,
    start: roundNumber(element.start),
    duration: elementDuration(element),
    lane: element.lane === undefined ? null : element.lane,
    category: element.category || null,
  }
  if (detail) view.fields = isPlainObject(element.fields) ? element.fields : {}
  return view
}

/** Compact project metadata for tool results. */
function compactProjectMeta(project) {
  const assets = isPlainObject(project.assets) ? project.assets : { images: [], audio: [] }
  return {
    id: project.id,
    title: project.title,
    form: project.form,
    tempo: isPlainObject(project.tempo) ? project.tempo : { bpm: 120, offset: 0 },
    duration: roundNumber(project.duration),
    audio: isPlainObject(project.audio)
      ? { file: project.audio.file, name: project.audio.name, duration: roundNumber(project.audio.duration) }
      : null,
    audioPeriods: Array.isArray(project.audioPeriods)
      ? project.audioPeriods.slice(0, 50).map((clip) => ({
          id: clip.id,
          staffId: clip.staffId,
          method: clip.method,
          name: clip.name,
          relativePath: clip.relativePath,
          offset: roundNumber(clip.offset),
          duration: roundNumber(clip.duration),
          missing: clip.missing === true,
        }))
      : [],
    assets: {
      images: Array.isArray(assets.images) ? assets.images.slice(0, 200) : [],
      audio: Array.isArray(assets.audio) ? assets.audio.slice(0, 200) : [],
    },
    warnings: capStrings(project.warnings, 50),
  }
}

/**
 * Build the seven Gorge/Dremu agent tools over one chart store.
 *
 * Options:
 *   - resolveDirectory(agent): base directory for relative project paths
 *   - maxElements: element cap in gorge_chart_get (default 400)
 *   - logger: `{warn}` sink
 *
 * Every tool returns a compact JSON-serializable object; failures are returned
 * as `{ ok: false, error }` rather than thrown so the agent can recover.
 */
export function createTools(store, options = {}) {
  const logger = pickLogger(options.logger)
  const maxElements = Number.isFinite(options.maxElements) ? Math.max(1, Math.floor(options.maxElements)) : MAX_TOOL_ELEMENTS
  const resolveDirectory = typeof options.resolveDirectory === 'function' ? options.resolveDirectory : () => process.cwd()

  /** Resolve the calling session's working directory, with a safe fallback. */
  function baseDirectory(exec) {
    try {
      const directory = resolveDirectory(exec && exec.agent)
      if (typeof directory === 'string' && directory.length > 0) return directory
    } catch (error) {
      warn(logger, `gorge-chart: cannot resolve session directory: ${messageOf(error)}`)
    }
    return process.cwd()
  }

  /** One JSON-safe project summary with optional staff/lane/element filters. */
  function summarizeChart(args = {}) {
    const state = store.state()
    if (!state.openPath || !state.project) {
      return {
        ok: false,
        error: state.openPath
          ? 'the open project could not be read; call gorge_project_open or check the Host log'
          : 'no project is open; call gorge_project_list then gorge_project_open first',
        rev: state.rev,
      }
    }
    const project = state.project
    const staffFilter = typeof args.staffId === 'string' && args.staffId.length > 0 ? args.staffId : null
    const laneFilter =
      Array.isArray(args.lanes) && args.lanes.length > 0 ? new Set(args.lanes.filter((lane) => typeof lane === 'string')) : null
    const detail = args.detail === true
    let budget = maxElements
    let truncated = false
    let totalElements = 0
    const laneSet = new Set()
    const staffs = []
    for (const staff of Array.isArray(project.staffs) ? project.staffs : []) {
      if (staffFilter && staff.id !== staffFilter) continue
      let staffElements = 0
      const periods = []
      for (const period of Array.isArray(staff.periods) ? staff.periods : []) {
        const elements = []
        const periodElements = Array.isArray(period.elements) ? period.elements : []
        for (const element of periodElements) {
          staffElements += 1
          totalElements += 1
          if (typeof element.lane === 'string' && element.lane.length > 0) laneSet.add(element.lane)
          if (laneFilter && !laneFilter.has(element.lane)) continue
          if (budget <= 0) {
            truncated = true
            continue
          }
          budget -= 1
          elements.push(compactElement(element, detail))
        }
        periods.push({
          id: period.id,
          method: period.method,
          timeOffset: roundNumber(period.timeOffset),
          minLength: period.minLength === null || period.minLength === undefined ? null : roundNumber(period.minLength),
          elementCount: periodElements.length,
          ...(elements.length > 0 || periodElements.length === 0 ? { elements } : {}),
        })
      }
      staffs.push({
        id: staff.id,
        kind: staff.kind,
        form: staff.form,
        displayName: staff.displayName,
        className: staff.className,
        elementCount: staffElements,
        periods,
        ...(Array.isArray(staff.audioPeriods)
          ? {
              audioPeriods: staff.audioPeriods.map((clip) => ({
                id: clip.id,
                method: clip.method,
                name: clip.name,
                relativePath: clip.relativePath,
                offset: roundNumber(clip.offset),
                duration: roundNumber(clip.duration),
                missing: clip.missing === true,
              })),
            }
          : {}),
      })
    }
    const result = {
      ok: true,
      rev: state.rev,
      dirty: state.dirty,
      openPath: state.openPath,
      project: { ...compactProjectMeta(project), staffCount: staffs.length, elementCount: totalElements },
      lanes: [...laneSet].sort(),
      staffs,
    }
    if (truncated) {
      result.truncated = true
      result.elementLimit = maxElements
    }
    return result
  }

  /** Full field tree for one element id, plus its staff/period context. */
  function lookupElement(elementId) {
    const state = store.state()
    if (!state.project) return { ok: false, error: 'no project is open' }
    for (const staff of state.project.staffs || []) {
      for (const period of staff.periods || []) {
        for (const element of period.elements || []) {
          if (element.id !== elementId) continue
          return {
            ok: true,
            rev: state.rev,
            dirty: state.dirty,
            element: {
              id: element.id,
              type: element.type,
              category: element.category,
              start: roundNumber(element.start),
              duration: elementDuration(element),
              lane: element.lane === undefined ? null : element.lane,
              staffId: staff.id,
              staffName: staff.displayName,
              periodId: period.id,
              periodMethod: period.method,
              timeOffset: roundNumber(period.timeOffset),
              fields: isPlainObject(element.fields) ? element.fields : {},
            },
          }
        }
      }
    }
    return { ok: false, error: `element not found: ${elementId}` }
  }

  /** List openable projects under the project root. */
  function projectList(args = {}) {
    const projects = store.projects(args.refresh === true)
    return {
      ok: true,
      projectRoot: store.projectRoot,
      openPath: store.view().openPath,
      count: projects.length,
      projects,
    }
  }

  /** Open a project by absolute path or project name. */
  function projectOpen(args = {}, exec) {
    const directory = resolveProjectDirectory(args.dir, {
      projectRoot: store.projectRoot,
      cwd: baseDirectory(exec),
    })
    const snapshot = store.open(directory)
    const project = snapshot.project
    const { staffCount, elementCount } = countProjectElements(project)
    return {
      ok: true,
      openPath: snapshot.openPath,
      rev: snapshot.rev,
      dirty: snapshot.dirty,
      title: project ? project.title : null,
      staffCount,
      elementCount,
      duration: project ? roundNumber(project.duration) : null,
      warnings: project ? capStrings(project.warnings, 20) : [],
    }
  }

  /** Apply an op batch at the current revision (agent edits never race). */
  function chartEdit(args = {}) {
    const current = store.view().rev
    const outcome = store.applyOps(current, args.ops)
    if (outcome.conflict === true) {
      return { ok: false, error: 'the project changed while editing; call gorge_chart_get again', rev: outcome.rev }
    }
    if (outcome.ok !== true) return { ok: false, error: outcome.error || 'edit rejected' }
    const result = { ok: true, rev: outcome.rev, dirty: outcome.dirty, changed: outcome.changed === true }
    if (Array.isArray(outcome.errors) && outcome.errors.length > 0) result.errors = outcome.errors
    if (Array.isArray(outcome.created) && outcome.created.length > 0) result.created = outcome.created
    return result
  }

  /** Force-save the open project. */
  function chartSave() {
    if (!store.view().openPath) return { ok: false, error: 'no project is open' }
    const result = store.save()
    return {
      ok: result.ok === true,
      written: Array.isArray(result.written) ? result.written : [],
      errors: Array.isArray(result.errors) ? result.errors : [],
      rev: result.rev,
      dirty: result.dirty,
    }
  }

  /** Validate the open project through the model. */
  function chartValidate() {
    const view = store.view()
    const project = view.project
    if (!project) return { ok: false, error: 'no project is open' }
    let issues
    try {
      issues = validateProject(project)
    } catch (error) {
      return { ok: false, error: messageOf(error) }
    }
    const list = Array.isArray(issues) ? issues : []
    const visible = list.slice(0, MAX_TOOL_ISSUES).map((issue) => {
      const clone = jsonClone(issue)
      return isPlainObject(clone) ? clone : { message: messageOf(issue) }
    })
    return {
      ok: true,
      rev: view.rev,
      dirty: view.dirty,
      issueCount: list.length,
      truncated: list.length > visible.length,
      issues: visible,
    }
  }

  /** Catalog lookup for element types and their field schemas. */
  function elementSchema(args = {}) {
    const catalog = CATALOG && typeof CATALOG === 'object' ? CATALOG : { version: 1, elements: [], valueTypes: {} }
    const elements = Array.isArray(catalog.elements) ? catalog.elements : []
    const requested = typeof args.type === 'string' ? args.type.trim() : ''
    if (requested.length === 0) {
      return {
        ok: true,
        version: catalog.version,
        count: elements.length,
        elements: elements.map((entry) => ({
          type: entry.type,
          shortName: entry.shortName,
          category: entry.category,
          group: entry.group,
          color: entry.color,
          timing: entry.timing,
          fieldCount: Array.isArray(entry.fields) ? entry.fields.length : 0,
        })),
        valueTypes: Object.keys(isPlainObject(catalog.valueTypes) ? catalog.valueTypes : {}),
        palettes: catalog.palettes,
      }
    }
    const wanted = requested.toLowerCase()
    const found =
      elements.find((entry) => typeof entry.type === 'string' && entry.type === requested) ||
      elements.find((entry) => typeof entry.type === 'string' && entry.type.toLowerCase() === wanted) ||
      elements.find((entry) => typeof entry.shortName === 'string' && entry.shortName.toLowerCase() === wanted)
    if (!found) {
      return {
        ok: false,
        error: `unknown element type "${requested}"`,
        knownTypes: elements.map((entry) => entry.type),
      }
    }
    return { ok: true, element: found }
  }

  /** One registry-ready tool: raw JSON-Schema parameters, pretty JSON output. */
  function defineTool(name, description, parameters, execute) {
    return { name, description, parameters, output: TOOL_OUTPUT, execute }
  }

  /** Wrap an implementation so a thrown error becomes a tool result. */
  function safe(name, execute) {
    return async (args = {}, exec) => {
      try {
        return await execute(args, exec)
      } catch (error) {
        const message = messageOf(error)
        warn(logger, `gorge-chart: ${name} failed: ${message}`)
        return { ok: false, error: message }
      }
    }
  }

  return [
    defineTool(
      'gorge_project_list',
      'List Dremu chart projects (directories containing .g staff files) under the configured project root, with staff/asset hints. 列出可打开的 Dremu 谱面项目。',
      TOOL_PARAMETERS.project_list,
      safe('gorge_project_list', (args) => projectList(args)),
    ),
    defineTool(
      'gorge_project_open',
      'Open a Dremu chart project directory in the shared chart studio, replacing the current project. Accepts an absolute directory or a project name under the project root. 打开谱面项目。',
      TOOL_PARAMETERS.project_open,
      safe('gorge_project_open', (args, exec) => projectOpen(args, exec)),
    ),
    defineTool(
      'gorge_chart_get',
      'Read the open Dremu chart project shown in the Web UI: project metadata, staffs, periods, lanes, and elements (start/duration in seconds, capped at ~400). Pass elementId to read one element with its full field tree, or detail:true for every field map. 读取谱面数据。',
      TOOL_PARAMETERS.chart_get,
      safe('gorge_chart_get', (args) => {
        if (typeof args.elementId === 'string' && args.elementId.length > 0) return lookupElement(args.elementId)
        return summarizeChart(args)
      }),
    ),
    defineTool(
      'gorge_chart_edit',
      'Edit the open Dremu chart project shown in the Web UI with an ordered op list: patch {elementId,path,value}, add {staffId,periodId?,element}, remove {elementId}, duplicate {elementId,newId?,timeShift?}, setMeta {tempo?,title?}, setStaffName {staffId,displayName}, setPeriodConfig {periodId,fields}, addStaff {kind?,form?,displayName?,className?,fileName?}, removeStaff {staffId,deleteFile?}, addAudioPeriod {staffId?,file?,sourcePath?,name?,timeOffset?,method?}, patchAudioPeriod {staffId?,audioPeriodId,fields}, removeAudioPeriod {staffId?,audioPeriodId}. Every accepted edit bumps the revision and appears live in the user\u2019s editor. 编辑谱面。',
      TOOL_PARAMETERS.chart_edit,
      safe('gorge_chart_edit', (args) => chartEdit(args)),
    ),
    defineTool(
      'gorge_chart_save',
      'Save the open Dremu chart project to disk (atomic .g writes with .g.bak backups) and report the written files. 保存谱面到磁盘。',
      TOOL_PARAMETERS.chart_save,
      safe('gorge_chart_save', () => chartSave()),
    ),
    defineTool(
      'gorge_chart_validate',
      'Validate the open Dremu chart project and return the model issues (timing, missing lanes/assets, format warnings). 校验谱面。',
      TOOL_PARAMETERS.chart_validate,
      safe('gorge_chart_validate', () => chartValidate()),
    ),
    defineTool(
      'gorge_element_schema',
      'Return the Dremu element catalog: known element types (timing + fields + defaults) and composite value types. Pass type for one full entry before building a patch. 查询元素字段定义。',
      TOOL_PARAMETERS.element_schema,
      safe('gorge_element_schema', (args) => elementSchema(args)),
    ),
  ]
}

// ---------------------------------------------------------------------------
// 11 · Dynamic prompt context
// ---------------------------------------------------------------------------

/** One-line workspace summary registered as dynamic prompt context. */
export function workspaceSummary(store) {
  const state = store.state()
  if (!state.openPath || !state.project) {
    return (
      'Dremu chart workspace: no project is open. Use gorge_project_list to find chart projects under ' +
      `${store.projectRoot}, then gorge_project_open to open one.`
    )
  }
  const project = state.project
  const { staffCount, elementCount } = countProjectElements(project)
  const title = typeof project.title === 'string' && project.title.length > 0 ? project.title : path.basename(state.openPath)
  const duration = Number(project.duration)
  const durationText = Number.isFinite(duration) ? `${roundNumber(duration, 3)}s` : 'unknown length'
  const audioCount = Array.isArray(project.audioPeriods) ? project.audioPeriods.length : project.audio ? 1 : 0
  return (
    `Dremu chart workspace: "${title}" | ${staffCount} staffs | ${elementCount} elements | ` +
    `${audioCount} audio period${audioCount === 1 ? '' : 's'} | ${durationText} | ` +
    `rev ${state.rev}${state.dirty ? ' | unsaved changes' : ''} | ${state.openPath}. The user sees this project in the ` +
    'Dremu 谱面工坊 editor panel of the Web UI; use gorge_chart_get to read it, gorge_chart_edit to change it ' +
    '(edits appear live), and gorge_chart_save to write the .g files to disk.'
  )
}

// ---------------------------------------------------------------------------
// 12 · Plugin configuration
// ---------------------------------------------------------------------------

/**
 * Plugin config schema (Standard Schema only).
 *
 * The Harness validates a plugin row's `config` through the Standard Schema
 * interface (`Config['~standard'].validate`), and that is the only runtime
 * contract this object may satisfy. It must NOT look like a Schemastery schema:
 * `@deepseek-ai/dsh-settings` treats every `Config` that carries a `toJSON`
 * method as a live Schemastery schema and reads `schema.meta.volatile` from it
 * while describing Settings namespaces. A plain JSON-Schema `toJSON()` therefore
 * makes `settings/describe` throw `TypeError: Cannot read properties of
 * undefined (reading 'volatile')`, which fails the desktop welcome RPC and
 * aborts boot ("desktop welcome: Web RPC failed").
 *
 * A real Schemastery schema is not available here (a bundle ships no runtime
 * dependencies), and this config has no volatile fields, so the plugin stays
 * out of the Settings forms on purpose; configure it through the profile patch
 * (`cordis.patch.yml`), where the loader still validates it via `~standard`.
 */
function ConfigSchema(input) {
  return normalizeConfig(input)
}
ConfigSchema['~standard'] = Object.freeze({
  version: 1,
  vendor: 'gorge-chart-studio',
  validate(value) {
    return { value: normalizeConfig(value) }
  },
})
ConfigSchema.validate = (value) => normalizeConfig(value)
ConfigSchema.description = 'Dremu 谱面工坊：项目根目录、自动保存与界面语言。'
/** Exported config schema (see the note above; Standard Schema compatible). */
export const Config = ConfigSchema

/** Normalize a (possibly partial/invalid) plugin config to usable options. */
export function normalizeConfig(config) {
  const value = isPlainObject(config) ? config : {}
  let projectRoot = DEFAULT_PROJECT_ROOT
  if (typeof value.projectRoot === 'string' && value.projectRoot.trim().length > 0) {
    try {
      projectRoot = path.resolve(value.projectRoot.trim())
    } catch {
      projectRoot = DEFAULT_PROJECT_ROOT
    }
  }
  const normalized = {
    projectRoot,
    autoSave: value.autoSave !== false,
    locale: value.locale === 'en' ? 'en' : 'zh',
  }
  // Not part of the row schema: an internal override used by tests/tools that
  // need an isolated recovery snapshot.
  if (typeof value.statePath === 'string' && value.statePath.length > 0) normalized.statePath = value.statePath
  if (Number.isFinite(value.autoSaveDelayMs)) normalized.autoSaveDelayMs = value.autoSaveDelayMs
  return normalized
}

// ---------------------------------------------------------------------------
// 13 · Plugin entry point
// ---------------------------------------------------------------------------

/**
 * Register the project store, agent tools, HTTP/SSE endpoints, and dynamic
 * prompt context. Optional services are injected lazily so a composition
 * without a web server or system prompt still loads the tools.
 */
export function apply(ctx, config = {}) {
  const logger = resolveLogger(ctx)
  const options = normalizeConfig(config)
  const store = createStore({
    projectRoot: options.projectRoot,
    autoSave: options.autoSave,
    logger,
    ...(options.statePath === undefined ? {} : { statePath: options.statePath }),
    ...(options.autoSaveDelayMs === undefined ? {} : { autoSaveDelayMs: options.autoSaveDelayMs }),
  })
  ctx.effect(() => () => store.close(), 'gorge-chart: project store')

  // Relative project directories resolve against the calling session's cwd.
  let resolveDirectory = () => process.cwd()
  ctx.inject(['workingDirectory'], (directoryCtx) => {
    directoryCtx.effect(() => {
      resolveDirectory = (agent) => {
        try {
          if (!agent || !agent.session) return process.cwd()
          const directory = directoryCtx.workingDirectory.get(agent.session)
          return typeof directory === 'string' && directory.length > 0 ? directory : process.cwd()
        } catch {
          return process.cwd()
        }
      }
      return () => {
        resolveDirectory = () => process.cwd()
      }
    }, 'gorge-chart: resolve session working directory')
  })

  for (const definition of createTools(store, {
    logger,
    locale: options.locale,
    resolveDirectory: (agent) => resolveDirectory(agent),
  })) {
    ctx.effect(() => ctx.tools.register(definition), `gorge-chart: ${definition.name} tool`)
  }

  // Ship the Dremu chart-editing skill with the bundle. Optional: a composition
  // without the skill registry still loads the tools and the editor.
  ctx.inject(['skills'], (skillCtx) => {
    skillCtx.effect(() => {
      try {
        return registerSkillProvider(skillCtx)
      } catch (error) {
        warn(logger, `gorge-chart: cannot register the chart-editing skill: ${messageOf(error)}`)
        return () => {}
      }
    }, 'gorge-chart: chart-editing skill provider')
  })

  ctx.inject(['webServer'], (httpCtx) => {
    for (const { path: routePath, handler } of createHandlers(store, {
      logger,
      resolveDirectory: () => resolveDirectory(),
    })) {
      httpCtx.effect(
        () => httpCtx.webServer.register({ kind: 'exact', path: routePath, handler }),
        `gorge-chart: ${routePath} endpoint`,
      )
    }
  })

  ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.effect(
      () =>
        promptCtx.systemPrompt.context({
          name: PROMPT_CONTEXT_NAME,
          order: PROMPT_CONTEXT_ORDER,
          text: () => workspaceSummary(store),
        }),
      'gorge-chart: workspace prompt context',
    )
  })
}
