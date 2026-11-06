/**
 * PEC (Phigros Editor Chart) -> Dremu .g converter.
 *
 * Source: "The Spectre" — 1 judge line, 6587 notes, 100 BPM, timingBase 48.
 * Mapping:
 *   judge line        -> Dremu.DremuMainLane (positionX/Y/rotationZ animated)
 *   props keyframes   -> PiecewiseFunctionCurve fitted with LinearCurve pieces
 *   note type 1/2/3/4 -> DremuTap / DremuDrag / DremuHold / DremuTaplik
 */
import fs from 'node:fs'
import path from 'node:path'
import { createEmptyProject, createElement, saveProject } from '/Users/daxingyi/code/GorgePluginForDSH/dremu-model.js'

const SRC = '/tmp/spectre/The Spectre'
const OUT = '/Users/daxingyi/code/GorgePluginForDSH/TheSpectre'
const PEC = JSON.parse(fs.readFileSync(path.join(SRC, 'The Spectre.json'), 'utf8'))

// ---------------------------------------------------------------- timing --
const TIMING_BASE = PEC.timingBase || 48
const BPM_LIST = [...(PEC.bpmList || [{ time: 0, bpm: 100 }])].sort((a, b) => a.time - b.time)
const bpmAt = (tick) => {
  let current = BPM_LIST[0]
  for (const entry of BPM_LIST) if (tick >= entry.time) current = entry
  return current
}
const tickToSec = (tick) => {
  let seconds = 0
  for (let i = 1; i < BPM_LIST.length; i += 1) {
    const prev = BPM_LIST[i - 1]
    const next = BPM_LIST[i]
    if (tick <= next.time) break
    seconds += ((next.time - prev.time) * 60) / (prev.bpm * TIMING_BASE)
  }
  const last = bpmAt(tick)
  return seconds + ((tick - last.time) * 60) / (last.bpm * TIMING_BASE)
}
const round = (value) => Math.round(value * 1e6) / 1e6

// ---------------------------------------------------------------- easings --
const easeInSine = (u) => 1 - Math.cos((u * Math.PI) / 2)
const easeOutSine = (u) => Math.sin((u * Math.PI) / 2)
const easeInOutSine = (u) => -(Math.cos(Math.PI * u) - 1) / 2
const easeInQuad = (u) => u * u
const easeOutQuad = (u) => 1 - (1 - u) ** 2
const easeInOutQuad = (u) => (u < 0.5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2)
const easeInCubic = (u) => u ** 3
const easeOutCubic = (u) => 1 - (1 - u) ** 3
const easeInOutCubic = (u) => (u < 0.5 ? 4 * u ** 3 : 1 - (-2 * u + 2) ** 3 / 2)
const easeInQuart = (u) => u ** 4
const easeOutQuart = (u) => 1 - (1 - u) ** 4
const easeInOutQuart = (u) => (u < 0.5 ? 8 * u ** 4 : 1 - (-2 * u + 2) ** 4 / 2)
const easeInQuint = (u) => u ** 5
const easeOutQuint = (u) => 1 - (1 - u) ** 5
const easeInOutQuint = (u) => (u < 0.5 ? 16 * u ** 5 : 1 - (-2 * u + 2) ** 5 / 2)
const easeInExpo = (u) => (u === 0 ? 0 : 2 ** (10 * u - 10))
const easeOutExpo = (u) => (u === 1 ? 1 : 1 - 2 ** (-10 * u))
const easeInOutExpo = (u) =>
  u === 0 ? 0 : u === 1 ? 1 : u < 0.5 ? 2 ** (20 * u - 10) / 2 : (2 - 2 ** (-20 * u + 10)) / 2
const easeInCirc = (u) => 1 - Math.sqrt(1 - u ** 2)
const easeOutCirc = (u) => Math.sqrt(1 - (u - 1) ** 2)
const easeInOutCirc = (u) =>
  u < 0.5 ? (1 - Math.sqrt(1 - (2 * u) ** 2)) / 2 : (Math.sqrt(1 - (-2 * u + 2) ** 2) + 1) / 2
const BACK_C1 = 1.70158
const easeInBack = (u) => (BACK_C1 + 1) * u ** 3 - BACK_C1 * u ** 2
const easeOutBack = (u) => 1 + (BACK_C1 + 1) * (u - 1) ** 3 + BACK_C1 * (u - 1) ** 2
const easeInOutBack = (u) => {
  const c2 = BACK_C1 * 1.525
  return u < 0.5
    ? ((2 * u) ** 2 * ((c2 + 1) * 2 * u - c2)) / 2
    : ((2 * u - 2) ** 2 * ((c2 + 1) * (u * 2 - 2) + c2) + 2) / 2
}
const easeInElastic = (u) => (u === 0 ? 0 : u === 1 ? 1 : -(2 ** (10 * u - 10)) * Math.sin((u * 10 - 10.75) * ((2 * Math.PI) / 3)))
const easeOutElastic = (u) => (u === 0 ? 0 : u === 1 ? 1 : 2 ** (-10 * u) * Math.sin((u * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1)
const easeInOutElastic = (u) => {
  const c5 = (2 * Math.PI) / 4.5
  if (u === 0) return 0
  if (u === 1) return 1
  return u < 0.5
    ? -(2 ** (20 * u - 10) * Math.sin((20 * u - 11.125) * c5)) / 2
    : (2 ** (-20 * u + 10) * Math.sin((20 * u - 11.125) * c5)) / 2 + 1
}
const easeInBounce = (u) => 1 - easeOutBounce(1 - u)
const easeOutBounce = (u) => {
  const n1 = 7.5625
  const d1 = 2.75
  if (u < 1 / d1) return n1 * u * u
  if (u < 2 / d1) return n1 * (u - 1.5 / d1) ** 2 + 0.75
  if (u < 2.5 / d1) return n1 * (u - 2.25 / d1) ** 2 + 0.9375
  return n1 * (u - 2.625 / d1) ** 2 + 0.984375
}
const easeInOutBounce = (u) =>
  u < 0.5 ? (1 - easeOutBounce(1 - 2 * u)) / 2 : (1 + easeOutBounce(2 * u - 1)) / 2

// PEC easing codes (0 = linear, then the usual sine/quad/cubic/... ladder).
const EASINGS = [
  (u) => u,
  easeInSine, easeOutSine, easeInOutSine,
  easeInQuad, easeOutQuad, easeInOutQuad,
  easeInCubic, easeOutCubic, easeInOutCubic,
  easeInQuart, easeOutQuart, easeInOutQuart,
  easeInQuint, easeOutQuint, easeInOutQuint,
  easeInExpo, easeOutExpo, easeInOutExpo,
  easeInCirc, easeOutCirc, easeInOutCirc,
  easeInBack, easeOutBack, easeInOutBack,
  easeInElastic, easeOutElastic, easeInOutElastic,
  easeInBounce, easeOutBounce, easeInOutBounce,
]

// ---------------------------------------------------------------- curves --
const G = 'GorgeFramework.'
const linearCurve = (t0, v0, t1, v1) => ({
  t: 'obj',
  type: G + 'LinearCurve',
  fields: { timeStart: round(t0), valueStart: round(v0), timeEnd: round(t1), valueEnd: round(v1) },
})
const constantCurve = (value) => ({ t: 'obj', type: G + 'ConstantFunctionCurve', fields: { value: round(value) } })
const piece = (startX, endX, functionCurve) => ({
  t: 'obj',
  type: G + 'FunctionPiece',
  fields: { functionCurve, startX: round(startX), endX: round(endX), leftClosed: true, rightClosed: true },
})
const vf = (baseValue) => ({ t: 'obj', type: G + 'VariableFloat', fields: { baseValue: round(baseValue) } })

/** keyframes: [{time(sec), value, easing}] -> VariableFloat carrying a fitted piecewise curve. */
function animatedFloat(keyframes, scale, label) {
  const keys = keyframes
    .map((k) => ({ t: round(tickToSec(k.time)), v: round(k.value * scale), e: k.easing || 0 }))
    .sort((a, b) => a.t - b.t)
  const constant = keys.every((k) => Math.abs(k.v - keys[0].v) < 1e-9)
  if (keys.length < 2 || constant) return vf(keys[0] ? keys[0].v : 0)

  const items = []
  if (keys[0].t > 0) items.push(piece(-1e9, keys[0].t, constantCurve(keys[0].v)))
  let subdivisions = 0
  for (let i = 0; i < keys.length - 1; i += 1) {
    const a = keys[i]
    const b = keys[i + 1]
    const dur = b.t - a.t
    if (!(dur > 1e-9)) continue
    if (a.e === 0) {
      items.push(piece(a.t, b.t, linearCurve(a.t, a.v, b.t, b.v)))
      continue
    }
    const ease = EASINGS[a.e] || EASINGS[0]
    const steps = Math.max(4, Math.min(40, Math.ceil(dur / 0.02)))
    subdivisions += steps
    for (let s = 0; s < steps; s += 1) {
      const u0 = s / steps
      const u1 = (s + 1) / steps
      const t0 = a.t + dur * u0
      const t1 = a.t + dur * u1
      const v0 = a.v + (b.v - a.v) * ease(u0)
      const v1 = a.v + (b.v - a.v) * ease(u1)
      items.push(piece(t0, t1, linearCurve(t0, v0, t1, v1)))
    }
  }
  const tail = keys[keys.length - 1]
  items.push(piece(tail.t, 1e9, constantCurve(tail.v)))
  console.log(`  ${label}: ${keys.length} keyframes -> ${items.length} pieces (${subdivisions} easing samples)`)
  return {
    t: 'obj',
    type: G + 'VariableFloat',
    fields: {
      baseValue: 0,
      variationCurve: {
        t: 'obj',
        type: G + 'PiecewiseFunctionCurve',
        fields: { functionPieces: { t: 'arr', type: G + 'FunctionPiece', items } },
      },
    },
  }
}

/** Drop fields that are byte-identical to the catalog default (engine falls back to them). */
function stripDefaults(value) {
  const defaults = createElement(value.type, {}).fields
  const fields = {}
  for (const [name, fieldValue] of Object.entries(value.fields)) {
    if (JSON.stringify(defaults[name]) === JSON.stringify(fieldValue)) continue
    fields[name] = fieldValue
  }
  return { t: 'obj', type: value.type, fields }
}

// ------------------------------------------------------------------ chart --
const lines = PEC.judgeLineList || []
const notes = []
for (const line of lines) for (const note of line.noteList || []) notes.push({ ...note, line })
notes.sort((a, b) => a.time - b.time)
const chartEnd = tickToSec(notes[notes.length - 1].time) + 2
console.log(`source: ${lines.length} judge line(s), ${notes.length} notes, end ${chartEnd.toFixed(3)}s`)

const project = createEmptyProject(OUT, 'The Spectre')
const staff = project.staffs[0]
staff.className = 'TheSpectreStaff'
staff.id = 'TheSpectreStaff.g'
staff.file = path.join(OUT, 'TheSpectreStaff.g')
staff.displayName = 'The Spectre'
staff._staffFile.className = 'TheSpectreStaff'
const headerDisplay = staff._staffFile.header.find((h) => h.name === 'displayName')
if (headerDisplay) headerDisplay.value = 'The Spectre'
const config = staff._staffFile.members[0].attr[0].value
config.fields.minLength = round(Math.ceil(chartEnd))

const items = staff._staffFile.members[0].chartArray.items
const line = lines[0]
const props = line.props || {}
const lane = createElement('Dremu.DremuMainLane', {
  start: 0,
  fields: {
    name: 'Main1',
    keepTime: round(Math.ceil(chartEnd) + 4),
    drawStartX: vf(-8),
    drawEndX: vf(8),
    positionX: animatedFloat(props.controlX || [{ time: 0, value: 0, easing: 0 }], 8, 'controlX'),
    positionY: animatedFloat(props.controlY || [{ time: 0, value: 0, easing: 0 }], 5, 'controlY'),
    rotationZ: animatedFloat(props.angle || [{ time: 0, value: 0, easing: 0 }], 180 / Math.PI, 'angle'),
  },
})
items.push(lane)

const TYPE_MAP = { 1: 'Dremu.DremuTap', 2: 'Dremu.DremuDrag', 3: 'Dremu.DremuHold', 4: 'Dremu.DremuTaplik' }
// tap keeps the engine default teal; the other three get a distinct tint.
const TYPE_TINT = { 2: [0.35, 0.62, 1], 3: [0.45, 0.9, 1], 4: [0.85, 0.45, 1] }
const counts = { 1: 0, 2: 0, 3: 0, 4: 0 }
for (const note of notes) {
  const type = TYPE_MAP[note.type]
  if (!type) continue
  counts[note.type] += 1
  const hit = round(tickToSec(note.time))
  const lead = round(Math.min(1.0, Math.max(0.05, hit)))
  const fields = {
    laneName: 'Main1',
    leadTime: lead,
    lagTime: 0.45,
    position: vf(note.x * 8),
  }
  const tint = TYPE_TINT[note.type]
  if (tint) {
    fields.color = {
      t: 'obj',
      type: G + 'LerpColorCurve',
      fields: {
        colorPoints: {
          t: 'arr',
          type: G + 'ColorArgb',
          items: [{ t: 'obj', type: G + 'ColorArgb', fields: { r: tint[0], g: tint[1], b: tint[2], a: 1 } }],
        },
      },
    }
  }
  if (note.type === 3) fields.holdTime = round(tickToSec(note.holdTime))
  const value = createElement(type, { start: hit, fields })
  items.push(stripDefaults(value))
}

const saved = saveProject(project, { force: true })
console.log('chart staff:', saved.written, saved.errors)

// ------------------------------------------------------------------ audio --
const duration = 145
fs.writeFileSync(
  path.join(OUT, 'Song.g'),
  `[
    string displayName = "音频"
]
@AudioStaff
class Song
{
    [
        GorgeFramework.PeriodConfig^ config = GorgeFramework.PeriodConfig : {
            timeOffset : 0.0,
        }
    ]
    @Song
    static GorgeFramework.AudioAsset^ GetSong()
    {
        return GorgeFramework.WavAudioAsset : {
            name : "song",
            wavFilePath : "song.wav",
        };
    }
}
`,
)

// ------------------------------------------------------------- storyboard --
fs.writeFileSync(
  path.join(OUT, 'Storyboard.g'),
  `[
    string form = "DeentyStoryboard",
    string displayName = "Storyboard"
]
@ElementStaff
class Storyboard
{
    [
        GorgeFramework.PeriodConfig^ config = GorgeFramework.PeriodConfig : {
            timeOffset : 0.0,
        }
    ]
    @Chart
    static GorgeFramework.Element^[] Period()
    {
        return new GorgeFramework.Element^[1]{
            DeentyStoryboard.Image : {
                assetName : "image:cover",
                keepTime : ${duration}.0,
                positionMode : DeentyStoryboard.ImagePositionMode.ScreenCover,
                positionZ : GorgeFramework.VariableFloat : {
                    baseValue : 1.0,
                },
            },
        };
    }
}
`,
)

fs.copyFileSync(path.join(SRC, 'The Spectre.jpg'), path.join(OUT, 'cover.jpg'))
console.log('notes by type', counts, 'chart end', chartEnd.toFixed(2))
console.log('wrote', fs.readdirSync(OUT).map((f) => `${f} ${(fs.statSync(path.join(OUT, f)).size / 1024).toFixed(0)}KB`).join(', '))
