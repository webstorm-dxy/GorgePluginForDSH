/**
 * Bundled skill provider for the Dremu chart-editing skill.
 *
 * The skill itself lives in `skills/dremu-chart-editing/SKILL.md` (with
 * `references/` beside it). Registering it through the Host `skills` service
 * puts it in the session catalog of every profile that installs this bundle,
 * without relying on a user-level skill directory.
 *
 * The provider parses only the two frontmatter keys it needs (`name` and
 * `description`) so the bundle keeps its no-dependencies contract; the body is
 * re-read on every `get()` so editing the skill does not need a restart.
 */

import { readFileSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Skill name (kebab-case; must match the directory and frontmatter). */
export const SKILL_NAME = 'dremu-chart-editing'
/** Provider name registered on `ctx.skills`. */
export const SKILL_PROVIDER = 'gorge-chart'
/** Bundled-provider precedence rank (same value as other packaged skills). */
export const SKILL_RANK = 600

const DEFAULT_SKILL_ROOT = fileURLToPath(new URL('./skills/', import.meta.url))
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/u

/** Decode one single-line YAML scalar (quoted or plain). */
function decodeScalar(raw) {
  const value = raw.trim()
  if (value.length >= 2) {
    const quote = value[0]
    if ((quote === '"' || quote === "'") && value[value.length - 1] === quote) {
      return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
    }
  }
  return value
}

/** Read `key: value` from a block of simple frontmatter lines. */
function frontmatterScalar(block, key) {
  const pattern = new RegExp(`^${key}:[ \\t]*(.+?)[ \\t]*$`, 'mu')
  const match = pattern.exec(block)
  return match ? decodeScalar(match[1]) : null
}

/**
 * Parse a skill markdown document into frontmatter fields and body.
 *
 * Supports the single-line `name` / `description` scalars this bundle uses.
 * Throws on a missing or malformed frontmatter block so packaging mistakes
 * surface in tests instead of producing a silently empty skill.
 *
 * @param {string} raw  file contents.
 * @param {string} [source]  path used in error messages.
 * @returns {{name: string, description: string, content: string}}
 */
export function parseSkillMarkdown(raw, source = 'SKILL.md') {
  if (typeof raw !== 'string') throw new TypeError(`${source}: skill markdown must be a string`)
  const match = FRONTMATTER.exec(raw)
  if (!match) throw new Error(`${source}: missing YAML frontmatter`)
  const name = frontmatterScalar(match[1], 'name')
  const description = frontmatterScalar(match[1], 'description')
  if (!name) throw new Error(`${source}: frontmatter has no name`)
  if (!SKILL_NAME_PATTERN.test(name)) throw new Error(`${source}: invalid skill name "${name}"`)
  if (!description) throw new Error(`${source}: frontmatter has no description`)
  const content = raw.slice(match[0].length).trim()
  if (content.length === 0) throw new Error(`${source}: skill body is empty`)
  return { name, description, content }
}

/**
 * Build the skill provider for the bundled chart-editing skill.
 *
 * @param {{skillRoot?: string}} [options]  root containing
 *        `<name>/SKILL.md`; defaults to this bundle's `skills/` directory.
 * @returns {{name: string, list: Function, get: Function}}
 */
export function createSkillProvider(options = {}) {
  const skillRoot = path.resolve(options.skillRoot ?? DEFAULT_SKILL_ROOT)
  const skillDir = path.join(skillRoot, SKILL_NAME)
  const skillPath = path.join(skillDir, 'SKILL.md')
  let stats
  try {
    stats = statSync(skillPath)
  } catch {
    throw new Error(`gorge-chart: missing skill file ${skillPath}`)
  }
  if (!stats.isFile()) throw new Error(`gorge-chart: skill file is not a file: ${skillPath}`)
  const initial = parseSkillMarkdown(readFileSync(skillPath, 'utf8'), skillPath)
  if (initial.name !== SKILL_NAME) {
    throw new Error(`gorge-chart: skill name "${initial.name}" does not match "${SKILL_NAME}"`)
  }

  const summary = {
    name: SKILL_NAME,
    description: initial.description,
    invocation: { modelInvocable: true, userInvocable: true },
    provider: SKILL_PROVIDER,
    source: 'bundled',
    rank: SKILL_RANK,
    resourceBase: { kind: 'directory', path: skillDir.split(path.sep).join('/') },
    locator: skillPath,
    path: skillPath,
  }

  return {
    name: SKILL_PROVIDER,
    /** One bundled skill; `rank` resolves it against filesystem roots. */
    list() {
      return [summary]
    },
    /**
     * Load the current body (so edits to SKILL.md are visible without a Host
     * restart) and return it in the definition shape the registry expects.
     */
    async get(candidate = summary, getOptions = {}) {
      if (!candidate || candidate.name !== SKILL_NAME) {
        throw new Error(`gorge-chart: unknown skill "${candidate && candidate.name}"`)
      }
      const locator = typeof candidate.locator === 'string' ? candidate.locator : skillPath
      const text = await readFile(locator, { encoding: 'utf8', signal: getOptions.signal })
      const current = parseSkillMarkdown(text, locator)
      const { rank: _rank, locator: _locator, ...definition } = summary
      return { ...definition, description: current.description, content: current.content }
    },
  }
}

/**
 * Register the bundled provider on a Cordis context carrying `skills`.
 *
 * @param {{skills: {registerProvider: Function}}} ctx
 * @param {{skillRoot?: string}} [options]
 * @returns {Function} the effect disposer returned by the registry.
 */
export function registerSkillProvider(ctx, options = {}) {
  if (!ctx || !ctx.skills || typeof ctx.skills.registerProvider !== 'function') {
    throw new Error('gorge-chart: the skills service is not available')
  }
  const provider = createSkillProvider(options)
  return ctx.skills.registerProvider(() => provider)
}
