# Tool and op reference

The Host half of `@local/gorge-chart-studio` exposes seven tools over one open
chart project. All return JSON; failures come back as `{ "ok": false, "error":
"..." }` instead of throwing. Every accepted edit bumps `rev` and appears live in
the user's editor.

## Tools

| Tool | Parameters | Returns |
|---|---|---|
| `gorge_project_list` | `{ refresh?: boolean }` | `{ ok, projectRoot, openPath, count, projects[] }`; each project has `dir`, `name`, `title`, `relative`, `chartFiles`, `staffs`, `audio`, `images`, `modified`. |
| `gorge_project_open` | `{ dir: string }` | `{ ok, openPath, rev, dirty, title, staffCount, elementCount, duration, warnings[] }`. Replaces the open project and re-derives ids. |
| `gorge_chart_get` | `{ staffId?, elementId?, lanes?: string[], detail?: boolean }` | Without `elementId`: project metadata, `lanes[]`, `staffs[] → periods[] → elements[]` with `id`, `type`, `start`, `duration`, `lane`, `category` (plus `fields` with `detail`). With `elementId`: that element plus `staffId`, `periodId`, `timeOffset`, full `fields`. Capped at 400 elements → `truncated: true`. |
| `gorge_chart_edit` | `{ ops: Op[] }` (min 1) | `{ ok, rev, dirty, changed, errors?, created? }`. |
| `gorge_chart_save` | `{}` | `{ ok, written[], errors[], rev, dirty }`. |
| `gorge_chart_validate` | `{}` | `{ ok, rev, dirty, issueCount, truncated, issues[] }`; at most 200 issues. |
| `gorge_element_schema` | `{ type?: string }` | Catalog index, or one element entry with `type`, `shortName`, `category`, `timing`, `fields[]` (name/type/default/label/unit), `palettes`. |

`staffId` is always the staff **file basename** (`DremuStaff.g`,
`DremuStaff1.g`, `Song.g`, `DeentyStoryboardStaff.g`). `lanes` filters by each
element's derived lane (`laneName` for notes/holds, `name` for lanes).

## Op batch semantics

```json
{ "ops": [ { "op": "patch", "elementId": "DremuStaff1.g:p1:e26", "path": ["holdTime"], "value": 0.75 } ] }
```

- Ops apply **in order** to the live in-memory project.
- Each op validates first, then mutates. A failing op is skipped and reported in
  `errors`; earlier successful ops stay applied. `changed` is true if any op
  applied.
- Unknown keys on an op are ignored but reported; unknown element fields are
  kept but reported. The result can therefore be successful with `errors`.
- `created` lists `add`, `duplicate`, and `addStaff` results, in op order:
  elements as `[{ elementId, staffId, periodId }]`, staffs as
  `[{ staffId, kind: "staff", staffKind }]`, audio periods as
  `[{ staffId, kind: "audioPeriod", audioPeriodId, method, file, timeOffset, imported }]`.
  Ops generated this way are also in `gorge_chart_get` after the call.
- The agent tool always edits at the current revision; there is no `baseRev`
  parameter. If it reports `the project changed while editing`, re-read and
  resend.

### `patch`

```json
{ "op": "patch", "elementId": "…", "path": ["hitTime"], "value": 22.5 }
```

- `path` navigates the element's `fields` map: string keys for objects, integer
  indices for native arrays. It must be an array.
- The value is cloned in as-is. Numbers, strings, booleans, and `null` are
  written directly. Composite values must be typed trees; see
  [element-fields.md](element-fields.md#value-trees).
- Typed objects and arrays wrap their members, so the path must spell that out:
  - `["position", "fields", "baseValue"]`
  - `["innerNotes", "items", 0, "fields", "hitTime"]`
  - `["color", "fields", "colorPoints", "items", 0, "fields", "r"]`

  Skipping `fields` / `items` either fails (`patch path not found`) or, when the
  parent exists, writes a dead key the serializer ignores. Never use
  `["position", "baseValue"]`.
- The parent of the final segment must already exist; the final field may be new
  at the top level (`["positionZ"]`).
- `path: []` replaces the whole `fields` map. It accepts a plain map or a
  `{ "t": "obj", "fields": {…} }` node. This discards all authored curves and
  colours on the element — avoid it for edits.
- Timing is refreshed after the patch: `start` / `duration` / `lane` in tool
  output reflect the new relative value plus the owning period.

### `add`

```json
{
  "op": "add",
  "staffId": "DremuStaff1.g",
  "element": {
    "type": "Dremu.DremuTap",
    "start": 25.5,
    "fields": { "laneName": "Main2L" }
  }
}
```

- `staffId` is required. Only add to a **chart** staff (notes, holds, lanes) or
  the **storyboard** staff (`DeentyStoryboard.Image`).
- `type` accepts qualified, short, or palette spelling: `Dremu.DremuTap`,
  `DremuTap`, `Tap`; same for `Hold`, `Drag`, `Taplik`, `MainLane`, `GuideLane`,
  `Image`.
- Period choice:
  - `periodId` omitted → `element.start` is **absolute** seconds (default 0). The
    model picks the period containing that time, else the nearest period by
    distance, and writes `timingField = start - timeOffset` unless you supplied
    that field yourself.
  - `periodId` present → the period is used verbatim; `element.start` is
    **ignored** and the timing field must be **period-relative**.
  - If the staff has no periods at all, `add` allocates a new `Period` member at
    the requested time. This is meant for chart staffs; do not rely on it for
    audio/storyboard staffs.
- Fields default from the catalog (`createElement`) for every top-level field you
  do not supply. Supplied composite values replace the default wholesale; they
  are not deep-merged. Nested missing keys simply fall back at runtime.
- Unknown field names are kept and reported. Unknown element keys other than
  `id`, `type`, `fields`, `start` are ignored and reported.
- `element.id` (optional) is honored if unique; a collision is reported and a
  deterministic id is generated instead. Use it to patch the new element later
  in the same batch.

### `remove`

```json
{ "op": "remove", "elementId": "…" }
```

Removes the element from its period and from the backing chart array. It does
not cascade: notes that referenced a removed lane stay and validate with
`unknown-lane`; inner notes disappear with their hold.

### `duplicate`

```json
{ "op": "duplicate", "elementId": "…", "timeShift": 0.5, "newId": "copy-1" }
```

- Deep-copies the element's value tree and inserts it directly after the
  original in the same period.
- `timeShift` (seconds) is added to the catalog timing field only (`hitTime`,
  `generateTime`, `startMoment`). Other time-valued fields (curves, inner notes)
  are copied unchanged.
- The copy stays in the source period even when the shifted absolute time leaves
  its range; for cross-period copies use `add`.
- `newId` is optional and follows the same uniqueness rules as `add`.

### `setMeta`

```json
{ "op": "setMeta", "tempo": { "bpm": 174, "offset": 0.12 }, "title": "New title" }
```

`tempo.bpm` must be a positive number, `tempo.offset` a finite number (seconds),
`title` a string. Both are **editor-only metadata** kept in the Host recovery
snapshot; `.g` has no tempo or title, so this writes nothing to disk and does not
retime notes. Use `patch` / period config for actual timing changes.

### `setStaffName`

```json
{ "op": "setStaffName", "staffId": "DremuStaff1.g", "displayName": "主歌" }
```

Updates the class header's `displayName` (the label in the editor's staff
groups). It does not rename the file or the class.

### `setPeriodConfig`

```json
{
  "op": "setPeriodConfig",
  "staffId": "DremuStaff1.g",
  "periodId": "p1",
  "fields": { "timeOffset": 21.5, "minLength": 10 }
}
```

- Merges into the period member's `PeriodConfig` attr; `timeOffset` (seconds) and
  `minLength` (seconds or `null`) are the known fields.
- `timeOffset` shifts every element in the period by the delta; relative fields
  are untouched. `minLength` only constrains the period picker.
- Always pass `staffId`: period ids (`p0`, `p1`, …) are scoped per staff, and
  `periodId` alone is ambiguous when several staffs have `p0`. The Model rejects
  an ambiguous call and tells you to pass `staffId`.
- Unknown fields are kept and reported.

### `addStaff`

```json
{
  "op": "addStaff",
  "kind": "chart",
  "displayName": "副歌",
  "className": "Staff2",
  "fileName": "Staff2.g"
}
```

- Creates a new empty staff: header (`form`, `displayName`), `@ElementStaff`, and
  one `@Chart` period at `timeOffset` (default 0) with optional `minLength`
  (default open-ended). The `.g` file is written by the next save (autosave or
  `gorge_chart_save`).
- `kind` is `"chart"` (default, form `"Dremu"`), `"storyboard"` (requires form
  `"DeentyStoryboard"`) or `"audio"` (`@AudioStaff`, no `@Song` and no form). An
  audio staff accepts `addAudioPeriod` next.
- `className` must be a C# identifier; `fileName` must be a plain `<Name>.g` and
  unique in the project. Omit both to get `Staff.g` / `Staff2.g` … (or
  `Storyboard.g` for a storyboard). `created` reports `{ staffId, kind: "staff",
  staffKind }`.
- A following `add` can target the new staff in the same batch (`staffId` =
  `fileName`, `periodId: "p0"`).

### `removeStaff`

```json
{ "op": "removeStaff", "staffId": "Staff2.g" }
```

Undo for `addStaff`: deletes the staff and its `.g`/`.bak` file. Only staffs
created by `addStaff` in the same session can be removed by default; a staff
loaded from disk is rejected so an op cannot delete chart data by accident.
Pass `deleteFile: true` to delete a staff read from disk (the editor's
right-click "删除谱表" sends that after confirmation) — it is permanent, so ask
the user before doing it from an agent.

### `addAudioPeriod`

```json
{
  "op": "addAudioPeriod",
  "staffId": "Song.g",
  "file": "第二段.wav",
  "name": "第二段",
  "timeOffset": 64.5
}
```

- Appends one `@Song` member ("音频乐段") to an audio staff. `timeOffset` is the
  **absolute chart time** at which the clip starts; its end is
  `timeOffset + clip duration`.
- `staffId` is optional when the project has a single audio staff. When the
  project has none, a minimal `Song.g` is created; `created` then has
  `{ staffId, kind: "staff", staffKind: "audio" }` followed by
  `{ staffId, kind: "audioPeriod", audioPeriodId, method, file, timeOffset, imported }`.
- `file` must be project-relative and exist. `sourcePath` (or an absolute
  `file`) copies an external audio file into the project directory under a
  sanitized unique name (`.wav`, `.mp3`, `.ogg`, `.m4a`, `.aac`, `.flac`,
  `.opus`); the response's `file` is the stored relative name.
- `name` is the asset name (`WavAudioAsset.name`), defaulted from the file stem.
- `method` is generated (`GetSong`, `GetSong1`, …) unless pinned. Pass the old
  method when recreating a removed clip so the file stays readable.

### `patchAudioPeriod`

```json
{
  "op": "patchAudioPeriod",
  "staffId": "Song.g",
  "audioPeriodId": "a1",
  "fields": { "timeOffset": 70, "name": "副歌" }
}
```

- `audioPeriodId` is `a0`, `a1`, … from `gorge_chart_get`; its `method` is also
  accepted. Pass `staffId` when several audio staffs exist.
- Known `fields`: `timeOffset` (seconds ≥ 0), `name`, and `file`/`sourcePath`
  (repoint the clip; external paths are imported).
- Unknown fields are kept and reported.

### `removeAudioPeriod`

```json
{ "op": "removeAudioPeriod", "staffId": "Song.g", "audioPeriodId": "a1" }
```

Deletes the `@Song` member. The audio file itself is **not** deleted (it may be
shared or reused); remove it from disk outside the tools if the user asks.

## Period selection

`add` without `periodId` uses the period that contains `element.start`; if none
contains it, it picks the period whose start or end is closest. A period's range
is `[timeOffset, timeOffset + (minLength ?? 20)]`. Near a boundary, pass
`periodId` explicitly.

## Element ids

`<staffId>:<periodId>:e<n>`, e.g. `DremuStaff1.g:p1:e26`. Ids are **derived from
file order** and are not persisted:

- Stable across ops in one open session, including after add/remove/duplicate.
- Re-derived by `gorge_project_open` and reload; re-read after either.
- `applyOps` accepts a suggested `element.id` / `newId` if unique.
- New ids default to the next free `e<n>` in that staff/period.

## Validation codes

`gorge_chart_validate` returns `{ level, code, message, staffId?, periodId?,
elementId? }`. Issues are advisory — the editor still saves — but error-level
issues mean the chart is inconsistent.

| Code | Level | Meaning |
|---|---|---|
| `no-project` | error | Nothing is open. |
| `missing-audio` | error | The audio staff's `@Song` file does not exist. |
| `bad-period-offset` | error | Non-finite `timeOffset`. |
| `bad-period-length` | error | Negative/non-finite `minLength`. |
| `empty-period` | info | A period has no elements. |
| `duplicate-element-id` | error | Two elements share an id (should not happen through the tools). |
| `unknown-element-type` | warning | Element type not in the catalog; it is still preserved. |
| `bad-timing` | error/warning | Non-finite start, or negative/invalid duration. |
| `unknown-lane` | warning | A note/hold `laneName` has no lane element in the project. |
| `duplicate-lane-name` | info | Same lane name twice in one period. |
| `missing-position-mode` | warning | `DeentyStoryboard.Image` without `positionMode`. |
| `unknown-position-mode` | info | `positionMode` is not an `ImagePositionMode.*` path. |
| `bad-inner-note` | warning | Hold inner note without `hitTime`. |
| `inner-note-outside-hold` | info | Inner note outside `0 … holdTime`. |
| `empty-color-points` | warning | `LerpColorCurve` with no points (renders white). |
| `bad-curve-range` | warning | `FunctionPiece.startX > endX`. |
| `unsorted-function-pieces` | info | Pieces not sorted by `startX`. |

## Save and revision

- `gorge_chart_save` serializes only staffs whose canonical text changed, writes
  atomically (temp file + rename), and keeps `<file>.g.bak` once per session per
  file.
- `autoSave` is on by default, so edits can reach disk before the explicit save;
  still call `gorge_chart_save` when you need a guaranteed result and report
  `written`.
- Saving does not reopen the project, so ids stay valid.
- `gorge_project_open`, reload, and a Host restart replace the in-memory document
  and reset the browser undo stack; save first.
