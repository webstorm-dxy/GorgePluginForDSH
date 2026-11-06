# Element and value reference

Catalog version 1 — eight element types and the composite value trees used by
their fields. `gorge_element_schema { type }` is the live source; this page adds
the authoring context the schema does not show.

Type names are qualified in the corpus (`Dremu.DremuTap`,
`GorgeFramework.LinearCurve`). The tools accept qualified, short (`DremuTap`),
and palette (`Tap`) spellings for `element.type`; write qualified names inside
value trees so the serializer matches the files.

## Value trees

| JavaScript value | JSON shape |
|---|---|
| Scalar | `2.5`, `"Main2L"`, `true`, `null` |
| Typed object | `{ "t": "obj", "type": "GorgeFramework.VariableFloat", "fields": { "baseValue": 0 } }` |
| Typed array | `{ "t": "arr", "type": "Dremu.DremuHoldInnerNote", "items": [ … ] }` |
| Enum / reference | `{ "t": "ref", "path": "DeentyStoryboard.ImagePositionMode.ScreenCover" }` |
| Expression | `{ "t": "expr", "src": "(1.0/0.0)", "special": "Infinity" }` |

- `type` is required on `obj` and `arr`; `arr.type` is the **element** type, not
  `T[]`.
- `expr` is only used for the infinite `startX` / `endX` bounds seen in
  `PiecewiseFunctionCurve`; prefer finite numbers for new values.
- The serializer rejects an `obj` without `type` or `fields`, and a plain object
  without `t` (`unknown value tag undefined`). Patches apply before the save, so
  this failure appears at save time, not at edit time.
- Missing keys inside a typed object mean "engine default" — `gorge_chart_get`
  shows only the keys actually stored.

## Elements

### Notes — `Dremu.DremuTap`, `Dremu.DremuDrag`, `Dremu.DremuTaplik`

Category `note`, lane `laneName`, start `hitTime`, no duration. The three types
share the same field set; only the gameplay semantics differ.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `laneName` | string | `""` | Required. Lane `name` the note is judged on. |
| `hitTime` | number (s) | `0` | Period-relative hit time. |
| `leadTime` | number (s) | `1.5` | Spawn lead before the hit. |
| `lagTime` | number (s) | `1.5` | Presentation lag after the hit. |
| `position` | `VariableFloat` | `{baseValue:0}` | Lateral offset on the lane. |
| `distance` | curve | `LinearFunctionCurve{k:-8,b:0}` | Depth/approach; default starts ~12 units out 1.5 s early. |
| `color` | `LerpColorCurve` | authoring default | Note tint. |
| `hintReference` | boolean | `false` | Reference-line hint. |
| `respondHintColor1` | `ColorArgb` | authoring default | Hit-effect colour A. |
| `respondHintColor2` | `ColorArgb` | authoring default | Hit-effect colour B. |
| `positionZ` | number | `-2` | Draw order. |

Authoring usually needs only `laneName`, `hitTime`, and occasionally `position`,
`distance`, or `color`.

### Hold — `Dremu.DremuHold`

Category `hold`, lane `laneName`, start `hitTime`, duration `holdTime`. Adds to
the note fields:

| Field | Type | Default | Meaning |
|---|---|---|---|
| `holdTime` | number (s) | `1` | Held duration. |
| `innerNotes` | `Dremu.DremuHoldInnerNote[]` | `[]` | Tick notes inside the hold. |
| `endDistance` | curve | `LinearFunctionCurve{k:-8,b:0}` | Depth of the tail. |
| `holdLine` | curve | `ConstantFunctionCurve{0}` | Hold-line shape. |
| `truncation` | boolean | `true` | Truncate the tail at the lane edge. |
| `holdLength` | number | `1` | Hold-line length parameter. |
| `pointCount` | int | `100` | Mesh sampling. Must be an integer. |
| `targetProjectionFix` | boolean | `true` | Projection correction. |

`innerNotes` is a typed array:

```json
{
  "t": "arr",
  "type": "Dremu.DremuHoldInnerNote",
  "items": [
    { "t": "obj", "type": "Dremu.DremuHoldInnerNote", "fields": { "hitTime": 0.5 } },
    { "t": "obj", "type": "Dremu.DremuHoldInnerNote", "fields": { "hitTime": 1.0, "audioEffect": true } }
  ]
}
```

Inner-note `hitTime` is **relative to the hold start** and should be inside
`0 … holdTime`; `audioEffect` / `respondHint` default to `true`.

### Main lane — `Dremu.DremuMainLane`

Category `lane`, lane/start/duration from `name` / `generateTime` / `keepTime`.
A lane defines the judgement line other elements bind to.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `name` | string | `""` | Required. Lane name used by `laneName`. |
| `generateTime` | number (s) | `0` | Period-relative birth. |
| `keepTime` | number (s) | `10` | Lifetime; notes spawning outside it are unbound. |
| `laneLines` | `GorgeFramework.FunctionCurve[]` | `[Constant 0]` | Cross-section shape keyframes. |
| `animation` | curve | `LinearFunctionCurve{k:1,b:0}` | Progress through `laneLines` over local time. |
| `drawStartX` | `VariableFloat` | `{baseValue:-10}` | Drawn span start. |
| `drawEndX` | `VariableFloat` | `{baseValue:10}` | Drawn span end. |
| `pointCount` | int | `100` | Polyline samples. |
| `evaluateDelta` | number | `0.01` | Derivative step. |
| `color` | `LerpColorCurve` | authoring default | Lane colour. |
| `positionZ` | number | `-1` | Draw order. |
| `positionX` / `positionY` / `rotationZ` | `VariableFloat` | `0` | Placement and rotation in degrees. |

### Guide lane — `Dremu.DremuGuideLane`

Category `lane`, same timing/lane fields as a main lane, plus:

| Field | Type | Default | Meaning |
|---|---|---|---|
| `mainLaneName` | string | `"Main1"` | Required. The main lane it attaches to. |
| `position` | `VariableFloat` | `{baseValue:0}` | Offset along the main lane. |
| `targetProjectionFix` | boolean | `true` | Project onto the main-lane tangent. |

A guide lane's own `name` is the `laneName` notes use. It is alive for its own
`generateTime … generateTime + keepTime` window, independent of the notes.

### Hold inner note — `Dremu.DremuHoldInnerNote`

Category `inner`; only valid inside a hold's `innerNotes` (never `add` it as a
top-level element).

| Field | Type | Default | Meaning |
|---|---|---|---|
| `hitTime` | number (s) | `1` | Relative to the hold start. |
| `audioEffect` | boolean | `true` | Play the tick sound. |
| `respondHint` | boolean | `true` | Show the hit effect. |

### Storyboard image — `DeentyStoryboard.Image`

Category `other`; lives in the `storyboard` staff. Start `startMoment`, duration
`keepTime`, no lane.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `assetName` | string | `""` | Required. Image file in the project. |
| `startMoment` | number (s) | `0` | Period-relative start. |
| `keepTime` | number (s) | `1` | Visible duration. |
| `positionMode` | ref | `ImagePositionMode.ScreenX` | Screen/gameplay placement mode. |
| `positionX` / `positionY` / `rotationZ` | `VariableFloat` | `0` | Offset in the chosen mode. |
| `scaleX` / `scaleY` | `VariableFloat` | `1` | Scale. |
| `positionZ` | `VariableFloat` | `1` | Draw order (later = in front). |
| `alpha` | `VariableFloat` | `1` | Opacity. |
| `useChartTime` | boolean | `false` | Use chart time instead of its own clock. |

`positionMode` must be a ref:

```json
{ "t": "ref", "path": "DeentyStoryboard.ImagePositionMode.ScreenCover" }
```

Allowed paths: `GamePlayPanel`, `ScreenXY`, `ScreenX`, `ScreenY`,
`ScreenContain`, `ScreenCover` (all prefixed
`DeentyStoryboard.ImagePositionMode.`).

## Composite value types

| Type | Fields (defaults) |
|---|---|
| `GorgeFramework.VariableFloat` | `baseValue` (0), `variationCurve` (optional) |
| `GorgeFramework.Vector2` | `x` (0), `y` (0) |
| `GorgeFramework.ColorArgb` | `a` (1), `r` (1), `g` (1), `b` (1) — 0…1 |
| `GorgeFramework.LinearCurve` | `timeStart` (0), `valueStart` (0), `timeEnd` (1), `valueEnd` (1) |
| `GorgeFramework.LinearFunctionCurve` | `k` (0), `b` (0) |
| `GorgeFramework.ConstantFunctionCurve` | `value` (0) |
| `GorgeFramework.CubicHermiteSpline` | `startPoint` (0,0), `startTangent` (0), `startWeight` (1/3), `endPoint` (1,1), `endTangent` (0), `endWeight` (1/3) |
| `GorgeFramework.FunctionPiece` | `functionCurve` (optional), `startX` (0), `endX` (0), `leftClosed` (false), `rightClosed` (false) |
| `GorgeFramework.PiecewiseFunctionCurve` | `functionPieces` (`FunctionPiece[]`, empty) |
| `GorgeFramework.LerpColorCurve` | `colorPoints` (`ColorArgb[]`, empty ⇒ white), `progressCurve` (optional) |
| `GorgeFramework.AxialSymmetricFunctionCurve` | `functionCurve`, `axis` (0), `keepLeft` (false) |
| `GorgeFramework.PeriodicFunctionCurve` | `functionCurve`, `startX` (0), `endX` (0), `leftClosed` (false) |
| `GorgeFramework.AdditionFunctionCurve` | `firstFunctionCurve`, `secondFunctionCurve` |
| `GorgeFramework.CompositeFunctionCurve` | `outerFunctionCurve`, `innerFunctionCurve` |
| `GorgeFramework.WavAudioAsset` | `name`, `wavFilePath` |
| `GorgeFramework.PeriodConfig` | `timeOffset` (0), `minLength` (10) |

### Curve maths

Sampled at local time `t` (seconds since the element's start) or at 0…1 for
progress curves:

- `ConstantFunctionCurve` → `value`.
- `LinearFunctionCurve` → `k*t + b`.
- `LinearCurve` → linear from `(timeStart,valueStart)` to `(timeEnd,valueEnd)`,
  clamped outside.
- `CubicHermiteSpline` → weighted-tangent cubic over
  `[startPoint.x, endPoint.x]`, clamped outside; tangents are slopes `dy/dx`.
- `PiecewiseFunctionCurve` → first piece containing `x` (open bounds unless
  `leftClosed` / `rightClosed`), evaluated at the same absolute `x`; no match
  returns 0.
- `AxialSymmetricFunctionCurve` → mirror `x` around `axis` on the non-kept side.
- `PeriodicFunctionCurve` → wrap `x` into `[startX,endX)` and evaluate.
- `AdditionFunctionCurve` → `f1(x) + f2(x)`.
- `CompositeFunctionCurve` → `outer(inner(x))`.
- `LerpColorCurve` → `p = progressCurve(x)`; floor/ceil colour stops lerped by
  `p - floor(p)`; no points ⇒ white, no progressCurve ⇒ first stop.
- `VariableFloat` → `baseValue + variationCurve(x)`; the variation is a delta.

## Audio periods (`@Song`)

An audio staff (`@AudioStaff`) has **no `@Chart` periods**. Instead every
`@Song` method is one audio period ("乐段"):

```
[
    GorgeFramework.PeriodConfig^ config = GorgeFramework.PeriodConfig : {
        timeOffset : 64.5,
    }
]
@Song
static GorgeFramework.AudioAsset^ GetSong1()
{
    return GorgeFramework.WavAudioAsset : {
        name : "第二段",
        wavFilePath : "第二段.wav",
    };
}
```

| Field | Meaning |
|---|---|
| `@Song` method `name` (`GetSong`, `GetSong1`, …) | unique method name = clip identity in the `.g` file |
| `PeriodConfig.timeOffset` | absolute chart time at which the clip starts |
| `WavAudioAsset.name` | asset name shown in the editor |
| `WavAudioAsset.wavFilePath` | audio file path **relative to the project directory** (imported files are copied there) |
| derived `duration` | probed from the file header; the clip ends at `timeOffset + duration` |

- A staff/track may declare several `@Song` methods; they play as independent
  clips, so `timeOffset` can overlap or leave gaps.
- `project.audioPeriods` in `gorge_chart_get` lists `{ id, staffId, method, name,
  relativePath, file, offset, duration, missing }`; `project.audio` is the
  first (legacy) clip.
- The audio file is **not** an `AutoLoaded` asset: only `wavFilePath` refers to
  it, and a missing file validates as `missing-audio`.
- Do not use normal `add`/`duplicate`/`patch` ops on audio periods — use
  `addAudioPeriod` / `patchAudioPeriod` / `removeAudioPeriod`.

## Authoring notes

- Build new composite values from the catalog defaults, then change only the
  leaves you need. A new note already gets a usable `distance`, `position`, and
  colour.
- `laneLines`, `innerNotes`, `functionPieces`, and `colorPoints` are typed
  arrays; the path to an item is `…items.<index>.fields.<field>`.
- `pointCount` is an int field and is serialized without `.0`; keep it an
  integer.
- Fields not in the catalog are kept and reported (`unknown field ... (kept)`);
  they are often engine fields the editor does not describe, so leave them alone.
- The note colour defaults and respond-hint colours are authoring conveniences,
  not engine defaults; the engine treats a missing `color` as white.
