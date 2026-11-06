#!/usr/bin/env node
/**
 * tests/skill.test.mjs — checks for the bundled Dremu chart-editing skill and
 * its provider (`skills.js`). No dependencies, no test runner.
 *
 * Run:  node tests/skill.test.mjs
 * Exit: 0 when every check passes, 1 otherwise.
 *
 * What is covered:
 *   - frontmatter/body parsing and rejection of malformed skill files;
 *   - the skill's own structure: name/folder match, body length, resolvable
 *     reference links, valid JSON examples, only real gorge_* tool names;
 *   - the provider's list/get shapes and rank;
 *   - registration through a fake `skills` service and disposal;
 *   - a missing skill root fails loudly instead of exposing an empty skill.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  SKILL_NAME,
  SKILL_PROVIDER,
  SKILL_RANK,
  createSkillProvider,
  parseSkillMarkdown,
  registerSkillProvider,
} from '../skills.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SKILL_ROOT = path.join(HERE, '..', 'skills')
const SKILL_DIR = path.join(SKILL_ROOT, SKILL_NAME)
const SKILL_FILE = path.join(SKILL_DIR, 'SKILL.md')
const REFERENCE_DIR = path.join(SKILL_DIR, 'references')

const KNOWN_TOOLS = new Set([
  'gorge_project_list',
  'gorge_project_open',
  'gorge_chart_get',
  'gorge_chart_edit',
  'gorge_chart_save',
  'gorge_chart_validate',
  'gorge_element_schema',
])

let passCount = 0
const failures = []

function test(name, fn) {
  try {
    fn()
    passCount += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`  FAIL ${name}: ${error && error.message ? error.message : error}`)
  }
}

async function testAsync(name, fn) {
  try {
    await fn()
    passCount += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`  FAIL ${name}: ${error && error.message ? error.message : error}`)
  }
}

/** All markdown files that belong to the skill. */
function skillMarkdownFiles() {
  return [
    SKILL_FILE,
    ...fs.readdirSync(REFERENCE_DIR).filter((name) => name.endsWith('.md')).map((name) => path.join(REFERENCE_DIR, name)),
  ]
}

/** Extract fenced ```json blocks. */
function jsonBlocks(text) {
  const blocks = []
  const pattern = /```json\r?\n([\s\S]*?)```/gu
  let match
  while ((match = pattern.exec(text)) !== null) blocks.push(match[1])
  return blocks
}

console.log('— A. skill document')

const raw = fs.readFileSync(SKILL_FILE, 'utf8')
const parsed = parseSkillMarkdown(raw, SKILL_FILE)

test('frontmatter name matches the folder and provider constant', () => {
  assert.equal(parsed.name, SKILL_NAME)
  assert.equal(path.basename(SKILL_DIR), SKILL_NAME)
})

test('description names Dremu and the editing purpose', () => {
  assert.ok(parsed.description.length >= 80, 'description must be specific enough to trigger')
  assert.match(parsed.description, /Dremu/)
  assert.match(parsed.description, /chart/i)
})

test('body is non-empty, starts with the title, and stays readable', () => {
  assert.ok(parsed.content.startsWith('# Dremu chart editing'))
  assert.ok(!parsed.content.includes('description:'), 'frontmatter must be stripped')
  const lines = parsed.content.split(/\r?\n/).length
  assert.ok(lines <= 500, `SKILL.md body should stay under 500 lines (got ${lines})`)
})

test('the workflow mentions the read → edit → validate → save loop', () => {
  for (const token of ['gorge_chart_get', 'gorge_chart_edit', 'gorge_chart_validate', 'gorge_chart_save']) {
    assert.ok(parsed.content.includes(token), `missing ${token}`)
  }
  assert.match(parsed.content, /period-relative/i)
})

test('every reference link resolves to a file in the skill directory', () => {
  const pattern = /\[[^\]]*\]\(([^)]+)\)/gu
  let match
  let links = 0
  for (const file of skillMarkdownFiles()) {
    const text = fs.readFileSync(file, 'utf8')
    while ((match = pattern.exec(text)) !== null) {
      const target = match[1].trim()
      if (/^(?:https?:|#)/u.test(target)) continue
      const relative = target.split('#')[0]
      if (!relative.endsWith('.md')) continue
      links += 1
      const resolved = path.resolve(path.dirname(file), relative)
      assert.ok(fs.existsSync(resolved), `${path.basename(file)} links to missing ${target}`)
    }
  }
  assert.ok(links >= 3, 'SKILL.md should link its references')
})

test('all fenced JSON examples parse', () => {
  let count = 0
  for (const file of skillMarkdownFiles()) {
    const blocks = jsonBlocks(fs.readFileSync(file, 'utf8'))
    count += blocks.length
    blocks.forEach((block, index) => {
      assert.doesNotThrow(() => JSON.parse(block), `${path.basename(file)} JSON block ${index + 1} is invalid`)
    })
  }
  assert.ok(count >= 15, `expected the skill to carry examples (got ${count} JSON blocks)`)
})

test('only real gorge_* tool names appear', () => {
  const pattern = /\bgorge_[a-z_]+[a-z]\b/gu
  const seen = new Set()
  for (const file of skillMarkdownFiles()) {
    const text = fs.readFileSync(file, 'utf8')
    let match
    while ((match = pattern.exec(text)) !== null) seen.add(match[0])
  }
  assert.ok(seen.size >= 7, `expected every tool to be named (got ${[...seen].join(', ')})`)
  for (const name of seen) assert.ok(KNOWN_TOOLS.has(name), `unknown tool name "${name}" in the skill`)
})

test('malformed skill documents are rejected', () => {
  assert.throws(() => parseSkillMarkdown('# no frontmatter'), /frontmatter/u)
  assert.throws(() => parseSkillMarkdown('---\nname: Bad_Name\ndescription: x\n---\nbody'), /invalid skill name/u)
  assert.throws(() => parseSkillMarkdown('---\nname: good-name\n---\nbody'), /description/u)
  assert.throws(() => parseSkillMarkdown('---\nname: good-name\ndescription: x\n---\n\n'), /empty/u)
})

test('quoted and plain frontmatter scalars are decoded', () => {
  const quoted = parseSkillMarkdown('---\nname: "a-b"\ndescription: "x: y"\n---\nbody')
  assert.deepEqual([quoted.name, quoted.description], ['a-b', 'x: y'])
  const plain = parseSkillMarkdown('---\nname: a-b\ndescription: plain text\n---\nbody')
  assert.equal(plain.description, 'plain text')
})

console.log('\n— B. provider')

const provider = createSkillProvider()

test('list returns one bundled candidate with the expected metadata', () => {
  const candidates = provider.list()
  assert.equal(candidates.length, 1)
  const candidate = candidates[0]
  assert.equal(candidate.name, SKILL_NAME)
  assert.equal(candidate.provider, SKILL_PROVIDER)
  assert.equal(candidate.source, 'bundled')
  assert.equal(candidate.rank, SKILL_RANK)
  assert.equal(candidate.invocation.modelInvocable, true)
  assert.equal(candidate.invocation.userInvocable, true)
  assert.equal(candidate.locator, SKILL_FILE)
  assert.equal(candidate.resourceBase.kind, 'directory')
  assert.equal(fs.realpathSync(candidate.resourceBase.path), fs.realpathSync(SKILL_DIR))
})

await testAsync('get returns the body without frontmatter and with the resource base', async () => {
  const definition = await provider.get(provider.list()[0])
  assert.equal(definition.name, SKILL_NAME)
  assert.equal(definition.provider, SKILL_PROVIDER)
  assert.ok(definition.content.startsWith('# Dremu chart editing'))
  assert.ok(!definition.content.startsWith('---'))
  assert.ok(definition.content.includes('gorge_chart_edit'))
  assert.ok(definition.resourceBase.path.endsWith(`skills/${SKILL_NAME}`))
  assert.equal(definition.rank, undefined, 'definition must not leak the internal rank')
  assert.equal(definition.locator, undefined, 'definition must not leak the locator')
})

await testAsync('get rejects an unknown candidate', async () => {
  await assert.rejects(() => provider.get({ name: 'other-skill' }), /unknown skill/u)
})

test('a missing skill root fails loudly', () => {
  assert.throws(() => createSkillProvider({ skillRoot: path.join(HERE, 'does-not-exist') }), /missing skill file/u)
})

console.log('\n— C. registration')

await testAsync('registerSkillProvider registers and disposes through ctx.skills', async () => {
  const registered = []
  const ctx = {
    skills: {
      registerProvider(create) {
        const instance = create({ signal: new AbortController().signal, invalidate() {} })
        registered.push(instance)
        return () => {
          const index = registered.indexOf(instance)
          if (index !== -1) registered.splice(index, 1)
        }
      },
    },
  }
  const dispose = registerSkillProvider(ctx)
  assert.equal(registered.length, 1)
  const definition = await registered[0].get(registered[0].list()[0])
  assert.ok(definition.content.includes('Dremu chart editing'))
  dispose()
  assert.equal(registered.length, 0)
})

test('registerSkillProvider explains a missing skills service', () => {
  assert.throws(() => registerSkillProvider({}), /skills service is not available/u)
})

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log('')
if (failures.length === 0) {
  console.log(`PASS ${passCount}/${passCount} skill checks`)
  process.exitCode = 0
} else {
  console.log(`FAIL ${failures.length} of ${passCount + failures.length} skill checks`)
  for (const failure of failures) {
    console.log(`\n[${failure.name}]`)
    console.log(String((failure.error && failure.error.stack) || failure.error))
  }
  process.exitCode = 1
}
