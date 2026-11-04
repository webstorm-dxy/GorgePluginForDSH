/**
 * dremu-model.js — chart / project model for Gorge **Dremu** `.g` chart projects.
 *
 * This module is the authoritative, I/O-owning half of the Gorge Chart Studio
 * bundle. It sits between the pure text codec (`gorge-codec.js`) and the Host
 * (`index.js`) / Client (`client.js`):
 *
 *   `.g` text  <--gorge-codec-->  StaffFile (typed value tree)
 *   StaffFile  <--dremu-model-->  Project (editable chart model)  <--wire-->  client
 *
 * Everything here is plain ESM + Node builtins (node:fs, node:path). There are
 * no dependencies and no build step. No function in this module throws for bad
 * *user* input: the mutating/validating entry points report problems in their
 * result objects (`errors`, `Issue[]`, `warnings`). Only programmer errors
 * (calling `createElement` with an unknown type) throw.
 *
 * ---------------------------------------------------------------------------
 * CONCEPTS
 * ---------------------------------------------------------------------------
 * project   A directory holding `.g` staff files plus assets (png/wav...).
 *           `loadProject(dir)` reads every top-level `*.g`; one unreadable file
 *           only produces a warning.
 * staff     One `.g` file. `kind` is `audio` (`@AudioStaff` / `@Song`),
 *           `storyboard` (`form = "DeentyStoryboard"`), `chart`
 *           (`@ElementStaff` + `@Chart`) or `other`.
 * period    One `@Chart` method of a staff. `PeriodConfig.timeOffset` is the
 *           slice start in *absolute* seconds; element times inside the slice
 *           are *relative*. Optional `minLength` bounds the slice length.
 *           Period order in a file is NOT time order, so `Staff.periods` is
 *           sorted by `timeOffset` (stable for equal offsets).
 * element   One typed object in a period's `new Element^[N]{ ... }` array.
 *
 * A chart may store many periods per staff (DremuStaff1.g has 20) and many
 * staffs control the same song (lanes in one staff, notes in another).
 *
 * ---------------------------------------------------------------------------
 * ID SCHEME (stable, deterministic — the client uses ids for selection/edits)
 * ---------------------------------------------------------------------------
 *   staff.id   file basename, e.g. `"DremuStaff1.g"`
 *   period.id  `"p0"`, `"p1"`, ... scoped to the staff (wire order = sorted by
 *              `timeOffset`, NOT file order)
 *   element.id `"<staffId>:<periodId>:e<arrayIndex>"` e.g.
 *              `"DremuStaff1.g:p3:e7"`.
 *
 * The Staff basename is part of the element id because the same `p0` exists in
 * several staffs, and the client matches elements by id across the whole
 * project. Ids are *derived*, not persisted (the `.g` format has no id field):
 *   - an unchanged project re-loads with exactly the same ids;
 *   - after structural edits (`add`/`remove`/`duplicate`) already-issued ids in
 *     that snapshot stay valid for the session; a later reload re-derives them
 *     from position. Clients should re-read ids from the authoritative wire
 *     state after a reload and use `applyOps(...).created` to learn the ids of
 *     newly created elements;
 *   - `applyOps` honours a client-suggested `element.id` / `newId` verbatim
 *     (if unique), otherwise it generates the deterministic next id.
 *
 * ---------------------------------------------------------------------------
 * OP LIST (applyOps) — `{ changed, errors, created }`, total, never throws
 * ---------------------------------------------------------------------------
 *   { op:'patch',      elementId, path:(string|number)[], value:Value }
 *         Navigate the element's `fields` map: string segments select object
 *         keys, numeric segments select `{t:'arr'}` items. `path: []` replaces
 *         the whole fields map (accepts either a plain map or an
 *         `{t:'obj', fields}` node).
 *   { op:'add',        staffId, periodId?, element:{ id?, type, fields? } }
 *         `periodId` omitted => pick the period covering `element.start`
 *         (absolute seconds; optional convenience) or allocate one if the
 *         staff has no periods.
 *   { op:'remove',     elementId }
 *   { op:'duplicate',  elementId, newId?, timeShift? }   (seconds)
 *   { op:'setMeta',    tempo?:{bpm?,offset?}, title? }   (UI-only metadata)
 *   { op:'setStaffName', staffId, displayName }
 *   { op:'setPeriodConfig', periodId, staffId?, fields } (merged into the
 *         member's PeriodConfig attr; updates timeOffset/minLength)
 * Ops apply in order. A failing op is reported in `errors` and skipped; the
 * successfully applied prefix is kept (`changed` is true if any op applied).
 * Unknown op keys are tolerated and reported in `errors`.
 *
 * ---------------------------------------------------------------------------
 * SAVING
 * ---------------------------------------------------------------------------
 * `saveProject(project, { force? })` re-serialises only staffs whose canonical
 * text differs from what was loaded and writes them atomically (temp file in
 * the project directory + rename). The first write per file per session keeps a
 * `<file>.g.bak` copy of the original bytes. A file that fails to serialise or
 * write is reported in `errors` and left untouched on disk.
 *
 * ---------------------------------------------------------------------------
 * TIME
 * ---------------------------------------------------------------------------
 * `elementTiming(element, period)` returns ABSOLUTE seconds:
 *   start    = period.timeOffset + local timing field
 *   duration = keepTime for lanes, holdTime for holds, null otherwise
 *   lane     = laneName for notes, name for lanes, null otherwise
 *   category = catalog category ('note' | 'hold' | 'lane' | 'inner' | ...)
 * Values are rounded to 1e-6 s (same as the client) to avoid float dust in the
 * wire state.
 *
 * For `Dremu.DremuHoldInnerNote` pass `{ parentStart }` (the absolute start of
 * the owning hold) as the 3rd argument: their `hitTime` is relative to the hold.
 * `project.audio.offset` is the audio staff's own `PeriodConfig.timeOffset`
 * (`Song.g`: 0.373): chart time = audio time + offset, the client transport
 * corrects for it, and `project.duration = max(element ends, audio duration +
 * audio offset)`.
 *
 * ---------------------------------------------------------------------------
 * CURVES — `evaluateCurve(value, x)` (source of truth; the client preview is a
 * small re-implementation, keep them in sync)
 * ---------------------------------------------------------------------------
 * These are the engine-exact semantics recovered from `docs/gorge-format-spec.md`
 * §D (the client preview re-implements a subset; keep them in sync). Numeric
 * curves return a number, `GorgeFramework.LerpColorCurve` returns
 * `{ r, g, b, a }` (0..1 channels), unknown values return `null`. Values in
 * parentheses are the engine's field defaults (used when the field is absent).
 *   ConstantFunctionCurve   f(x) = value                                     (0)
 *   LinearFunctionCurve     f(x) = k*x + b                                   (0, 0)
 *   LinearCurve             Unity AnimationCurve from the two keys
 *                           (timeStart,valueStart)-(timeEnd,valueEnd): linear
 *                           between them, clamped outside.                   (0,0)-(1,1)
 *   CubicHermiteSpline      Unity weighted-tangent cubic over
 *                           [startPoint.x, endPoint.x], clamped outside (flat
 *                           continuation). Weights 0..1; the classic 1/3 case
 *                           is plain Hermite. Tangents are slopes dy/dx.
 *                           Default = identity ramp (0,0)->(1,1) with 1/3 weights.
 *   PiecewiseFunctionCurve  first FunctionPiece whose [startX,endX] contains x
 *                           (open unless leftClosed/rightClosed), evaluated at
 *                           the absolute x; no match => 0.
 *   AxialSymmetricFunctionCurve  keepLeft ? (x<=axis ? f(x) : f(2*axis-x))
 *                                          : (x>=axis ? f(x) : f(2*axis-x)). (axis=0)
 *   PeriodicFunctionCurve   phase = startX + (x-startX) mod (endX-startX),
 *                           then f(phase); leftClosed owns the boundary.    (period<=0: f(x))
 *   AdditionFunctionCurve   f1(x) + f2(x) (missing operand counts as 0).      (0)
 *   CompositeFunctionCurve  outerFunctionCurve( innerFunctionCurve(x) ); any
 *                           missing curve counts as 0.                        (0)
 *   LerpColorCurve          null/empty colorPoints => white; null progressCurve
 *                           => the first stop; else p = progressCurve(x),
 *                           i1=clamp(floor p), i2=clamp(ceil p), lerp by p-i1.
 *   VariableFloat           baseValue + variationCurve(x)  (variation is a
 *                           delta; a missing curve means 0)                  (base)
 * `CATALOG.curveKinds` names the editable kinds and their return type.
 *
 * The `.g` format has NO tempo and no project metadata: `project.tempo`
 * (`{bpm:120, offset:0}`) and `project.title` are UI-only conveniences that the
 * Host persists in its recovery snapshot; `saveProject` writes `*.g` files only.
 *
 * @module dremu-model
 */

import fs from 'node:fs'
import path from 'node:path'
import { parseGorgeFile, serializeGorgeFile } from './gorge-codec.js'

// ===========================================================================
// 0. Small utilities
// ===========================================================================

const G = 'GorgeFramework.'

/** Round to 6 decimals (matches the client's derived timing maths). */
function round6(value) {
  if (!Number.isFinite(value)) return 0
  const factor = 1e6
  return Math.round(value * factor) / factor
}

/** True for a non-null, non-array object. */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** True for a typed value wrapper `{ t:'obj'|'arr'|'ref'|'expr' }`. */
function isTypedValue(value) {
  return isPlainObject(value) && typeof value.t === 'string' && (value.t === 'obj' || value.t === 'arr' || value.t === 'ref' || value.t === 'expr')
}

/** `'Dremu.DremuTap'` -> `'DremuTap'`; `null`/numbers -> `''`. */
function shortType(type) {
  if (typeof type !== 'string') return ''
  const dot = type.lastIndexOf('.')
  return dot === -1 ? type : type.slice(dot + 1)
}

/** `'GorgeFramework.PeriodConfig^'` -> `'PeriodConfig'` (strips `^` marker). */
function bareTypeName(type) {
  const short = shortType(type)
  return short.endsWith('^') ? short.slice(0, -1) : short
}

/** JSON deep clone for the JSON-safe typed value tree. */
function cloneValue(value) {
  if (value === null || typeof value !== 'object') return value
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return value
  }
}

/** Error message without leaking a stack to the wire. */
function messageOf(error) {
  if (!error) return 'unknown error'
  return String((error && error.message) || error)
}

/**
 * Numeric reading of a scalar Value: numbers pass through, `{t:'expr'}` uses
 * its `special` (`'Infinity' | '-Infinity' | 'NaN' | number`). Non-finite
 * results are reported as `null` so they never reach the JSON wire state.
 */
function valueAsNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (isPlainObject(value) && value.t === 'expr') {
    if (typeof value.special === 'number' && Number.isFinite(value.special)) return value.special
    if (value.special === 'Infinity') return Infinity
    if (value.special === '-Infinity') return -Infinity
  }
  return null
}

/** Like valueAsNumber but only finite results (timing/offsets). */
function finiteNumber(value) {
  const n = valueAsNumber(value)
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}

/** Read a finite number from a plain object field. */
function fieldNumber(fields, name) {
  if (!name || !isPlainObject(fields) || !(name in fields)) return null
  return finiteNumber(fields[name])
}

/** String field or null. */
function fieldString(fields, name) {
  if (!name || !isPlainObject(fields) || !(name in fields)) return null
  return typeof fields[name] === 'string' ? fields[name] : null
}

// ---------------------------------------------------------------------------
// Generic path helpers used by `patch` ops. They mirror the client's optimistic
// `getAtPath`/`setAtPath`: plain objects by string key, arrays by index.
// ---------------------------------------------------------------------------

function getAtPath(root, segments) {
  let current = root
  for (const segment of segments) {
    if (current === null || current === undefined) return undefined
    if (Array.isArray(current)) current = current[Number(segment)]
    else if (isPlainObject(current)) current = current[segment]
    else return undefined
  }
  return current
}

function setAtPath(root, segments, value) {
  if (!segments.length) return cloneValue(value)
  const copy = cloneValue(root)
  let current = copy
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i]
    let next = Array.isArray(current) ? current[Number(segment)] : current[segment]
    if (next === null || next === undefined) {
      next = typeof segments[i + 1] === 'number' ? [] : {}
      if (Array.isArray(current)) current[Number(segment)] = next
      else current[segment] = next
    }
    current = next
  }
  const last = segments[segments.length - 1]
  if (Array.isArray(current)) current[Number(last)] = cloneValue(value)
  else current[last] = cloneValue(value)
  return copy
}

// ===========================================================================
// 1. Value-tree default builders (all types qualified, as in most staffs)
// ===========================================================================

/** `GorgeFramework.VariableFloat { baseValue }` */
const vf = (baseValue = 0) => ({ t: 'obj', type: G + 'VariableFloat', fields: { baseValue } })

/** `GorgeFramework.Vector2 { x, y }` */
const vec2 = (x = 0, y = 0) => ({ t: 'obj', type: G + 'Vector2', fields: { x, y } })

/** `GorgeFramework.ColorArgb { [a,] r, g, b }` (a omitted => 1.0). */
const color = (r = 0, g = 0, b = 0, a = undefined) => {
  const fields = a === undefined ? { r, g, b } : { a, r, g, b }
  return { t: 'obj', type: G + 'ColorArgb', fields }
}

/** `GorgeFramework.ConstantFunctionCurve { value }` */
const constCurve = (value = 0) => ({ t: 'obj', type: G + 'ConstantFunctionCurve', fields: { value } })

/** `GorgeFramework.LinearFunctionCurve { k, b }` */
const linearFn = (k = 1, b = 0) => ({ t: 'obj', type: G + 'LinearFunctionCurve', fields: { k, b } })

/** `GorgeFramework.LinearCurve { timeStart, valueStart, timeEnd, valueEnd }` */
const linearCurve = (timeStart = 0, valueStart = 0, timeEnd = 1, valueEnd = 0) => ({
  t: 'obj',
  type: G + 'LinearCurve',
  fields: { timeStart, valueStart, timeEnd, valueEnd },
})

/** `GorgeFramework.CubicHermiteSpline { startPoint, endPoint, ... }` */
const spline = (startX = 0, startY = 0, endX = 1, endY = 0, extra = {}) => ({
  t: 'obj',
  type: G + 'CubicHermiteSpline',
  fields: Object.assign({ startPoint: vec2(startX, startY), endPoint: vec2(endX, endY) }, extra),
})

/** `GorgeFramework.LerpColorCurve { colorPoints }` */
const lerpColor = (points, progressCurve = undefined) => {
  const fields = { colorPoints: { t: 'arr', type: G + 'ColorArgb', items: points } }
  if (progressCurve !== undefined) fields.progressCurve = progressCurve
  return { t: 'obj', type: G + 'LerpColorCurve', fields }
}

/** `GorgeFramework.FunctionCurve^` array Value. */
const curveList = (items) => ({ t: 'arr', type: G + 'FunctionCurve', items })

// Palette defaults, derived from the corpus' most common values.
const NOTE_COLOR = lerpColor([color(0.9411765, 0.9490196, 0.7568628)])
const LANE_COLOR = lerpColor([color(0.0196078, 0.7607843, 0.5882353)])
const HINT_COLOR_1 = color(0.0196078, 0.4, 0.5529412)
const HINT_COLOR_1_B = color(0.0196078, 0.7607843, 0.5882353, 1)
const HINT_COLOR_2 = color(0.0196078, 0.7607843, 0.5882353, 1)
const HINT_COLOR_2_B = color(0.7568628, 0.9490196, 0.9411765)
const LANE_LINES = curveList([constCurve(0)])

// ===========================================================================
// 2. CATALOG — composite value types, curve metadata, element descriptors
// ===========================================================================
//
// Data derived from the real corpus AND from the engine declarations recovered
// by the format research (`docs/gorge-format-spec.md` §C/D): field *order* is
// the corpus' observed serialisation order, `default` is the engine's
// `[auto defaultValue]` where the engine has a concrete one. Fields whose
// engine default is `null` (curves, colours, ...) are marked `optional` and get
// an authoring-friendly default only where the editor needs one to produce a
// usable new element (documented per field).
//
// `valueTypes[TypeName] = { label, group, fields: { name: descriptor } }`
// where a descriptor is:
//   { type, label, default?, optional?, required?, unit?, enum?, itemSchema?,
//     schema?, fields? }
// `type` is one of: number | int | string | boolean | ref | color | curve |
// an element type (`Dremu.DremuHoldInnerNote`) | a value type (`VariableFloat`).
// `fields` is present for descriptors of composite value types so generic
// inspectors can resolve nested labels without a second lookup (it is the same
// object as `valueTypes[X].fields`; harmless duplication in JSON).

/** Build a `fields` map with stable ordering. */
function fieldsMap(entries) {
  const out = {}
  for (const entry of entries) out[entry.name] = entry
  return out
}

const VALUE_TYPES = {}

/** Register one composite value type; `fields` must already be a map. */
function defineValueType(name, label, group, fields) {
  const descriptor = { label, group, fields }
  VALUE_TYPES[name] = descriptor
  return descriptor
}

// NOTE: `ColorArgb` channels all default to 1.0 in the engine (so `{ r: 0.5 }`
// is an opaque, bright colour); `LinearCurve` defaults to the identity ramp
// (0,0)->(1,1); `LinearFunctionCurve` defaults to the zero function (k=b=0);
// `CubicHermiteSpline` defaults to the identity ramp with classic weights 1/3.
defineValueType('VariableFloat', '变量浮点', 'Gorge', fieldsMap([
  { name: 'baseValue', type: 'number', default: 0, label: '基础值' },
  { name: 'variationCurve', type: 'curve', optional: true, label: '变化曲线' },
]))

defineValueType('Vector2', '二维向量', 'Gorge', fieldsMap([
  { name: 'x', type: 'number', default: 0, label: 'X' },
  { name: 'y', type: 'number', default: 0, label: 'Y' },
]))

defineValueType('ColorArgb', '颜色 (ARGB)', 'Gorge', fieldsMap([
  { name: 'a', type: 'number', default: 1, label: '透明度' },
  { name: 'r', type: 'number', default: 1, label: '红' },
  { name: 'g', type: 'number', default: 1, label: '绿' },
  { name: 'b', type: 'number', default: 1, label: '蓝' },
]))

defineValueType('LinearCurve', '线性曲线', 'Gorge', fieldsMap([
  { name: 'timeStart', type: 'number', default: 0, label: '开始时间', unit: 's' },
  { name: 'valueStart', type: 'number', default: 0, label: '起始值' },
  { name: 'timeEnd', type: 'number', default: 1, label: '结束时间', unit: 's' },
  { name: 'valueEnd', type: 'number', default: 1, label: '结束值' },
]))

defineValueType('CubicHermiteSpline', '三次埃尔米特样条', 'Gorge', fieldsMap([
  {
    name: 'startPoint',
    type: 'Vector2',
    default: vec2(0, 0),
    label: '起点',
    schema: VALUE_TYPES.Vector2,
    fields: VALUE_TYPES.Vector2.fields,
  },
  { name: 'startTangent', type: 'number', default: 0, label: '起点切线' },
  { name: 'startWeight', type: 'number', default: 0.33333, label: '起点权重' },
  {
    name: 'endPoint',
    type: 'Vector2',
    default: vec2(1, 1),
    label: '终点',
    schema: VALUE_TYPES.Vector2,
    fields: VALUE_TYPES.Vector2.fields,
  },
  { name: 'endTangent', type: 'number', default: 0, label: '终点切线' },
  { name: 'endWeight', type: 'number', default: 0.33333, label: '终点权重' },
]))

defineValueType('LinearFunctionCurve', '线性函数曲线', 'Gorge', fieldsMap([
  { name: 'k', type: 'number', default: 0, label: '斜率' },
  { name: 'b', type: 'number', default: 0, label: '截距' },
]))

defineValueType('ConstantFunctionCurve', '常量曲线', 'Gorge', fieldsMap([
  { name: 'value', type: 'number', default: 0, label: '值' },
]))

defineValueType('FunctionPiece', '函数分段', 'Gorge', fieldsMap([
  { name: 'functionCurve', type: 'curve', optional: true, label: '函数曲线' },
  { name: 'startX', type: 'number', default: 0, label: '开始 X' },
  { name: 'endX', type: 'number', default: 0, label: '结束 X' },
  { name: 'leftClosed', type: 'boolean', default: false, label: '左闭' },
  { name: 'rightClosed', type: 'boolean', default: false, label: '右闭' },
]))

defineValueType('PiecewiseFunctionCurve', '分段函数曲线', 'Gorge', fieldsMap([
  {
    name: 'functionPieces',
    type: 'array',
    label: '函数分段',
    default: { t: 'arr', type: G + 'FunctionPiece', items: [] },
    itemSchema: VALUE_TYPES.FunctionPiece,
  },
]))

defineValueType('LerpColorCurve', '颜色渐变曲线', 'Gorge', fieldsMap([
  {
    name: 'colorPoints',
    type: 'array',
    label: '颜色点',
    optional: true,
    itemSchema: VALUE_TYPES.ColorArgb,
  },
  { name: 'progressCurve', type: 'curve', optional: true, label: '进度曲线' },
]))

defineValueType('AxialSymmetricFunctionCurve', '轴对称函数曲线', 'Gorge', fieldsMap([
  { name: 'functionCurve', type: 'curve', label: '函数曲线' },
  { name: 'axis', type: 'number', default: 0, label: '对称轴' },
  { name: 'keepLeft', type: 'boolean', default: false, label: '保留左侧' },
]))

defineValueType('PeriodicFunctionCurve', '周期函数曲线', 'Gorge', fieldsMap([
  { name: 'functionCurve', type: 'curve', label: '函数曲线' },
  { name: 'startX', type: 'number', default: 0, label: '开始 X' },
  { name: 'endX', type: 'number', default: 0, label: '结束 X' },
  { name: 'leftClosed', type: 'boolean', default: false, label: '左闭' },
]))

defineValueType('AdditionFunctionCurve', '相加函数曲线', 'Gorge', fieldsMap([
  { name: 'firstFunctionCurve', type: 'curve', label: '第一函数曲线' },
  { name: 'secondFunctionCurve', type: 'curve', label: '第二函数曲线' },
]))

defineValueType('CompositeFunctionCurve', '复合函数曲线', 'Gorge', fieldsMap([
  { name: 'outerFunctionCurve', type: 'curve', label: '外函数曲线' },
  { name: 'innerFunctionCurve', type: 'curve', label: '内函数曲线' },
]))

defineValueType('WavAudioAsset', 'WAV 音频资源', 'GorgeFramework', fieldsMap([
  { name: 'name', type: 'string', default: '', label: '资源名' },
  { name: 'wavFilePath', type: 'string', default: '', label: '音频文件' },
]))

defineValueType('PeriodConfig', '周期配置', 'GorgeFramework', fieldsMap([
  { name: 'timeOffset', type: 'number', default: 0, label: '时间偏移', unit: 's' },
  { name: 'minLength', type: 'number', default: 10, label: '最短长度', unit: 's' },
]))

/**
 * Editable curve kinds. `returns` is `number` or `color`; `evaluate` names the
 * `evaluateCurve` dispatch arm. `editable` means the client's curve dialog can
 * draw/scrub it.
 */
const CURVE_KINDS = {
  ConstantFunctionCurve: { label: '常量', returns: 'number', evaluate: 'constant', editable: true, fields: VALUE_TYPES.ConstantFunctionCurve.fields },
  LinearFunctionCurve: { label: '线性函数', returns: 'number', evaluate: 'linear-function', editable: true, fields: VALUE_TYPES.LinearFunctionCurve.fields },
  LinearCurve: { label: '线性', returns: 'number', evaluate: 'linear', editable: true, fields: VALUE_TYPES.LinearCurve.fields },
  CubicHermiteSpline: { label: '三次样条', returns: 'number', evaluate: 'hermite', editable: true, fields: VALUE_TYPES.CubicHermiteSpline.fields },
  PiecewiseFunctionCurve: { label: '分段函数', returns: 'number', evaluate: 'piecewise', editable: true, fields: VALUE_TYPES.PiecewiseFunctionCurve.fields },
  AxialSymmetricFunctionCurve: { label: '轴对称', returns: 'number', evaluate: 'axial-symmetric', editable: true, fields: VALUE_TYPES.AxialSymmetricFunctionCurve.fields },
  PeriodicFunctionCurve: { label: '周期函数', returns: 'number', evaluate: 'periodic', editable: true, fields: VALUE_TYPES.PeriodicFunctionCurve.fields },
  AdditionFunctionCurve: { label: '相加函数', returns: 'number', evaluate: 'addition', editable: true, fields: VALUE_TYPES.AdditionFunctionCurve.fields },
  CompositeFunctionCurve: { label: '复合函数', returns: 'number', evaluate: 'composite', editable: true, fields: VALUE_TYPES.CompositeFunctionCurve.fields },
  LerpColorCurve: { label: '颜色渐变', returns: 'color', evaluate: 'lerp-color', editable: true, fields: VALUE_TYPES.LerpColorCurve.fields },
  VariableFloat: { label: '变量浮点', returns: 'number', evaluate: 'variable-float', editable: true, baseField: 'baseValue', curveField: 'variationCurve', fields: VALUE_TYPES.VariableFloat.fields },
}

/** Concrete numeric curve type names offered by the curve-type dropdown. */
const CURVE_TYPE_LIST = [
  'ConstantFunctionCurve',
  'LinearFunctionCurve',
  'LinearCurve',
  'CubicHermiteSpline',
  'PiecewiseFunctionCurve',
  'AxialSymmetricFunctionCurve',
  'PeriodicFunctionCurve',
  'AdditionFunctionCurve',
  'CompositeFunctionCurve',
]

// --- element field descriptor helpers --------------------------------------

function fNum(name, label, defaultValue, extra) {
  const field = { name, type: 'number', label }
  if (defaultValue !== undefined) field.default = defaultValue
  return Object.assign(field, extra)
}

function fInt(name, label, defaultValue, extra) {
  const field = { name, type: 'int', label }
  if (defaultValue !== undefined) field.default = defaultValue
  return Object.assign(field, extra)
}

function fStr(name, label, defaultValue, extra) {
  const field = { name, type: 'string', label }
  if (defaultValue !== undefined) field.default = defaultValue
  return Object.assign(field, extra)
}

function fBool(name, label, defaultValue, extra) {
  const field = { name, type: 'boolean', label }
  if (defaultValue !== undefined) field.default = defaultValue
  return Object.assign(field, extra)
}

/** Enum-like `{t:'ref'}` field. */
function fEnum(name, label, enumName, defaultPath, extra) {
  const field = { name, type: 'ref', label, enum: enumName }
  if (defaultPath !== undefined) field.default = { t: 'ref', path: defaultPath }
  return Object.assign(field, extra)
}

/** Composite value-type field; carries the value schema inline for inspectors. */
function fValue(name, typeName, label, defaultValue, extra) {
  const valueType = VALUE_TYPES[typeName] || null
  const field = { name, type: typeName, label }
  if (defaultValue !== undefined) field.default = defaultValue
  if (valueType) {
    field.schema = valueType
    field.fields = valueType.fields
  }
  return Object.assign(field, extra)
}

/** Curve field (`schema.type === 'curve'`). */
function fCurve(name, label, defaultValue, extra) {
  const field = { name, type: 'curve', label, schema: { type: 'curve', label: '曲线' } }
  if (defaultValue !== undefined) field.default = defaultValue
  return Object.assign(field, extra)
}

/** Array field; `elem` is the on-disk element type, `itemSchema` the inspector schema. */
function fArr(name, label, elem, itemSchema, defaultValue, extra) {
  const field = { name, type: 'array', elem, label }
  if (itemSchema) field.itemSchema = itemSchema
  if (defaultValue !== undefined) field.default = defaultValue
  return Object.assign(field, extra)
}

/** Timing descriptor: which field carries absolute start / length / lane. */
function timing(start, duration, lane, extra) {
  return Object.assign({ start, duration, lane }, extra)
}

/** One element catalog entry. */
function elementEntry(spec) {
  return spec
}

/**
 * Engine defaults shared by all four note types (`Dremu.DremuNote`, see
 * docs/gorge-format-spec.md §C.6). `color` / `respondHintColor*` have a null
 * engine default; the editor substitutes corpus-typical values so a new note is
 * immediately visible (marked "authoring default" below).
 */
function noteFields(hint1, hint2) {
  return [
    fStr('laneName', '轨道', '', { required: true }),
    fNum('hitTime', '击打时间', 0, { unit: 's' }),
    fNum('leadTime', '前导时间', 1.5, { unit: 's' }),
    fNum('lagTime', '后置时间', 1.5, { unit: 's' }),
    fValue('position', 'VariableFloat', '位置', vf(0)),
    fCurve('distance', '距离曲线', linearFn(-8, 0)),
    fValue('color', 'LerpColorCurve', '颜色', NOTE_COLOR, { optional: true }),
    fBool('hintReference', '参考提示', false),
    fValue('respondHintColor1', 'ColorArgb', '响应提示颜色 1', hint1, { optional: true }),
    fValue('respondHintColor2', 'ColorArgb', '响应提示颜色 2', hint2, { optional: true }),
    fNum('positionZ', '绘制层级', -2),
  ]
}

/**
 * `CATALOG` — JSON-serialisable descriptor sent to the client and to agent
 * tools. `elements` are ordered as they appear in the "+ add" palette; each
 * `fields` array follows the on-disk serialisation order.
 */
const ELEMENT_SPECS = [
  elementEntry({
    type: 'Dremu.DremuTap',
    shortName: 'DremuTap',
    label: '点击',
    category: 'note',
    group: 'Dremu',
    color: '#22c55e',
    timing: timing('hitTime', null, 'laneName'),
    fields: noteFields(HINT_COLOR_1, HINT_COLOR_2),
  }),
  elementEntry({
    type: 'Dremu.DremuDrag',
    shortName: 'DremuDrag',
    label: '滑动',
    category: 'note',
    group: 'Dremu',
    color: '#38bdf8',
    timing: timing('hitTime', null, 'laneName'),
    fields: noteFields(HINT_COLOR_1_B, HINT_COLOR_2_B),
  }),
  elementEntry({
    type: 'Dremu.DremuTaplik',
    shortName: 'DremuTaplik',
    label: '轻点',
    category: 'note',
    group: 'Dremu',
    color: '#2dd4bf',
    timing: timing('hitTime', null, 'laneName'),
    fields: noteFields(HINT_COLOR_1_B, HINT_COLOR_2),
  }),
  elementEntry({
    type: 'Dremu.DremuHold',
    shortName: 'DremuHold',
    label: '长按',
    category: 'hold',
    group: 'Dremu',
    color: '#f59e0b',
    timing: timing('hitTime', 'holdTime', 'laneName'),
    fields: noteFields(HINT_COLOR_1, HINT_COLOR_2_B).concat([
      fNum('holdTime', '按住时长', 1, { unit: 's' }),
      fArr('innerNotes', '内部音符', 'Dremu.DremuHoldInnerNote', {
        type: 'Dremu.DremuHoldInnerNote',
        label: '内部音符',
        fields: {
          hitTime: { name: 'hitTime', type: 'number', label: '相对时间', unit: 's' },
          audioEffect: { name: 'audioEffect', type: 'boolean', label: '音效' },
          respondHint: { name: 'respondHint', type: 'boolean', label: '命中效果' },
        },
      }),
      fCurve('endDistance', '结束距离曲线', linearFn(-8, 0)),
      fCurve('holdLine', '长按线曲线', constCurve(0)),
      fBool('truncation', '截断尾部', true),
      fNum('holdLength', '长按线长度', 1, { unit: 's' }),
      fInt('pointCount', '采样点数', 100),
      fBool('targetProjectionFix', '切向投影修正', true),
    ]),
  }),
  elementEntry({
    type: 'Dremu.DremuMainLane',
    shortName: 'DremuMainLane',
    label: '主轨道',
    category: 'lane',
    group: 'Dremu',
    color: '#a78bfa',
    timing: timing('generateTime', 'keepTime', 'name'),
    fields: [
      fStr('name', '轨道名', '', { required: true }),
      fNum('generateTime', '生成时间', 0, { unit: 's' }),
      fNum('keepTime', '持续时间', 10, { unit: 's' }),
      fArr('laneLines', '轨道线', 'FunctionCurve', { type: 'curve', label: '曲线' }, LANE_LINES),
      fCurve('animation', '动画曲线', linearFn(1, 0)),
      fValue('drawStartX', 'VariableFloat', '绘制起点 X', vf(-10)),
      fValue('drawEndX', 'VariableFloat', '绘制终点 X', vf(10)),
      fInt('pointCount', '采样点数', 100),
      fNum('evaluateDelta', '微分步长', 0.01),
      fValue('color', 'LerpColorCurve', '颜色', LANE_COLOR, { optional: true }),
      fNum('positionZ', '绘制层级', -1),
      fValue('positionX', 'VariableFloat', '位置 X', vf(0)),
      fValue('positionY', 'VariableFloat', '位置 Y', vf(0)),
      fValue('rotationZ', 'VariableFloat', '旋转 Z', vf(0)),
    ],
  }),
  elementEntry({
    type: 'Dremu.DremuGuideLane',
    shortName: 'DremuGuideLane',
    label: '引导轨道',
    category: 'lane',
    group: 'Dremu',
    color: '#818cf8',
    timing: timing('generateTime', 'keepTime', 'name'),
    fields: [
      fStr('name', '轨道名', '', { required: true }),
      fNum('generateTime', '生成时间', 0, { unit: 's' }),
      fNum('keepTime', '持续时间', 10, { unit: 's' }),
      fArr('laneLines', '轨道线', 'FunctionCurve', { type: 'curve', label: '曲线' }, LANE_LINES),
      fValue('drawStartX', 'VariableFloat', '绘制起点 X', vf(-10)),
      fValue('drawEndX', 'VariableFloat', '绘制终点 X', vf(10)),
      fCurve('animation', '动画曲线', linearFn(1, 0)),
      fValue('color', 'LerpColorCurve', '颜色', LANE_COLOR, { optional: true }),
      fStr('mainLaneName', '主轨名称', 'Main1', { required: true }),
      fValue('position', 'VariableFloat', '位置', vf(0)),
      fBool('targetProjectionFix', '切向投影修正', true),
    ],
  }),
  elementEntry({
    type: 'Dremu.DremuHoldInnerNote',
    shortName: 'DremuHoldInnerNote',
    label: '长按内部音符',
    category: 'inner',
    group: 'Dremu',
    color: '#fbbf24',
    timing: timing('hitTime', null, null, { relativeTo: 'hold', parentField: 'innerNotes', parentType: 'Dremu.DremuHold' }),
    fields: [
      fNum('hitTime', '相对时间', 1, { unit: 's' }),
      fBool('audioEffect', '音效', true),
      fBool('respondHint', '命中效果', true),
    ],
  }),
  elementEntry({
    type: 'DeentyStoryboard.Image',
    shortName: 'Image',
    label: '剧情图片',
    category: 'other',
    group: 'DeentyStoryboard',
    color: '#f472b6',
    timing: timing('startMoment', 'keepTime', null),
    fields: [
      fStr('assetName', '图片资源', '', { required: true }),
      fNum('startMoment', '开始时刻', 0, { unit: 's' }),
      fNum('keepTime', '持续时间', 1, { unit: 's' }),
      fEnum('positionMode', '定位模式', 'ImagePositionMode', 'DeentyStoryboard.ImagePositionMode.ScreenX'),
      fValue('positionX', 'VariableFloat', '位置 X', vf(0)),
      fValue('positionY', 'VariableFloat', '位置 Y', vf(0)),
      fValue('rotationZ', 'VariableFloat', '旋转 Z', vf(0)),
      fValue('scaleX', 'VariableFloat', '横向缩放', vf(1)),
      fValue('scaleY', 'VariableFloat', '纵向缩放', vf(1)),
      fValue('positionZ', 'VariableFloat', '绘制层级', vf(1)),
      fValue('alpha', 'VariableFloat', '透明度', vf(1)),
      fBool('useChartTime', '使用谱面时间', false),
    ],
  }),
]

/** Fast lookup by short type name. */
const CATALOG_BY_SHORT = new Map()
for (const entry of ELEMENT_SPECS) CATALOG_BY_SHORT.set(entry.shortName, entry)

/**
 * Reverse alias map: every accepted type spelling -> canonical type.
 * `Dremu.DremuTap` / `DremuTap` / `Tap` all resolve to `Dremu.DremuTap`.
 */
const TYPE_ALIASES = {}
for (const entry of ELEMENT_SPECS) {
  TYPE_ALIASES[entry.type] = entry.type
  TYPE_ALIASES[entry.shortName] = entry.type
  TYPE_ALIASES[entry.group + '.' + entry.shortName] = entry.type
  // Palette-friendly aliases: Dremu.DremuTap -> Tap, Dremu.DremuHold -> Hold, ...
  const stripped = entry.shortName.replace(/^Dremu/, '')
  if (stripped.length > 0) TYPE_ALIASES[stripped] = entry.type
}

/** Resolve any type spelling (qualified, short, alias) to a catalog entry. */
function catalogEntry(type) {
  if (typeof type !== 'string' || type.length === 0) return null
  const alias = TYPE_ALIASES[type] || TYPE_ALIASES[shortType(type)]
  if (alias) return CATALOG_BY_SHORT.get(shortType(alias)) || null
  return CATALOG_BY_SHORT.get(shortType(type)) || null
}

/** Canonical element type for a catalog entry (qualified, e.g. `Dremu.DremuTap`). */
function canonicalType(type) {
  const entry = catalogEntry(type)
  return entry ? entry.type : null
}

export const CATALOG = {
  version: 1,
  source: 'derived from the Gorge .g corpus (/Users/daxingyi/Music/DremuTest, /Users/daxingyi/Music/Chart/**)',
  groups: {
    Dremu: { label: 'Dremu 谱面', namespace: 'Dremu' },
    DeentyStoryboard: { label: 'Deenty 剧情板', namespace: 'DeentyStoryboard' },
  },
  elements: ELEMENT_SPECS,
  valueTypes: VALUE_TYPES,
  curveKinds: CURVE_KINDS,
  curveTypeList: CURVE_TYPE_LIST,
  enums: {
    ImagePositionMode: {
      label: '图片定位模式',
      default: 'DeentyStoryboard.ImagePositionMode.ScreenX',
      options: [
        'DeentyStoryboard.ImagePositionMode.GamePlayPanel',
        'DeentyStoryboard.ImagePositionMode.ScreenXY',
        'DeentyStoryboard.ImagePositionMode.ScreenX',
        'DeentyStoryboard.ImagePositionMode.ScreenY',
        'DeentyStoryboard.ImagePositionMode.ScreenContain',
        'DeentyStoryboard.ImagePositionMode.ScreenCover',
      ],
    },
  },
  palettes: {
    noteTypes: ['Dremu.DremuTap', 'Dremu.DremuDrag', 'Dremu.DremuTaplik', 'Dremu.DremuHold'],
    laneTypes: ['Dremu.DremuMainLane', 'Dremu.DremuGuideLane'],
    storyboardTypes: ['DeentyStoryboard.Image'],
    innerTypes: ['Dremu.DremuHoldInnerNote'],
    allTypes: ELEMENT_SPECS.map((entry) => entry.type),
  },
  typeAliases: TYPE_ALIASES,
}

// ===========================================================================
// 3. Curve evaluation (`evaluateCurve`) — authoritative semantics, see header
// ===========================================================================

function clamp01(value) {
  return value < 0 ? 0 : value > 1 ? 1 : value
}

/** Numeric field of a curve object with fallback. */
function curveNumber(fields, name, fallback) {
  const value = valueAsNumber(fields && fields[name])
  return typeof value === 'number' && !Number.isNaN(value) ? value : fallback
}

/**
 * Solve `3(1-u)^2*u*w1 + 3(1-u)*u^2*(1-w2) + u^3 = target` for `u` in [0,1]
 * (Unity's weighted-tangent Hermite parameter). Monotone for the weights the
 * corpus uses; bisection keeps it stable for the degenerate cases.
 */
function solveHermiteParameter(target, w1, w2) {
  if (target <= 0) return 0
  if (target >= 1) return 1
  const curveX = (u) => {
    const oneMinus = 1 - u
    return 3 * oneMinus * oneMinus * u * w1 + 3 * oneMinus * u * u * (1 - w2) + u * u * u
  }
  let lo = 0
  let hi = 1
  // Guard non-monotone weight combinations by locating a bracketing sub-range.
  if (curveX(1) < target) return 1
  for (let i = 0; i < 64; i += 1) {
    const mid = (lo + hi) / 2
    if (curveX(mid) < target) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

/** Normalised colour object from a ColorArgb-ish Value (engine defaults are 1). */
function colorFromValue(value) {
  const fields = value && isPlainObject(value) && value.t === 'obj' && isPlainObject(value.fields) ? value.fields : {}
  return {
    r: clamp01(curveNumber(fields, 'r', 1)),
    g: clamp01(curveNumber(fields, 'g', 1)),
    b: clamp01(curveNumber(fields, 'b', 1)),
    a: clamp01(curveNumber(fields, 'a', 1)),
  }
}

/** Interpolate two colour objects. */
function lerpColorObject(from, to, t) {
  return {
    r: from.r + (to.r - from.r) * t,
    g: from.g + (to.g - from.g) * t,
    b: from.b + (to.b - from.b) * t,
    a: from.a + (to.a - from.a) * t,
  }
}

const WHITE = { r: 1, g: 1, b: 1, a: 1 }

/**
 * Evaluate one curve-ish Value at `x`.
 *
 * @param {*} value  typed value tree (`{t:'obj',type:'...'}`), a plain number,
 *                   or `null`.
 * @param {number} x  sample position (seconds in the owning element's local
 *                   time, or 0..1 progress for progress-based fields).
 * @returns {number|{r:number,g:number,b:number,a:number}|null} number for scalar
 *          curves, `{r,g,b,a}` (0..1) for `LerpColorCurve`, `null` when unknown.
 * @see The module header for the exact inferred maths of every curve kind.
 */
export function evaluateCurve(value, x) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (value === null || value === undefined) return null
  if (!isTypedValue(value) || value.t !== 'obj') return null
  const fields = isPlainObject(value.fields) ? value.fields : {}
  const type = shortType(value.type)
  const sample = (node, at) => evaluateCurve(node, at)
  switch (type) {
    case 'ConstantFunctionCurve':
    case 'ConstantCurve':
      return curveNumber(fields, 'value', 0)
    // Default k=b=0 (zero function) per the engine declaration.
    case 'LinearFunctionCurve':
      return curveNumber(fields, 'k', 0) * x + curveNumber(fields, 'b', 0)
    // Unity AnimationCurve built from two keys; clamped before/after the keys.
    case 'LinearCurve': {
      // Unity AnimationCurve built from two keys (times should be ascending;
      // reversed pairs are handled by clamping to the time range).
      const t0 = curveNumber(fields, 'timeStart', 0)
      const v0 = curveNumber(fields, 'valueStart', 0)
      const t1 = curveNumber(fields, 'timeEnd', 1)
      const v1 = curveNumber(fields, 'valueEnd', 1)
      if (t1 === t0) return x < t0 ? v0 : v1
      const ascending = t0 < t1
      const lo = ascending ? t0 : t1
      const hi = ascending ? t1 : t0
      const vLo = ascending ? v0 : v1
      const vHi = ascending ? v1 : v0
      if (x <= lo) return vLo
      if (x >= hi) return vHi
      return vLo + (vHi - vLo) * ((x - lo) / (hi - lo))
    }
    // Unity weighted-tangent cubic; clamped outside [startPoint.x, endPoint.x].
    case 'CubicHermiteSpline':
    case 'HermiteSpline': {
      const start = fields.startPoint
      const end = fields.endPoint
      const x0 = start && start.t === 'obj' ? curveNumber(start.fields, 'x', 0) : 0
      const y0 = start && start.t === 'obj' ? curveNumber(start.fields, 'y', 0) : 0
      const x1 = end && end.t === 'obj' ? curveNumber(end.fields, 'x', 1) : 1
      const y1 = end && end.t === 'obj' ? curveNumber(end.fields, 'y', 1) : 1
      if (x < x0) return y0
      if (x > x1) return y1
      const dx = x1 - x0
      const dy = y1 - y0
      if (dx === 0) return y1
      if (dy === 0) return y0
      const target = (x - x0) / dx
      const w1 = clamp01(curveNumber(fields, 'startWeight', 1 / 3))
      const w2 = clamp01(curveNumber(fields, 'endWeight', 1 / 3))
      // Slopes are dy/dx; the Unity solver works in normalised units.
      const m1 = (curveNumber(fields, 'startTangent', 0) * dx) / dy
      const m2 = (curveNumber(fields, 'endTangent', 0) * dx) / dy
      const classic = Math.abs(w1 - 1 / 3) < 1e-9 && Math.abs(w2 - 1 / 3) < 1e-9
      const u = classic ? target : solveHermiteParameter(target, w1, w2)
      const oneMinus = 1 - u
      const cubic =
        3 * oneMinus * oneMinus * u * w1 * m1 +
        3 * oneMinus * u * u * (1 - w2 * m2) +
        u * u * u
      return y0 + dy * cubic
    }
    // First piece whose [startX,endX] contains x (open by default); else 0.
    case 'PiecewiseFunctionCurve':
    case 'PiecewiseCurve': {
      const list = fields.functionPieces
      const items = list && list.t === 'arr' && Array.isArray(list.items) ? list.items : []
      for (const item of items) {
        if (!isPlainObject(item) || item.t !== 'obj') continue
        const pieceFields = isPlainObject(item.fields) ? item.fields : {}
        const startX = valueAsNumber(pieceFields.startX)
        const endX = valueAsNumber(pieceFields.endX)
        const leftClosed = pieceFields.leftClosed === true
        const rightClosed = pieceFields.rightClosed === true
        const afterStart = startX === null ? true : leftClosed ? x >= startX : x > startX
        const beforeEnd = endX === null ? true : rightClosed ? x <= endX : x < endX
        if (afterStart && beforeEnd) {
          const inner = sample(pieceFields.functionCurve, x)
          return inner === null ? 0 : inner
        }
      }
      return 0
    }
    case 'AxialSymmetricFunctionCurve': {
      const axis = curveNumber(fields, 'axis', 0)
      const keepLeft = fields.keepLeft === true
      const mirrored = keepLeft ? (x <= axis ? x : 2 * axis - x) : x >= axis ? x : 2 * axis - x
      const inner = sample(fields.functionCurve, mirrored)
      return inner === null ? 0 : inner
    }
    // Period = endX-startX; wrap x into [startX, endX) then evaluate.
    case 'PeriodicFunctionCurve': {
      const startX = curveNumber(fields, 'startX', 0)
      const endX = curveNumber(fields, 'endX', 0)
      const period = endX - startX
      if (!(period > 0)) {
        const inner = sample(fields.functionCurve, x)
        return inner === null ? 0 : inner
      }
      let phase = startX + (((x - startX) % period) + period) % period
      // `leftClosed` decides which side owns the boundary.
      if (phase === startX && fields.leftClosed !== true) phase = endX - 1e-9
      const inner = sample(fields.functionCurve, phase)
      return inner === null ? 0 : inner
    }
    case 'AdditionFunctionCurve': {
      const first = sample(fields.firstFunctionCurve, x)
      const second = sample(fields.secondFunctionCurve, x)
      if (first === null && second === null) return 0
      return (first === null ? 0 : first) + (second === null ? 0 : second)
    }
    case 'CompositeFunctionCurve': {
      const inner = sample(fields.innerFunctionCurve, x)
      if (inner === null) return 0
      const outer = sample(fields.outerFunctionCurve, inner)
      return outer === null ? 0 : outer
    }
    // Engine: null/empty stops => Color.white; null progress => first stop.
    case 'LerpColorCurve': {
      const points = fields.colorPoints
      const items = points && points.t === 'arr' && Array.isArray(points.items) ? points.items : []
      const usable = items.filter((item) => isPlainObject(item) && item.t === 'obj')
      if (usable.length === 0) return Object.assign({}, WHITE)
      const progressCurve = fields.progressCurve
      if (progressCurve === undefined || progressCurve === null) return colorFromValue(usable[0])
      const sampled = sample(progressCurve, x)
      const progress = typeof sampled === 'number' && Number.isFinite(sampled) ? sampled : 0
      const i1 = Math.max(0, Math.min(usable.length - 1, Math.floor(progress)))
      const i2 = Math.max(0, Math.min(usable.length - 1, Math.ceil(progress)))
      const t = progress - i1
      return lerpColorObject(colorFromValue(usable[i1]), colorFromValue(usable[i2]), t)
    }
    // VariableFloat: value = baseValue + variationCurve(t); null curve => base.
    case 'VariableFloat': {
      const base = curveNumber(fields, 'baseValue', 0)
      const variation = sample(fields.variationCurve, x)
      return variation === null ? base : base + variation
    }
    default:
      return null
  }
}

// ===========================================================================
// 4. Timing + element construction
// ===========================================================================

/** Engine-declared numeric default of one catalog field (or null). */
function catalogFieldDefault(entry, fieldName) {
  if (!entry || !fieldName || !Array.isArray(entry.fields)) return null
  for (const field of entry.fields) {
    if (field.name !== fieldName) continue
    return typeof field.default === 'number' && Number.isFinite(field.default) ? field.default : null
  }
  return null
}

/** Numeric relative start field name for an element (catalog first, then fallbacks). */
function startFieldName(entry, fields) {
  const timingSpec = (entry && entry.timing) || {}
  const candidates = [timingSpec.start, 'hitTime', 'startMoment', 'generateTime']
  for (const name of candidates) {
    if (name && isPlainObject(fields) && name in fields && valueAsNumber(fields[name]) !== null) return name
  }
  return timingSpec.start || null
}

/** Numeric duration field name for an element (catalog first, then fallbacks). */
function durationFieldName(entry, fields) {
  const timingSpec = (entry && entry.timing) || {}
  const candidates = [timingSpec.duration, 'keepTime', 'holdTime']
  for (const name of candidates) {
    if (name && isPlainObject(fields) && name in fields && valueAsNumber(fields[name]) !== null) return name
  }
  return timingSpec.duration || null
}

/**
 * Absolute timing of one element inside its period.
 *
 * @param {{type?:string, fields?:object}} element  wire element or any object
 *        with `{ type, fields }`.
 * @param {{timeOffset?:number}|number} [period]  owning period (or a raw
 *        timeOffset number).
 * @param {{parentStart?:number}} [options]  `parentStart` overrides the period
 *        offset for parent-relative elements (`Dremu.DremuHoldInnerNote`).
 * @returns {{start:number, duration:number|null, lane:string|null, category:string}}
 *          absolute start/duration in seconds (rounded to 1e-6), the lane name
 *          (`laneName` for notes, `name` for lanes) and the catalog category.
 *          A missing timing field falls back to the engine default (lane
 *          `keepTime` 10.0, hold `holdTime` 1.0, image `keepTime` 1.0); notes
 *          have no duration (`null`).
 */
export function elementTiming(element, period, options = {}) {
  const entry = catalogEntry(element && element.type)
  const fields = element && isPlainObject(element.fields) ? element.fields : {}
  const periodOffset =
    typeof options === 'number'
      ? options
      : options && typeof options.parentStart === 'number' && Number.isFinite(options.parentStart)
        ? options.parentStart
        : typeof period === 'number'
          ? period
          : period && Number.isFinite(period.timeOffset)
            ? period.timeOffset
            : 0
  const startField = startFieldName(entry, fields)
  const rawStart = startField ? valueAsNumber(fields[startField]) : null
  const localStart = typeof rawStart === 'number' && Number.isFinite(rawStart) ? rawStart : 0
  const durationField = durationFieldName(entry, fields)
  let rawDuration = durationField ? valueAsNumber(fields[durationField]) : null
  if (rawDuration === null && durationField) {
    // The field is absent: fall back to the engine's declared default (e.g.
    // lane `keepTime` 10.0, hold `holdTime` 1.0, image `keepTime` 1.0).
    rawDuration = catalogFieldDefault(entry, durationField)
  }
  const duration =
    typeof rawDuration === 'number' && Number.isFinite(rawDuration) && rawDuration >= 0 ? round6(rawDuration) : null
  const laneField = (entry && entry.timing && entry.timing.lane) || 'laneName'
  const lane = laneField ? fieldString(fields, laneField) : null
  return {
    start: round6(periodOffset + localStart),
    duration,
    lane,
    category: (entry && entry.category) || 'other',
  }
}

/**
 * Create a new element value node with catalog defaults.
 *
 * @param {string} type  element type (qualified or short, e.g. `Dremu.DremuTap`
 *        or `DremuTap`).
 * @param {{start?:number, duration?:number, lane?:string, fields?:object}} [options]
 *        `start`/`duration` are values for the timing fields (period-RELATIVE,
 *        i.e. the same space as `hitTime`/`generateTime`); `lane` fills the
 *        catalog's lane field (`laneName` for notes, `name` for lanes);
 *        `fields` shallow-overlays extra values.
 * @returns {{t:'obj', type:string, fields:object}} a typed value node ready to
 *          be pushed into a period's chart array / merged by `add` ops.
 * @throws {Error} when `type` is not a known catalog element type.
 */
export function createElement(type, options = {}) {
  const entry = catalogEntry(type)
  if (!entry) throw new Error(`unknown element type "${String(type)}" (known: ${CATALOG.palettes.allTypes.join(', ')})`)
  const timingSpec = entry.timing || {}
  const fields = {}
  for (const field of entry.fields) {
    if (field.default !== undefined) fields[field.name] = cloneValue(field.default)
  }
  const opts = isPlainObject(options) ? options : {}
  if (timingSpec.start) {
    if (typeof opts.start === 'number' && Number.isFinite(opts.start)) fields[timingSpec.start] = round6(opts.start)
    else if (fields[timingSpec.start] === undefined) fields[timingSpec.start] = 0
  }
  if (timingSpec.duration && typeof opts.duration === 'number' && Number.isFinite(opts.duration)) {
    fields[timingSpec.duration] = Math.max(0, round6(opts.duration))
  }
  if (timingSpec.lane && typeof opts.lane === 'string' && opts.lane.length > 0) fields[timingSpec.lane] = opts.lane
  if (timingSpec.duration && fields[timingSpec.duration] === undefined) fields[timingSpec.duration] = 0
  if (isPlainObject(opts.fields)) {
    for (const key of Object.keys(opts.fields)) fields[key] = cloneValue(opts.fields[key])
  }
  return { t: 'obj', type: entry.type, fields }
}

// ===========================================================================
// 5. Staff-file inspection helpers (heterogeneous type spellings, config attrs)
// ===========================================================================

/** Find a header entry (`[' string form = "Dremu", ... ]`) by name. */
function headerValue(staffFile, name) {
  if (!staffFile || !Array.isArray(staffFile.header)) return null
  const entry = staffFile.header.find((item) => item && item.name === name)
  return entry ? entry.value : null
}

/** Period config object fields from a member's attr block, or null. */
function periodConfigValue(member) {
  const attr = member && Array.isArray(member.attr) ? member.attr : null
  if (!attr) return null
  for (const entry of attr) {
    if (!entry || typeof entry.type !== 'string') continue
    if (bareTypeName(entry.type) !== 'PeriodConfig') continue
    if (entry.value && entry.value.t === 'obj') return entry.value
  }
  return null
}

/** `timeOffset` / `minLength` of one `@Chart` member. */
function readPeriodConfig(member) {
  const config = periodConfigValue(member)
  const fields = config && isPlainObject(config.fields) ? config.fields : {}
  const timeOffset = finiteNumber(fields.timeOffset)
  const minLength = finiteNumber(fields.minLength)
  return { timeOffset: timeOffset === null ? 0 : timeOffset, minLength }
}

/** Find the `@Song` member return value (audio asset) of an audio staff. */
function songMember(staffFile) {
  if (!staffFile || !Array.isArray(staffFile.members)) return null
  for (const member of staffFile.members) {
    if (!member || member.annotation !== 'Song') continue
    if (member.returnValue && member.returnValue.t === 'obj') return member
  }
  return null
}

/**
 * Preferred type spelling for a staff: use the short form when the file has
 * `using` directives (Chart 4 style), otherwise the qualified form (the style
 * of every other corpus staff). Existing elements keep the spelling they were
 * parsed with; this only affects newly created nodes.
 */
function preferredTypeName(staff, canonical) {
  const usings = staff && staff._staffFile && Array.isArray(staff._staffFile.usings) ? staff._staffFile.usings : []
  return usings.length > 0 ? shortType(canonical) : canonical
}

/** Map a parsed raw type string to the catalog canonical type (raw when unknown). */
function normalizeElementType(rawType) {
  const entry = catalogEntry(rawType)
  return entry ? entry.type : typeof rawType === 'string' ? rawType : 'Unknown'
}

// ===========================================================================
// 6. Project load
// ===========================================================================

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.svg', '.tga'])
const AUDIO_EXTENSIONS = new Set(['.wav', '.mp3', '.ogg', '.m4a', '.aac', '.flac', '.opus'])

/** Empty project shell used by loadProject/createEmptyProject. */
function makeProjectShell(dir, title) {
  return {
    dir,
    id: dir,
    title: typeof title === 'string' && title.length > 0 ? title : path.basename(dir) || 'Untitled',
    form: 'Dremu',
    tempo: { bpm: 120, offset: 0 },
    audio: null,
    assets: { images: [], audio: [] },
    staffs: [],
    warnings: [],
    dirty: false,
    // Internal, non-wire state:
    _backups: new Set(),
    _new: false,
  }
}

/** Build one internal staff model from a parsed StaffFile. */
function buildStaff(project, dir, fileName, staffFile, originalText, warnings) {
  const form = typeof headerValue(staffFile, 'form') === 'string' ? headerValue(staffFile, 'form') : ''
  const displayNameRaw = headerValue(staffFile, 'displayName')
  const displayName = typeof displayNameRaw === 'string' && displayNameRaw.length > 0 ? displayNameRaw : staffFile.className
  const annotations = Array.isArray(staffFile.annotations) ? staffFile.annotations : []
  const members = Array.isArray(staffFile.members) ? staffFile.members : []
  const hasSong = members.some((member) => member && member.annotation === 'Song')
  const chartMembers = members.filter((member) => member && member.annotation === 'Chart' && member.chartArray)
  let kind = 'other'
  if (annotations.indexOf('AudioStaff') !== -1 || hasSong) kind = 'audio'
  else if (form === 'DeentyStoryboard') kind = 'storyboard'
  else if (annotations.indexOf('ElementStaff') !== -1 || chartMembers.length > 0) kind = 'chart'

  const staff = {
    id: fileName,
    file: path.join(dir, fileName),
    kind,
    form,
    displayName,
    className: staffFile.className,
    periods: [],
    _staffFile: staffFile,
    _origText: originalText,
    _new: false,
  }

  // Audio staffs expose their @Song asset; charts/storyboards expose periods.
  const song = kind === 'audio' ? songMember(staffFile) : null
  if (song) {
    const asset = song.returnValue
    const assetFields = isPlainObject(asset.fields) ? asset.fields : {}
    const config = readPeriodConfig(song)
    staff._song = {
      name: typeof assetFields.name === 'string' && assetFields.name.length > 0 ? assetFields.name : staffFile.className,
      assetType: asset.type,
      offset: config.timeOffset,
      relativePath: findAudioFilePath(assetFields),
    }
  }

  // Periods: sorted by absolute start time (file order breaks ties).
  const unknownTypes = new Set()
  const periods = chartMembers.map((member, fileIndex) => {
    const config = readPeriodConfig(member)
    const period = {
      id: '',
      method: member.name,
      timeOffset: config.timeOffset,
      minLength: config.minLength,
      elements: [],
      _member: member,
    }
    const items = Array.isArray(member.chartArray.items) ? member.chartArray.items : []
    items.forEach((value, arrayIndex) => {
      if (!isPlainObject(value) || value.t !== 'obj') return
      const rawType = typeof value.type === 'string' ? value.type : 'Unknown'
      const type = normalizeElementType(rawType)
      if (!catalogEntry(type) && !unknownTypes.has(rawType)) {
        unknownTypes.add(rawType)
        warnings.push(`${fileName}: unknown element type "${rawType}" kept verbatim`)
      }
      const element = {
        id: '',
        type,
        rawType,
        fields: isPlainObject(value.fields) ? value.fields : {},
        start: 0,
        duration: null,
        lane: null,
        category: 'other',
        _value: value,
        _arrayIndex: arrayIndex,
      }
      period.elements.push(element)
    })
    return { period, fileIndex }
  })
  periods.sort((a, b) => {
    if (a.period.timeOffset !== b.period.timeOffset) return a.period.timeOffset - b.period.timeOffset
    return a.fileIndex - b.fileIndex
  })
  periods.forEach((item, periodIndex) => {
    const period = item.period
    period.id = 'p' + periodIndex
    for (const element of period.elements) {
      element.id = `${fileName}:${period.id}:e${element._arrayIndex}`
      refreshElement(element, period)
    }
    staff.periods.push(period)
  })
  return staff
}

/** First string field whose name looks like an audio file path. */
function findAudioFilePath(assetFields) {
  if (!isPlainObject(assetFields)) return null
  for (const key of Object.keys(assetFields)) {
    if (/FilePath$/i.test(key) && typeof assetFields[key] === 'string' && assetFields[key].length > 0) return assetFields[key]
  }
  for (const key of ['wavFilePath', 'mp3FilePath', 'filePath', 'path']) {
    if (typeof assetFields[key] === 'string' && assetFields[key].length > 0) return assetFields[key]
  }
  return null
}

/** Recompute derived timing fields of one element from its fields tree. */
function refreshElement(element, period) {
  const value = element._value
  if (value && value.t === 'obj' && isPlainObject(value.fields)) element.fields = value.fields
  const derived = elementTiming(element, period)
  element.start = derived.start
  element.duration = derived.duration
  element.lane = derived.lane
  element.category = derived.category
  return element
}

/** Recompute `project.duration` = max(last element end, audio duration + audio offset). */
function refreshDuration(project) {
  let lastEnd = 0
  for (const staff of project.staffs || []) {
    for (const period of staff.periods || []) {
      for (const element of period.elements || []) {
        const end = (element.start || 0) + (element.duration || 0)
        if (Number.isFinite(end) && end > lastEnd) lastEnd = end
      }
    }
  }
  const audio = project.audio
  const audioEnd = audio && typeof audio.duration === 'number' && Number.isFinite(audio.duration) ? audio.duration + (Number.isFinite(audio.offset) ? audio.offset : 0) : 0
  project.duration = round6(Math.max(lastEnd, audioEnd, 0))
  return project.duration
}

/**
 * Read one chart project directory.
 *
 * Reads every top-level `*.g` (one staff per file) plus the asset inventory and
 * the audio staff's `@Song` asset. Never throws: unreadable/unparsable files are
 * reported in `project.warnings` and simply not represented in the model (so
 * they are never rewritten by `saveProject` either).
 *
 * @param {string} dir  absolute project directory.
 * @returns {object} internal Project model (pass to `projectToWire` etc.).
 */
export function loadProject(dir) {
  const absDir = path.resolve(String(dir === undefined || dir === null || dir === '' ? '.' : dir))
  const project = makeProjectShell(absDir, path.basename(absDir))
  let entries = []
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true })
  } catch (error) {
    project.warnings.push(`cannot read project directory ${absDir}: ${messageOf(error)}`)
    return project
  }

  const staffFiles = entries
    .filter((entry) => entry.isFile() && /\.g$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))

  for (const fileName of staffFiles) {
    const file = path.join(absDir, fileName)
    try {
      const text = fs.readFileSync(file, 'utf8')
      const staffFile = parseGorgeFile(text)
      project.staffs.push(buildStaff(project, absDir, fileName, staffFile, text, project.warnings))
    } catch (error) {
      project.warnings.push(`cannot parse ${fileName}: ${messageOf(error)}`)
    }
  }
  if (staffFiles.length === 0) project.warnings.push('no .g staff files found in the project directory')

  // Asset inventory (top-level files, excluding staff files).
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const extension = path.extname(entry.name).toLowerCase()
    if (extension === '.g') continue
    if (IMAGE_EXTENSIONS.has(extension)) project.assets.images.push(entry.name)
    else if (AUDIO_EXTENSIONS.has(extension)) project.assets.audio.push(entry.name)
  }
  project.assets.images.sort()
  project.assets.audio.sort()

  // Audio staff -> project.audio.
  const audioStaffs = project.staffs.filter((staff) => staff.kind === 'audio' && staff._song)
  if (audioStaffs.length > 1) project.warnings.push(`multiple audio staffs found; using "${audioStaffs[0].id}"`)
  const audioStaff = audioStaffs[0] || null
  if (audioStaff) {
    const song = audioStaff._song
    let file = song.relativePath ? path.resolve(absDir, song.relativePath) : null
    let duration = null
    let sampleRate = null
    let channels = null
    let format = null
    if (!file) {
      project.warnings.push(`audio staff "${audioStaff.id}" declares no audio file path`)
    } else if (!isPathInside(file, absDir)) {
      // Keep the absolute path (the client can still ask for it), but warn.
      project.warnings.push(`audio file "${song.relativePath}" is outside the project directory`)
    }
    if (file && !fs.existsSync(file)) {
      project.warnings.push(`audio file not found: ${song.relativePath}`)
    } else if (file) {
      const probe = probeAudioFile(file)
      duration = probe.duration
      sampleRate = probe.sampleRate
      channels = probe.channels
      format = probe.format
      if (duration === null) project.warnings.push(`cannot read audio duration: ${song.relativePath}`)
    }
    project.audio = {
      file: file || '',
      name: song.name,
      duration: typeof duration === 'number' && Number.isFinite(duration) ? round6(duration) : null,
      offset: Number.isFinite(song.offset) ? round6(song.offset) : 0,
    }
    if (sampleRate !== null || channels !== null || format !== null) {
      // Extra hints for the UI (ignored by the wire consumers that only need file/name/duration/offset).
      project.audio.sampleRate = sampleRate
      project.audio.channels = channels
      project.audio.format = format
    }
  }

  // Project form: prefer a chart staff, then a storyboard, then Dremu.
  const chartForm = project.staffs.find((staff) => (staff.kind === 'chart' || staff.kind === 'other') && staff.form) || null
  const storyboardForm = project.staffs.find((staff) => staff.kind === 'storyboard' && staff.form) || null
  project.form = (chartForm && chartForm.form) || (storyboardForm && storyboardForm.form) || 'Dremu'
  project.warnings = project.warnings.slice(0, 100)
  refreshDuration(project)
  return project
}

/** True when `candidate` resolves inside `directory`. */
function isPathInside(candidate, directory) {
  const resolvedDir = path.resolve(directory)
  const resolvedCandidate = path.resolve(candidate)
  return resolvedCandidate === resolvedDir || resolvedCandidate.startsWith(resolvedDir + path.sep)
}

// ===========================================================================
// 7. Wire state
// ===========================================================================

/** Deep-clone an element's field tree for the wire (client may hold it). */
function wireFields(element) {
  return cloneValue(element.fields)
}

/** One wire element (`Element` in CONTRACTS §2). */
function wireElement(element) {
  return {
    id: element.id,
    type: element.type,
    fields: wireFields(element),
    start: element.start,
    duration: element.duration,
    lane: element.lane,
    category: element.category,
  }
}

/** One wire period. */
function wirePeriod(period) {
  return {
    id: period.id,
    method: period.method,
    timeOffset: period.timeOffset,
    minLength: period.minLength,
    elements: (period.elements || []).map(wireElement),
  }
}

/** One wire staff. */
function wireStaff(staff) {
  return {
    id: staff.id,
    file: staff.file,
    kind: staff.kind,
    form: staff.form,
    displayName: staff.displayName,
    className: staff.className,
    periods: (staff.periods || []).map(wirePeriod),
  }
}

/**
 * Build the client-facing wire state.
 *
 * @param {object} project  internal Project model.
 * @param {{rev?:number, dirty?:boolean}} [options]  `rev` is the Host's revision
 *        counter; `dirty` overrides the model's own dirty flag (the Host keeps
 *        the authoritative one).
 * @returns {{rev:number, dirty:boolean, project:object, catalog:object}}
 *          exactly the `WireState` shape of CONTRACTS §2. Treat the result as
 *          read-only; the Host caches it per revision.
 */
export function projectToWire(project, options = {}) {
  const opts = isPlainObject(options) ? options : {}
  const rev = typeof opts.rev === 'number' && Number.isFinite(opts.rev) ? opts.rev : 0
  const dirty = typeof opts.dirty === 'boolean' ? opts.dirty : project && project.dirty === true
  if (!project || typeof project !== 'object') {
    return { rev, dirty, project: null, catalog: CATALOG }
  }
  refreshDuration(project)
  // Exactly the four documented keys ({file,name,duration,offset}); extra probe
  // hints (sampleRate/channels/format) stay on the internal model only.
  const audio = project.audio
    ? {
        file: project.audio.file,
        name: project.audio.name,
        duration: project.audio.duration === null || project.audio.duration === undefined ? null : project.audio.duration,
        offset: Number.isFinite(project.audio.offset) ? project.audio.offset : 0,
      }
    : null
  const wire = {
    dir: project.dir,
    id: project.id,
    title: project.title,
    form: project.form,
    tempo: {
      bpm: project.tempo && Number.isFinite(project.tempo.bpm) ? project.tempo.bpm : 120,
      offset: project.tempo && Number.isFinite(project.tempo.offset) ? project.tempo.offset : 0,
    },
    duration: project.duration,
    audio,
    assets: {
      images: (project.assets && Array.isArray(project.assets.images) ? project.assets.images : []).slice(),
      audio: (project.assets && Array.isArray(project.assets.audio) ? project.assets.audio : []).slice(),
    },
    staffs: (project.staffs || []).map(wireStaff),
    warnings: Array.isArray(project.warnings) ? project.warnings.slice() : [],
  }
  return { rev, dirty, project: wire, catalog: CATALOG }
}

// ===========================================================================
// 8. Mutations (`applyOps`)
// ===========================================================================

/** Project-wide lookup tables, rebuilt after structural edits. */
function buildIndex(project) {
  const byElementId = new Map()
  const staffById = new Map()
  const periodsByStaff = new Map()
  for (const staff of project.staffs || []) {
    staffById.set(staff.id, staff)
    const periods = Array.isArray(staff.periods) ? staff.periods : []
    periodsByStaff.set(staff.id, periods)
    for (const period of periods) {
      for (const element of period.elements || []) byElementId.set(element.id, { staff, period, element })
    }
  }
  return { byElementId, staffById, periodsByStaff }
}

/** Client-compatible period picker: containing period, else nearest by distance. */
function pickPeriod(staff, absoluteTime) {
  const periods = Array.isArray(staff.periods) ? staff.periods : []
  if (periods.length === 0) return null
  const time = Number.isFinite(absoluteTime) ? absoluteTime : 0
  let best = periods[0]
  let bestDistance = Infinity
  for (const period of periods) {
    const offset = Number.isFinite(period.timeOffset) ? period.timeOffset : 0
    const length = Number.isFinite(period.minLength) ? period.minLength : 20
    if (time >= offset && time < offset + length) return period
    const distance = Math.min(Math.abs(time - offset), Math.abs(time - (offset + length)))
    if (distance < bestDistance) {
      bestDistance = distance
      best = period
    }
  }
  return best
}

/** Next free deterministic element id in a staff/period pair. */
function nextElementId(index, staff, period) {
  let maxSuffix = -1
  for (const element of period.elements || []) {
    const match = /:e(\d+)$/.exec(element.id)
    if (match) maxSuffix = Math.max(maxSuffix, Number(match[1]))
  }
  let candidate = maxSuffix + 1
  for (;;) {
    const id = `${staff.id}:${period.id}:e${candidate}`
    if (!index.byElementId.has(id)) return id
    candidate += 1
  }
}

/** Create a new chart period on a staff (used when adding to an empty staff). */
function allocatePeriod(index, project, staff, timeOffset) {
  const staffFile = staff._staffFile
  const methodBase = 'Period'
  let suffix = 1
  const used = new Set((staff.periods || []).map((period) => period.method))
  let method = methodBase
  while (used.has(method)) {
    method = methodBase + String(suffix)
    suffix += 1
  }
  const qualified = (staff._staffFile && staff._staffFile.usings && staff._staffFile.usings.length > 0) ? '' : G
  const configType = qualified + 'PeriodConfig'
  const member = {
    attr: [
      {
        type: configType + '^',
        name: 'config',
        value: { t: 'obj', type: configType, fields: { timeOffset: round6(timeOffset) } },
      },
    ],
    annotation: 'Chart',
    retType: qualified + 'Element^[]',
    name: method,
    chartArray: { elemType: qualified + 'Element', items: [] },
    returnValue: null,
  }
  if (!Array.isArray(staffFile.members)) staffFile.members = []
  staffFile.members.push(member)
  const period = {
    id: 'p' + (staff.periods || []).length,
    method,
    timeOffset: round6(timeOffset),
    minLength: null,
    elements: [],
    _member: member,
  }
  if (!Array.isArray(staff.periods)) staff.periods = []
  staff.periods.push(period)
  index.staffById.set(staff.id, staff)
  index.periodsByStaff.set(staff.id, staff.periods)
  return period
}

/** Resolve a period id, optionally scoped to one staff (period ids repeat per staff). */
function findPeriod(project, index, periodId, staffId) {
  if (typeof staffId === 'string' && staffId.length > 0) {
    const staff = index.staffById.get(staffId)
    if (!staff) return { error: `unknown staff "${staffId}"` }
    const period = (staff.periods || []).find((item) => item.id === periodId)
    return period ? { staff, period } : { error: `unknown period "${periodId}" in staff "${staffId}"` }
  }
  const matches = []
  for (const staff of project.staffs || []) {
    for (const period of staff.periods || []) if (period.id === periodId) matches.push({ staff, period })
  }
  if (matches.length === 0) return { error: `unknown period "${periodId}"` }
  if (matches.length > 1) return { error: `ambiguous period "${periodId}": pass staffId` }
  return matches[0]
}

/** Merge a PeriodConfig attr block into a member's fields. */
function mergePeriodConfig(staff, period, fields) {
  const member = period._member
  if (!member) return { error: 'period has no backing member' }
  if (!Array.isArray(member.attr)) member.attr = []
  const qualified = (staff._staffFile && staff._staffFile.usings && staff._staffFile.usings.length > 0) ? '' : G
  const configType = qualified + 'PeriodConfig'
  let entry = member.attr.find((item) => item && typeof item.type === 'string' && bareTypeName(item.type) === 'PeriodConfig')
  if (!entry) {
    entry = { type: configType + '^', name: 'config', value: { t: 'obj', type: configType, fields: {} } }
    member.attr.push(entry)
  }
  if (!entry.value || entry.value.t !== 'obj' || !isPlainObject(entry.value.fields)) {
    entry.value = { t: 'obj', type: (entry.value && entry.value.type) || configType, fields: {} }
    entry.type = (entry.value.type ? entry.value.type : configType) + '^'
  }
  const target = entry.value.fields
  for (const key of Object.keys(fields)) {
    if (key === 'timeOffset') {
      const number = finiteNumber(fields[key])
      if (number === null) return { error: 'timeOffset must be a finite number' }
      target.timeOffset = round6(number)
      period.timeOffset = round6(number)
    } else if (key === 'minLength') {
      if (fields[key] === null) {
        delete target.minLength
        period.minLength = null
      } else {
        const number = finiteNumber(fields[key])
        if (number === null) return { error: 'minLength must be a finite number or null' }
        target.minLength = round6(number)
        period.minLength = round6(number)
      }
    } else {
      target[key] = cloneValue(fields[key])
    }
  }
  return { ok: true }
}

/** Known keys per op (anything else is tolerated but reported). */
const OP_KEYS = {
  patch: ['op', 'elementId', 'path', 'value'],
  add: ['op', 'staffId', 'periodId', 'element'],
  remove: ['op', 'elementId'],
  duplicate: ['op', 'elementId', 'newId', 'timeShift'],
  setMeta: ['op', 'tempo', 'title'],
  setStaffName: ['op', 'staffId', 'displayName'],
  setPeriodConfig: ['op', 'periodId', 'staffId', 'fields'],
}

function reportUnknownKeys(opName, op, errors, label) {
  const known = OP_KEYS[opName]
  if (!known) return
  for (const key of Object.keys(op)) {
    if (known.indexOf(key) === -1) errors.push(`${label}: unknown key "${key}" for op "${opName}" (ignored)`)
  }
}

/** `patch` op implementation; returns true when applied. */
function applyPatch(project, index, op, errors, label) {
  const elementId = typeof op.elementId === 'string' ? op.elementId : ''
  if (!elementId) {
    errors.push(`${label}: patch requires elementId`)
    return false
  }
  const found = index.byElementId.get(elementId)
  if (!found) {
    errors.push(`${label}: unknown element "${elementId}"`)
    return false
  }
  const element = found.element
  const segments = Array.isArray(op.path) ? op.path.slice() : null
  if (!segments) {
    errors.push(`${label}: patch requires path to be an array`)
    return false
  }
  const validSegment = segments.every((segment) => typeof segment === 'string' || (typeof segment === 'number' && Number.isInteger(segment)))
  if (!validSegment) {
    errors.push(`${label}: patch path segments must be strings or integers`)
    return false
  }
  let nextFields
  if (segments.length === 0) {
    const value = op.value
    if (isPlainObject(value) && value.t === 'obj' && isPlainObject(value.fields)) nextFields = cloneValue(value.fields)
    else if (isPlainObject(value)) nextFields = cloneValue(value)
    else {
      errors.push(`${label}: patch with empty path requires a fields object`)
      return false
    }
  } else {
    const parent = getAtPath(element.fields, segments.slice(0, -1))
    if (parent === undefined) {
      errors.push(`${label}: patch path not found: ${segments.join('.')}`)
      return false
    }
    nextFields = setAtPath(element.fields, segments, op.value)
  }
  if (!isPlainObject(nextFields)) {
    errors.push(`${label}: patched fields is not an object`)
    return false
  }
  element.fields = nextFields
  if (element._value && element._value.t === 'obj') element._value.fields = nextFields
  refreshElement(element, found.period)
  return true
}

/** `add` op implementation; returns the created descriptor or null. */
function applyAdd(project, index, op, errors, label) {
  const staffId = typeof op.staffId === 'string' ? op.staffId : ''
  if (!staffId) {
    errors.push(`${label}: add requires staffId`)
    return null
  }
  const staff = index.staffById.get(staffId)
  if (!staff) {
    errors.push(`${label}: unknown staff "${staffId}"`)
    return null
  }
  const spec = isPlainObject(op.element) ? op.element : null
  if (!spec) {
    errors.push(`${label}: add requires element { type, fields }`)
    return null
  }
  for (const key of Object.keys(spec)) {
    if (['id', 'type', 'fields', 'start'].indexOf(key) === -1) errors.push(`${label}: unknown element key "${key}" (ignored)`)
  }
  const entry = catalogEntry(spec.type)
  if (!entry) {
    errors.push(`${label}: unknown element type "${String(spec.type)}"`)
    return null
  }
  const absoluteStart = typeof spec.start === 'number' && Number.isFinite(spec.start) ? spec.start : null
  let period = null
  const requestedPeriodId = typeof op.periodId === 'string' && op.periodId.length > 0 ? op.periodId : null
  if (requestedPeriodId) {
    period = (staff.periods || []).find((item) => item.id === requestedPeriodId) || null
    if (!period) {
      errors.push(`${label}: unknown period "${requestedPeriodId}" in staff "${staffId}"`)
      return null
    }
  } else {
    if ((staff.periods || []).length === 0) period = allocatePeriod(index, project, staff, absoluteStart === null ? 0 : absoluteStart)
    else period = pickPeriod(staff, absoluteStart === null ? 0 : absoluteStart)
  }
  if (!period) {
    errors.push(`${label}: staff "${staffId}" has no usable period`)
    return null
  }
  const timingSpec = entry.timing || {}
  const fields = createElement(entry.type, {}).fields
  const provided = isPlainObject(spec.fields) ? spec.fields : {}
  const knownNames = new Set(entry.fields.map((field) => field.name))
  for (const key of Object.keys(provided)) {
    if (!knownNames.has(key)) errors.push(`${label}: unknown field "${key}" for ${entry.type} (kept)`)
    fields[key] = cloneValue(provided[key])
  }
  // When no period was named, `element.start` is the ABSOLUTE placement time:
  // it selected the period, so translate it into the period-relative field
  // (unless the caller explicitly supplied that timing field already).
  const hasProvidedStart = timingSpec.start && Object.prototype.hasOwnProperty.call(provided, timingSpec.start)
  if (absoluteStart !== null && !requestedPeriodId && timingSpec.start && !hasProvidedStart) {
    fields[timingSpec.start] = round6(absoluteStart - period.timeOffset)
  }
  let elementId = typeof spec.id === 'string' && spec.id.trim().length > 0 ? spec.id.trim() : null
  if (elementId !== null && index.byElementId.has(elementId)) {
    errors.push(`${label}: element id "${elementId}" already exists; generated a new one`)
    elementId = null
  }
  if (elementId === null) elementId = nextElementId(index, staff, period)
  const value = { t: 'obj', type: preferredTypeName(staff, entry.type), fields }
  const itemIndex = period._member.chartArray.items.length
  period._member.chartArray.items.push(value)
  const element = {
    id: elementId,
    type: entry.type,
    rawType: value.type,
    fields,
    start: 0,
    duration: null,
    lane: null,
    category: entry.category,
    _value: value,
    _arrayIndex: itemIndex,
  }
  refreshElement(element, period)
  period.elements.push(element)
  index.byElementId.set(elementId, { staff, period, element })
  return { elementId, staffId: staff.id, periodId: period.id }
}

/** `remove` op implementation. */
function applyRemove(project, index, op, errors, label) {
  const elementId = typeof op.elementId === 'string' ? op.elementId : ''
  if (!elementId) {
    errors.push(`${label}: remove requires elementId`)
    return false
  }
  const found = index.byElementId.get(elementId)
  if (!found) {
    errors.push(`${label}: unknown element "${elementId}"`)
    return false
  }
  const { staff, period, element } = found
  const elementIndex = (period.elements || []).indexOf(element)
  if (elementIndex !== -1) period.elements.splice(elementIndex, 1)
  const items = period._member && period._member.chartArray ? period._member.chartArray.items : null
  if (Array.isArray(items)) {
    const itemIndex = items.indexOf(element._value)
    if (itemIndex !== -1) items.splice(itemIndex, 1)
  }
  index.byElementId.delete(elementId)
  void staff
  return true
}

/** `duplicate` op implementation. */
function applyDuplicate(project, index, op, errors, label) {
  const elementId = typeof op.elementId === 'string' ? op.elementId : ''
  if (!elementId) {
    errors.push(`${label}: duplicate requires elementId`)
    return null
  }
  const found = index.byElementId.get(elementId)
  if (!found) {
    errors.push(`${label}: unknown element "${elementId}"`)
    return null
  }
  const timeShift = typeof op.timeShift === 'number' && Number.isFinite(op.timeShift) ? op.timeShift : 0
  const { staff, period, element } = found
  const value = cloneValue(element._value)
  if (!isPlainObject(value) || value.t !== 'obj') {
    errors.push(`${label}: element "${elementId}" has no value tree to duplicate`)
    return null
  }
  value.fields = isPlainObject(value.fields) ? value.fields : {}
  const entry = catalogEntry(element.type)
  const timingSpec = (entry && entry.timing) || {}
  if (timeShift !== 0 && timingSpec.start && timingSpec.start in value.fields) {
    const current = valueAsNumber(value.fields[timingSpec.start])
    if (current !== null) value.fields[timingSpec.start] = round6(current + timeShift)
  }
  let newId = typeof op.newId === 'string' && op.newId.trim().length > 0 ? op.newId.trim() : null
  if (newId !== null && index.byElementId.has(newId)) {
    errors.push(`${label}: element id "${newId}" already exists; generated a new one`)
    newId = null
  }
  if (newId === null) newId = nextElementId(index, staff, period)
  const items = period._member.chartArray.items
  const originalItemIndex = items.indexOf(element._value)
  const insertAt = originalItemIndex === -1 ? items.length : originalItemIndex + 1
  items.splice(insertAt, 0, value)
  const clone = {
    id: newId,
    type: element.type,
    rawType: value.type,
    fields: value.fields,
    start: 0,
    duration: null,
    lane: null,
    category: element.category,
    _value: value,
    _arrayIndex: insertAt,
  }
  refreshElement(clone, period)
  const elementIndex = (period.elements || []).indexOf(element)
  if (elementIndex === -1) period.elements.push(clone)
  else period.elements.splice(elementIndex + 1, 0, clone)
  index.byElementId.set(newId, { staff, period, element: clone })
  return { elementId: newId, staffId: staff.id, periodId: period.id }
}

/** `setMeta` op implementation. */
function applySetMeta(project, op, errors, label) {
  let applied = false
  if (op.tempo !== undefined) {
    if (!isPlainObject(op.tempo)) {
      errors.push(`${label}: setMeta.tempo must be an object`)
    } else {
      const next = { bpm: project.tempo && Number.isFinite(project.tempo.bpm) ? project.tempo.bpm : 120, offset: project.tempo && Number.isFinite(project.tempo.offset) ? project.tempo.offset : 0 }
      if (op.tempo.bpm !== undefined) {
        if (typeof op.tempo.bpm === 'number' && Number.isFinite(op.tempo.bpm) && op.tempo.bpm > 0) next.bpm = op.tempo.bpm
        else errors.push(`${label}: tempo.bpm must be a positive number`)
      }
      if (op.tempo.offset !== undefined) {
        if (typeof op.tempo.offset === 'number' && Number.isFinite(op.tempo.offset)) next.offset = op.tempo.offset
        else errors.push(`${label}: tempo.offset must be a finite number`)
      }
      project.tempo = next
      applied = true
    }
  }
  if (op.title !== undefined) {
    if (typeof op.title === 'string') {
      project.title = op.title
      applied = true
    } else errors.push(`${label}: setMeta.title must be a string`)
  }
  return applied
}

/** `setStaffName` op implementation. */
function applySetStaffName(project, index, op, errors, label) {
  const staffId = typeof op.staffId === 'string' ? op.staffId : ''
  if (!staffId) {
    errors.push(`${label}: setStaffName requires staffId`)
    return false
  }
  const staff = index.staffById.get(staffId)
  if (!staff) {
    errors.push(`${label}: unknown staff "${staffId}"`)
    return false
  }
  if (typeof op.displayName !== 'string') {
    errors.push(`${label}: setStaffName requires displayName string`)
    return false
  }
  staff.displayName = op.displayName
  const staffFile = staff._staffFile
  if (!Array.isArray(staffFile.header)) staffFile.header = []
  let entry = staffFile.header.find((item) => item && item.name === 'displayName')
  if (!entry) {
    entry = { type: 'string', name: 'displayName', value: op.displayName }
    staffFile.header.push(entry)
  } else entry.value = op.displayName
  return true
}

/** `setPeriodConfig` op implementation. */
function applySetPeriodConfig(project, index, op, errors, label) {
  const periodId = typeof op.periodId === 'string' ? op.periodId : ''
  if (!periodId) {
    errors.push(`${label}: setPeriodConfig requires periodId`)
    return false
  }
  if (!isPlainObject(op.fields)) {
    errors.push(`${label}: setPeriodConfig requires a fields object`)
    return false
  }
  const resolved = findPeriod(project, index, periodId, typeof op.staffId === 'string' ? op.staffId : '')
  if (resolved.error) {
    errors.push(`${label}: ${resolved.error}`)
    return false
  }
  const known = new Set(['timeOffset', 'minLength'])
  for (const key of Object.keys(op.fields)) {
    if (!known.has(key)) errors.push(`${label}: unknown PeriodConfig field "${key}" (kept)`)
  }
  const result = mergePeriodConfig(resolved.staff, resolved.period, op.fields)
  if (result.error) {
    errors.push(`${label}: ${result.error}`)
    return false
  }
  for (const element of resolved.period.elements || []) refreshElement(element, resolved.period)
  return true
}

/**
 * Apply an ordered batch of edit operations to a project, in place.
 *
 * Total function: never throws for malformed ops. Each op is applied
 * atomically (validate first, mutate second); failing ops are reported in
 * `errors` and skipped while the successfully applied prefix is kept.
 *
 * @param {object} project  internal Project model from `loadProject`.
 * @param {object[]} ops    op list, see the module header / CONTRACTS §3.
 * @returns {{changed:boolean, errors:string[], created:{elementId:string,staffId:string,periodId:string}[]}}
 *          `changed` is true when at least one op applied; `created` lists the
 *          ids of elements created by `add`/`duplicate` so the client can
 *          reconcile optimistic edits.
 */
export function applyOps(project, ops) {
  const errors = []
  const created = []
  if (!project || typeof project !== 'object') return { changed: false, errors: ['no project'], created }
  if (!Array.isArray(ops)) return { changed: false, errors: ['ops must be an array'], created }
  let index = buildIndex(project)
  let changed = false
  let structureDirty = false
  for (let i = 0; i < ops.length; i += 1) {
    const label = `ops[${i}]`
    const op = ops[i]
    if (!isPlainObject(op)) {
      errors.push(`${label}: op must be an object`)
      continue
    }
    const opName = typeof op.op === 'string' ? op.op : ''
    if (!opName) {
      errors.push(`${label}: missing op name`)
      continue
    }
    if (structureDirty) {
      index = buildIndex(project)
      structureDirty = false
    }
    try {
      let applied = false
      switch (opName) {
        case 'patch':
          reportUnknownKeys(opName, op, errors, label)
          applied = applyPatch(project, index, op, errors, label)
          break
        case 'add': {
          reportUnknownKeys(opName, op, errors, label)
          const made = applyAdd(project, index, op, errors, label)
          if (made) {
            created.push(made)
            applied = true
            structureDirty = true
          }
          break
        }
        case 'remove':
          reportUnknownKeys(opName, op, errors, label)
          applied = applyRemove(project, index, op, errors, label)
          if (applied) structureDirty = true
          break
        case 'duplicate': {
          reportUnknownKeys(opName, op, errors, label)
          const made = applyDuplicate(project, index, op, errors, label)
          if (made) {
            created.push(made)
            applied = true
            structureDirty = true
          }
          break
        }
        case 'setMeta':
          reportUnknownKeys(opName, op, errors, label)
          applied = applySetMeta(project, op, errors, label)
          break
        case 'setStaffName':
          reportUnknownKeys(opName, op, errors, label)
          applied = applySetStaffName(project, index, op, errors, label)
          break
        case 'setPeriodConfig':
          reportUnknownKeys(opName, op, errors, label)
          applied = applySetPeriodConfig(project, index, op, errors, label)
          break
        default:
          errors.push(`${label}: unsupported op "${opName}"`)
          continue
      }
      if (applied) changed = true
    } catch (error) {
      errors.push(`${label}: ${messageOf(error)}`)
    }
  }
  if (changed) {
    project.dirty = true
    refreshDuration(project)
  }
  return { changed, errors, created }
}

// ===========================================================================
// 9. Save (atomic, .bak, changed files only)
// ===========================================================================

/** Unique temp filename in the target directory (same filesystem => rename is atomic). */
function tempPathFor(file) {
  const dir = path.dirname(file)
  const base = path.basename(file)
  const unique = `${process.pid.toString(36)}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  return path.join(dir, `.${base}.${unique}.tmp`)
}

/**
 * Write changed staff files back to disk.
 *
 * Only staffs whose canonical serialisation differs from the text that was
 * loaded are written (pass `{ force: true }` to rewrite all). Writes are atomic
 * (temp file + rename in the same directory). The first write to an existing
 * file per session preserves a `<file>.g.bak` copy of the bytes that were on
 * disk before the session edited it. Files that fail to serialise/write are
 * reported and left untouched, so a bad edit never loses chart data.
 *
 * @param {object} project  internal Project model.
 * @param {{force?:boolean, backup?:boolean}} [options]  `force` rewrites every
 *        staff (tests / explicit "save as"), `backup` (default true) toggles the
 *        `.bak` copy.
 * @returns {{written:string[], errors:string[]}} absolute paths written and
 *          human-readable failures. `project.dirty` is cleared when no error
 *          occurred.
 */
export function saveProject(project, options = {}) {
  const written = []
  const errors = []
  if (!project || typeof project !== 'object') return { written, errors: ['no project'] }
  const opts = isPlainObject(options) ? options : {}
  const force = opts.force === true
  const backup = opts.backup !== false
  const projectDir = path.resolve(project.dir || '.')
  if (!project._backups || typeof project._backups.has !== 'function') project._backups = new Set()
  try {
    fs.mkdirSync(projectDir, { recursive: true })
  } catch (error) {
    return { written, errors: [`cannot create project directory: ${messageOf(error)}`] }
  }
  for (const staff of project.staffs || []) {
    if (!staff || !staff._staffFile) continue
    const target = path.resolve(staff.file || path.join(projectDir, staff.id))
    if (!isPathInside(target, projectDir)) {
      errors.push(`${staff.id}: refusing to write outside the project directory (${target})`)
      continue
    }
    let text
    try {
      text = serializeGorgeFile(staff._staffFile)
    } catch (error) {
      errors.push(`${staff.id}: cannot serialise: ${messageOf(error)}`)
      continue
    }
    const fileExists = fs.existsSync(target)
    if (!force && fileExists && typeof staff._origText === 'string' && text === staff._origText) continue
    try {
      if (backup && fileExists) {
        const backupPath = target + '.bak'
        if (!project._backups.has(backupPath)) {
          if (!fs.existsSync(backupPath)) fs.copyFileSync(target, backupPath)
          project._backups.add(backupPath)
        }
      }
      const tmp = tempPathFor(target)
      try {
        fs.writeFileSync(tmp, text, 'utf8')
        fs.renameSync(tmp, target)
      } catch (error) {
        try {
          if (fs.existsSync(tmp)) fs.unlinkSync(tmp)
        } catch {
          /* ignore cleanup failures */
        }
        throw error
      }
      staff._origText = text
      staff._new = false
      written.push(target)
    } catch (error) {
      errors.push(`${staff.id}: write failed: ${messageOf(error)}`)
    }
  }
  if (errors.length === 0) project.dirty = false
  return { written, errors }
}

// ===========================================================================
// 10. Validation
// ===========================================================================

/** Push one issue with a level and stable code. */
function issue(issues, level, code, message, context = {}) {
  issues.push(Object.assign({ level, code, message }, context))
}

/** Collect lane names defined by lane elements across the project. */
function collectLaneNames(project) {
  const names = new Set()
  for (const staff of project.staffs || []) {
    for (const period of staff.periods || []) {
      for (const element of period.elements || []) {
        if (element.category !== 'lane') continue
        const name = fieldString(element.fields, 'name')
        if (name) names.add(name)
      }
    }
  }
  return names
}

/** Recursively check curve-ish values for structural problems. */
function validateCurveValue(value, elementId, issues, trail) {
  if (!isTypedValue(value) || value.t !== 'obj') return
  const type = shortType(value.type)
  const fields = isPlainObject(value.fields) ? value.fields : {}
  const where = trail ? `${trail}.` : ''
  if (type === 'LerpColorCurve') {
    const points = fields.colorPoints
    const items = points && points.t === 'arr' && Array.isArray(points.items) ? points.items : []
    if (items.length === 0) issue(issues, 'warning', 'empty-color-points', `${elementId}: LerpColorCurve ${where}colorPoints is empty`, { elementId })
  }
  if (type === 'PiecewiseFunctionCurve') {
    const pieces = fields.functionPieces
    const items = pieces && pieces.t === 'arr' && Array.isArray(pieces.items) ? pieces.items : []
    let previous = -Infinity
    for (const piece of items) {
      if (!isTypedObject(piece)) continue
      const pieceFields = isPlainObject(piece.fields) ? piece.fields : {}
      const startX = valueAsNumber(pieceFields.startX)
      const endX = valueAsNumber(pieceFields.endX)
      if (startX !== null && endX !== null && startX > endX) {
        issue(issues, 'warning', 'bad-curve-range', `${elementId}: function piece ${where}startX > endX`, { elementId })
      }
      if (startX !== null) {
        if (startX < previous) issue(issues, 'info', 'unsorted-function-pieces', `${elementId}: function pieces ${where}are not sorted by startX`, { elementId })
        previous = startX
      }
    }
  }
  for (const key of Object.keys(fields)) {
    const child = fields[key]
    if (isTypedObject(child)) validateCurveValue(child, elementId, issues, trail ? `${trail}.${key}` : key)
    else if (isPlainObject(child) && child.t === 'arr') {
      for (const item of Array.isArray(child.items) ? child.items : []) {
        if (isTypedObject(item)) validateCurveValue(item, elementId, issues, trail ? `${trail}.${key}` : key)
      }
    }
  }
}

/** True for a typed object value (not arrays/refs/exprs). */
function isTypedObject(value) {
  return isPlainObject(value) && value.t === 'obj'
}

/**
 * Validate the in-memory project.
 *
 * @param {object} project  internal Project model.
 * @returns {{level:'error'|'warning'|'info', code:string, message:string,
 *            staffId?:string, periodId?:string, elementId?:string}[]}
 *          an empty array means the project looks consistent. Issues are
 *          advisory: the editor still lets the user save a project with issues.
 */
export function validateProject(project) {
  const issues = []
  if (!project || typeof project !== 'object') {
    issue(issues, 'error', 'no-project', 'no project loaded')
    return issues
  }
  const laneNames = collectLaneNames(project)
  const seenElementIds = new Set()
  const seenLaneNames = new Map()

  if (project.audio && project.audio.file && !fs.existsSync(project.audio.file)) {
    issue(issues, 'error', 'missing-audio', `audio file is missing: ${project.audio.file}`)
  }

  for (const staff of project.staffs || []) {
    const staffContext = { staffId: staff.id }
    if (staff.kind === 'audio') {
      if (!staff._song) issue(issues, 'warning', 'audio-without-song', `${staff.id}: audio staff declares no @Song asset`, staffContext)
      continue
    }
    const periods = staff.periods || []
    for (let i = 0; i < periods.length; i += 1) {
      const period = periods[i]
      const periodContext = { staffId: staff.id, periodId: period.id }
      if (!Number.isFinite(period.timeOffset)) issue(issues, 'error', 'bad-period-offset', `${staff.id}/${period.id}: invalid timeOffset`, periodContext)
      if (period.minLength !== null && (!Number.isFinite(period.minLength) || period.minLength < 0)) {
        issue(issues, 'error', 'bad-period-length', `${staff.id}/${period.id}: invalid minLength`, periodContext)
      }
      if ((period.elements || []).length === 0) issue(issues, 'info', 'empty-period', `${staff.id}/${period.id} (${period.method}) has no elements`, periodContext)
      for (const element of period.elements || []) {
        if (seenElementIds.has(element.id)) issue(issues, 'error', 'duplicate-element-id', `duplicate element id ${element.id}`, Object.assign({ elementId: element.id }, periodContext))
        seenElementIds.add(element.id)
        const entry = catalogEntry(element.type)
        if (!entry) {
          issue(issues, 'warning', 'unknown-element-type', `${element.id}: unknown element type "${element.type}"`, Object.assign({ elementId: element.id }, periodContext))
          continue
        }
        if (!Number.isFinite(element.start)) issue(issues, 'error', 'bad-timing', `${element.id}: non-finite start`, Object.assign({ elementId: element.id }, periodContext))
        if (element.duration !== null && (!Number.isFinite(element.duration) || element.duration < 0)) {
          issue(issues, 'warning', 'bad-timing', `${element.id}: invalid duration`, Object.assign({ elementId: element.id }, periodContext))
        }
        if (element.category === 'note' || element.category === 'hold') {
          const lane = fieldString(element.fields, entry.timing && entry.timing.lane ? entry.timing.lane : 'laneName')
          if (lane && !laneNames.has(lane)) {
            issue(issues, 'warning', 'unknown-lane', `${element.id}: lane "${lane}" is not defined by any lane element`, Object.assign({ elementId: element.id }, periodContext))
          }
        }
        if (element.category === 'lane') {
          const name = fieldString(element.fields, 'name')
          if (name) {
            const scope = `${staff.id}\u0000${period.id}\u0000${name}`
            if (seenLaneNames.has(scope)) issue(issues, 'info', 'duplicate-lane-name', `${element.id}: duplicate lane name "${name}" in ${period.id}`, Object.assign({ elementId: element.id }, periodContext))
            else seenLaneNames.set(scope, element.id)
          }
        }
        if (entry.type === 'DeentyStoryboard.Image') {
          const mode = element.fields && element.fields.positionMode
          const path = mode && isPlainObject(mode) && mode.t === 'ref' ? String(mode.path || '') : ''
          if (!path) issue(issues, 'warning', 'missing-position-mode', `${element.id}: Image without positionMode`, Object.assign({ elementId: element.id }, periodContext))
          else if (!/ImagePositionMode\./.test(path)) issue(issues, 'info', 'unknown-position-mode', `${element.id}: unrecognised positionMode "${path}"`, Object.assign({ elementId: element.id }, periodContext))
        }
        if (element.category === 'hold') {
          const inner = element.fields && element.fields.innerNotes
          const items = inner && isPlainObject(inner) && inner.t === 'arr' && Array.isArray(inner.items) ? inner.items : []
          for (const note of items) {
            if (!isTypedObject(note)) continue
            const hit = fieldNumber(note.fields, 'hitTime')
            if (hit === null) issue(issues, 'warning', 'bad-inner-note', `${element.id}: inner note without hitTime`, Object.assign({ elementId: element.id }, periodContext))
            else if (element.duration !== null && (hit < 0 || hit > element.duration + 1e-6)) {
              issue(issues, 'info', 'inner-note-outside-hold', `${element.id}: inner note at ${hit}s is outside the hold`, Object.assign({ elementId: element.id }, periodContext))
            }
          }
        }
        validateCurveValue(element.fields, element.id, issues, '')
      }
    }
  }
  return issues
}

// ===========================================================================
// 11. Audio probing
// ===========================================================================

function readFully(fd, length, position) {
  const buffer = Buffer.alloc(length)
  const bytes = fs.readSync(fd, buffer, 0, length, position)
  return bytes === length ? buffer : buffer.subarray(0, bytes)
}

function readUInt32LE(buffer, offset) {
  if (offset + 4 > buffer.length) return null
  return buffer.readUInt32LE(offset)
}

function readUInt16LE(buffer, offset) {
  if (offset + 2 > buffer.length) return null
  return buffer.readUInt16LE(offset)
}

/** Parse a RIFF/WAVE header: duration = data bytes / byteRate. */
function probeWav(fd, fileSize) {
  const header = readFully(fd, 12, 0)
  if (header.length < 12) return { duration: null, sampleRate: null, channels: null, format: 'wav' }
  const riff = header.toString('ascii', 0, 4)
  const wave = header.toString('ascii', 8, 12)
  if (riff !== 'RIFF' || wave !== 'WAVE') return { duration: null, sampleRate: null, channels: null, format: 'wav' }
  let offset = 12
  let sampleRate = null
  let channels = null
  let byteRate = null
  let dataSize = null
  for (let guard = 0; guard < 64 && offset + 8 <= fileSize; guard += 1) {
    const chunkHeader = readFully(fd, 8, offset)
    if (chunkHeader.length < 8) break
    const id = chunkHeader.toString('ascii', 0, 4)
    const size = chunkHeader.readUInt32LE(4)
    if (id === 'fmt ') {
      const body = readFully(fd, Math.min(size, 40), offset + 8)
      const audioFormat = readUInt16LE(body, 0)
      channels = readUInt16LE(body, 2)
      sampleRate = readUInt32LE(body, 4)
      byteRate = readUInt32LE(body, 8)
      if (audioFormat === 0xfffe && body.length >= 26) {
        // WAVE_FORMAT_EXTENSIBLE: sub-format GUID's first two bytes are the format tag.
        const subFormat = readUInt16LE(body, 24)
        if (subFormat !== null) {
          /* keep byteRate as-is; valid for PCM/IEEE float */
        }
      }
    } else if (id === 'data') {
      dataSize = size > 0 && size !== 0xffffffff ? size : Math.max(0, fileSize - (offset + 8))
      break
    }
    const padded = size + (size % 2)
    offset += 8 + padded
    if (size === 0 && id !== 'fmt ') break
  }
  let duration = null
  if (dataSize !== null) {
    let bytesPerSecond = byteRate
    if (!bytesPerSecond && sampleRate && channels) bytesPerSecond = sampleRate * channels * 2
    if (bytesPerSecond && bytesPerSecond > 0) duration = dataSize / bytesPerSecond
  }
  return {
    duration: typeof duration === 'number' && Number.isFinite(duration) && duration > 0 ? duration : null,
    sampleRate: typeof sampleRate === 'number' && sampleRate > 0 ? sampleRate : null,
    channels: typeof channels === 'number' && channels > 0 ? channels : null,
    format: 'wav',
  }
}

// MPEG audio tables (index 0 = free bitrate, 15 = invalid).
const MP3_BITRATES = {
  // version 1
  1: {
    1: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
    2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
    3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  },
  // version 2 / 2.5
  2: {
    1: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
    2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
    3: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  },
}
const MP3_SAMPLE_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] }
const MP3_SAMPLES_PER_FRAME = { 1: 384, 2: 1152, 3: { 3: 1152, 2: 576, 0: 576 } }

/** Parse the first MPEG frame header; returns { versionBits, layerBits, bitrate, sampleRate, channels, frameLength }. */
function parseMp3FrameHeader(buffer, offset) {
  if (offset + 4 > buffer.length) return null
  if (buffer[offset] !== 0xff) return null
  const b1 = buffer[offset + 1]
  if ((b1 & 0xe0) !== 0xe0) return null
  const versionBits = (b1 >> 3) & 0x03 // 3=MPEG1, 2=MPEG2, 0=MPEG2.5, 1=reserved
  const layerBits = (b1 >> 1) & 0x03 // 3=Layer I, 2=Layer II, 1=Layer III, 0=reserved
  if (versionBits === 1 || layerBits === 0) return null
  const b2 = buffer[offset + 2]
  const b3 = buffer[offset + 3]
  const bitrateIndex = (b2 >> 4) & 0x0f
  const sampleRateIndex = (b2 >> 2) & 0x03
  if (bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 3) return null
  const padding = (b2 >> 1) & 0x01
  const channelMode = (b3 >> 6) & 0x03
  const tableVersion = versionBits === 3 ? 1 : 2
  const layerKey = 4 - layerBits // 3=Layer I,2=Layer II,1=Layer III -> 1..3
  const bitrateKbps = MP3_BITRATES[tableVersion] && MP3_BITRATES[tableVersion][layerKey] ? MP3_BITRATES[tableVersion][layerKey][bitrateIndex] : 0
  const sampleRates = MP3_SAMPLE_RATES[versionBits]
  const sampleRate = sampleRates ? sampleRates[sampleRateIndex] : 0
  if (!bitrateKbps || !sampleRate) return null
  const bitrate = bitrateKbps * 1000
  const samplesPerFrame =
    layerKey === 1 ? 384 : layerKey === 2 ? 1152 : versionBits === 3 ? 1152 : 576
  const frameLength = layerKey === 1
    ? Math.floor((12 * bitrate) / sampleRate + padding) * 4
    : Math.floor((samplesPerFrame / 8) * bitrate / sampleRate) + padding
  if (!frameLength || frameLength < 4) return null
  return {
    versionBits,
    layerKey,
    bitrate,
    sampleRate,
    samplesPerFrame,
    frameLength,
    channels: channelMode === 3 ? 1 : 2,
  }
}

/** Best-effort MP3 duration (Xing/Info VBR header, else CBR from the first frame). */
function probeMp3(fd, fileSize) {
  const empty = { duration: null, sampleRate: null, channels: null, format: 'mp3' }
  try {
    let audioStart = 0
    const id3 = readFully(fd, 10, 0)
    if (id3.length === 10 && id3.toString('ascii', 0, 3) === 'ID3') {
      const size = ((id3[6] & 0x7f) << 21) | ((id3[7] & 0x7f) << 14) | ((id3[8] & 0x7f) << 7) | (id3[9] & 0x7f)
      audioStart = 10 + size
      if (id3[5] & 0x10) audioStart += 10 // footer present
    }
    // ID3v1 tag at the end.
    let endTrim = 0
    if (fileSize > 128) {
      const tail = readFully(fd, 128, fileSize - 128)
      if (tail.length === 128 && tail.toString('ascii', 0, 3) === 'TAG') endTrim = 128
    }
    // Find the first valid frame within 64 KiB of the audio start.
    const scanLength = Math.min(65536, Math.max(0, fileSize - audioStart))
    const scan = scanLength > 0 ? readFully(fd, scanLength, audioStart) : Buffer.alloc(0)
    let frameOffset = -1
    let frame = null
    for (let i = 0; i + 4 < scan.length; i += 1) {
      const parsed = parseMp3FrameHeader(scan, i)
      if (parsed) {
        frame = parsed
        frameOffset = i
        break
      }
    }
    if (!frame) return empty
    const channels = frame.channels
    const sampleRate = frame.sampleRate
    // Xing/Info header sits after the side info.
    const sideInfo = frame.versionBits === 3 ? (channels === 1 ? 17 : 32) : channels === 1 ? 9 : 17
    const xingOffset = frameOffset + 4 + sideInfo
    let duration = null
    if (xingOffset + 12 <= scan.length) {
      const tag = scan.toString('ascii', xingOffset, xingOffset + 4)
      if (tag === 'Xing' || tag === 'Info') {
        const flags = readUInt32LE(scan, xingOffset + 4)
        if (flags !== null && flags & 0x01) {
          const frames = readUInt32LE(scan, xingOffset + 8)
          if (frames) duration = (frames * frame.samplesPerFrame) / sampleRate
        }
      }
    }
    if (duration === null && frame.bitrate > 0) {
      const audioBytes = Math.max(0, fileSize - (audioStart + frameOffset) - endTrim)
      duration = (audioBytes * 8) / frame.bitrate
    }
    return {
      duration: typeof duration === 'number' && Number.isFinite(duration) && duration > 0 ? duration : null,
      sampleRate,
      channels,
      format: 'mp3',
    }
  } catch {
    return empty
  }
}

/**
 * Probe an audio file's duration and basic format, from its header only (no
 * decoding, no whole-file read: a 46 MB `Song.wav` costs two small reads).
 * WAV duration is `data bytes / byteRate`, so it is correct for non-16-bit
 * files too (the corpus `Song.wav` is 32-bit IEEE float stereo and is ~130.74 s,
 * not the ~261 s that 16-bit maths would suggest).
 *
 * @param {string} absPath  absolute path to a `.wav` / `.mp3` (anything else
 *        returns `duration: null`; the client can measure with `<audio>`).
 * @returns {{duration:number|null, sampleRate:number|null, channels:number|null, format:string|null}}
 *          never throws.
 */
export function probeAudioFile(absPath) {
  const result = { duration: null, sampleRate: null, channels: null, format: null }
  if (typeof absPath !== 'string' || absPath.length === 0) return result
  const extension = path.extname(absPath).toLowerCase().replace('.', '')
  result.format = extension || null
  let fd = null
  try {
    const stat = fs.statSync(absPath)
    if (!stat.isFile()) return result
    fd = fs.openSync(absPath, 'r')
    if (extension === 'wav' || extension === 'wave') {
      const parsed = probeWav(fd, stat.size)
      return parsed
    }
    if (extension === 'mp3') return probeMp3(fd, stat.size)
    return result
  } catch {
    return result
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        /* ignore */
      }
    }
  }
}

// ===========================================================================
// 12. Empty project creation
// ===========================================================================

/**
 * Create a brand-new in-memory chart project (nothing is written until
 * `saveProject`). The project starts with one empty chart staff
 * (`DremuStaff.g`, class `DremuStaff`) holding a single empty `Period` at
 * `timeOffset: 0`; `applyOps` `add` ops can then create elements, allocating
 * periods as needed.
 *
 * @param {string} dir    target project directory (may not exist yet).
 * @param {string} [title] project title (defaults to the directory basename).
 * @returns {object} internal Project model with `dirty: true`.
 */
export function createEmptyProject(dir, title) {
  const absDir = path.resolve(String(dir === undefined || dir === null || dir === '' ? '.' : dir))
  const project = makeProjectShell(absDir, typeof title === 'string' && title.length > 0 ? title : path.basename(absDir) || 'Untitled')
  project._new = true
  project.dirty = true
  const qualified = G
  const staffFile = {
    usings: [],
    header: [
      { type: 'string', name: 'form', value: 'Dremu' },
      { type: 'string', name: 'displayName', value: 'Dremu谱表' },
    ],
    className: 'DremuStaff',
    annotations: ['ElementStaff'],
    blankAfterUsings: 1,
    eol: '\n',
    members: [
      {
        attr: [
          {
            type: qualified + 'PeriodConfig^',
            name: 'config',
            value: { t: 'obj', type: qualified + 'PeriodConfig', fields: { timeOffset: 0 } },
          },
        ],
        annotation: 'Chart',
        retType: qualified + 'Element^[]',
        name: 'Period',
        chartArray: { elemType: qualified + 'Element', items: [] },
        returnValue: null,
      },
    ],
  }
  const staff = {
    id: 'DremuStaff.g',
    file: path.join(absDir, 'DremuStaff.g'),
    kind: 'chart',
    form: 'Dremu',
    displayName: 'Dremu谱表',
    className: 'DremuStaff',
    periods: [],
    _staffFile: staffFile,
    _origText: null,
    _new: true,
  }
  const member = staffFile.members[0]
  staff.periods.push({
    id: 'p0',
    method: 'Period',
    timeOffset: 0,
    minLength: null,
    elements: [],
    _member: member,
  })
  project.staffs.push(staff)
  project.form = 'Dremu'
  refreshDuration(project)
  return project
}
