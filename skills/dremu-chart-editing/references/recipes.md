# Recipes

Copy-ready `gorge_chart_edit` batches for common chart work. Replace staff ids,
period ids, element ids, lane names, and times with the values from your
`gorge_chart_get`. Times are seconds.

A batch is one JSON `ops` array. Send tens to a few hundred ops per call and
split longer runs: ops apply in order and a failing op is reported as `ops[i]`,
so smaller batches are easier to debug.

## 1. Add one tap at an absolute time

No `periodId`: `start` is absolute, and the model picks the period and converts
it to a period-relative `hitTime`.

```json
{
  "ops": [
    {
      "op": "add",
      "staffId": "DremuStaff1.g",
      "element": { "type": "Dremu.DremuTap", "start": 25.5, "fields": { "laneName": "Main2L" } }
    }
  ]
}
```

Equivalent with an explicit period: `hitTime = 25.5 - period.timeOffset`.

```json
{ "op": "add", "staffId": "DremuStaff1.g", "periodId": "p1",
  "element": { "type": "Tap", "fields": { "laneName": "Main2L", "hitTime": 4.28947 } } }
```

## 2. Add a beat-grid stream

`secondsPerBeat = 60 / bpm`; beat 0 is at `tempo.offset`. For 120 BPM and
16th notes, step = `60 / 120 / 4 = 0.125` s. Compute every `t`, keep 6 decimals,
and emit one `add` per note:

```json
{
  "ops": [
    { "op": "add", "staffId": "DremuStaff1.g",
      "element": { "type": "Tap", "start": 22.0,   "fields": { "laneName": "Main2L" } } },
    { "op": "add", "staffId": "DremuStaff1.g",
      "element": { "type": "Drag", "start": 22.125, "fields": { "laneName": "Main2R" } } },
    { "op": "add", "staffId": "DremuStaff1.g",
      "element": { "type": "Tap", "start": 22.25,  "fields": { "laneName": "Main2L" } } },
    { "op": "add", "staffId": "DremuStaff1.g",
      "element": { "type": "Taplik", "start": 22.375, "fields": { "laneName": "Main2R" } } }
  ]
}
```

If the run crosses a period boundary, that is fine when using absolute `start`:
the model places each note in the period covering its time. Check the result's
`created[].periodId` when organization matters.

## 3. Add a hold with inner notes

`start` is absolute; `holdTime` and inner-note `hitTime` are relative to the
hold.

```json
{
  "ops": [
    {
      "op": "add",
      "staffId": "DremuStaff1.g",
      "element": {
        "id": "verse-hold-1",
        "type": "Dremu.DremuHold",
        "start": 30.0,
        "fields": {
          "laneName": "Main2R",
          "holdTime": 1.5,
          "innerNotes": {
            "t": "arr",
            "type": "Dremu.DremuHoldInnerNote",
            "items": [
              { "t": "obj", "type": "Dremu.DremuHoldInnerNote", "fields": { "hitTime": 0.5 } },
              { "t": "obj", "type": "Dremu.DremuHoldInnerNote", "fields": { "hitTime": 1.0 } }
            ]
          }
        }
      }
    }
  ]
}
```

Supplying `id` is optional, but it lets later ops in the same batch patch the
new hold (for example `["holdLine"]`) without waiting for `created`.

## 4. Create and adjust in one batch

Use `element.id` / `newId` so the id is known before the result arrives.

```json
{
  "ops": [
    { "op": "add", "staffId": "DremuStaff1.g",
      "element": { "id": "new-tap-1", "type": "Tap", "start": 26.0, "fields": { "laneName": "Main2L" } } },
    { "op": "patch", "elementId": "new-tap-1", "path": ["position", "fields", "baseValue"], "value": -1.5 },
    { "op": "patch", "elementId": "new-tap-1", "path": ["positionZ"], "value": -1 }
  ]
}
```

## 5. Duplicate a phrase

`duplicate` deep-copies the element and shifts only its timing field. The copy
stays in the source period.

```json
{
  "ops": [
    { "op": "duplicate", "elementId": "DremuStaff1.g:p1:e2",  "timeShift": 2.0, "newId": "echo-1" },
    { "op": "duplicate", "elementId": "DremuStaff1.g:p1:e3",  "timeShift": 2.0, "newId": "echo-2" },
    { "op": "duplicate", "elementId": "DremuStaff1.g:p1:e26", "timeShift": 2.0, "newId": "echo-3" }
  ]
}
```

To copy into a **different** period, read the source element and `add` a fresh
one with the same fields at the absolute target time instead.

## 6. Move one element to an absolute time

`patch` writes relative values. With `timeOffset = 21.21053` and target
`T = 27.0`:

`hitTime = 27.0 - 21.21053 = 5.78947`

```json
{ "op": "patch", "elementId": "DremuStaff1.g:p1:e26", "path": ["hitTime"], "value": 5.78947 }
```

Batch related changes together:

```json
{
  "ops": [
    { "op": "patch", "elementId": "DremuStaff1.g:p1:e26", "path": ["hitTime"], "value": 5.78947 },
    { "op": "patch", "elementId": "DremuStaff1.g:p1:e26", "path": ["holdTime"], "value": 0.75 },
    { "op": "patch", "elementId": "DremuStaff1.g:p1:e26", "path": ["innerNotes", "items", 0, "fields", "hitTime"], "value": 0.375 }
  ]
}
```

## 7. Shift or resize a whole period

Always pass `staffId` — `p1` exists in several staffs.

```json
{
  "op": "setPeriodConfig",
  "staffId": "DremuStaff1.g",
  "periodId": "p1",
  "fields": { "timeOffset": 21.5, "minLength": 10 }
}
```

All elements in that period keep their relative times and move by the
`timeOffset` delta. Other periods are untouched — shift each affected period in
its own op.

## 8. Add a lane and a note pattern

Add the lane first, then notes with the same `name` as `laneName`. Use absolute
`start` for both; `keepTime` gives the lane a window that covers the notes.

```json
{
  "ops": [
    { "op": "add", "staffId": "DremuStaff1.g",
      "element": { "id": "lane-verse", "type": "MainLane", "start": 58.0,
                   "fields": { "name": "Verse1", "keepTime": 10 } } },
    { "op": "add", "staffId": "DremuStaff1.g",
      "element": { "type": "Tap", "start": 60.5, "fields": { "laneName": "Verse1" } } },
    { "op": "add", "staffId": "DremuStaff1.g",
      "element": { "type": "Tap", "start": 61.0, "fields": { "laneName": "Verse1" } } },
    { "op": "add", "staffId": "DremuStaff1.g",
      "element": { "type": "Hold", "start": 61.5,
                   "fields": { "laneName": "Verse1", "holdTime": 1.0 } } }
  ]
}
```

A main-lane note only renders when a lane with its `laneName` is alive at spawn
(`hitTime - leadTime`, default lead 1.5 s), so start the lane early enough.

## 9. Restyle a lane

Replace the whole colour curve:

```json
{
  "op": "patch",
  "elementId": "DremuStaff1.g:p1:e0",
  "path": ["color"],
  "value": {
    "t": "obj",
    "type": "GorgeFramework.LerpColorCurve",
    "fields": {
      "colorPoints": {
        "t": "arr",
        "type": "GorgeFramework.ColorArgb",
        "items": [
          { "t": "obj", "type": "GorgeFramework.ColorArgb",
            "fields": { "a": 1, "r": 0.2, "g": 0.8, "b": 1 } }
        ]
      }
    }
  }
}
```

Patch one leaf instead when the rest of the curve should survive:

```json
{ "op": "patch", "elementId": "DremuStaff1.g:p1:e0",
  "path": ["drawStartX", "fields", "baseValue"], "value": -8 }
```

## 10. Add a storyboard image

The storyboard staff holds `DeentyStoryboard.Image`; `start` is absolute.

```json
{
  "op": "add",
  "staffId": "DeentyStoryboardStaff.g",
  "element": {
    "type": "DeentyStoryboard.Image",
    "start": 10.5,
    "fields": {
      "assetName": "Background2.png",
      "keepTime": 4.0,
      "positionMode": { "t": "ref", "path": "DeentyStoryboard.ImagePositionMode.ScreenCover" },
      "alpha": { "t": "obj", "type": "GorgeFramework.VariableFloat", "fields": { "baseValue": 0.8 } }
    }
  }
}
```

Check `gorge_chart_get` → `project.assets.images` for valid `assetName` values.
`useChartTime: true` makes the image follow chart time.

## 11. Fix a lane warning

If validation says `unknown-lane`, either correct the notes or define the lane:

```json
{
  "ops": [
    { "op": "patch", "elementId": "DremuStaff1.g:p1:e2", "path": ["laneName"], "value": "Main2L" },
    { "op": "patch", "elementId": "DremuStaff1.g:p1:e3", "path": ["laneName"], "value": "Main2L" }
  ]
}
```

If the lane is genuinely missing, add a `MainLane` whose `name` matches and whose
`generateTime … generateTime + keepTime` window covers the notes.

## 12. Verify and save

1. `gorge_chart_get { staffId, lanes: ["Verse1"] }` — confirm `start`,
   `duration`, and lane.
2. `gorge_chart_validate` — expect no new `error`; `unknown-lane` /
   `inner-note-outside-hold` are the usual authoring slips.
3. `gorge_chart_save` — report `written` and any `errors`.

If a save reports `cannot serialise`, a patch stored a plain object/array in a
typed field (or a dead key was written). Re-read the element, fix the value tree,
and save again — no partial file is left behind.

## 13. Add an audio period (乐段)

Read `gorge_chart_get` → `project.audioPeriods` first. Reference an audio file
that is already in the project directory:

```json
{
  "ops": [
    { "op": "addAudioPeriod", "staffId": "Song.g", "file": "第二段.wav", "name": "第二段", "timeOffset": 64.5 }
  ]
}
```

Import a file from outside the project (`sourcePath` copies it in; the response
reports the stored project-relative name):

```json
{ "ops": [ { "op": "addAudioPeriod", "sourcePath": "/Users/me/Music/clip.wav", "name": "人声", "timeOffset": 0 } ] }
```

`created` lists the new clip as
`{ kind: "audioPeriod", audioPeriodId: "a1", method: "GetSong1", file, timeOffset, imported }`.
Omit `staffId` when there is one audio staff; a project with none gets a new
`Song.g`. The `@Song` half of the file then looks like:

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

`gorge_chart_validate` reports `missing-audio` when the relative path does not
resolve inside the project.

## 14. Move or remove an audio period

```json
{ "ops": [ { "op": "patchAudioPeriod", "staffId": "Song.g", "audioPeriodId": "a1", "fields": { "timeOffset": 70, "name": "副歌" } } ] }
```

```json
{ "ops": [ { "op": "removeAudioPeriod", "staffId": "Song.g", "audioPeriodId": "a1" } ] }
```

To undo a removal, re-add it with the same `file`, `name`, `timeOffset` and the
old `method`; the audio file is left on disk by `removeAudioPeriod`.
