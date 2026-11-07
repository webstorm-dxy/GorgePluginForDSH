# Dremu 谱面工坊 · Dremu Chart Studio

A DeepSeek Harness bundle that adds a **full-page chart editor for Gorge / Dremu
`.g` chart projects** to the Harness Web UI, plus Host tools so the agent can
read, edit, generate, and package the same chart.

Editing logic and layout follow [rpe-next](https://github.com/kclg-YSJ/rpe-next)
(Re:PhiEdit Next, a Phigros chart editor): a horizontal time axis with a snapping
beat grid, direct manipulation, an inspector with per-field editors and a docked,
beat-aligned curve panel, undo/redo, and audio playback. The chart format is the
Gorge framework declarative `.g` format used by the Dremu chart projects on this machine
(`~/Music/DremuTest`, `~/Music/Chart/**`).

> 界面语言：中文（可在插件配置里切换到 English）。

---

## What it does

* **Opens a chart project folder** — every `.g` staff file is parsed, the periods
  are flattened onto one absolute-time axis, and assets (WAV/MP3/PNG) are served
  to the page with HTTP Range support so audio scrubs and plays.
* **Creates a brand-new project** — **新建项目 / New project** in the header
  (also on the empty page and in the 打开项目 dialog) asks for a folder name, an
  existing parent folder (defaults to `projectRoot`), a starter template (blank
  chart, or chart + storyboard) and the initial period length. The Host writes
  `DremuStaff.g` (plus `Storyboard.g`) immediately, so the new project opens
  clean and its next save already has a real folder. An existing **empty**
  folder is adopted; a non-empty one is refused instead of overwritten. The same
  flow is available to the agent as `gorge_project_create`.
* **Grouped by staff (谱表)** — the timeline gutter and the element list are grouped by
  staff: one header per `.g` staff (`表演 · DremuStaff`, `Storyboard · DeentyStoryboardStaff`, …)
  with its lane/file counts, and the lanes indented underneath. Click a header to
  collapse or expand that staff's rows. A row no longer repeats the staff name.
* **Add staffs and elements from the left list** — the **+** beside 谱表 creates a
  new chart or storyboard `@ElementStaff` (header + one empty `@Chart` period,
  written to a new `.g` on the next save); the **+** beside 元素 opens the element
  catalog and inserts the chosen type at the playhead, into the selected staff —
  lanes get a unique name and storyboard images pick the project's first image.
  Created staffs are undoable (their `.g` is removed again) and agent edits can
  create staffs the same way through the `addStaff` op.
* **Audio periods (音频乐段)** — an audio staff (`@AudioStaff`) holds one or
  more `@Song` clips; the **+** on its 谱表 row opens a dialog that appends one:
  pick a project audio file or import one from this computer (the file is copied
  into the project directory), set the chart start time, and save. Every clip
  gets a timeline row you can drag in time, its waveform is drawn at its offset
  in the waveform strip, and playback runs all clips together (the preview
  shares the same multi-clip transport). Drag a clip's bar to move it; the left
  list seeks to a clip and can remove it (the audio file stays on disk). Agent
  edits use `addAudioPeriod` / `patchAudioPeriod` / `removeAudioPeriod`, with
  rename available through `patchAudioPeriod`. When the project has no audio
  staff yet, the audio button in the 谱表 header creates `Song.g` together with
  the first clip.
* **Right-click a staff to rename or delete it** — the context menu on every
  谱表 row edits its alias (the `.g` header `displayName`, one undoable
  `setStaffName` op) or deletes the staff. Deletion asks for confirmation, then
  removes the `.g` and its `.bak` from disk (`removeStaff` with `deleteFile`);
  it is permanent and not undoable.
* **Timeline editing** — one row per lane name (`DremuMainLane`, `DremuGuideLane`);
  a row shows every lane element that carries that name (charts reuse names across
  periods: `DremuStaff2.g` has 82 lane elements over 33 names), plus its notes
  (`DremuTap`, `DremuDrag`, `DremuHold`, `DremuTaplik`), hold bodies and inner-note
  ticks; storyboard images and unknown element types get their own rows so nothing
  is lost.
* **Direct manipulation** — drag an element to move it in time, drag its right
  edge to change `keepTime` / `holdTime`, box-select, ⇧-click to extend the
  selection, double-click empty space to place the current tool.
* **Judgement-line note editor (判定线音符编辑器)** — double-click a lane strip
  (select tool) or its gutter/label to open a vertical editor for that one lane:
  horizontal note `position` on a 0.5-column grid, vertical `hitTime` on the
  project BPM/offset beat grid, a fixed judgement line near the bottom (future
  above it), and the audio spectrogram down the far-left edge. `Q` / `W` / `E` /
  `R` pick Tap / Drag / Taplik / Hold, click to place (drag a Hold to set its
  length); drag notes to retime and reposition, drag a Hold's tail to resize,
  box-select/delete, nudge with the arrow keys, or edit the selected note in the
  inspector. The lane strip's label also opens the editor while a placement tool
  is active; every gesture is one undo step, and the header back button / `Esc`
  returns to the timeline without losing its view.
* **Inspector** — every field of the selected element, rendered from the catalog
  (numbers, strings, booleans, enums, `VariableFloat`, `Vector2`, `ColorArgb`,
  function curves, arrays of `FunctionPiece`, and a raw "other fields" section
  for anything the catalog does not describe).
* **Nested values** — object cards inside the inspector/curve sidebar use a
  compact 72px label column (the outer element rows stay 104px) so a `Vector2`
  or `ColorArgb` nested two or three levels deep still has usable number/colour
  inputs instead of being squeezed to a sliver.
* **Optional fields** — every optional catalog field has a checkbox: the
  `variationCurve` of a `VariableFloat` (位置 X/Y, 旋转 Z, draw ranges, …), the
  `color` / `respondHintColor1/2` of notes and lanes, `LerpColorCurve.colorPoints`
  and `progressCurve`, and an optional `FunctionPiece.functionCurve`. Checking
  adds the catalog default (a new curve is a flat zero `LinearCurve`), unchecking
  removes the field again — nested fields disappear from their parent object and
  top-level fields from the element's field map, so the `.g` file goes back to
  the omitted form.
* **Docked curve panel** — the inspector's curve button opens a full-size
  segment editor in the center pane (the timeline area, while the header,
  toolbars, side panes and transport stay reachable). X is the curve's own
  relative time in seconds; beat ticks and snapping follow the main timeline's
  BPM/offset and the toolbar's snap division, anchored at the selected element's
  start time. The panel docks **under the timeline's content** in the lower part
  of the center pane: the ruler/rows/waveform stay visible above, the curve
  editor fills the remaining height (the timeline gets its measured content
  height, capped at 58%, so the editor keeps at least 42%). The x view is
  **live-synced** with the main timeline: it uses the main timeline's current
  `t0`/pixels-per-second and the same 148px time gutter, so beat lines line up
  vertically with the main ruler visible above; scrolling or zooming the main
  timeline moves the panel, and horizontal wheel/pan/zoom on the panel drives the
  main timeline, so both stay on the same `t0`/pps. The panel's time labels stay
  relative to the element; its **fit** button fits the project's timeline (both
  views), while reset only resets the curve. Curves stored in arrays
  (`laneLines`, etc.) get the same curve button, not only top-level fields.
  A plain function curve opens as **one synthetic segment** and keeps
  its type; adding a second segment or dragging a segment boundary converts it to
  `PiecewiseFunctionCurve`. Right-click the plot for **新建段 / 修改函数类型 /
  删除段** (the type is chosen from the function list); segment boundaries can be
  dragged (they stay shared, so there are no gaps/overlaps), and the selected
  segment exposes draggable per-type parameters — constant value, `kx+b` handles,
  `LinearCurve` keys, spline endpoints/tangents, periodic/axial guides and inner
  curves. The panel is stacked: the plot/ruler/segment band occupy the full-width
  top, and the **properties** area below holds the segment list, type selector,
  boundary/flags, complete numeric editor and value-jump warnings (it scrolls if
  tall). A value-jump warning card has an **自动修复** button: it vertically
  shifts the right segment so the shared boundary value matches the left
  (composite/unknown curves are wrapped in an Addition with a constant offset),
  leaving all segment times and outer ±∞ bounds untouched; review the draft and
  Apply. One Apply = one undo step;
  an untouched Apply writes the original value back unchanged.
* **Auto BPM** — the inspector's BPM row has a **自动 BPM** button. It derives a
  low-band-weighted spectral-flux onset envelope from the cached spectrogram,
  runs a Goertzel tempogram over 60–200 BPM (harmonic support + a mild tempo
  prior), and writes the result through `setMeta.tempo` so the beat grid and
  transport update immediately. The BPM field stays editable afterwards.
* **Waveform / spectrum view** — right-click the audio strip above the lanes to
  switch between the per-clip **waveform** and a **spectrogram** (log-frequency
  heat map, computed from each clip's samples with a 1024-point STFT at up to
  8192 × 128 resolution and cached per file). The choice is remembered in
  `localStorage`.
* **Playback** — a waveform band per audio clip, play/pause, seek, rate
  (0.25×–2×), follow-playback auto-scroll.
* **Playback preview (播放预览, autoplay / playback only)** — the header's preview
  button embeds a 16:10 Canvas-2D rendering of the Dremu playfield **in the
  timeline pane** (`.dgc-center`); the editor header, left lists and inspector stay
  visible. It is ported from the Unity form renderer: judgement lines from
  `laneLines` + `animation`, notes and hold
  bodies from their `distance` / `position` curves, `LerpColorCurve` colours, the
  16:10 camera framing, the autoplay look (note head disappears at the hit) and
  the `DremuRespondHint` diamond/heart hit effects plus `RespondEffect.wav`.
  Playback only — no signals, judgement, scoring, HUD or hold `innerNotes`.
  `Space` play/pause, `Esc` close, `←` / `→` seek. The ported model
  is specified in `docs/playback-model.md`.

  ![Embedded playback preview](docs/media/playback-embedded.png)
* **Undo/redo, copy/paste, duplicate, nudge** — all edits are queued as op
  batches, so each gesture is exactly one undo step.
* **Saves the real `.g` files** — atomic writes with a `.g.bak` of the original
  content on the first save of a session. The codec is byte-exact: opening and
  saving an untouched project reproduces every file byte for byte.
* **Exports a shareable chart ZIP (导出 ZIP)** — the header button packages the
  **live** document as `<project>.zip`, so unsaved edits are included without
  saving first. The archive holds a `<project>/` folder with every `.g` staff,
  `README.md`, and the audio/images the chart actually references (storyboard
  `image:<name>` references and `@Song` clip paths are resolved); unreferenced
  files are reported as skipped instead of bloating the package. The browser
  streams it to the download folder with a progress readout; `gorge_chart_export`
  does the same for the agent and writes the zip next to the project.
* **Agent tools** — the same document is exposed as
  `gorge_project_list` / `gorge_project_open` / `gorge_project_create` /
  `gorge_chart_get` / `gorge_chart_edit` / `gorge_chart_save` /
  `gorge_chart_export` / `gorge_chart_validate` / `gorge_element_schema`, and a
  one-line workspace summary is injected into the system context. Agent edits
  appear live in the open editor.
* **Bundled agent skill** — `dremu-chart-editing` ships with the bundle and is
  registered on the Harness `skills` service: when to use it, the
  absolute-vs-period-relative timing rules, typed value trees and patch paths,
  element semantics, common errors, and copy-ready op batches
  (`skills/dremu-chart-editing/SKILL.md` + `references/`). It is loaded through
  the `skill` tool like any other skill and appears after the Host starts with
  this bundle enabled.

## Install

The bundle lives in this directory. In a Harness session with Full access:

```
plugin_manager { action: "install_bundle", target: "<path to this checkout>" }
```

Installation links the checkout, so later edits in this directory are live after
a page refresh (a replaced JavaScript module needs a restart, as with any
bundle). In particular, new-project creation, adding/importing audio periods and
the ZIP export need the **new Host half**: after upgrading this bundle, quit and
reopen the app before using the 新建项目, audio or export buttons. The plugin
appears in **Settings → Plugins** as “Dremu 谱面工坊” and in the sidebar panel
list (a golden lane glyph); clicking it opens the studio in the main panel.

## Use

1. Click the sidebar glyph. To start from scratch, click **新建项目**: enter a
   folder name, the existing parent folder (prefilled with `projectRoot`), the
   starter template (blank chart or chart + storyboard) and the initial length;
   the Host writes the `.g` files and opens the project. To open an existing
   chart, click **打开项目** → pick a folder (`~/Music/DremuTest`,
   `~/Music/Chart/Chart 2`, …) or type an absolute path. The library list is
   scanned from the configured `projectRoot` (default `~/Music`).
2. Click **+** next to 谱表 to create a new staff, **+** on an audio staff row to
   append an 音频乐段, or **+** next to 元素 to pick a type and insert it at the
   playhead; the left list updates immediately.
3. Pick tools in the toolbar (or `V` select, `Q` tap, `W` drag, `E` hold,
   `T` lane), set the snap division, and double-click the timeline to place.
   To edit one judgement line note-by-note, select a lane strip and
   double-click it (or double-click the lane's gutter/label) to open the note
   editor; `Esc` or 返回时间轴 goes back.
4. Select something and edit it in the right-hand inspector; optional fields
   (for example a `VariableFloat`'s `variationCurve`) are enabled with their
   checkbox, and a curve field's curve button opens the docked curve panel in
   the center pane (apply/cancel returns to the timeline).
5. `Ctrl/Cmd+S` saves. Autosave is on by default (`autoSave` in the plugin
   config) and debounces to the same atomic writer.
6. Click **导出 ZIP / Export ZIP** in the header to download the current chart as
   a `<project>.zip` package. No save is needed first: staff files come from the
   live document, referenced assets and `README.md` are copied in, and the toast
   reports the file name, size and how many unreferenced assets were left out.
7. Click **播放预览 / Play preview** in the header: the Autoplay playfield
   (audio + canvas) replaces the timeline pane, while the editor header and side
   panes stay visible. `Space` play/pause, `Esc` closes; the preview bar below the
   canvas has restart, seek, rate, mute and a storyboard-background toggle.

### Shortcuts

| Key | Action |
|---|---|
| `V` / `Q` / `W` / `E` / `T` | select / tap / drag / hold / lane tool |
| `Space` | play / pause |
| `Delete` / `Backspace` | delete selection |
| `Ctrl/Cmd+Z`, `Ctrl/Cmd+Shift+Z` / `Ctrl+Y` | undo / redo |
| `Ctrl/Cmd+S` | save |
| `Ctrl/Cmd+A` | select all elements |
| `Ctrl/Cmd+C` / `Ctrl/Cmd+V` | copy / paste at the playhead |
| `Ctrl/Cmd+D` | duplicate (+1 grid step) |
| `←` / `→` | nudge selection one grid step (seeks when nothing is selected) |
| `1`…`8` | snap division 1/1 … 1/16 beat |
| `+` / `-` / `0` | zoom in / out / fit |
| `Home` | back to 0:00 |
| `Esc` | clear selection / select tool |
| `Space` / `Esc` (playback preview) | play/pause, close the preview |
| `←` / `→` (playback preview) | seek backwards / forwards |
| `Q` / `W` / `E` / `R` (note editor) | Tap / Drag / Taplik / Hold tool |
| `↑` / `↓` (note editor) | nudge selected notes in time (Shift ×4) |
| `←` / `→` (note editor) | nudge selected notes in position (Shift ×2) |
| `+` / `-` / `0` (note editor) | zoom in / out / reset |
| `Esc` (note editor) | clear selection, then close the editor |

Mouse: wheel scrolls lane rows, `Shift`+wheel scrolls time, `Ctrl`+wheel zooms
around the pointer, middle-drag or `Alt`+drag pans, drag on the ruler scrubs.
In the note editor: wheel seeks, `Ctrl`+wheel zooms, click the spectrum/ruler to
seek, `Alt` temporarily disables snapping, and dragging a Hold's tail changes
its length. Double-click a lane strip (select tool, or its label/gutter in any
mode) to open the note editor. Right-click a 谱表 row (or a staff group header
in the element list) to rename its alias or delete it.

## Plugin configuration

Set keys in the plugin row's `config:` block in the profile's
`cordis.patch.yml` (`dsh plugin --profile desktop` manages that file). The
loader validates the row through `Config['~standard'].validate`; the plugin
intentionally has **no Settings form** (its `Config` must not pose as a
Schemastery schema — a `toJSON()` lookalike crashes `settings/describe` and
aborts desktop boot with `desktop welcome: Web RPC failed`).

| key | default | meaning |
|---|---|---|
| `projectRoot` | `~/Music` | folder scanned for chart projects (directories containing `*.g`) |
| `autoSave` | `true` | debounce-save edits to disk; `false` keeps edits in the Host until an explicit save |
| `locale` | `zh` | display language hint for the Host half |

## Architecture

```
package.json          bundle manifest (dsh.bundle.patch + dsh.client)
cordis.patch.yml      inserts the loader row
index.js              Host half: project store, HTTP/SSE, agent tools, prompt context
gorge-codec.js        .g text <-> typed value tree, byte-exact writer (no I/O)
dremu-model.js        chart model: catalog, project create/load/save, timing, op application
gorge-zip.js          chart package export: dependency-free ZIP writer + asset selection
skills.js             bundled skill provider registered on ctx.skills
skills/dremu-chart-editing/  agent skill: SKILL.md + references (tools/ops,
                      element fields, recipes)
client.js             browser half: the whole editor UI (one self-contained file)
locale/{zh,en}.json   display metadata
docs/                 gorge-format-spec.md (the .g text format),
                      playback-model.md (the Unity → Canvas playback port),
                      note-editor.md (judgement-line note editor geometry/ops)
tests/                codec / model / host / skill / client smoke tests (plain node scripts)
```

`client.js` stays one file because the bundle loader serves exactly one client
module per package. It is organized as numbered sections (`// 07 · Audio`,
`// 15 · Timeline canvas`, `// 15.5 · Judgement-line note editor`, …).
`index.js`, `dremu-model.js` and `gorge-codec.js`
follow the same convention — numbered section banners plus a section map in the
file header — so each file's top comment tells you where to jump.

Data flow: the browser keeps an optimistic copy of the project. A gesture
becomes an op batch (`patch` / `add` / `remove` / `setMeta` / …) that is applied
locally and POSTed to `/plugins/gorge-chart/edit` with `{baseRev, ops}`; the Host
applies it to the canonical model, bumps the revision, autosaves and notifies SSE
subscribers. When the revision was not produced by this tab (an agent edit), the
page refetches `/state`. `.g` serialization always happens on the Host.
`GET /export` reuses that live model: it serialises every staff (unsaved edits
included), packs the referenced assets from the project folder and returns one
ZIP, so the download and the agent tool share the same package builder.

## Format notes

A staff file is a tiny declarative program:

```
[
    string form = "Dremu",
    string displayName = "Dremu谱表"
]
@ElementStaff
class DremuStaff
{
    [
        PeriodConfig^ config = PeriodConfig : {
            timeOffset : 0.0,
        }
    ]
    @Chart
    static Element^[] Period()
    {
        return new Element^[1]{
            DremuTap : {
                laneName : "mainLine01",
                hitTime : 2.842105,
            },
        };
    }
}
```

* A class can declare many period methods (`Period`, `Period1`, …); each has its
  own `timeOffset` (absolute start in seconds) and element times inside it are
  relative to that offset. The editor flattens them.
* Values are typed object/list literals (`Type : {...}` / `Type^ : {...}`),
  enum references, numbers, strings, and the occasional `(-1.0/0.0)` ±Infinity
  expression.
* The writer is canonical and byte-exact against the entire corpus in
  `~/Music/DremuTest` and `~/Music/Chart/**` (see `tests/codec.test.mjs`).

## Development

```
node tests/codec.test.mjs        # 12/12 corpus files byte-exact + 37 codec checks
node tests/model.test.mjs        # 71 checks: load/save fidelity (CRLF + LF), create, ops, audio periods, catalog
node tests/host.test.mjs         # 43 checks: store, create/open, HTTP handlers, export ZIP, audio import, tools, Range, recovery
node tests/skill.test.mjs        # 15 checks: skill document, examples, provider, registration
node tests/client-smoke.mjs      # mounts the page in a tiny React runtime (fixture project)
GORGE_SMOKE_REAL=1 node tests/client-smoke.mjs
                                 # ... and again against the real DremuTest project
node tests/fixtures/review-undo-repro.mjs
                                 # regression harness with React-18 batching semantics
```

The client harness is a deliberately small React-compatible runtime (function
components, hooks with real dependency memoisation, refs, host elements) plus the
browser globals the bundle touches. It asserts the page renders, the timeline
paints, selecting an element fills the inspector, the docked curve panel opens and
applies, right-click segment creation/type change/delete and boundary drags emit
the expected piecewise patches, the client curve sampler matches the Host
`evaluateCurve`, dragging a note emits `patch(hitTime)`, undo emits the inverse
patch, redo restores it, and placing a Tap emits an `add` op with the row's lane.
The judgement-line note editor is exercised end-to-end too: the lane strip's
double-click (and the label/gutter shortcuts) opens it, the canvas paints the
spectrum caption, judgement-line label and beat numbers, `Q`/`W`/`E`/`R` create
the four note types with snapped `hitTime`/`position`/`holdTime`, dragging a note
patches both time and position, a Hold tail drag patches `holdTime`, box-delete
emits `remove` ops, a spectrum scrub keeps the pointer-down time anchor (so the
playhead cannot run away while scrubbing), and `Esc`/the back button return to
the timeline. The new-project flow is also mounted end-to-end: the header button
opens the dialog with `projectRoot` prefilled, an invalid name is rejected inline
without a request, choosing the storyboard template and a custom length posts
`{ name, parent, template, minLength }` to `POST /create`, and the answered state
closes the dialog, shows the success notice and adopts the new project.

## Verification status

* **Host half is live in this profile** (`plugin_manager` reports the bundle
  enabled; `application: applied`). Host-side changes (new create/audio ops and
  the `/create`, `/import-audio` and `/export` routes) take effect on the next
  Host start; the client half loads on a page refresh. Verified over HTTP from a
  shell: `/state` returns the catalog, `/projects` lists 6 chart folders,
  `/create` writes and opens a starter project, `/edit` round-trips, `/file`
  serves Range requests, and `/export` streams a zip that `unzip -t` reports as
  valid.
* **New-project creation is covered by the Node and client suites**:
  `validateProjectName` rejects separators, hidden/trailing-dot names and long
  names; `create: ...` writes `DremuStaff.g` (and optionally `Storyboard.g`),
  adopts an existing empty folder, refuses a non-empty one with 409, and rolls
  back a failed empty folder; the HTTP handler answers 200/400/409 and the agent
  tool creates, opens and immediately edits a project; the client smoke test
  covers the dialog, inline validation, POST body and adopted state.
* **Audio periods are covered by the Node suites**: `addAudioPeriod` writes a
  second `@Song` (save → reload keeps both clips and the 32 s duration),
  external files are copied under unique project-relative names, patch/remove
  round-trips, auto-creating `Song.g` works, and the HTTP import endpoint is
  limited to local requests, audio extensions and a bounded body.
* **Chart ZIP export is covered by the Node and client suites**: `gorge-zip.js`
  round-trips through a central-directory reader that checks both headers, the
  UTF-8 name flag and every CRC; the package carries unsaved staff edits, the
  referenced storyboard images and `@Song` audio, the README, and never a `.bak`;
  `assets=all|none` are honoured; the HTTP handler answers `application/zip`
  with download headers; and the page smoke test turns the response into one
  `download` link with the Host-provided name and the success notice.
* **Agent tools verified live**: `gorge_project_open` opened
  `~/Music/DremuTest` (5 staffs / 506 elements / 137.421 s), `gorge_chart_get`
  returned the flattened chart, `gorge_chart_validate` returned 0 issues.
* **Bundled skill is registered and loadable**: `tests/host.test.mjs` asserts
  `apply` registers the `gorge-chart` provider (one `dremu-chart-editing`
  candidate, rank 600) and disposes it; `tests/skill.test.mjs` parses the skill,
  checks every reference link/JSON example, and exercises `list` / `get` /
  registration. In this development checkout the same skill is also linked into
  the gitignored `.dsh/skills/` project root, so the live session catalog and
  the `skill` tool were verified without a restart; the provider path takes over
  on the next Host start.
* **Corpus safety**: codec and model suites copy the real projects to temp dirs;
  the read-only corpus is hashed before/after and asserted unchanged.
* **Playback preview is asserted structurally** by the client smoke suite:
  `node tests/client-smoke.mjs` and `GORGE_SMOKE_REAL=1 node tests/client-smoke.mjs`
  check the preview model and frame sampler (lanes / notes / holds / colours, on
  the fixture project and on the real `DremuTest` project), the guide-lane node
  transform, and that the preview mounts **inside `.dgc-center`**, paints and closes.
* **Playback preview was checked visually** with headless Chrome against the real
  page code + `DremuTest` (screenshots at many chart times, holds around 26 s,
  guide/effect scenes around 11 s): note sprites, lane/guide-line orientation,
  hold bodies, storyboard backgrounds, hit diamonds/hearts and camera scale were
  compared with the Dremu gameplay reference video. The reference is a
  *different* chart (`enchanted love`), so it validates semantics, not pixel
  identity; an exact frame diff needs that chart's `.g` project.
* **Lane/hold geometry was cross-checked against the Godot adaptor** running the
  same `DremuTest` chart: at t=4.352s (animated ArtLine) and t=26.20s (hold) the
  lane/hold positions and shapes now agree. This cross-check found and fixed two
  real curve bugs: weighted `CubicHermiteSpline` tangents were not normalized by
  the y span (drawStart/End overshot), and `PiecewiseFunctionCurve` bounds using
  `expr Infinity` were skipped (the holdLine tail was lost). The run lacked
  `DeentyStoryboard` and the nine-slice extension, so only lanes/holds/hearts
  were comparable; the `DremuRespondHint` ring uses the same Gorge nine-slice
  algorithm as the Godot adaptor's `draw_gorge_nine_slice`.
* **Hit sound** is the form's `RespondEffect.wav` (played once per hit while
  playing, muted with the song); headless Chrome counted the `Audio.play()`
  calls (`13` hit sounds over 4.5 s of a dense section).
* **Docked curve panel is covered by the client smoke suite**: the panel renders
  inside `.dgc-center`; a plain curve shows one synthetic segment and an untouched
  Apply round-trips the value; right-click + type choice creates a contiguous
  second segment; the sidebar type selector keeps a single segment's plain type;
  dragging a boundary changes its time and converts a plain curve; deleting a
  segment transfers its span to a neighbor; the pure helpers (`__curve`) are
  asserted against the Host `evaluateCurve` for piecewise open bounds,
  axial/periodic defaults, addition field names, flat splines and composite
  evaluation. Both fixture and `GORGE_SMOKE_REAL=1` modes pass.
* **Optional fields are covered**: checking a missing optional colour adds the
  catalog default, unchecking it removes the field through a whole-fields patch;
  checking a tap's `VariableFloat.variationCurve` adds a flat-zero `LinearCurve`,
  preserves `baseValue`, exposes the curve button, and applying an edit
  (`valueEnd` 0.5) patches exactly `[position, fields, variationCurve]` and is
  still 0.5 when the panel is reopened; a real `DremuTest` lane exposes its
  nested `variationCurve` checkbox too. The suite also asserts that the curve
  center enters the split layout (`has-curve`), the curve layer is a flow child
  after the timeline (not an absolute overlay), the timeline content height is
  passed into `--dgc-timeline-h`, the aligned view puts relative x=0 and x=1 at
  the main ruler's x positions for a 148px gutter / 46px-per-second view, zooming
  the main toolbar repaints the panel's beat grid and restoring it returns the
  grid, scrolling the panel's plot changes the shared view and scrolling back
  restores it, and a curve inside an array opens with an item path
  (`['curves','items',0]`). The auto-fix helper is asserted on two-segment,
  multi-boundary cascade and composite cases (the composite is wrapped as an
  addition offset); the UI test edits a constant to 999, clicks the warning
  card's auto-fix, applies, and checks the boundary samples meet.
* **Editor page** is still exercised structurally by `tests/client-smoke.mjs`;
  refresh the Web UI and open the sidebar glyph to confirm layout/theming.

No dependencies, no build step: the Client half is plain browser JavaScript in
the module-loader format and only imports `react` from the Harness module table.
Styling uses `--dsw-alias-*` theme tokens, so the page follows the shell's light
and dark themes.

## Known limitations

* The playback preview implements the Autoplay **chart layer** (lanes, notes,
  holds, storyboard, `DremuRespondHint` diamonds/hearts and `RespondEffect.wav`),
  but not the game's **UI layer** (score/combo/judgement HUD/pause menu) or
  Unity's bloom/shader pass. It is a visual preview, not a playable build.
* The judgement-line note editor is a focused 1D view: it positions notes from
  `VariableFloat.baseValue` (a `variationCurve` is editable in the inspector but
  not previewed on the canvas), draws future above a fixed bottom judgement
  line, and shows positions only in ±5.5 world units. It is an authoring view,
  not the playfield; use the playback preview for the rendered chart.
* The timeline is a chart editor, not the game renderer: it shows element
  time extents, not the playfield. The playback preview draws the playfield, but
  as a **Canvas-2D approximation** — line caps/joins follow the CurveSprite
  prefab (`numCapVertices=10` round caps, `numCornerVertices=0` miter corners);
  blending and Unity's material/bloom pass are close to, not pixel-identical
  with, the real renderer.
  `positionZ` ordering and the nine-slice hit ring are implemented exactly;
  curves are still edited as data and previewed as plots.
* Only the element fields present in the catalog get friendly labels; other
  fields are editable in the "其它字段" section but shown by their raw names.
* The curve panel's X axis is the curve's own relative seconds, not absolute
  chart time. Beat ticks use the selected element's start as the origin, which is
  exact for note `hitTime` / lane `generateTime` curves but approximate for
  release-relative curves (a hold's `endDistance` is relative to release time).
* Segment **time** continuity is enforced (shared boundaries, no gaps/overlaps);
  **value** jumps are only marked (`!` on the plot + sidebar list), never smoothed
  automatically. Composite curves are edited numerically (their outer input is
  the inner output, so there is no direct time handle).
* `.g.bak` backups are written next to the staff files (once per session per
  file). They are plain copies; the editor does not prune them.
* The page re-renders on the transport clock while playing (the left list, the
  inspector and the docked curve panel are memoised, the timeline paints through
  its own rAF loop).
* A Host refresh (agent edit, reload, conflict) replaces the local document and
  clears the client-side undo stack: the document on disk is the source of truth.
  Audio-period edits refetch the canonical clip metadata after the batch while
  keeping their undo entry.
* The playback preview is playback only: no chart signals, judgement, scoring,
  combo/HUD, and no hold `innerNotes`. `DremuRespondHint` diamond/heart hit
  effects and `RespondEffect.wav` are implemented; Unity bloom/shader is not.
  Storyboard backgrounds work for `DeentyStoryboard.Image` behind a toggle;
  `StoryboardVideo` is not supported.
* On a Host restart the last project is reopened from the recovery snapshot and
  accepted-but-unsaved op batches are replayed when `autoSave` is false.
* ZIP export inventories top-level project files only (like the editor's asset
  list). A referenced asset in a subfolder, or one named only inside an unknown
  element type, is not auto-detected; use `gorge_chart_export { assets: "all" }`
  (or `/plugins/gorge-chart/export?assets=all`) for a full folder copy.
