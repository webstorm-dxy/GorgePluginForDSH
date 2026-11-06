/**
 * Phigros v3 (The SpectreE.json) -> Dremu .g converter  (v2)
 *
 * Source quirks:
 *  - times are ticks: 32 ticks per beat at 128 BPM => 1 tick = 14.6484375 ms
 *  - rotations are degrees (values pass 360 and 1000)
 *  - chart offset is -0.945 s -> audio starts at chart time +0.945
 *  - coordinates are WORLD units (screen x in -8..8, y in -5..5): note
 *    positionX runs -5.8..6.2, so nothing is normalised to -1..1
 *  - judge lines blink: on average only ~2 of the 30 lines are visible at once,
 *    so each line is cut into alpha>0.45 windows. Every note still needs a lane
 *    alive at spawn, so lines with uncovered notes get an extra alpha-0 lane.
 *
 * Mapping: judge line window -> Dremu.DremuMainLane (same name per line)
 *          note type 1/2/3/4 -> DremuTap / DremuDrag / DremuHold / DremuTaplik
 */
import fs from 'node:fs'
import path from 'node:path'
import { createEmptyProject, createElement, saveProject } from '/Users/daxingyi/code/GorgePluginForDSH/dremu-model.js'

const SRC = '/tmp/spectre/The Spectre'
const OUT = '/Users/daxingyi/code/GorgePluginForDSH/TheSpectreE'
const RAW = JSON.parse(fs.readFileSync(path.join(SRC, 'The SpectreE.json'), 'utf8'))

const BPM = 128
const TICKS_PER_BEAT = 32
const UNIT = 60 / (BPM * TICKS_PER_BEAT)
const SAMPLE_HZ = 30
const AUDIO_OFFSET = -RAW.offset
// Coordinate mapping into Dremu world (x +-8, y +-5), following
// GorgeChartHelper_Test/RPE_to_gorge.py: RPE x in +-675 -> +-8, y in +-450 -> +-5.
// This chart stores RPE pixels / 100 (notes run +-6.18 ~= +-618 px), so the
// effective scale is 100*8/675 and 100*5/450.
// y: the source is a normalised fraction of half-height -> x5 fills +-5.
// x: the source's note positionX is lane-local and already spans +-6.18 world
//    units, while the line centre sits at 0.5. Scaling the centre by 8 would
//    push 174/744 notes past the +-8 edge, so x stays 1:1. Set LANE_X_SCALE=8
//    for a strict normalised mapping (23.4% of notes then land off-screen).
const LANE_X_SCALE = 8
const NOTE_X_SCALE = (100 * 8) / 675
const LANE_Y_SCALE = 5
// Notes are absolute screen positions (+-6.18), the lane centre sits at 2.4..5.6
// after x8, so the drawn lane must reach +-11 to keep every note on it.
const LANE_HALF_LENGTH = 16
const ALPHA_ON = 0.06
const USE_ALPHA_WINDOWS = process.env.ALPHA_WINDOWS !== '0'
const ONLY_LINES_WITH_NOTES = process.env.NOTED_ONLY === '1'
const USE_SLOTS = process.env.SLOTS !== '0'
const MERGE_GAP = 0.35
const MIN_WINDOW = 0.15

const G = 'GorgeFramework.'
const round = (v) => Math.round(v * 1e6) / 1e6
const TYPE_MAP = { 1: 'Dremu.DremuTap', 2: 'Dremu.DremuDrag', 3: 'Dremu.DremuHold', 4: 'Dremu.DremuTaplik' }
const TYPE_TINT = { 2: [0.35, 0.62, 1], 3: [0.45, 0.9, 1], 4: [0.85, 0.45, 1] }

// ---------------------------------------------------------------- events --
function evalEvents(events, tick) {
  if (!events || events.length === 0) return 0
  let lo = 0
  let hi = events.length - 1
  let found = null
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (events[mid].startTime <= tick) {
      found = events[mid]
      lo = mid + 1
    } else hi = mid - 1
  }
  if (!found) return events[0].start
  if (tick >= found.endTime) return found.end
  const span = found.endTime - found.startTime
  if (!(span > 0)) return found.end
  return found.start + (found.end - found.start) * ((tick - found.startTime) / span)
}

// -------------------------------------------------------------- simplify --
function simplify(points, eps) {
  if (points.length < 3) return points
  const keep = new Uint8Array(points.length)
  keep[0] = 1
  keep[points.length - 1] = 1
  const stack = [[0, points.length - 1]]
  while (stack.length) {
    const [a, b] = stack.pop()
    const [t0, v0] = points[a]
    const [t1, v1] = points[b]
    const span = t1 - t0 || 1e-9
    let maxD = -1
    let idx = -1
    for (let i = a + 1; i < b; i += 1) {
      const [t, v] = points[i]
      const d = Math.abs(v - (v0 + ((v1 - v0) * (t - t0)) / span))
      if (d > maxD) {
        maxD = d
        idx = i
      }
    }
    if (maxD > eps && idx > 0) {
      keep[idx] = 1
      stack.push([a, idx], [idx, b])
    }
  }
  const out = []
  for (let i = 0; i < points.length; i += 1) if (keep[i]) out.push(points[i])
  return out
}

// ---------------------------------------------------------------- curves --
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

/** samples: [[lane-local t, value], ...] -> VariableFloat */
function curveFromSamples(samples, eps) {
  if (samples.length === 0) return vf(0)
  const constant = samples.every((s) => Math.abs(s[1] - samples[0][1]) < 1e-9)
  if (constant) return vf(samples[0][1])
  let tolerance = eps
  let points = simplify(samples, tolerance)
  while (points.length > 400) {
    tolerance *= 1.6
    points = simplify(samples, tolerance)
  }
  const items = []
  for (let i = 0; i < points.length - 1; i += 1) {
    const [t0, v0] = points[i]
    const [t1, v1] = points[i + 1]
    if (!(t1 > t0)) continue
    items.push(piece(t0, t1, linearCurve(t0, v0, t1, v1)))
  }
  const [lastT, lastV] = points[points.length - 1]
  items.push(piece(lastT, 1e9, constantCurve(lastV)))
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

// ------------------------------------------------------------------ chart --
const lines = RAW.judgeLineList || []
let maxTick = 0
for (const line of lines) {
  for (const note of [...(line.notesAbove || []), ...(line.notesBelow || [])]) {
    maxTick = Math.max(maxTick, note.time + (note.holdTime || 0))
  }
}
const chartEnd = maxTick * UNIT
const project = createEmptyProject(OUT, 'The Spectre E')
const staff = project.staffs[0]
staff.className = 'TheSpectreEStaff'
staff.id = 'TheSpectreEStaff.g'
staff.file = path.join(OUT, 'TheSpectreEStaff.g')
staff.displayName = 'The Spectre E'
staff._staffFile.className = 'TheSpectreEStaff'
const headerDisplay = staff._staffFile.header.find((h) => h.name === 'displayName')
if (headerDisplay) headerDisplay.value = 'The Spectre E'
staff._staffFile.members[0].attr[0].value.fields.minLength = round(Math.ceil(chartEnd))
const items = staff._staffFile.members[0].chartArray.items

/** One lane element whose curves only span [w0, w1]; curve times are lane-local. */
function makeLane(line, laneName, w0, w1, alpha, ySlot, yBase) {
  const moveEvents = line.judgeLineMoveEvents || []
  const yEvents = moveEvents.map((e) => ({ startTime: e.startTime, endTime: e.endTime, start: e.start2, end: e.end2 }))
  const rotEvents = line.judgeLineRotateEvents || []
  const frames = Math.max(2, Math.ceil((w1 - w0) * SAMPLE_HZ))
  const xs = []
  const ys = []
  const rs = []
  for (let f = 0; f <= frames; f += 1) {
    const local = ((w1 - w0) * f) / frames
    const tick = (w0 + local) / UNIT
    // y is a normalised fraction of half-height -> x5 into Dremu's +-5.
    // x stays 1:1: the notes' local spread is already +-6.2 world units, so
    // scaling the lane centre by 8 would push 23% of them past +-8.
    xs.push([local, evalEvents(moveEvents, tick) * LANE_X_SCALE])
    // Source lines are stacked on a handful of y levels (14 of them sit exactly
    // on 0.0), so they converge into one star. Give every line its own slot and
    // keep its own vertical motion on top of it.
    ys.push([local, ySlot + (evalEvents(yEvents, tick) - yBase) * LANE_Y_SCALE])
    rs.push([local, evalEvents(rotEvents, tick)])
  }
  const fields = {
    name: laneName,
    generateTime: round(w0),
    keepTime: round(w1 - w0),
    drawStartX: vf(-LANE_HALF_LENGTH),
    drawEndX: vf(LANE_HALF_LENGTH),
    positionX: curveFromSamples(xs, 0.02),
    positionY: curveFromSamples(ys, 0.02),
    rotationZ: curveFromSamples(rs, 0.4),
    color: {
      t: 'obj',
      type: G + 'LerpColorCurve',
      fields: {
        colorPoints: {
          t: 'arr',
          type: G + 'ColorArgb',
          items: [
            {
              t: 'obj',
              type: G + 'ColorArgb',
              fields: { r: 0.0196078, g: 0.7607843, b: 0.5882353, a: round(alpha) },
            },
          ],
        },
      },
    },
  }
  const element = createElement('Dremu.DremuMainLane', { start: round(w0), fields })
  element.fields.generateTime = round(w0)
  element.fields.keepTime = round(w1 - w0)
  return element
}

const typeCounts = { 1: 0, 2: 0, 3: 0, 4: 0 }
let laneCount = 0
let windowCount = 0

// vertical layout: one slot per line, ordered by the line's own average height
const yStats = lines.map((line) => {
  const mv = line.judgeLineMoveEvents || []
  const yEv = mv.map((e) => ({ startTime: e.startTime, endTime: e.endTime, start: e.start2, end: e.end2 }))
  let lo = Infinity, hi = -Infinity
  for (let t = 0; t <= chartEnd; t += 0.5) {
    const v = evalEvents(yEv, t / UNIT)
    lo = Math.min(lo, v); hi = Math.max(hi, v)
  }
  return { base: (lo + hi) / 2, range: hi - lo }
})
const order = yStats.map((s, i) => ({ i, base: s.base })).sort((a, b) => a.base - b.base || a.i - b.i)
const slotOf = new Array(lines.length)
order.forEach((entry, rank) => {
  slotOf[entry.i] = USE_SLOTS ? round(-4.2 + (rank / Math.max(1, lines.length - 1)) * 8.4) : 0
})

lines.forEach((line, index) => {
  const lineNoteCount = (line.notesAbove || []).length + (line.notesBelow || []).length
  if (ONLY_LINES_WITH_NOTES && lineNoteCount === 0) return
  const laneName = `Line${index}`
  const ySlot = slotOf[index]
  const yBase = yStats[index].base
  const alphaEvents = line.judgeLineDisappearEvents || []
  const notes = [...(line.notesAbove || []), ...(line.notesBelow || [])].sort((a, b) => a.time - b.time)

  // ---- visible windows from the disappear (alpha) events ----
  const step = 1 / SAMPLE_HZ
  const raw = []
  let open = null
  for (let t = 0; t <= chartEnd + step; t += step) {
    const visible = evalEvents(alphaEvents, t / UNIT) > ALPHA_ON
    if (visible && open === null) open = t
    else if (!visible && open !== null) {
      raw.push([open, Math.min(t, chartEnd)])
      open = null
    }
  }
  if (open !== null) raw.push([open, chartEnd])
  const merged = []
  for (const w of raw) {
    const last = merged[merged.length - 1]
    if (last && w[0] - last[1] < MERGE_GAP) last[1] = w[1]
    else merged.push([w[0], w[1]])
  }
  const visibleWindows = USE_ALPHA_WINDOWS
    ? merged.filter((w) => w[1] - w[0] >= MIN_WINDOW)
    : [[0, chartEnd]]
  windowCount += visibleWindows.length

  // Decorative lines (no notes) are dimmed so the playable lines stay readable
  // when every judge line is drawn continuously.
  const decorativeAlpha = (line.notesAbove || []).length + (line.notesBelow || []).length > 0 ? 1 : 0.22
  const laneDefs = []
  if (!USE_ALPHA_WINDOWS) {
    laneDefs.push({ w0: 0, w1: chartEnd, alpha: decorativeAlpha })
  } else {
    // Dremu lane colour has no time axis, so the alpha curve is baked into
    // piecewise-constant windows: each visible window gets the mean alpha of
    // that span, and spans where alpha swings hard are split in two.
    const alphaAt = (t) => evalEvents(alphaEvents, t / UNIT)
    for (const [w0, w1] of visibleWindows) {
      const span = w1 - w0
      let lo = 1
      let hi = 0
      for (let t = w0; t <= w1; t += 0.05) {
        const v = alphaAt(t)
        lo = Math.min(lo, v); hi = Math.max(hi, v)
      }
      // split so every lane piece covers a narrow alpha band (step <= 0.25)
      const parts = span > 0.3 && hi - lo > 0.3 ? 2 : 1
      for (let p = 0; p < parts; p += 1) {
        const a = w0 + (span * p) / parts
        const b = w0 + (span * (p + 1)) / parts
        let sum = 0
        let n = 0
        for (let t = a; t <= b; t += 0.05) { sum += alphaAt(t); n += 1 }
        const mean = n > 0 ? sum / n : 1
        laneDefs.push({ w0: a, w1: b, alpha: round(Math.max(0.2, Math.min(1, mean))) })
      }
    }
  }

  // ---- notes ----
  const lead = (hit) => 1.0
  const covered = (t) => visibleWindows.some(([a, b]) => t >= a - 1e-6 && t <= b + 1e-6)
  const uncovered = notes.filter((n) => {
    const hit = round(n.time * UNIT)
    return !covered(hit - lead(hit))
  })

  if (uncovered.length > 0) {
    // Invisible binding lanes: they only exist so every note has a lane at spawn.
    const spans = uncovered.map((n) => {
      const hit = round(n.time * UNIT)
      return [Math.max(0, hit - lead(hit) - 0.1), hit + 0.6]
    })
    spans.sort((a, b) => a[0] - b[0])
    const groups = []
    for (const s of spans) {
      const last = groups[groups.length - 1]
      if (last && s[0] <= last[1] + 0.5) last[1] = Math.max(last[1], s[1])
      else groups.push([s[0], s[1]])
    }
    for (const [g0, g1] of groups) laneDefs.push({ w0: g0, w1: g1, alpha: 0 })
  }

  laneDefs.sort((a, b) => a.w0 - b.w0)
  laneDefs.forEach((def, k) => {
    def.name = `${laneName}_${k}`
    items.push(makeLane(line, def.name, round(def.w0), round(def.w1), def.alpha, ySlot, yBase))
    laneCount += 1
  })

  for (const note of notes) {
    const type = note.type
    if (typeCounts[type] === undefined) continue
    typeCounts[type] += 1
    const hit = round(note.time * UNIT)
    const spawn = hit - lead(hit)
    const win = laneDefs.find((d) => spawn >= d.w0 - 1e-6 && spawn <= d.w1 + 1e-6) || laneDefs[laneDefs.length - 1]
    const fields = {
      laneName: win ? win.name : laneName,
      leadTime: lead(hit),
      lagTime: 0.45,
      position: vf((note.positionX || 0) * NOTE_X_SCALE - evalEvents(line.judgeLineMoveEvents || [], note.time) * LANE_X_SCALE),
    }
    if (type === 3) fields.holdTime = round((note.holdTime || 0) * UNIT)
    const tint = TYPE_TINT[type]
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
    items.push(createElement(TYPE_MAP[type], { start: hit, fields }))
  }
})

const saved = saveProject(project, { force: true })
console.log('chart staff:', saved.written, saved.errors)
console.log('notes', typeCounts, 'lanes', laneCount, 'visible windows', windowCount)

// ------------------------------------------------------------------ audio --
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
            timeOffset : ${round(AUDIO_OFFSET)},
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
                assetName : "image:cover_blur",
                keepTime : 196.0,
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

console.log('files', fs.readdirSync(OUT).map((f) => `${f} ${(fs.statSync(path.join(OUT, f)).size / 1024).toFixed(0)}KB`).join(', '))
