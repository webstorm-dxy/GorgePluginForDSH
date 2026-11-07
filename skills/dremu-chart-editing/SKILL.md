---
name: dremu-chart-editing
description: "Create and edit Dremu/Gorge .g rhythm-game charts through the gorge_* chart tools: create a brand-new project (gorge_project_create), inspect the flattened chart, apply patch/add/remove/duplicate/setMeta/setPeriodConfig/addStaff/removeStaff ops, add or edit audio periods (乐段) with addAudioPeriod/patchAudioPeriod/removeAudioPeriod, validate, and save byte-exact staffs. Use for notes, holds, lanes, storyboard images, periods, new staffs, audio clips, tempo, retiming, or starting a project from scratch in a Dremu谱面 project, including mapping a section, copying patterns, or fixing validation issues."
---

# Dremu chart editing

`gorge_*` edits the chart project open in the Dremu 谱面工坊 panel. The user sees
every accepted op immediately, and `gorge_chart_save` writes the `.g` staffs
atomically with a `.g.bak` backup. Use the tools instead of hand-editing `.g`
text: they own period-relative timing, stable ids, the canonical serializer, and
the revision stream.

## Workflow

1. **Locate** — `gorge_project_list` (scans `~/Music` by default; pass
   `refresh: true` to rescan), then `gorge_project_open { dir }`. `dir` is an
   absolute path, a project name under the root, or a path relative to the
   session cwd. To start from scratch, `gorge_project_create` (see below) makes
   and opens a new folder in one call.
2. **Inspect before writing** — `gorge_chart_get` with `staffId` and/or `lanes`
   keeps the result small; an unfiltered read caps at 400 elements and sets
   `truncated: true`. `gorge_chart_get { elementId }` returns one element with
   its `staffId`, `periodId`, `timeOffset`, and full typed `fields`.
   `gorge_element_schema { type }` returns field names, defaults, and timing;
   omit `type` for the catalog index.
3. **Plan one ordered batch** — collect the element ids and every value you need,
   then send a single `gorge_chart_edit { ops }` for the whole gesture.
4. **Apply and read the result** — check `errors` (they can be advisory) and
   take new ids from `created` (`[{ elementId, staffId, periodId }]`).
5. **Verify** — re-read the affected staff or lane, then `gorge_chart_validate`.
   Fix error-level issues; warnings are often intentional.
6. **Save** — `gorge_chart_save`, then report the written files and any
   remaining validation issues.
7. **Share (optional)** — `gorge_chart_export` packages the live project as
   `<project>.zip` next to its staffs (staffs, referenced assets, README). It
   works without saving first and reports the path, byte size and skipped
   unreferenced assets.

## Creating a brand-new project

`gorge_project_create { name, parent?, template?, minLength? }` creates a
project folder **on disk** and opens it in the studio:

```json
{ "name": "MySong", "template": "storyboard", "minLength": 180 }
```

- `name` is one folder name (no `/ \ : * ? " < > |`, no leading or trailing
  `.`); the project directory becomes `<parent>/<name>`.
- `parent` defaults to the configured project root and must already exist.
  `~` is **not** expanded: pass an absolute path, or a path relative to the
  project root / session cwd.
- `template: "chart"` (default) writes `DremuStaff.g` with one empty `@Chart`
  period; `"storyboard"` also writes `Storyboard.g` (`form = "DeentyStoryboard"`).
- `minLength` (default 180 s) is each starter period's length, so it also sets
  the new project's duration; adjust it later with `setPeriodConfig`.
- The result reports `openPath`, `staffCount`, `elementCount`, `duration`,
  `files` and `warnings`. The starter files are saved immediately, so the new
  project opens clean (not dirty).
- An existing **empty** folder is reused; an existing non-empty folder is a
  conflict (`ok: false`). Never try to overwrite it — pick another name.
- Typical start: create the project, then add a lane with `gorge_chart_edit`
  (`add` a `MainLane`), place notes on it, and save. For an audio-driven chart,
  import the track with `addAudioPeriod { sourcePath }` first so the timeline
  length follows the music.

## The two time spaces

`gorge_chart_get` reports **absolute** seconds. Values inside a period are
**period-relative**:

```
absolute start = period.timeOffset + timing field
timing field   = hitTime (notes/holds/inner notes), generateTime (lanes), startMoment (images)
```

- `add` **without** `periodId`: put the **absolute** time in `element.start`
  (optional, defaults to 0). The model picks the period and converts.
- `add` **with** `periodId`: put the **relative** time in `fields.hitTime` /
  `generateTime` / `startMoment`. `element.start` is ignored.
- `patch` always writes **relative** values. To move a note to absolute `T`:
  `hitTime = T - period.timeOffset`.
- `duplicate.timeShift` is seconds added to the copied timing field; the copy
  stays in the same period.
- `setPeriodConfig.timeOffset` shifts every element in that period by the same
  delta; the relative fields do not change.

Never mix the two forms: an absolute `hitTime` sent together with `periodId`
lands one period offset late, and an absolute `hitTime` without `start` is
interpreted inside whichever period is picked (usually `p0`), often placing the
note far from the intended time.

Grid math: `secondsPerBeat = 60 / tempo.bpm`, beat 0 at `tempo.offset`, so
`t = offset + beat * 60 / bpm`. `setMeta.tempo` changes only the editor grid:
the `.g` format has no tempo, so notes are not retimed and nothing is written to
disk. Round authored times to 6 decimals.

## Audio periods (乐段)

An **audio period** is one `@Song` method of an `@AudioStaff` (`Song.g`). Its
`PeriodConfig.timeOffset` is the **absolute chart time** at which the clip starts;
the clip lasts its own audio duration, and a project may schedule several clips.
`gorge_chart_get` reports them twice:

- `project.audioPeriods: [{ id, staffId, method, name, relativePath, file, offset, duration, missing }]`
  sorted by chart time; `project.audio` is the legacy first clip.
- `staff.audioPeriods` on each staff with `kind: "audio"`.

```json
{ "op": "addAudioPeriod", "staffId": "Song.g", "file": "第二段.wav", "name": "第二段", "timeOffset": 64.5 }
```

- `file` must be a project-relative audio path. Use `sourcePath` (or an absolute
  `file`) to copy an **external** file into the project first; the response
  reports the stored name and `imported: true`.
- Omit `staffId` to target the first audio staff; when the project has none, a
  minimal `Song.g` is created and `created` lists both the staff and the clip.
- `method` is normally generated (`GetSong`, `GetSong1`, …); pin it only when
  recreating a removed clip (undo) so the file stays readable.
- `patchAudioPeriod { staffId?, audioPeriodId, fields: { timeOffset?, name?, file? } }`
  moves/renames/repoints one clip; `removeAudioPeriod { staffId?, audioPeriodId }`
  deletes the `@Song` member but keeps the audio file on disk.
- The audio staff has **no `@Chart` periods**: never send a normal `add` there.
  `addStaff { kind: "audio" }` creates an empty audio staff if a separate one is
  needed.

## Ops

| `op` | Shape | Use |
|---|---|---|
| `patch` | `{ elementId, path: (string\|int)[], value }` | Change fields on one element. `path: []` replaces the whole field map. |
| `add` | `{ staffId, periodId?, element: { id?, type, start?, fields? } }` | Create an element. `type` accepts `Dremu.DremuTap`, `DremuTap`, or `Tap`. |
| `remove` | `{ elementId }` | Delete one element; does not cascade to notes that reference its lane. |
| `duplicate` | `{ elementId, newId?, timeShift? }` | Copy in place (same period) and optionally shift time. |
| `setMeta` | `{ tempo?: { bpm?, offset? }, title? }` | Editor-only metadata; see the tempo warning above. |
| `setStaffName` | `{ staffId, displayName }` | Change the staff header `displayName`. |
| `setPeriodConfig` | `{ staffId, periodId, fields: { timeOffset?, minLength? } }` | Move/resize a period. Always pass `staffId`: `p0` exists in every staff. |
| `addStaff` | `{ kind?: 'chart'\|'storyboard'\|'audio', form?, displayName?, className?, fileName?, timeOffset?, minLength? }` | Create a new empty `.g` staff (chart/storyboard: one `@Chart` period; audio: no `@Song` yet). Omitted `className`/`fileName` get unique generated names; the file is written by the next save. |
| `removeStaff` | `{ staffId, deleteFile? }` | Undo an `addStaff` from the same session: deletes its `.g` and `.bak`. A staff read from disk is only deleted when `deleteFile: true`; that is permanent, so confirm with the user first. |
| `addAudioPeriod` | `{ staffId?, file, name?, timeOffset?, method?, sourcePath? }` | Append one `@Song` clip (乐段) to an audio staff; `sourcePath` imports an external file. Auto-creates `Song.g` if needed. |
| `patchAudioPeriod` | `{ staffId?, audioPeriodId, fields: { timeOffset?, name?, file?, sourcePath? } }` | Move/rename/repoint one audio clip. |
| `removeAudioPeriod` | `{ staffId?, audioPeriodId }` | Delete one `@Song` member; the audio file stays on disk. |

Ops apply in order. Each op validates before mutating; a failing op is skipped
and reported while the applied prefix stays. `changed` can be `true` alongside
`errors` (unknown op keys and unknown field names are reported but tolerated),
so judge success from `changed` plus the current state, not from `errors` alone.

## Ids

Element ids look like `<staffId>:<periodId>:e<n>` (for example
`DremuStaff1.g:p1:e26`). They are **derived**, not stored in `.g`:

- stable across edits in one open session (including after add/remove/duplicate);
- re-derived from file position by `gorge_project_open` and reload, so never
  cache ids across an open/reload — re-read them;
- for new elements use the `created` ids, or supply a unique `element.id` /
  `newId` so you can `patch` the same element later in the same batch.

## Values are typed

Scalars stay plain (`2.5`, `"Main2L"`, `true`). Objects, arrays, curves, colours,
and enums are tagged trees copied from `gorge_chart_get { elementId }`:

```json
[
  { "t": "obj", "type": "GorgeFramework.VariableFloat", "fields": { "baseValue": 0 } },
  { "t": "arr", "type": "Dremu.DremuHoldInnerNote", "items": [ { "t": "obj", "type": "Dremu.DremuHoldInnerNote", "fields": { "hitTime": 0.5 } } ] },
  { "t": "ref", "path": "DeentyStoryboard.ImagePositionMode.ScreenCover" },
  { "t": "expr", "src": "(1.0/0.0)", "special": "Infinity" }
]
```

A plain `{ "baseValue": 0 }` passes the edit but later fails the save with
`cannot serialise: unknown value tag undefined`. Keep `type` on every object
(qualified names such as `GorgeFramework.*` and `Dremu.*` are what the corpus
uses).

Patch paths into typed values must include the wrapper keys:

| Goal | `path` |
|---|---|
| Scalar field | `["hitTime"]` |
| Field of a typed object | `["position", "fields", "baseValue"]` |
| Item of a typed array | `["innerNotes", "items", 0, "fields", "hitTime"]` |
| First colour stop channel | `["color", "fields", "colorPoints", "items", 0, "fields", "r"]` |
| Replace all fields | `[]` (rare; wipes authored curves/colours) |

`["position", "baseValue"]` is accepted but writes a dead key that the
serializer ignores — always include `fields` / `items`. A path whose parent does
not exist is rejected; a new top-level field (`["positionZ"]`) is allowed.

## Element model

| Type | Category | Start | Duration | Lane |
|---|---|---|---|---|
| `Dremu.DremuTap` / `Drag` / `Taplik` | note | `hitTime` | — | `laneName` |
| `Dremu.DremuHold` | hold | `hitTime` | `holdTime` | `laneName` |
| `Dremu.DremuMainLane` | lane | `generateTime` | `keepTime` | `name` |
| `Dremu.DremuGuideLane` | lane | `generateTime` | `keepTime` | `name` + `mainLaneName` |
| `Dremu.DremuHoldInnerNote` | inner | `hitTime` (relative to the hold) | — | — |
| `DeentyStoryboard.Image` | other | `startMoment` | `keepTime` | — |

- `chart` staffs hold lanes and notes; the `storyboard` staff holds `Image`;
  the `audio` staff has no `@Chart` periods — use the audio-period ops above,
  never the normal `add`.
- A note's `laneName` must match a lane `name` in the project, or validation
  reports `unknown-lane`.
- Playback binds a note to the lane **alive at spawn time** (~`hitTime -
  leadTime`). Keep the lane's `generateTime … generateTime + keepTime` window
  covering the notes, or they are counted but never drawn.
- A guide lane belongs to the main lane named by `mainLaneName`; notes on it use
  its `name` as `laneName`.
- Hold `innerNotes[].hitTime` is relative to the hold start and should stay in
  `0 … holdTime`.
- Fields absent from `fields` fall back to engine defaults (lane `keepTime` 10,
  hold `holdTime` 1, image `keepTime` 1); the catalog defaults are what `add`
  materializes for the top-level fields you do not supply.

## Batching and safety

- Prefer one batch per gesture. Add ids (`element.id` / `newId`) so a later op
  in the same batch can patch what you just created.
- `duplicate` is cheaper than `add` for an identical element, but it stays in
  the source period; to cross a period boundary, `add` a fresh element instead.
- To move an element to another period, `remove` it and `add` it at the absolute
  time in the target staff.
- Do not rewrite fields you did not intend to change — notes carry authored
  curves and colours (`distance`, `position`, `color`, `holdLine`, …).
- There is no undo tool: `remove`, whole-field `patch` (`path: []`), and bulk
  retimes are final for the session. Save before opening another project;
  opening/reloading replaces the in-memory document.
- Treat the real chart corpus as read-only: copy a project directory before
  destructive experiments, and only edit the project the user asked for.
- There is no create-project tool. To start a new chart, copy an existing
  project folder (or author a minimal `.g` staff) and `gorge_project_open` it.

## Common errors

| Message | Fix |
|---|---|
| `unknown element "..."` | Id is stale (reopen/reload) or belongs to another project; re-read it. |
| `patch path not found` | Traverse `fields` / `items`, and make sure the parent exists. |
| `add requires staffId` / `unknown staff` | Use the staff file basename, e.g. `DremuStaff1.g`. |
| `unknown period "p1" in staff` | Period ids repeat per staff; pass the right `staffId` and `periodId`. |
| `cannot serialise` on save | A plain object/array reached a typed field, or a dead key was written. |
| `unknown-lane` warning | Add the lane element or correct `laneName`. |
| `inner note ... outside the hold` | Set `innerNotes[].hitTime` within `0 … holdTime`. |
| `the project changed while editing` | Re-read with `gorge_chart_get` and send the batch again. |

## References

- [references/op-reference.md](references/op-reference.md) — tool parameters and
  return shapes, full op semantics, path rules, validation codes.
- [references/element-fields.md](references/element-fields.md) — every element
  type's fields, defaults, composite value trees, and curve maths.
- [references/recipes.md](references/recipes.md) — copy-ready op batches for
  taps, holds, streams, lanes, retiming, periods, and storyboard images.
