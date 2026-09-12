# Cartcut

An Electron video editor (`cartcut-app`, formerly "nugget"). Lit web components
and vanilla zustand in the renderer, plain TypeScript in the main process,
FFmpeg for export.

## Build layout — read this first

`electron/` is **source**; `main/` is the **compiled output** of it, and
`package.json` points `"main"` at `main/main.js`. Edit `electron/`, never
`main/`.

`.tsconfig/tsconfig.json` pins `rootDir: ../electron` deliberately. If any file
under `electron/` imports from `apps/app/src`, `rootDir` widens, the whole build
relocates from `main/` to `main/electron/`, and the app stops finding its entry
point. This is why the MCP tools talk to the renderer over IPC instead of
calling the editing functions directly.

`apps/app` has no `package.json` — the root webpack config builds it. The three
folders under `apps/` and `packages/` that *do* have one are standalone Vite
apps with their own lockfiles; this is not an npm workspace.

## Commands

```
npm run dev      # tsc --watch (main) + webpack --watch (renderer), concurrently
npm run start    # electron .   — run in a second terminal
npm test         # vitest run
npx tsc --noEmit -p ./.tsconfig    # typecheck the main process
npx webpack --mode=development     # build the renderer once
npm run build:overlay              # the screen recorder's own Vite app
npm run build:speech               # the native STT sidecar (Swift, macOS only)
```

`npm run dev` does **not** build `apps/overlay-record`; it has its own lockfile
and its own `tsc`. Build it after changing anything under it, or the recorder
windows load a stale bundle. The release scripts do run it.

It **does** build `native/cartcut-stt`, the Swift speech sidecar — that one is a
staleness check and two `swiftc` calls, so it costs nothing after the first run,
and a checkout with no binary would otherwise silently lose on-device
transcription. It skips itself, loudly, on Windows or without the macOS 26 SDK.
See "On-device speech-to-text".

FFmpeg and ffprobe binaries live in `./bin/<platform>-<arch>/` — `darwin-arm64`,
`darwin-x64`, `win32-x64` — and `electron/lib/ffmpeg.ts` picks the directory from
`process.arch`. electron-builder flattens the matching one into `resources/bin`,
so a packaged app sees them directly under `bin/`. `yt-dlp` sits at `bin/` root;
it is already a universal binary. See the README.

The macOS builds must be **native**. An x86_64 FFmpeg runs on Apple Silicon
under Rosetta at roughly half speed and says nothing about it — measured through
the app's own pipeline at 1080p60, H.264 goes 112 → 240 fps and H.265 32 → 102
fps just by being the right architecture. `lipo -archs bin/darwin-arm64/ffmpeg`
is the check.

## How editing works

The most important convention in the codebase. Every edit is a **pure function
`(TimelineDocument) => TimelineDocument`**, applied through
`useTimelineStore.withCheckpoint(fn)`, which records one undo step.

A pure op that declines an edit returns **its input, by identity**.
`withCheckpoint` reads that as "nothing happened" and records no step. This is
load-bearing: it is what makes a split off the end of a clip, or a drag into an
occupied slot, cost the user nothing. Preserve it in any new op.

```
apps/app/src/@types/timeline.ts          element shapes
apps/app/src/features/timeline/tracks.ts TimelineDocument, tracks, z-order
apps/app/src/features/timeline/geometry.ts   trim/duration/speed invariants
apps/app/src/features/timeline/clipOps.ts    split, trim, move, delete, removeRanges
apps/app/src/features/timeline/placement.ts  where a new element lands
apps/app/src/states/timelineStore.ts     the store, undo history
```

Two things about time that are easy to get wrong:

- `trim` is a window into the **source file**, in source ms.
  `duration === trim.endTime - trim.startTime`.
- The clip occupies `[startTime, startTime + duration/speed)` on the
  **timeline**. Use `spanOf`/`spanLength`, and `timelineTimeAt`/`sourceTimeAt`
  to convert between the two. Never open-code the arithmetic.

`priority` is derived from track order, never authored.

## The project file

A `.ngt` is a zip of five JSON entries, written and read entirely in the
renderer by `functions/project.ts`: `project.json` (`{ schemaVersion }`),
`timeline.json` (the element map), `tracks.json`, `renderOptions.json`
(`features/project/renderOptionsFile.ts`) and `assetPaths.json`
(`features/project/assetsFile.ts`).

Load **refuses to open** on a `schemaVersion` mismatch — it is a compatibility
check, not a migrator. So **a new field never moves the version**: absent means
default, answered on the way in. Both file modules state this at the top.

Media is referenced by absolute path, *and* — for anything sitting inside the
`.ngt`'s own folder — by a relative one recorded alongside it in
`assetPaths.json`. That is what makes a project folder portable: hand someone
the folder and the relative paths still name the files. The absolute paths stay
in `timeline.json` as the fallback for a `.ngt` moved on its own, away from its
media, so relinking is a *preference* and never a *replacement*.

One invariant carries the whole feature:

> **The in-memory `TimelineDocument` is always absolute.** A relative path
> exists only inside the archive.

`loadedAssetStore`, `ffmpegArgs`, the MCP tools, the preview and the export all
read `localpath` directly and all needed no changes because of it. Conversion
happens at the two file boundaries and nowhere else. A relative path must not
become a field on the element: it would enter `normalizeDocument`, every undo
snapshot and the agent serializer, and go stale the moment `localpath` changes.

Two things that make the path arithmetic (`features/project/assetPaths.ts`)
fussier than it looks, both pinned by tests:

- **`localpath` is not percent-encoded**, despite usually being a `file://`
  URL. `functions/path.ts#encode` escapes `#` and nothing else, so
  `decodeURIComponent` throws on a file named `100%.mp4` and `new URL` truncates
  `a?b.mp4` at the `?`. The exact inverse is `%23` → `#`.
- **On Windows the URL is malformed** — `toLocalPath` concatenates, so it mints
  `file://C:\Users\me\a.mp4`, drive letter where a URL host goes. Chromium
  accepts it, which is why it survives. Anything reading these must tolerate it,
  and anything writing one must reproduce it: minting the tidy form instead
  would give one file two spellings, and `mergeOps` compares these strings to
  decide two clips share a source.

`assetPaths.ts` has **no imports at all**. `node:path` only ever answers for the
host platform, which is the wrong one half the time here, and webpack has no
`resolve.fallback` so it would not resolve anyway. Path flavour is an explicit
`"posix" | "win32"` parameter, the same rule `utils/platform.ts` states for
`isMac` and for the same reason: both branches have to be covered on one CI host.

## Compositing and blend modes

Everything visual is composited in the **renderer, on a 2D canvas**, by one
function: `renderTimelineAtTime` -> `paint` -> `renderElement`. The preview, the
in-app export, the offscreen export window, the agent's contact sheet and the
e2e reference render all call it, which is why parity between preview and
export is structural rather than something anyone maintains.

FFmpeg does **no** video compositing on the v2 path. `renderTimeline.ts` hands
it finished frames as raw RGBA over a pipe and the video half of the filter
graph is `[0:v]null[vout]` — a pass-through, not a discard. So a new visual
property is a change to `renderElement` and to nothing in `electron/render/`.

A clip carries an optional `blend`
(`@types/timeline.ts#BLEND_MODES`, seventeen values, Canvas2D vocabulary), on
video, image, gif, shape and text. Absent means `"source-over"`, resolved by
`renderer/blend.ts#blendOf` on every read; `coerceBlend` validates writes. The
same `normalizeFps`/`coerceFps` split, for the same reason. **A blend of
`"source-over"` deletes the key** rather than storing it, so a project nobody
has blended saves byte-identically to one written before the feature — and
`SCHEMA_VERSION` did not move.

Three things about it that are easy to get wrong:

- **A blended clip is drawn in isolation.** `renderElement` paints it whole onto
  a scratch layer and composites that once. Not tidiness: `renderText` issues up
  to five overlapping draws per line — background box, glow, shadow, outline
  stroke, fill — and with the mode set on the shared context those blend against
  *each other*. The layer comes from an injected factory
  (`renderer/surface.ts`), because the node suites have no `document`; omit the
  factory and it degrades to setting `globalCompositeOperation` directly, which
  is still exact for the single-draw element types.
- **Blend is suspended inside a transition.** `fx/compositor.ts#renderClip`
  draws each half into a cleared *transparent* buffer, so there is nothing to
  blend against and `multiply` would erase the clip. `paint` marks that context
  `isolated`. A transition is an operation on a pair, not a property of one clip.
- **The backdrop is the whole stack, including the project background.** A
  `multiply` clip on the bottom track multiplies with the background colour, so
  on black it goes black. That is correct and matches every NLE; it is also the
  first thing anyone reports as a bug.

`tests/e2e/specs/blend.spec.ts` checks the modes against the blend arithmetic
restated independently in that file, through a real export — not against a
reference render, which would use the same code and prove nothing.

## The frame rate

A project setting, sitting on `renderOptionStore.options` next to `previewSize`
and `duration` — not in `TimelineDocument`, and not in `ExportSettings`. It
decides the snap grid, the ruler, the frame grid, the zoom ceiling, the rate
animation is baked at, which frame the preview shows, and the rate FFmpeg is
clocked at, all of which happen long before anything is exported.

Whole frames per second, 1..240, presets at 24/25/30/50/60/120. **Integers
only** — the NTSC family is `30000/1001` and its relatives, which a `number`
cannot name exactly, and admitting them means carrying a rational through every
conversion in `frames.ts` and through the exporter that has to agree with it bit
for bit.

Two rules keep this straight:

- **Pure ops never read the store.** `features/timeline/` and
  `features/animation/` take `fps` (or `bakeHz`) as an argument, which is what
  keeps them DOM-free and node-testable. Only UI components and the agent
  commands read `renderOptionStore`.
- **`normalizeFps` guards reads; `coerceFps` validates writes.** The first runs
  on every draw and must never throw. The second runs once, where a value is
  stored, and makes an unusable rate unrepresentable from then on.

Changing the rate goes through `features/editor/frameRate.ts#setProjectFps`,
which is also the only place the three consequences are sequenced: re-clamp the
zoom (the ceiling is `zoom.ts#maxRangeForFps`), re-snap the playhead, and re-bake
animation through `withCheckpoint`. **Clips do not move.** A rate change is a
change of grid, not a re-cut; off-grid clips are pulled onto the new grid the
next time they are dragged, which is what every NLE does and the only choice
that cannot lose work.

**The grid does not apply to audio.** Frame alignment is a picture constraint —
an edge between two frame instants shows one frame of whatever is behind it — and
sound has no frames, so `frames.ts#isFrameLocked` lets an audio clip drag freely,
to the millisecond. This is drag only (`resolveMove`); trims, drops and the MCP
`move_clips` still quantize everything. Two consequences are easy to get wrong
and both are pinned by `dragResolve.test.ts`:

- **One gesture is one delta**, so the grid is all-or-nothing across a selection:
  one picture clip in the drag keeps it on, which is what stops a video and its
  detached audio drifting apart.
- **With audio under the pointer and picture along for the ride, the *distance*
  is quantized rather than the destination** — the anchor cannot be corrected onto
  a grid it is exempt from, so whole-frame travel is what leaves the picture as
  aligned as it started. That path outranks the edge snap, the only place in the
  module where anything does, and it suppresses the snap guide when it rounds
  away from the line.

The baked animation lanes (`ax`/`ay`) are a *cache* read by nearest-sample
lookup, so their rate has to be at least the project's — `keyframes.ts#bakeRateFor`
is `max(BAKE_HZ, fps)`, keeping a 60Hz floor so nothing at or below 60 changes.
Rebaking happens at exactly two moments, ingress (`patchDocument({ bakeHz })`)
and a rate change; never on a checkpoint.

## What a clip can animate

Five properties, listed by `@types/timeline.ts#OWN_ANIMATABLE_PROPERTIES` and
offered per element by `animatableProperties`: `position`, `opacity`, `scale`,
`rotation` and `size`. Plus the mask's five, which exist only while the clip
has a mask — see "Masks". An effect has `opacity` alone; gif and audio have no
`animation` block at all.

`position`, `size`, `maskPosition` and `maskSize` are the two-lane ones,
registered in `keyframes.ts#VECTOR_PROPERTIES` and asked of `lanesOf`. Nothing
hardcodes a property name: the curve editor takes its lane count from `lanesOf`,
the diamond lane and the context menu walk `animatableProperties`, and
`cloneAnimation`/`rebaseAnimation`/`sliceAnimation`/`rebakeElement` walk
`Object.keys(animation)`. So split, trim, duplicate, paste and a frame-rate
change carry any property for free.

**`size` and `scale` are different things, and the difference is the point.**
`scale` is uniform, stored in *tenths*, and multiplies the matrix about the
element's centre; it never touches the box. `size` is the clip's own `width`
and `height`, in **pixels** — the two numbers the sidebar's Size row shows —
and the sampled value **replaces** those fields on the way to the renderer.

That replacement is the whole contract:

> **A keyframed property behaves exactly like the static field it keyframes.**

`renderer/element.ts#drawDirect` substitutes the sampled box into the element it
hands each renderer, so `image.ts`, `video.ts`, `shape.ts` and `text.ts` needed
no changes — they go on reading `element.width`. Animating to 500 therefore
draws precisely what typing 500 into the sidebar draws, including on text, where
`width` is the *wrapping* width and re-wraps, and `height` is a consequence of
layout that the renderer never reads. A non-uniform matrix scale would have been
fewer lines and would have given those two numbers a second meaning.

Four things that are easy to get wrong:

- **`timeline/transform.ts#sampledBoxOf` is the only way to ask how big a clip
  is** at a cursor. The renderer, the mask's element-space mapping
  (`renderer/mask.ts`), the selection outline, the eight grips, the hit test and
  the resize origin all go through it. One of them left reading `element.width`
  is the `previewCanvas.collisionCheck` bug over again — the picture in one
  place and the pointer's idea of it in another.
- **`localMatrixOf` pivots on the sampled box, not the stored one.** Getting
  this wrong is invisible until someone rotates a clip whose size is animated,
  and then it swings about a point it has no corner on.
- **The track is unconditional, so it has to be seeded.** Unlike the mask's
  five it is in `emptyAnimation`, and `normalizeAnimation` adds it on ingress to
  any element missing it — the symmetric half of the orphan-mask drop, in the
  same loop. Without that, the stopwatch on a project written before the feature
  clicks and does nothing: `resolve` and `setTrackActive` both decline by
  identity on an absent track, silently.
- **`withFittedTextHeights` declines while the track is on.** A keyframed height
  is authored, and the fit would be invisible anyway (the sampled height wins)
  while still dirtying the document once per width scrub.

`SCHEMA_VERSION` did not move. A project written by an older build simply lacks
the track and gains one on load.

### Animation presets

Nineteen ready-made moves, in `features/animation/presets.ts` as **plain
TypeScript data** — deliberately not in the `assets/presets/` registry, which
exists to load untrusted, user-installable data-plus-GLSL and has nothing an
animation preset needs. Adding one is a diff to one object literal, plus the
hand-copied `PRESETS` in `electron/mcp/tools/define.ts` that `tools.test.ts`
pins by set equality.

```
apps/app/src/features/animation/presets.ts        the table, applyPreset, playheadAnchor
apps/app/src/features/animation/presetPreview.ts  what a tile draws — pure, node-tested
apps/app/src/features/option/animationPresetBrowser.ts   the grid, in the Animation tab
apps/app/src/features/animation/keyframeOps.ts    clearAnimation / hasAnimation
```

Reached three ways, all through the same `applyPreset`: the **Animation tab**
in the text, image, video and shape inspectors; the `apply_animation_preset`
MCP tool; and `apply_edit_plan`.

Four things that are easy to get wrong:

- **`startAtMs` is element-local, and it outranks `fromEnd`.** Anchored, *every*
  preset starts there and runs forward — a `fade_out` dropped mid-clip runs from
  the playhead, not from the tail. The conversion from the playhead is
  `playheadAnchor`, which answers `undefined` when the cursor is off the clip so
  the preset falls back to its own anchor. The panel takes that fallback; the
  agent command throws instead (`localTime`), because an agent naming a time
  meant that time and a silently relocated keyframe looks like the request.
- **Near the clip's end the preset is compressed, not moved back.** Sliding the
  anchor to make room starts the move somewhere nobody clicked, which is the one
  thing an anchor is for.
- **The tiles run the real thing.** `previewSamples` applies the actual
  `applyPreset` to a throwaway clip and reads it back through the actual
  `localSampleAt`, so nothing restates what a preset does and nothing can drift
  from it — the argument `fxPreviewProvider` makes for its own thumbnails. The
  one place the tile is *not* faithful is scale: it is a diagram, so one box
  length is drawn as `TILE_TRAVEL` of the tile. At 1:1 a slide's start pose is
  exactly off the tile's edge and Move Up renders empty.
- **"None" is `clearAnimation`, not `setTrackActive(false)` in a loop.**
  Switching a track off *keeps* its keyframes, which is right for a stopwatch
  and wrong for a tile claiming the clip has no animation. It empties authored
  and baked lanes together and leaves the mask's five alone — those belong to
  the mask, and clearing exactly what the grid can write is what keeps the tile
  honest. `hasAnimation` is the same condition, written once, and is what
  lights the tile up.

`SCHEMA_VERSION` did not move: a preset writes ordinary keyframes, and nothing
records that a preset was what wrote them. That is also why no tile but "None"
shows an applied state — a highlight on Fade In would be a guess presented as a
fact.

## Revealing text

Showing a text clip's lettering a piece at a time — the typewriter, and every
other cadence built from the same scalar. CapCut has a one-click preset for it;
Premiere makes you keyframe the Source Text once per glyph.

```
apps/app/src/features/text/reveal.ts        the plan: units -> character offsets
apps/app/src/features/text/typewriter.ts    applyTypewriter, built on the ops
apps/app/src/features/timeline/textRevealOps.ts  setClipTextReveal / …Fields
apps/app/src/features/renderer/text.ts      paintLettering, paintRevealHead
apps/app/src/features/option/optionTextRevealSection.ts  the Animation-tab panel
```

**A reveal is one continuous scalar, and `unit` says what it counts.** That
split is the whole design, and it puts the two halves in different places:

- **Meaning** is `element.reveal` — `{ unit, progress, fade? }`, an optional
  field on text alone. It holds **no time at all**, so nothing in `clipOps` has
  to rebase it.
- **Timing** is `element.animation.revealProgress`, an ordinary keyframe track
  over the static `progress`. `rebaseAnimation`, `sliceAnimation` and
  `rebakeElement` all walk `Object.keys(animation)`, so split, trim, duplicate,
  paste and a frame-rate change carry a typewriter's timing for free — the same
  argument the mask's five make for living there. Storing `startMs`/`durationMs`
  on the field would have meant reimplementing every one of those, and the one
  anyone forgot would fail silently on one edit.

Absent means the whole text is shown, clearing deletes the key, and
**`SCHEMA_VERSION` did not move**. `revealProgress` is kept out of
`emptyAnimation` and gated in `animatableProperties` on `element.reveal != null`
— the mask's arrangement exactly, and `normalizeAnimation` collects the orphans
through `keyframes.ts#carriesTrack`, which is now a table rather than the two
hard-coded conditions it was becoming.

Keyframing the *string*, as Premiere does, is the alternative and is wrong here:
`HistoryEntry` keeps fifty snapshots of the element map, so the undo stack would
grow by the whole body times its glyph count; easing and handles would mean
nothing; and correcting one typo would invalidate every keyframe. A progress
scalar is independent of the wording, so the timing survives an edit to the text.

Five things that are easy to get wrong:

- **The reveal is applied *after* layout, never before.** `layoutFor`'s
  `wrapCache` is keyed on the whole string, so wrapping a growing prefix would
  miss that cache every frame *and* re-flow the text as each word arrived. It
  also means the box never changes size, which is why nothing about a reveal
  belongs in `textFit.ts#RE_FITTING_PATHS`.
- **The lettering is drawn left-anchored while revealing.** `backgroundX + pad`
  is already the full line's left edge under all three alignments, so the prefix
  is drawn there with `textAlign: "left"`. Drawing it at a centre or right
  anchor re-centres it every frame and the text creeps sideways as it types —
  the defect Premiere's Source Text keyframing has, and invisible in any
  left-aligned test.
- **The background band is drawn at the full line's width.** A band is a layout
  element, not something that types; one that grew would redraw at a new size
  every frame and, centred, grow both ways at once. It appears whole with the
  line's first unit, and a line that has not started gets no band.
- **A cut never lands inside a grapheme.** `Intl.Segmenter` decides, pinned to
  one locale so the same sentence does not segment differently on CI than on a
  Korean machine. It is also the only thing that makes `word` mean anything in
  Japanese or Chinese, where there is no space to split on.
- **`fade` is bounded to one unit.** At most one unit is ever part-drawn, so the
  cost is one extra clipped pass per line rather than one per unit in flight.
  That pass draws the *whole* prefix and clips it, because `measureText` on a
  substring loses the kerning against the glyph before it.

`applyTypewriter` writes exactly what a user could place by hand —
`setClipTextReveal`, `setTrackActive`, two `addKeyframe`s, one linear easing —
so the stopwatch, the curve editor and undo all work on its result without
knowing a button made it. It is deliberately **not** in
`features/animation/presets.ts`: a `PresetShape` is transform and opacity stops
and `applyPreset` writes keyframes only, while a reveal preset must also write
`element.reveal`. The linear default is load-bearing — `addKeyframe` gives every
anchor a 100ms handle, so two bare keyframes describe an ease-in-out, and typing
that starts slow, races and then dawdles reads as a stutter.

There is no dedicated MCP tool yet, but `revealProgress` **is** in
`define.ts#ANIMATABLE`, so the existing animation tools reach the curve on a
clip that has a reveal. That list is now pinned against
`@types/timeline.ts#ALL_ANIMATABLE_PROPERTIES` rather than against the families
spelled out in the test — which is the third time that guard would otherwise
have gone stale at the same moment as the copy it guards.

## On-device speech-to-text

Transcription with **per-word timings**, from macOS's own recogniser. No key, no
network, no server. It is what the auto-caption panel's word chips and
split-at-a-word are built on, and the reason the panel's "Local" method is
finally local: it used to ask for a `CartcutAutoServer` URL, read it out of a DOM
input by id, and POST the wav to a WhisperX server the user had to run.

```
native/cartcut-stt/Sources/     the Swift CLI — main.swift, Transcribe.swift, Emitter.swift
scripts/buildSpeech.mjs         two swiftc calls into bin/<platform>-<arch>/
electron/lib/speechBin.ts       where the binary is, and whether this Mac can use it
electron/lib/speechStt.ts       spawn + NDJSON parse + abort. No Electron, so it is tested
electron/mcp/transcribe.ts      the three back ends and the disk cache
electron/ipc/ipcTranscribe.ts   the renderer's job queue, progress and cancel
apps/app/src/features/caption/locale.ts   which language to offer first
```

**A sidecar process, not a native Node addon.** A N-API module would couple the
app to Electron's ABI and an `electron-rebuild` step this repo has never needed —
it has zero first-party native modules. Speech.framework also wants a Swift
concurrency runtime and an async result stream, which is natural in a process
and awkward across that boundary, and a framework crash cannot take the editor
with it. Same shape as `ffmpeg`, `ffprobe` and `yt-dlp`.

**`"apple"`, never `"native"` and never folded into `"local"`.** The WhisperX
server is *also* local, so the useful distinction is whose engine it is:
`local` is a server you run, `openai` is an API you pay for, `apple` is the OS.
The panel's button says **On-device**.

Five things that are easy to get wrong:

- **Word timings live on the runs of the `AttributedString`, not on
  `Result.range`.** `Result.range` is the whole segment, so reading it gives one
  pseudo-word per sentence — which is exactly the defect the OpenAI path has and
  the reason this exists. The attribute is
  `AttributeScopes.SpeechAttributes.TimeRangeAttribute`, and it is only populated
  because the transcriber was built with `attributeOptions: [.audioTimeRange]`.
- **A finish call is mandatory.** Ending the input does not end the session, so
  omitting `finalizeAndFinish*` leaves the results stream open and the process
  **hangs** instead of failing.
- **Built at a macOS 12 deployment target, though everything it uses is
  macOS 26.** At 12.0 the Speech symbols are weak imports, `if #available` never
  touches them, and the binary launches on an old system and reports
  `requires_macos_26` in the same NDJSON as everything else. Built at
  `-target …macos26.0` it fails at `exec` with a dyld diagnostic on stderr, which
  a caller cannot tell from a missing binary. 12.0 is also where Swift
  concurrency is in the OS, so no back-deployment dylib has to be found a home.
- **`assetInstallationRequest` is not nil for an installed locale.** It hands
  back a request that completes at once, so acting on it alone flashed
  "Downloading language model" on every single run. `AssetInventory.status` is
  the separate question, and the one to ask first.
- **Availability is decided in JS before anything is spawned**
  (`speechBin.ts#isNativeSpeechAvailable`), from `process.getSystemVersion()` and
  the binary's existence. The Swift `if #available` is the second line of
  defence, not the first.

Nothing signs the binary here. electron-builder signs every Mach-O under
`Contents/`, deepest-first with the `.app` last — verified against the 0.5.4
build, where an entirely unsigned `bin/darwin-x64/ffmpeg` came out carrying
Developer ID, the hardened runtime and this repo's `entitlementsInherit`. So
`extraResources` needed no change, and an `afterSign` hook would be actively
wrong: it would invalidate the outer signature that seals `Contents/Resources`
and fail notarization. **No new entitlement either** — the macOS 26 Speech API
has no authorization call at all (`grep -i authoriz` over its `.swiftinterface`
finds nothing), so there is no TCC prompt for on-device file transcription;
`NSSpeechRecognitionUsageDescription` belongs to the legacy `SFSpeechRecognizer`
and is in `extendInfo` only as belt-and-braces.

**The panel and the agent call one function.** Both go through
`transcribeFile`, which already owned ffmpeg extraction (16 kHz mono, exactly
what the recogniser wants) and the disk cache — so a clip the agent has read
opens instantly in the panel, and there is one ffmpeg pass per clip rather than
two. The locale is folded into the cache key's `method` component
(`apple:ko-KR`), because the same file read as Korean and as English gives
different words; `method` was already part of the hash, so `CACHE_VERSION` did
not move and every transcript cached before this stays valid.

Measured on the machine this was built on, at 11s of Korean speech: a cold run
8.7s — essentially all of it the one-off model download — and a warm run 0.44s,
about 25x real time. That ratio is why the progress UI names the stage: the
download is the only wait worth a bar, and it happens once per language.

`analysis/segments.ts` gained `groupWords` so the break rule is written once.
The panel needs the *words* of each caption line and an agent needs the *text*,
and two copies of "where does a caption break" is two answers to the one
judgement in that file. `segmentWords` is now `groupWords(...).map(toSegment)`
and its suite did not change.

## The application menu

The macOS menu bar is a second surface onto the editor's commands, and it obeys
the rule `features/editor/actions.ts` states for the toolbar: the menu item, the
button and the keystroke are one code path.

```
electron/lib/menuCommands.ts          what the menu offers — pure data, no Electron
electron/lib/menu.ts                  the menus, built from that table
electron/ipc/ipcEditing.ts            webContents undo/cut/copy/paste, allowlisted
apps/app/src/features/editor/menuCommands.ts  the ids, run in the renderer
apps/app/src/features/editor/textEditing.ts   ⌘C/⌘V/⌘Z *inside a text field*
```

One channel, `menu:command`, carrying an id — not a channel per item, which is
what the two `SHORTCUT_CONTROL_*` channels it replaced would have needed. The
renderer's table is a `Record<MenuCommandId, …>`, so an item with no handler is
a webpack type error rather than a click that does nothing.

Three things about it are easy to get wrong, and all three were paid for once:

- **A menu accelerator fires whatever the page does with the same keystroke.** A
  renderer `preventDefault` does not cancel it. So for a combination the
  renderer already binds on `keydown` — ⌘Z, ⌘X, ⌘C, ⌘V, ⌘D, ⌘0, ⌘+, ⌘- — the
  item carries the accelerator (that is what draws the shortcut beside the
  label) but declines to send it: `rendererOwnsKey`, tested against
  `event.triggeredByAccelerator`, which distinguishes the keystroke from the
  click. Without it one ⌘Z is two undo steps. Verified in the running app:
  ⌘Z moves `historyNow` by exactly one, and Edit → Undo by exactly one.
- **A menu accelerator is global to the window with no per-focus escape.** So
  Space, the arrows, Backspace and Delete are *not* registered — they would
  toggle playback and delete clips while someone typed a caption. Those stay in
  `elementTimelineCanvas._handleKeydown` and `Timeline._handleKeydown`, which
  can see the focus, and their menu items are offered without a shortcut.
  `menuCommands.test.ts` pins that every registered accelerator has a modifier.
- **Replacing the `undo`/`cut`/`copy`/`paste` roles takes their job with it.** A
  role acts on the focused editable and nothing else, which is why Edit → Copy
  with three clips selected copied nothing. The items are the editor's own
  commands now, and `textEditing.ts` is the half that would otherwise have gone
  missing: the same keys, meaning the text, while the caret is in a field. It
  cancels the keystroke *only* once the command has somewhere to go, because the
  web build has no main process behind the bridge.

`features/editor/shortcuts.ts` still lists every binding the user can press,
menu-owned and renderer-owned alike — the help modal that leaves one out is
wrong whichever half implements it.

## The Claude Code bridge

`electron/mcp/` runs a Streamable HTTP MCP server on `127.0.0.1:9826/mcp`,
bearer-token authenticated, started with the app. Its tools validate with zod
and forward to `apps/app/src/features/agent/`, which runs the real commands
against the store — so an AI edit takes the same code path, and the same undo
step, as the user's own mouse.

```
electron/mcp/server.ts      transport, sessions, auth
electron/mcp/tools.ts       barrel: assembles the 56 tools Claude Code sees
electron/mcp/tools/define.ts  the erased Registrar, shared zod fragments
electron/mcp/tools/*.ts     one module per family (read, cut, media, tracks, …)
electron/mcp/bridge.ts      main -> renderer request/response
electron/mcp/transcribe.ts  speech-to-text, cached on disk
apps/app/src/features/agent/commit.ts      run a pure op, record one undo step
apps/app/src/features/agent/context.ts     document/element/frame-grid lookups
apps/app/src/features/agent/serialize.ts   whitelist projections
apps/app/src/features/agent/commands/      the commands themselves
apps/app/src/features/caption/timing.ts    source ms -> timeline ms for captions
```

`tools.ts` must stay a barrel — do **not** turn it into `tools/index.ts`. Both
resolve for `import … from "./tools"`, and nothing cleans `main/`, so a stale
`main/mcp/tools.js` would shadow `main/mcp/tools/index.js` and silently ship an
old tool list.

Every mutating command goes through `commit(fn, declineReason)`, which probes
the pure op first and records no history at all when it declines by identity.
`electron/mcp/tools/tools.test.ts` pins the tool names, so adding one is a
one-line diff a reviewer sees.

Two constraints shape every tool:

- **Tool output is capped** — Claude Code warns at 10k tokens and truncates at
  25k. Never return a raw element: `animation.ax` holds up to 36,000 baked
  samples per lane. Add fields to `serialize.ts`'s whitelist deliberately.
- **`registerTool`'s generics must stay erased.** `electron/mcp/tools.ts` calls
  it through a hand-written `Registrar` type. Letting TypeScript infer handler
  arguments from the zod shapes costs ~10s per tool and exhausts the compiler's
  heap across the file. There is a comment at the call site; do not "clean it
  up".

Connect with the command shown under the ⚡ icon at the bottom right of the app,
or set `CARTCUT_MCP_TOKEN` and use the committed `.mcp.json`.

## Groups and null objects

**They are the same thing.** `GroupElementType` *is* After Effects' null object:
a `TimelinePlaced & Visual & Animatable` element that draws nothing and exists
only to hold a transform for its children. There is no `filetype: "null"`, and
adding one would be a mistake — the two rules that make the feature work are
keyed on the single string `"group"`. `hierarchy.ts#parentOf` admits **only** a
group as a parent, and `isVisualTimelineElement` excludes **only** a group from
the paint loop. Missing the first detaches every child in silence; missing the
second crashes the renderer on an undefined call.

```
apps/app/src/features/timeline/hierarchy.ts     the parent graph, repairHierarchy
apps/app/src/features/timeline/transform.ts     localMatrixOf / worldMatrixOf
apps/app/src/features/timeline/groupOps.ts      createGroup, ungroup, setParent
apps/app/src/features/timeline/parentOptions.ts what a parent picker may offer
apps/app/src/features/element/nullElement.ts    createNullElement — the empty one
apps/app/src/features/option/controlParent.ts   <parent-select>, the pick-whip
```

**One type, two ways of being born**, and the difference is only the pivot:

- **`createGroup`** wraps a selection, from the timeline's "Group selected".
  Its pivot is the selection's bounding box, and that is not a preference: it
  makes the compensation each child owes exactly `−bbox.topLeft`, a pure
  translation, which is the only transform that is *exact* for a bezier
  keyframe's handles as well as its anchor.
- **`createNullElement`** starts empty, from the preview's create menu or the
  `create_null` tool. It has nothing to keep still, so its pivot is a plain
  100×100 square on a point the caller chooses, and clips are attached
  afterwards through `setParent`.

`name` — "Group" or "Null" — is the only thing that tells them apart, and it is
shown on the bar. No schema change; `SCHEMA_VERSION` did not move.

Four things that are easy to get wrong:

- **"Parenting does not touch the child's keyframes" is true and false
  depending on which moment you mean**, and conflating the two is the way to
  misunderstand the whole feature. *At the instant of parenting*, `setParent`
  rewrites the child's numbers once, by the change of basis between its old
  space and its new one — that is what keeps the picture still while the space
  underneath it changes, and it is what AE's pick-whip does too. *Every moment
  after that*, moving the parent changes nothing on the child at all: the
  matrix is composed at draw time by `applyParentTransform`, so the child's
  curves are read and never written. `nullParenting.test.ts` pins exactly that
  pair, in that order, and says so at the top.
- **A null starts at 0, not at the playhead.** `localSampleAt` falls back to the
  static value for a cursor before an element's `startTime`, so a null seated at
  the playhead would have its own keyframes quietly ignored everywhere to the
  left of it. Its `duration` gates nothing — `renderer/timeline.ts` states that
  a group's span does not gate its children — so the bar's length is only how
  much there is to aim at when setting a keyframe.
- **`width`/`height` are the pivot, not a size to draw.** `localMatrixOf`
  rotates and scales about `w/2, h/2`, so seating a null on a point means
  offsetting its `location` by half the box. Getting this wrong is invisible
  until someone rotates it, and then everything swings about the wrong place.
- **The picker and the op must not drift.** `parentOptions.ts` re-derives
  `setParent`'s refusals so the dropdown never offers a choice the op would
  decline — the same rule `groupMenuTemplate` already keeps. It is held by a
  contract test that asserts, across a table of documents, that every enabled
  choice is one `setParent` accepts and every disabled one is one it declines.

Opacity is the one deliberate divergence from AE: parenting there does not pass
opacity down, and `inheritedOpacityOf` does, so that fading a group fades what
is in it. The reasoning is at the function.

## Templates

A **template** is a whole edit standing in for one clip: one bar on a video
track, one name, its contents invisible to the timeline and its length fixed.
Its author marks some clips **replaceable**, and whoever uses it swaps their own
footage and words into those slots. CapCut's arrangement, and the vocabulary is
deliberately theirs.

```
apps/app/src/features/template/archive.ts     what makes a .cttpl a template
apps/app/src/features/template/slots.ts       slotsOf — the slot list, derived
apps/app/src/features/template/compose.ts     composeTemplate / expandTemplates
apps/app/src/features/template/templateDocument.ts  reading an installed .ngt
apps/app/src/features/template/templateRegistry.ts  lazy load, the resolver
apps/app/src/features/template/exportPlan.ts  staging, pure
apps/app/src/features/template/templateExport.ts / templateInstall.ts  the IO
apps/app/src/features/timeline/templateOps.ts fills, marks, and the factory
apps/app/src/features/renderer/template.ts    the nested render
electron/lib/templateScan.ts                  the folder walk, no Electron
```

### The decision the whole feature turns on

**A template element stores a reference, not a copy.** It holds a `templateId`
and the user's `fills`; the document behind it is resolved at draw time from
`templateRegistry.ts`, exactly as `element.lut.presetId` resolves through
`lutRegistry.ts`.

Inlining the document was the alternative and is wrong three times over:
`HistoryEntry` keeps fifty snapshots of the element map and a baked animation
lane runs to 36,000 samples; `normalizeDocument` would have to recurse; and
`agent/serialize.ts` would have to whitelist a nested tree past a 25k output
cap.

The registry brings its contract with it: **a template that is not installed
draws nothing and reports nothing.** The consequence is stated rather than
hidden — a project that uses a template needs that template installed, the same
as a LUT preset. `name` lives on the element, not in the registry, so the bar
still says what is missing.

`template` is the one filetype that takes `isVisualTimelineElement`'s *negative*
default on purpose: it paints itself onto whatever is there, so it fits
`ElementRenderFunction` exactly and inherits transform, opacity, keyframes,
group parenting and the control outline without any of them knowing it exists.

### The archive

```
name.cttpl                 (a zip)
├── template.ngt           REQUIRED, at the root — a real .ngt
├── template.json          optional  { name, author?, thumbnail? }
├── thumbnail.png          optional
└── assets/…               media, at any subdirectory depth
```

**No `template.ngt` at the root → not a template → refuse.** One level down does
not count; that is what zipping the folder rather than its contents produces.

Inside the `.ngt`, media is referenced the way a portable project already
references it — absolute in `timeline.json`, relative in `assetPaths.json` — so
installing is: extract, then hand the extracted `template.ngt` to the existing
`relinkAssets`. **The format needed almost no new path code**, and the
subdirectory rule comes free: `relativizeInside` emits multi-segment POSIX
relatives and `resolveInside` splits them at any depth.

Slot definitions are **not** in `template.json`. They are an optional
`replaceable` field on the inner elements, and `slotsOf` derives the list by
walking the document — one source of truth, and a slot cannot outlive the clip
it names. `template.json` carries presentation only.

### Four things that are easy to get wrong

- **Every composed key is namespaced** `outerId::innerKey`. `loadedAssetStore`
  caches video and audio decoders by element id, so two copies of one template
  would otherwise share one decoder and seek each other backwards.
- **`expandTemplates` is for the asset layer, never the renderer.** It flattens
  each template's contents onto the real timeline so `loadAssetsNeededAtTime`,
  `syncPlayback`, `seek` and the export's audio planner work unchanged — and
  handing it to `renderTimelineAtTime` would draw every inner clip twice, once
  nested and once loose. `template/assetTimeline.ts` is the seam.
- **The nested render must not paint a background.** `renderTimelineAtTime`
  fills its frame before drawing, so the template's layer gets a transparent
  one. Get it wrong and everything beneath the template is blanked — which
  looks exactly like a template that is simply full-bleed.
- **A fill moves the trim window, never the duration.** A slot's span is the
  author's; the user chooses which part of their own footage lands in it. That
  keeps `duration === trim.endTime - trim.startTime` satisfied and is the
  difference between a template and a project.

### The length belongs to the author

`geometry.ts#isDurationLocked` is the single predicate, and it lives there
because it is a statement about the duration invariants. Split, trim, speed and
merge all decline on it, and `layout.ts#hitTest` reads it so the trim handles
are never drawn — the rule the context menu already keeps, that an affordance
which could only decline is not offered.

Two of those were real hazards rather than tidiness, and both were silent.
`clipEdit.ts#splitAt` takes its non-dynamic branch for anything without a
`trim`, so it cut a template into two halves that each rendered the whole thing.
And `mergeOps.ts#canJoin` decides two clips share a source by comparing
`localpath` — every template carries the same `"TEMPLATE"` sentinel, so two
*different* templates sitting edge to edge looked like two halves of one cut.
`templateLock.test.ts` pins both.

### Known limits, stated rather than discovered

- **Effects and transitions inside a template do not render.** The nested render
  passes `fx = null`: `FxRuntime`'s compositor holds one shared scratch surface
  and entering it from inside a nested render would clear the frame it is
  composing. `paint` skips both silently, so `templateExport.ts` **warns at
  export**, where someone can still act on it. Making the compositor re-entrant
  is the phase-2 work.
- **Nesting is capped at one level.** `composeTemplate` strips a nested template
  silently — by then there is nobody to tell — and `planTemplateExport` refuses
  outright, which is the half someone can act on.
- **A project needs its templates installed.** The LUT contract, above.

`SCHEMA_VERSION` did not move. `replaceable` is an optional field that clearing
deletes, so a project nobody has marked up saves byte-identically to one written
before the feature.

### Two things this feature fixed on its way past

- **`FILETYPES` is now pinned.** `@types/timeline.ts` exports it as a runtime
  list and `tools.test.ts` compares `define.ts`'s hand-copy against it. The
  "Known rough edges" note below records that entry having been wrong twice in
  opposite directions; it was checked by eye until now.
- **`ipcFilesystem.writeFileEnsured`.** The existing `writeFile` calls the
  *callback* form of `fs.writeFile` and returns before it runs, so a failure is
  indistinguishable from success — and it does not create parent directories,
  which every template install needs for `assets/`. The first version of the
  export reported a `.cttpl` it had not written. Anything that must know whether
  its bytes landed should use the new one.

## Masks

**One mask per clip**, cutting its picture to a shape: `rectangle`, `star`,
`heart`, or `pen` — a bezier path drawn on the preview. `feather` softens the
edge, `roundness` rounds the corners, `invert` cuts a hole instead. It is an
optional `mask` field over the same five types `Blendable` and `Gradable` cover,
absent means unmasked, clearing deletes the key, and **`SCHEMA_VERSION` did not
move** — the rule `blend` and `lut` both follow.

```
apps/app/src/features/mask/maskShape.ts   maskOf / coerceMask — the read/write split
apps/app/src/features/mask/geometry.ts    nodes, segments, true curve bounds, affine mapping
apps/app/src/features/mask/templates.ts   the three built-ins, normalised onto the unit square
apps/app/src/features/mask/round.ts       corner rounding, as a rewrite of the node list
apps/app/src/features/mask/place.ts       unit square -> element-local pixels
apps/app/src/features/mask/sample.ts      the five animatable values at a cursor
apps/app/src/features/mask/penSession.ts  the pen tool's state machine, DOM-free
apps/app/src/features/renderer/mask.ts    device-space resolve, then one destination-in
apps/app/src/features/timeline/maskOps.ts setClipMask / …Fields / …Path, and their declines
```

**One mask per clip is a consequence, not a preference.** Mask keyframes live in
`element.animation` under `maskPosition`, `maskSize`, `maskRotation`,
`maskFeather` and `maskRoundness`, and that record addresses a track by a single
name. A second mask would have nowhere to put its curves without teaching every
consumer of `animation[property]` about indices.

Putting them in that same record is what makes them animate at all:
`normalizeAnimation`, `cloneAnimation`, `rebaseAnimation`, `sliceAnimation` and
`rebakeElement` all walk `Object.keys(animation)` or
`animatableProperties(element)`, so split, trim, duplicate, paste and a
frame-rate change carry mask curves for free. The tracks exist **only while the
clip has a mask** — `animatableProperties` became a function of the element's
state, not just its filetype — so `maskOps` seeds and removes them with the mask
in one transform, and `normalizeAnimation` collects any orphans on ingress.

Five things about it that are easy to get wrong:

- **The mask matrix is not `worldMatrixOf`.** It is the destination's own
  transform, read from `ctx` *before* the layer is allocated, composed with the
  parent chain and the element's local transform — the same three
  `renderElement` and `drawDirect` apply between them. `worldMatrixOf` maps into
  *project* space, and the preview's context carries zoom and DPR on top of it.
  A mask built the wrong way is exact in every node suite, which all draw at
  identity, and misplaced in the app at any zoom but 100% on any display but 1×.
- **The stencil is filled under an identity transform**, with the path already
  mapped to device pixels. `ctx.filter = "blur(Npx)"` is scaled by the current
  transform in Skia and `shadowBlur` is not, in either engine — and the preview
  is Chromium while every renderer suite is Skia, so a divergence there would be
  invisible in the suite and wrong in the app. Mapping the path ourselves means
  neither engine is asked to scale anything. An affine matrix maps a cubic's
  control points exactly, so nothing is approximated by doing it.
- **Everything is a cubic, including a straight edge and a rounded corner.**
  Corners become quarter-arc beziers (`4/3 · tan(θ/4)` generalises the 0.5523
  constant to any angle), never `arcTo` or `roundRect`, because those survive
  only a similarity transform and a stretched mask must give an elliptical
  corner.
- **Roundness applies to nodes with no handles.** That one rule is why a
  rectangle rounds completely, a heart never rounds, and a pen path rounds
  exactly the vertices the user clicked rather than dragged — with no shape name
  appearing in `round.ts` at all.
- **A `pen` mask with fewer than three nodes renders as no mask**, not as a
  hole. Same contract a LUT that is not installed has, and it is also what stops
  the clip vanishing between the first click of a stroke and the third.

The mask is applied on the blend-isolation layer, after the grade — the order is
unobservable, since a LUT does not touch alpha, so it sits next to the blit it
belongs to. It is **not** suspended by `isolated`: like a grade and unlike a
blend, it is a property of the clip, so a masked clip stays masked through a
transition. The no-layer fallback degrades to `ctx.clip()`, which loses the
feather and drops an inverted mask rather than applying it backwards.

**The pen tool is the one thing that fights the rest of the editor**, and the
whole conflict matrix is in `penSession.test.ts`. Two guards are load-bearing
and neither is obvious: `elementTimelineCanvas._handleKeydown` yields explicitly
on `penCapturesKey`, because a capture-phase listener only beats a bubble one
when the event's target is *below* `window` — for one dispatched at `window`
both fire in AT_TARGET order and the timeline, mounting first, would delete the
clip being masked. And `moveSelectionByTrack` gained the `cursorType` guard
`stepCursor` already had. The session holds element-local pixels and writes
nothing until the path closes, so zooming, scrubbing and undo cannot reach it,
and one drawn mask is one undo step.

The word **pen** means the mask tool and nothing else: the create menu's entry
that click-appends segments to a new `shape` element was called "Pen Tool" and
is now "Polygon", for the reason the LUT section gives about "filter".

## LUTs

**Called a LUT, never a "filter".** `VideoElementType.filter` and
`set_video_filters` already own that word for the chroma key and the two blurs,
and this feature is a different thing that would sit next to it in the same
sidebar and the same tool list. Two things called a filter is a UI nobody can
describe and a tool surface an agent will pick wrongly from. The sidebar tab
says "LUTs", the MCP tools are `list_luts` and `set_lut`, and the word "filter"
appears in this feature's code only where it means texture filtering or
`Array.prototype.filter`.

A **LUT is a third preset kind**, alongside `effect` and `transition`, living in
the same registry and scanned by the same `presetScan.ts`. It ships data rather
than GLSL: every LUT preset runs one shader, and eighty copies of that shader
would have defeated `catalogue.test.ts`'s "no two presets run the same
pipeline" rule outright.

```
assets/presets/luts/<slug>/{manifest.json,lut.cube}   80 built-ins, 17³, ~11 MB
apps/app/src/features/lut/cube.ts        the .cube reader — the compatibility promise
apps/app/src/features/lut/sample.ts      tetrahedral + trilinear. The reference oracle
apps/app/src/features/lut/glsl.ts        the same maths in GLSL, for both GPU call sites
apps/app/src/features/lut/atlas.ts       cube -> tiled 2D texture (WebGL 1 has no TEXTURE_3D)
apps/app/src/features/lut/colorMath.ts   the operations the built-ins are composed from
apps/app/src/features/lut/recipes.ts     the eighty, as formulas
apps/app/src/features/lut/lutRegistry.ts lazy load, and the renderer's resolver
apps/app/src/features/lut/sampleImage.ts the fixed picture every tile shows
apps/app/src/features/lut/ffmpegParity.test.ts  us against ffmpeg's own lut3d
apps/app/src/features/timeline/lutOps.ts setClipLut / setClipLutIntensity
apps/app/src/features/renderer/lut/      apply.ts (injection), gpu.ts, cpu.ts
scripts/generateLuts.ts                  npx vite-node scripts/generateLuts.ts
```

A LUT reaches the picture **two ways**, which is the Premiere/Final Cut
arrangement and not two implementations of one thing:

- **On a clip**, as `element.lut = { presetId, intensity }` — a `Gradable`
  mixin over the same five types `Blendable` covers. Applied in
  `renderElement`, on the blend-isolation layer, *before* the blend: grade the
  clip, then combine it with the scene.
- **On an adjustment layer**, as an ordinary `EffectElementType` whose
  `presetId` names a LUT. No new element type, no new MCP tool — `add_effect`
  already does it, and track order already decides what it covers.

Absent means ungraded and **`SCHEMA_VERSION` did not move**; clearing deletes
the key, so an ungraded project saves byte-identically to one written before
the feature. Same rule `blend` follows.

Four things about it that are easy to get wrong:

- **`.cube` is red-fastest; `.3dl` is blue-fastest.** Reading one as the other
  produces a *plausible* wrong grade, not a broken picture. Both are pinned by
  hand-built 2³ tables.
- **A missing LUT grades nothing and reports nothing.** `lutFor` answers `null`
  for "not installed", "not read yet" and "unreadable" alike, and all three
  render as a pass-through — the contract `planFrame.ts` already gives a
  missing shader preset. The one consequence: `renderTimeline.ts` must
  `preloadLutsForDocument` before the first frame, because an export's loop
  cannot wait for the next repaint the way the preview does.
- **The grade is applied to straight, not premultiplied, colour.** Both GPU
  call sites rely on `premultipliedAlpha: false` and the default
  `UNPACK_PREMULTIPLY_ALPHA_WEBGL`; flipping either silently darkens every
  soft edge. `getImageData` is already straight, so the CPU applier needs
  nothing.
- **Interpolation is tetrahedral**, as in Resolve, Lumetri and `ffmpeg -vf
  lut3d`. Trilinear is implemented only as the cross-check: the two agree
  exactly at grid nodes and differ between them, which is what catches an
  off-by-one in the index arithmetic.
- **The LUT panel's thumbnails never change.** They grade one fixed sample
  (`sampleImage.ts`), not the project at the playhead. A grid of eighty tiles is
  a *comparison*, and a thumbnail sourced from the timeline moves under the user
  every time the playhead does — so two LUTs looked at a few seconds apart
  would have been judged against different pictures, with nothing on screen
  saying so. Drawn in code, so it cannot go missing and a screenshot of the
  panel stays comparable across builds.

### How it is known to be right

Every check above is ultimately a check against *ourselves*, and a LUT that is
subtly wrong does not look broken — it looks like a slightly different grade,
which is what a LUT is. So the load-bearing verification is external:

**`lut/ffmpegParity.test.ts` runs the bundled ffmpeg's own `lut3d` filter over
4,096 colours and compares it to `sampleLut` on the same `.cube`.** Raw `rgb24`
in and out, no codec. It agrees to within **one 8-bit step** on the shipped
tables and on hand-written spec corners, under *both* tetrahedral and trilinear
— two separate code paths in both implementations, which is what rules out an
axis transposition that one scheme could hide by coincidence. The suite also
proves it is measuring something: hand the two sides different tables and it
must diverge by >200.

`tests/e2e/specs/lut.spec.ts` closes the last gap, tying the **shader that
actually ships** to ffmpeg: it renders patches on the GPU with no codec in the
way and compares them to `lut3d` on the same files. Currently within 1/255 on
every case.

Between them the chain is: ffmpeg ↔ `sample.ts` ↔ (`glsl.test.ts` parses the
GLSL and evaluates its six tetrahedra) ↔ the GPU ↔ ffmpeg again. Nothing in it
rests on our own idea of what a LUT means.

Add to that: `lutComposite.test.ts` drives the real `renderElement` with the CPU
applier and asserts bytes, and the e2e spec checks the delivered `.mp4` after a
real Render.

The built-ins are generated, never traced. `recipes.ts` composes them from
published colour science, and `lutCatalogue.test.ts` regenerates them and
compares byte for byte, so the files and the recipes cannot drift. Its other
rules are the LUT translation of the catalogue rules: no two tables closer than
eight 8-bit steps, every category at least six deep, and every table smooth
enough that a 17-node grid reconstructs it — that last one is a real constraint
on the recipes, and it is why `hueBand` has no plateau and `vibrance` measures
chroma as an RMS distance rather than as `max - min`. **The `log-convert` six
apply the published transfer function and a neutral Rec.709 render only**: no
camera primaries matrix and no manufacturer look, so they are a correct base
grade and not a substitute for a vendor conversion LUT.

## Color adjustments

A clip's manual colour controls — CapCut's Adjust panel, which is also
Lightroom's and Lumetri's basic set. Fifteen sliders in three groups, on the
same five types a LUT covers:

- **Color**: temperature, tint, saturation
- **Lightness**: exposure, contrast, highlights, shadows, whites, blacks, brilliance
- **Effects**: sharpen, clarity, particles (grain), fade, vignette

```
apps/app/src/features/adjust/spec.ts         the table: group, range, every physical scale
apps/app/src/features/adjust/tone.ts         colour + lightness as one pure pixel function
apps/app/src/features/adjust/bake.ts         that function baked into a 33³ LUT, cached by key
apps/app/src/features/adjust/finishMath.ts   effects: the CPU oracle the GLSL is generated from
apps/app/src/features/renderer/adjust.ts     adjustOf / coerceAdjustPatch — the read/write split
apps/app/src/features/renderer/adjust/       apply.ts (injection), glsl.ts, gpu.ts, cpu.ts
apps/app/src/features/timeline/adjustOps.ts  setClipAdjust / resetClipAdjust, and their declines
apps/app/src/features/option/optionAdjustSection.ts   the Adjust tab
```

`element.adjust` is a **sparse** map of slider values: a slider at zero has no
key, a clip with every slider at zero has no field, so an unadjusted project
saves byte-identically to one written before the feature and
**`SCHEMA_VERSION` did not move**. Bipolar sliders run −100..100, the four
effects with no meaningful negative run 0..100; vignette is bipolar (+ darkens
the edges, − lightens). Static values only — there are no adjustment keyframes
yet, and nothing in the design stands in their way.

**The two groups are applied in two different places, and that split is the
design.** Every colour and lightness control is a pure function of the pixel's
own colour, so `bake.ts` evaluates the whole chain at the nodes of a cube and
hands it to the *existing* clip-LUT applier. No new shader: the tone half
inherits a GLSL path already pinned to ffmpeg's `lut3d`, the half-float atlas,
the CPU fallback and export blocking. What is left to prove is that the table
matches the function, and `bake.test.ts` holds it to one 8-bit step for every
slider at both ends of its travel. The effects need a pixel's neighbours or its
position, so they run in a separate **finish** pass with its own GPU and CPU
appliers, injected the way `lut/apply.ts` injects its own.

The order inside `renderElement`'s isolation layer:

```
drawDirect → tone (baked LUT) → clip LUT → finish → mask → blend
```

Tone before the LUT is Lumetri's Basic-then-Creative: correct the shot, then
apply the look. Finish after it because fade has to see the graded blacks to
lift them. Finish before the mask for the reason the grade is — the GPU applier
blits back with `copy`. Neither half is suspended by `isolated`. An unadjusted
clip, or one whose sliders are all zero, keeps the fast path; `golden.test.ts`'s
plain digests are the proof, and there is a separate adjusted block beside the
blended one.

Six things that are easy to get wrong, most of them paid for once:

- **The table is baked unclamped.** The final clamp is a crease wherever
  exposure or saturation pushes a channel through 0 or 1, and a crease inside a
  cube cell does not shrink usefully with the table (+2 EV was 2.7 steps out at
  33³ and still 1.6 at 65³). `LutData` stores out-of-range nodes on purpose, and
  both appliers clamp *after* the lookup, which is exactly where `toneStep`
  clamps. The tone curve is continued linearly past its ends for the same reason.
- **White balance and exposure go through a pure 2.2 power, not piecewise
  sRGB.** Under a power law a gain on light is a gain on the signal —
  `x·g^(1/2.2)` — so all three fold into one per-channel multiply, which a LUT
  reproduces exactly. Through the sRGB toe, +2 EV with warm white balance was
  5.2 steps out near black at 33³. The two curves differ only below ~4% signal,
  and `tone.test.ts` checks 18% grey against sRGB to within 1%.
- **Highlights, shadows, whites, blacks and brilliance are one monotone curve**,
  not five in a row, with a minimum rise between control points. Five composed
  curves can fight; one curve that must rise cannot invert.
- **Highlights and shadows are global**, a curve and not Lightroom's
  edge-aware local tone mapping. Deliberate: a global curve bakes exactly, so the
  preview and the export are structurally the same picture.
- **Every finish distance is the clip's, not the layer's.** The layer is in
  device pixels — the preview carries zoom × DPR — so sharpen's tap spacing and
  the grain cell are clip pixels × the device scale, clarity's radius is a share
  of the clip's shorter side, and the vignette maps device → clip space through
  `mask.ts#elementDeviceMatrix`, the chain the mask already used. That is why the
  vignette follows a rotated clip and why `adjustComposite.test.ts` can require
  the same picture at 1× and 2×.
- **The blurs average premultiplied colour.** The layer holds one clip against
  transparency; averaging straight colour across its edge reads the empty
  surroundings as black picture and sharpens a rim onto the border. The GPU
  uploads the layer a second time with `UNPACK_PREMULTIPLY_ALPHA_WEBGL` for the
  taps; the centre pixel still comes from the straight upload.

Two more that are about the tests rather than the feature:

- **`@napi-rs/canvas` applies the current transform to `putImageData`**, which
  the spec says must be ignored and Chromium does ignore. Both CPU appliers
  (`adjust/cpu.ts` and `lut/cpu.ts`) now write back under an explicit identity.
  Before that, any node suite drawing at a scale other than 1 read a magnified
  layer back — invisible in every LUT suite, all of which draw at identity.
- **Grain uses Hoskins' sine-free hash**, because GPUs disagree about `sin` at
  large arguments. It is still not bit-exact between float32 on the GPU and
  float64 on the CPU, so grain is checked statistically everywhere, and the
  adjusted golden block leaves it out.

The GLSL is **generated** from `finishMath.ts`'s constants (`glsl.ts`), so a
tap weight or a scale cannot drift between the two; `glsl.test.ts` checks the
text carries them and runs the stages in `finishPixel`'s order.
`tests/e2e/specs/adjust.spec.ts` is what ties the shader that ships to the CPU
oracle on real pixels.

Reached three ways, all through `adjustOps.ts`: the **Adjust tab** in the
video, image, shape and text inspectors (gif still has no inspector at all);
the `set_color_adjustments` MCP tool, whose strict schema is built from
`define.ts#COLOR_ADJUSTMENTS` and pinned against `COLOR_ADJUSTMENT_KEYS`; and
nothing else. A reset and a patch in one tool call are one undo step, and a
slider drag is one undo step through `GestureCommit`.

## Reverse and mirror

Two per-clip operations that sit next to each other in the UI — the timeline's
context menu and the option panel's `<clip-orientation>` row both call the
same functions — and are opposite in every other way. Mirror is a render
property: instant, no file. Reverse makes a new media file and points the clip
at it.

```
apps/app/src/features/timeline/mirrorOps.ts    flipH / flipV — video and image only
apps/app/src/features/renderer/mirror.ts       applyMirror, called from drawDirect
apps/app/src/features/timeline/reverseOps.ts   applyReverse / unreverse
apps/app/src/features/reverse/reverseSession.ts  start a job, apply on landing
apps/app/src/states/backgroundTaskStore.ts     the bottom-left tray's list
electron/lib/reverseRecipe.ts                  args + chunk sizing, pure
electron/lib/reversePipeline.ts                the run, no Electron — tested for real
electron/lib/reverse.ts / ipc/ipcReverse.ts    cache in userData/reversed, serial queue
```

**Mirror flips the picture inside its box, not the element.** `applyMirror`
runs in `drawDirect` after the transform and just before the per-type
renderer, so the box — and with it the hit test, the grips, the outline,
resize, the pen tool, tracking and group children — does not move.
`transform.ts` deliberately refuses a negative scale, and `rotationOf` would
read a mirrored matrix as a half turn. The consequence to know: **a mask stays
where it was drawn** and the picture turns over beneath it. `true` or absent;
off deletes the key.

**Reverse swaps `localpath` for a reversed copy of the trim window.** That is
why the preview, the export's audio (`-i localpath`), the filmstrip, the
waveform and `loadedAssetStore` needed no changes. The clip becomes
`trim = [0, duration]` over the new file, so its span does not move. The
original is kept in `element.reversed`, and source time `r` in the reversed
file is `to − r` in the original, which is what makes `unreverse` instant and
exact after a split or an inner trim. Keyframes, speed, blend, grade, mask and
mirror are untouched.

Four things that are easy to get wrong:

- **FFmpeg's `reverse` buffers its whole input.** At 3600×2338@120 that is
  1.5GB a second, so the window is cut into chunks sized to a 512MB budget
  (`chunkSecondsFor`), each reversed alone and joined last-first. The cut is
  one decode through the `segment` muxer with forced keyframes, not one seek
  per chunk — N independent seeks can duplicate or drop a boundary frame.
- **`applyReverse` declines if the clip changed while the file was made.** It
  takes minutes on heavy footage and editing continues; a clip trimmed in the
  meantime covers a different window. The session toasts rather than applying.
- **`reversePipeline.test.ts` is the real check**, against the bundled ffmpeg:
  output frame `i` must be closest to source frame `N−1−i` across four chunk
  boundaries. Its fixture is flat greys at `16 + 3N`, and it was wrong twice
  first — `testsrc2` at 64×48 changes by less than encode noise, and levels
  outside 16..235 clip to 0/255 and collide. Both failed while the pipeline
  was right. Change the fixture carefully.
- **The reversed file lives in `userData/reversed`, like proxies.** A project
  moved to another machine shows a reversed clip as missing media, and
  `reversed.localpath` is not an `AssetField`, so `relinkAssets` does not
  rewrite it. A sound detached *before* reversing stays forward — it is a
  separate clip. There is no MCP write tool for either yet; the serializer
  reports `mirror` and `reversed`.

`SCHEMA_VERSION` did not move.

## The screen recorder

A separate application inside the app: two windows and a tray icon, opened from
Utilities → Screen Recorder and reached by the editor exactly once, at the end,
with a path to a finished MP4. Nothing about a recording touches the editor's
renderer — that is the requirement the whole shape follows from.

```
apps/overlay-record/                 a standalone Vite app, two entry points
  overlay.html  src/overlay/         the camera bubble, transparent + click-through
  engine.html   src/engine/          capture, encode, the whole state machine
apps/app/src/features/record/        the pure logic, so vitest can reach it
  recordSettings.ts   the schema, normalize/apply read-write split
  captureSettings.ts  native size, bitrate, H.264 level, the size ladder
  bubbleLayout.ts     where the bubble goes and what it shows
  zoomPlan.ts         cursor track -> zoom moves  (planned, not yet wired)
  strokeRender.ts     pen strokes and click ripples  (planned, not yet wired)
  trayModel.ts        the menu, as data
electron/lib/recordSession.ts        disk, the cursor track, delivery
electron/lib/recorder.ts             the two windows and the routing
electron/lib/recordTray.ts           Tray lifecycle;  recordTrayMenu.ts renders a model
electron/lib/recordMux.ts            the one ffmpeg call
electron/lib/displayMedia.ts         one-shot getDisplayMedia, for system audio
```

**The encoder is driven by a fixed-rate clock, not by the capturer.** This is
the decision everything else falls out of. A desktop capturer is variable-rate —
it produces a frame when something changed and nothing while a page of text sits
still — so encoding frames as they arrive gives a stream whose timing lives only
in its timestamps, which needs a container, which needs a muxer in the renderer.
Encoding on a metronome instead, taking the newest frame each tick and
re-encoding the previous one when nothing changed, makes frame `n` *be* at
`n / fps`. The bytes then need no timestamps at all: a bare Annex-B elementary
stream that FFmpeg reads with `-r` and copies into an MP4 with `-c:v copy`.

It costs almost nothing — a duplicate frame is a P-frame with no residual — and
it produces what the editor wants anyway, since the timeline is CFR and
`features/export/renderTimeline.ts` samples at `frame / fps * 1000`. There is no
muxer dependency and no second encode generation. Verified: a measured 10.001s
take gives 301 frames and a 10.033s container.

Four more things that are easy to get wrong:

- **Capture at the display's own pixels.** `size × scaleFactor`, pinned with
  `min` *and* `max` constraints. The in-panel `screen-record-panel` caps at
  1920×1080 unconditionally, which throws away 64% of a Retina panel before the
  encoder sees the picture. `videoTrack.contentHint = "detail"` goes with it —
  spatial detail over temporal smoothness, which is the right trade for a screen
  and precisely wrong for the camera, which gets `"motion"`.
- **A hardware encoder's limits are not the codec's, so ask.** VideoToolbox
  refuses this machine's own 3600×2338 whatever the level tables say.
  `negotiateEncode` walks `captureSizeLadder` through
  `VideoEncoder.isConfigSupported` and takes the first size accepted — measured
  here, that is 3324×2160 at `avc1.640033`. Guessing the limit would be wrong on
  the next machine.
- **The overlay window is `setContentProtection(true)`.** `NSWindowSharingNone`
  on macOS, `WDA_EXCLUDEFROMCAPTURE` on Windows: the compositor leaves it out of
  every screen capture including ours. Without it the bubble the user is looking
  at is captured into the recording and the compositor draws a second one on
  top. It is also what lets the bubble be positioned live — the preview and the
  file are two renderings of one layout, from one `bubbleLayout.ts`, not a
  recording of each other. Pinned by a sentinel check: put the overlay's bubble
  in one corner and the composite's in another, and only the composite's appears
  in the file.
- **`electron/` may not import `apps/app/src`**, so the tray menu crosses the
  boundary as *data*. The engine builds a model, main renders it with
  `Menu.buildFromTemplate`, and menu item ids are opaque to main. What is
  duplicated is the vocabulary of a menu — label, checkbox, radio, submenu —
  which does not change when a setting is added. `lib/preset.ts` makes the same
  call for the same reason.

Audio is uncompressed PCM to a headerless `.pcm` file, converted to AAC once at
mux time: a WAV header states a length that is not known until the recording
stops, and a header patch that fails leaves a file that looks valid and plays as
noise. `captureMicrophone` turns off `echoCancellation`, `noiseSuppression` and
`autoGainControl` — all three default to on because the default caller is a
video call, and all three are wrong for a recording.

**macOS cannot capture system audio.** Electron 33's `Streams.audio` documents
`loopback` as Windows-only (`node_modules/electron/electron.d.ts`). The tray
greys the item and says why rather than hiding it. macOS support needs Electron
35+.

### Drawing mode has to carry its own exit

Turning drawing on means `setIgnoreMouseEvents(false)` on a window covering the
whole display, and from that moment **every click on the screen lands in the
overlay**. `pointer-events: none` does not help — it governs dispatch inside the
page, not whether the OS window receives the click at all. That is inherent; it
is what a drawing surface *is*. What is not inherent is being unable to leave,
and the first version managed to be unleavable three ways at once: the window
sat at `"screen-saver"` level over the menu bar so the tray was unclickable, it
rendered nothing when no camera was selected so there was no sign anything had
happened, and `drawing` was **persisted**, so a session that ended in that state
came back to an unclickable screen on the next launch.

So there are three exits and each is enough on its own:

- the toolbar's **Done** button, drawn by the overlay itself;
- the **Escape** key, which is why the window is `setFocusable(true)` and
  focused for exactly the duration of drawing mode and at no other time;
- the **tray**, kept reachable by dropping the window to `"floating"` level —
  below `NSMainMenuWindowLevel` — for the duration. On Windows the taskbar is
  topmost, so leaving always-on-top does the same job.

And `normalizeRecordSettings` **never reads `drawing` back**. It is written like
any other field, because one write path is simpler than two, and then ignored on
load: it is a mode, not a preference.

Annotations cross from the overlay to the compositor **as data, through main** —
two renderer processes sharing no memory. A stroke is re-sent whole as it grows
and replaces its earlier self by id, which is what makes the line appear in the
recording as it is drawn rather than popping in complete when the pen lifts, and
makes a dropped message cost one frame. Points are normalised `0..1` to the
display, the only space the overlay's CSS pixels and the encoder's capture
pixels can agree on. The fade is timed from when a stroke stopped changing, on
the *engine's* clock — the two windows' `performance.now()` share no epoch.

Strokes are re-drawn from their points rather than captured, which keeps them
crisp at any scale and is anyway the only option: the overlay is
content-protected and therefore invisible to the capture. `shouldCompose` is
asked per encoded frame, so a take with no camera and nothing drawn keeps the
zero-copy path until the moment something has to be drawn.

Still not wired, though the pure module and its suite exist: **auto zoom**
(`zoomPlan.ts`; `recordSession.ts` already records the cursor track at 30Hz).
**Click highlight** needs a global mouse hook — `screen.getCursorScreenPoint()`
gives position but not clicks — which means a native module and, on macOS, the
Accessibility prompt.

## Exporting

The trigger is one button on the **title bar**, and it is the only one: the
settings panel under `#nav-home` chooses the codec and the preset, under its
Export tab, and starting a render is not its job. Menu, button and keystroke are one code path, the rule
`features/editor/actions.ts` states for the toolbar.

```
apps/app/src/features/export/exportSession.ts   startExport / cancelExport — the one path
apps/app/src/features/export/exportPhase.ts     the four phases, as a pure table
apps/app/src/states/exportStore.ts              phase, percent, remainingMs, destination
apps/app/src/features/export/exportProgress.ts  the ETA singleton — publishes, never paints
apps/app/src/features/export/snapshot.ts        what the frame loop reads, detached
apps/app/src/features/export/exportButton.ts    <export-button>, the ring and its popover
apps/app/src/features/export/exportRing.ts      ringDash — pure, node-tested
apps/app/src/features/asset/videoScope.ts       the decoders an export owns
```

### The modal was the safety, and it is gone

Clicking Render used to open a Bootstrap dialog whose backdrop covered the
window. Nobody chose that as a concurrency control, but it was one: **the export
frame loop runs in the editor's own renderer and drove the same `<video>`
handles as the preview.** `previewCanvas` repaints on every store write, and its
draw path calls `syncPlayback` and `releaseUnusedVideos(timeline, cursorMs)` —
the second of which `loadedAssetStore` already documented as the thing an export
"must never" suffer. Editing during a render would have produced a plausible
wrong frame, or a frame loop waiting forever on a `seeked` for a handle that had
been torn down.

So an export now owns its decoders. `videoScope.ts` holds a named set of
handles, and `withVideoScope(scope, draw)` makes it answer `getElementVideo` for
the duration of one composite.

Four things about it are easy to get wrong:

- **The seam is `getElementVideo`, not the renderer table.** `renderVideoWithWait`
  and `renderVideoWithoutWait` differ only in `waitFilter` and both resolve
  through the same lookup — and `App.ts` installs the *export* table on the
  template resolver globally, so a per-caller table would never reach a
  template's nested clips at all.
- **The dynamic extent is only safe because every renderer is synchronous.**
  `renderer/{timeline,element,video,image,gif,text,shape,template}.ts` and
  `fx/compositor.ts` all are. The moment one gains an `await`, the export's scope
  leaks into whatever runs next and the preview draws the export's frames.
- **No fallback to the shared map inside a scope.** A silent fallback restores
  the bug exactly, and converts a visible "this clip is missing" into an
  invisible "this clip is at the preview's playhead".
- **Overlay effects are a second decoder set**, in `fx/overlaySource.ts`, keyed
  by scope for the same reason. `releaseUnusedOverlays` runs from the preview's
  draw path and sweeps the preview's scope alone.

Images and gifs stay shared: keyed by path, immutable once decoded, so nothing
can move one under a frame loop. The contact sheet, the template thumbnail and
the e2e reference render stay on the shared set too — they draw one frame of the
*live* document, which is what `seek`'s unchanged signature keeps them doing.

### What else the loop reads

`snapshot.ts` copies the element map and each element, and **not one level
deeper**. The document is immutable by convention, so `animation`, `mask`,
`filter` and `lut` are safe to share — and a deep clone would not be: one baked
lane is 36,000 samples per property. The shallow element copy exists for the two
places that still write a field onto a live element, `elementTimeline.ts`'s
`.blob` and `optionImage.ts`'s `.localpath`; the second would make a clip vanish
from the delivered file mid-render.

### The phases

`idle → running → finalizing → idle`, plus `cancelling`. That last one is not
decoration: aborting is instant in the renderer and slow in main, which is still
SIGKILLing FFmpeg — and `ipcRenderV2.start` throws "An export is already
running" throughout. With the button permanently on screen that window is one
double-click away. `render:v2:cancelled` settles it, and `exportSession` arms a
timeout in case it never arrives.

`nextPhase` returns its input **by identity** for a transition that does not
apply, and `exportStore` compares before writing, so the duplicate `settled`
that the click handler's `finally` and the IPC event race over costs no repaint.
`report` declines on an unchanged whole percent and whole second for the same
reason: at one write per frame an 18,000-frame export would be 18,000 Lit
renders on the thread pushing 8MB a frame into a pipe.

**`exportProgress.begin` calls `reset`, never `stop`.** `stop` dispatches
`settled`, and the session calls `begin` one line *before* `exportStore.begin` —
so settling there would knock the phase back to idle and the button would sit as
a pill for the whole export. `eta.ts`, `cost.ts` and `countdown.ts` are untouched
by any of this; the singleton publishes where it used to paint.

### Playback during a render is allowed

Scrub, play, edit, undo — none of it can reach the export's handles now, and its
audio was reconstructed in the main process from the timeline sent at
`render:v2:start`. The cost is contention: both get slower and the preview drops
frames. That is the trade, and it is stated rather than discovered.

### How it is known to be right

`tests/e2e/specs/background-export.spec.ts` exports the same project twice —
once undisturbed, once while the playhead is scrubbed at 60Hz across a
twenty-second timeline — and requires the two files to agree frame for frame.
Asserting the *difference* is what lets it stay green while the seek defect in
FINDINGS #1 is open: that afflicts both runs and cancels.

The twenty seconds are load-bearing. `decoderWindow.ts` only releases a decoder
more than 10s ahead or 6s behind the playhead, so a short project never triggers
a release and the spec would pass with or without the scope — which a first
draft of it did. With the scope removed the disturbed export **deadlocks**,
which is how the spec is known to measure something.

## Releasing and the download mirror

`npm run build:osx` uploads a draft GitHub release. Publishing it runs
`.github/workflows/mirror-r2.yml`, which copies the assets to Cloudflare R2
under `cartcut/<tag>/` and rewrites `cartcut/latest.json` and `latest.txt` —
what the "Download for macOS" button on cartesiancs.com/cartcut reads.

```
scripts/r2LatestManifest.mjs     release JSON -> latest.json, pure + CLI, no deps
.github/workflows/mirror-r2.yml  download, upload, point latest, prune to 3
```

- **GitHub is the source of truth; R2 is a mirror.** electron-updater still
  reads GitHub (`build.publish` is unchanged), and every installed copy has
  that baked into its `app-update.yml`, so moving the updater means publishing
  to both for as long as old installs exist.
- **`latest.*` is written last**, after every file under the tag has landed,
  so it never names a file that is not there. Everything under a tag is cached
  `immutable`; only the two `latest.*` files change.
- **The manifest refuses a release with no `.dmg`**, which is what renaming
  an artifact would produce. `slotOf` maps names by suffix (`-arm64.dmg`, bare
  `.dmg` = Intel); change `artifactName` and change it with it.
- **Not `wrangler r2 object put`** — it stops at 300 MiB and a DMG is ~1.1 GB.
  The workflow uses the S3 API through `aws s3 cp`, which goes multipart.

## Testing

Vitest, suites co-located with sources. The `features/timeline/` and
`features/animation/` modules are deliberately DOM-free so they run under
`environment: "node"`; the renderer suites draw onto a real Skia canvas via
`@napi-rs/canvas` and assert on pixels.

New pure ops should get a co-located suite that covers the decline path —
returning the input by identity — as well as the happy one.

`tests/e2e/` is the end-to-end render suite: Playwright launches the real app,
builds a project holding all nine element types, clicks the real Render button
and checks the delivered file frame by frame. It lives outside the vitest
include patterns and outside the root `tsconfig.json` (which has no `include`,
so `tests` has to be excluded explicitly or the harness lands in the bundle's
type program and breaks `webpack`). Start with `tests/e2e/README.md`, and
`tests/e2e/FINDINGS.md` for what it currently reports — including a
one-frame-in-three seek defect that makes it fail against `main`.

```
npm run test:e2e:fixtures   # download and derive the media, once
npm run test:e2e:smoke      # ~1 min at 360p30, for iterating
npm run test:e2e:smoke120   # same size at 120fps — the top of the rate band
npm run test:e2e            # 5 min at 1080p60, 18,000 frames
npm run test:e2e:check      # typecheck the suite on its own
```

## Known rough edges

- Undo history stores post-edit snapshots only, and nothing checkpoints on
  load, so the first edit after opening a project is not undoable. The agent
  works around this in `features/agent/checkpoint.ts`; the app itself does not.
- Video filters (`chromakey`, `blur`, `radialblur`) apply in the WebGL preview.
  They were believed not to reach the FFmpeg export, on the strength of its
  `[0:v]null[vout]` video branch — but that reading looks wrong for the v2 path:
  input 0 is `-f rawvideo -i pipe:0`, i.e. frames the *renderer* drew, and
  `export/renderers.ts` hands the exporter `renderVideoWithWait`, which runs
  `VideoFilterPipeline` whenever `filter.enable` is set. So `null` is a
  pass-through of already-filtered frames rather than a discard. The stale note
  does still hold for `electron/render/renderMain.ts`, the legacy `RENDER` ipc
  path, which nothing in the renderer calls any more.

  The *pipe* half of that reading is now confirmed by a run:
  `tests/e2e/specs/blend.spec.ts` exports through the real Render button and
  decodes back per-clip compositing the renderer did, landing within one byte
  per channel. So renderer-side picture work does reach the delivered file. The
  filters specifically are still untested end to end — they go through WebGL
  rather than the 2D context — so confirm `chromakey` before relying on it.
  Note that the *LUT* path is a separate thing and is confirmed end to end:
  `tests/e2e/specs/lut.spec.ts` decodes a graded export and matches it to the
  arithmetic within one 8-bit step. See "LUTs".
- Transitions and effects are finished, and this entry is the least
  trustworthy thing in this file.
  `TransitionElementType` and `EffectElementType` are real, `transitionOps.ts`
  and `effectOps.ts` hold every mutator, `transitionRepair.ts` keeps them honest
  from `normalizeDocument`, and both the WebGL preview and the v2 export render
  them — 37 transition presets and 39 effect presets ship under
  `assets/presets/`.

  This entry has been wrong twice, in opposite directions. It first said
  transitions did not exist at all, which made agents refuse work the renderer
  could do. It then said MCP was missing entirely — also no longer true:
  `electron/mcp/tools/fx.ts` ships `add_transition`, `set_transition`,
  `remove_transition`, `add_effect`, `set_effect`, `get_fx` and both
  `list_*_presets`, and `add_track`'s enum does include `"effect"`.

  The last narrow claim — that **`FILETYPES` in
  `electron/mcp/tools/define.ts` still omits `effect` and `transition`** — has
  now gone the same way. That list is no longer checked by eye at all:
  `@types/timeline.ts` exports `FILETYPES` as a runtime value and
  `tools.test.ts` asserts the hand-copy matches it, so a filetype missing from
  the agent's view is now a failing test rather than a note in this file. The
  standing instruction this bullet gives about itself still holds for the rest
  of it: verify before believing any claim in it, including this one.
- **`fluent-ffmpeg` cannot read this ffmpeg's capabilities.** The bundled
  binary is ffmpeg 9, whose `-formats` output puts *two* spaces between the flag
  column and the name (it gained a third flag for devices); `fluent-ffmpeg`
  2.1.2's parser expects one. So its capability list comes back **empty** and
  every `.format(...)` is rejected with "Output format X is not available"
  against a binary whose own `-muxers` lists it. Spawn ffmpeg directly for
  anything new — `render/framePipe.ts`, `mcp/transcribe.ts` and `mcp/analyze.ts`
  all do. The wrapper survives only in `render/renderMain.ts`, the legacy
  `RENDER` ipc path nothing calls.
- The playback loop still reads the wall clock and drives the cursor from
  `requestAnimationFrame`; only the *value* is quantized
  (`timeline/playbackClock.ts`). It does not drop or pace frames, so a project
  faster than the display simply repeats cursor values, which `setCursor`
  discards.
- Cross-component calls are frequently `document.querySelector("element-…")`
  followed by direct property access.
