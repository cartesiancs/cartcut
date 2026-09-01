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
```

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

## The Claude Code bridge

`electron/mcp/` runs a Streamable HTTP MCP server on `127.0.0.1:9826/mcp`,
bearer-token authenticated, started with the app. Its tools validate with zod
and forward to `apps/app/src/features/agent/`, which runs the real commands
against the store — so an AI edit takes the same code path, and the same undo
step, as the user's own mouse.

```
electron/mcp/server.ts      transport, sessions, auth
electron/mcp/tools.ts       barrel: assembles the 53 tools Claude Code sees
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
  `ControlRender` hands the exporter `renderVideoWithWait`, which runs
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
  now gone the same way. The array holds all nine filetypes; a tool that filters
  by filetype can name every one of them. Checked 2026-09-01, which is the
  standing instruction this bullet gives about itself: verify before believing
  any claim in it, including this one.
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
