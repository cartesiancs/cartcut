# What the E2E suite found

Everything here was found by running the suite against `main` at the commit it
was written on. Each item says how to reproduce it and how confident the
evidence is. Nothing here has been fixed — the suite reports, it does not
repair.

---

## 1. A third to two thirds of exported frames show the previous source frame

**Severity: high.** Worst at 60 fps, which is the app's own default and the only
rate its UI allows.

### What happens

The exported file shows source frame `N-1` at output frame `N`, for a large and
regular fraction of every export. Both figures below are measured end to end,
by reading a frame index burned into the source clip back out of the delivered
file — every frame of it, not a sample:

| profile | frames | wrong | share | offsets |
|---|---|---|---|---|
| smoke — 640x360 @ **30** | 600 | 206 | **34.3 %** | `-1` only |
| full — 1920x1080 @ **60** | 18,000 | 12,029 | **66.8 %** | `-1` only |

The wrong frames are perfectly regular, not scattered.

At 30 fps the ordinals where `N mod 3 === 2` are wrong, and the decoded index
sequence reads `0, 1, 1, 3, 4, 4, 6, 7, 7, 9, 10, 10, …`.

At 60 fps *two* frames in every three are wrong — the run-length encoding shows
`{from:1,to:2}`, `{from:4,to:5}`, `{from:7,to:8}` … — and the sequence reads
`0, 0, 1, 3, 3, 4, 6, 6, 7, 9, 9, 10, …`. Source frames 2, 5, 8, 11 … are never
shown at all. A 60 fps timeline of 60 fps footage delivers roughly 40 distinct
source frames per second, with judder, in every export.

### Why

`features/export/renderTimeline.ts` asks for each frame at exactly its boundary:

```
frameTimeMs(N, fps) = (N / fps) * 1000
```

and `features/asset/loadedAssetStore.ts#seek` turns that into

```
video.currentTime = sourceTimeAt(element, time) / 1000
```

Chromium stores that assignment as whole **microseconds**. Whenever `1e6 / fps`
is not an integer, truncating the boundary lands one microsecond *below* the
frame's presentation timestamp, and the decoder then correctly returns the
previous frame.

Measured in the running app — requested `0.0666667`, `video.currentTime` read
back `0.066666`, and the composited frame carried index 1 instead of 2.

That the truncation is real is not inferred — it was read back out of the
running app.

**How far the model goes, and where it stops.** A simple model of "truncate the
request to microseconds, then take the frame whose PTS is at or below it"
predicts the 30 fps result exactly, including which ordinals are affected:

| fps | model predicts | measured |
|---|---|---|
| 24 | 33 %, `n mod 3 === 1` | not measured |
| **25** | **0** — `1e6/25 = 40000`, exact | not measured |
| 30 | 33 %, `n mod 3 === 2` | **34.3 %, `n mod 3 === 2`** ✓ |
| **50** | **0** — `1e6/50 = 20000`, exact | not measured |
| 60 | 33 %, `n mod 3 === 1` | **66.8 %, two in three** ✗ |

At 60 fps the damage is **twice** what the model predicts, so something beyond
plain truncation is compounding it — the container timebase the demuxer reports
PTS in, or a second rounding inside the media pipeline. The mechanism above is
demonstrated; the exact arithmetic at 60 fps is not yet fully accounted for, and
the per-rate shares in the table should be treated as measured where marked and
unverified otherwise. The rates predicted to be exempt (25 and 50) have not been
confirmed by measurement.

The float arithmetic in `frameTimeMs` is *not* at fault — `(N/fps)*1000/1000`
round-trips exactly for every N tested. Nothing here is a floating-point bug in
the app's own code.

### Reproduce

```
npx playwright test -c tests/e2e/playwright.config.ts --project=smoke seek-diagnosis.spec.ts
```

The attached `seek-samples.json` lists requested time, `video.currentTime` as
read back, and the frame index decoded off the composited canvas, per frame.

The full assertion lives in `stress.spec.ts` under "every one of the exported
frames carries its own index", and reports the offsets and the affected runs.

### The shape of a fix

Aim at the middle of the frame's interval rather than its edge, so quantisation
in either direction stays inside the right frame. The same trick is already used
on the extraction side of this suite (`decode.ts#singleFrameCommand` seeks to
`(N - 0.25) / fps` for exactly this reason). A half-frame bias in
`loadedAssetStore#seek` would do it:

```
const want = (sourceTimeAt(element, time) + 500 / projectFps) / 1000;
```

Not applied here — it changes export output for every user and wants its own
review and its own unit tests. `MIN_ALIGNMENT_MARGIN` in
`harness/compare.ts` documents a second-order consequence: while frames are
duplicated, neighbouring output frames are genuinely similar, so the ticker
alignment search legitimately cannot separate them.

Whatever the fix, it should be validated by running the suite at 30 **and** 60
fps — the 60 fps case is twice as bad and is not explained by truncation alone,
so a fix verified only at 30 fps may leave most of the damage in place.

---

## 2. `add_media` ignores three of its documented parameters

**Severity: medium.** The MCP tool advertises placement control it does not have.

`electron/mcp/tools/media.ts` declares per-item `startMs`, `durationMs` and
`trackId`:

```ts
items: z.array(z.object({
  path: z.string(),
  startMs: z.number().optional(),
  durationMs: z.number().optional(),
  trackId: z.string().optional(),
}))
```

`apps/app/src/features/agent/commands/media.ts` reads none of them. It uses only
the batch-level `params.startMs` and `params.sequential`, then hands everything
to `placeImported`. A caller asking for a three-second clip on a named track
gets a clip of the source's full length on whichever track placement chose.

Observed: two clips requested at `startMs` 0 and 3000 with `durationMs` 3000 and
an explicit `trackId` came back 30021 ms and 25021 ms long, on two *different*
tracks, overlapping.

The suite works around it in `scenario/kitchenSink.ts#addMediaAt` by following
each import with `trim_clip` and `move_clips`, which do honour their arguments.

---

## 3. Switching sidebar tabs clears the selection, which silently disables the fx grid

**Severity: medium** for automation, **low** for a human (who selects after
switching anyway).

`fxPresetBrowser.applyTransition` puts a transition on the bare cut nearest the
playhead **on the selected clip's track**, and reads
`selectionStore.getState().ids[0]`. Opening the Fx tab clears that selection, so
a "select the clip, then open the panel, then click a preset" sequence finds an
empty selection, toasts *"Select a clip next to a cut"* and places nothing.

There is no error and no return value, so the caller cannot tell. The suite
orders it the other way round (`harness/ui.ts#applyFxPreset` selects after the
tab is open, and verifies the selection took).

---

## 4. `ElementControlAsset.templateAudio` throws on every audio clip added

**Severity: low.** A Lit render error, logged and swallowed; the export is
unaffected because it draws through the canvas renderer, not this DOM overlay.

```
TypeError: Cannot read properties of undefined (reading 'filetype')
    at ElementControlAsset.templateAudio (elementControlAsset.ts:150)
```

```ts
templateAudio() {
  const element = this.timeline[this.elementId];
  if (element.filetype !== "audio") { return ``; }
```

`element` is not guarded against being absent, and the component renders for an
id its `timeline` map does not hold. Reproduced every time an audio clip is
added — see `agent.spec.ts`.

---

## 5. `filesystem:removeDirectory` throws `ReferenceError: status is not defined`

**Severity: low.** Fires during export cleanup.

```
Error invoking remote method 'filesystem:removeDirectory':
  ReferenceError: status is not defined
```

A bare `status` in the main-process handler, reached on a path the happy case
does not take.

---

## 6. Audio input is limited to three extensions

**Severity: low**, but surprising.

`apps/app/src/functions/mime.ts` accepts exactly `mp3`, `wav` and `m4a` for
audio. `.ogg`, `.opus`, `.flac` and `.aac` are all refused with *"Cartcut has no
renderer for …"*, even though FFmpeg and Chromium both handle them and the
exporter can itself *produce* Opus and Vorbis for the WebM container.

`.ogv` is likewise absent from the video list. (Theora would not have decoded
anyway — Chromium removed it in M123, and this is Electron 33 / Chromium 130.)

---

## 7. `saveProjectFile` resolves before it has written anything

**Severity: low.**

`functions/project.ts#saveProjectFile` starts `zip.generateAsync(...).then(...)`
and does not return that promise, so awaiting the call awaits nothing and the
file does not exist yet when it resolves. The suite polls for the file instead.

---

## 8. Smaller notes

- **The export writes no colour metadata.** `videoOutputArgs` emits no
  `-colorspace`, `-color_primaries` or `-color_range`, so the delivered file is
  colorimetrically untagged and ffprobe reports `color_space=unknown`. The round
  trip is self-consistent today, so this is not a defect the suite fails on —
  and the suite deliberately does *not* pin decode flags, so adding correct
  tagging later will not break it. The `swatch` canary verifies the round trip
  empirically instead.
- **The fps field has no working control.** `#projectDuration` in
  `ControlSetting` renders `disabled` with a hardcoded 60, so a project cannot
  be set to any other frame rate through the UI. The suite reaches
  `renderOptionStore` for non-60 profiles and says so at the call site
  (`harness/ui.ts#setFpsThroughStore`).
- **`effect` and `transition` have no agent commands at all**, and are missing
  from `define.ts`'s `FILETYPES`, so the read tools cannot even filter for them.
  Two of the nine element types are invisible to the automation surface. The
  suite places them by clicking the fx grid and reads them out of the document
  directly (`harness/agent.ts#timelineDocument`).
- **`CLAUDE.md` says transitions do not exist in the data model.** They do —
  `TransitionElementType` is at `@types/timeline.ts:433`, with a full
  `transitionOps.ts`, `transitionGeometry.ts` and an `option-transition` panel.
  The note is stale. The tool count in the same file says 36; it is 37.
