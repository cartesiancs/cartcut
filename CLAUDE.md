# Cartcut

An Electron video editor (`cartcut-app`, formerly "nugget"). Lit web components
and vanilla zustand in the renderer, plain TypeScript in the main process,
FFmpeg for export.

This file is a map and a list of invariants. It is loaded into every session, so
keep it short: record what a reader cannot get from the code in a minute, and
nothing else. Design history, changelogs and "how we know it works" belong in
commit messages and in the tests.

## Writing rules

**Never use an em-dash (`—`) or a middle dot (`·`).** Not in code comments, not
in documentation, not in commit messages, not in UI strings, not here. Write
what the dash was standing in for: a comma or brackets for an aside, a colon for
a consequence, a semicolon or two sentences for two joined thoughts, `1 to 10`
for a range, `a * b` for multiplication, a real list for a list. An en-dash
(`–`) is fine in a numeric range and nowhere else; a hyphen is always fine.

Two habits for the same reason: no "It's not X, it's Y" constructions, and no
rhetorical flourish where a fact belongs. A comment earns its length by naming
the specific failure the line below it prevents.

## Build layout: read this first

`electron/` is **source**; `main/` is its **compiled output**, and `package.json`
points `"main"` at `main/main.js`. Edit `electron/`, never `main/`.

**`electron/` may not import from `apps/app/src`.** `.tsconfig/tsconfig.json`
pins `rootDir: ../electron`; one such import widens it, the build relocates from
`main/` to `main/electron/`, and the app stops finding its entry point. This is
why the MCP tools talk to the renderer over IPC instead of calling the editing
functions directly, and why the recorder tray crosses the boundary as data.

`apps/app` has no `package.json`; the root webpack config builds it. The folders
under `apps/` and `packages/` that *do* have one are standalone Vite apps with
their own lockfiles. This is not an npm workspace.

`plugins/cartcut-editing/` is **published to users**, through the marketplace
declared at `.claude-plugin/marketplace.json`. Its skill is the one the app's
users get; it is no longer under `.claude/`, so editing it changes what ships.
The plugin has to stay a subdirectory: a plugin's root `package.json` is
installed by Claude Code, and pointing a plugin at the repository root would
make installing it build the whole Electron app. The two versions, in
`plugin.json` and in the marketplace entry, have to agree; `claude plugin tag`
checks that, `claude plugin validate <path> --strict` checks the rest.

FFmpeg and ffprobe live in `./bin/<platform>-<arch>/` (`darwin-arm64`,
`darwin-x64`, `win32-x64`); `electron/lib/ffmpeg.ts` picks by `process.arch`.
The macOS binaries must be **native**: an x86_64 ffmpeg runs under Rosetta at
roughly half speed and says nothing. `lipo -archs bin/darwin-arm64/ffmpeg`.

## Commands

```
npm run dev      # tsc --watch (main) + webpack --watch (renderer)
npm run start    # electron .   (run in a second terminal)
npm run dev:hot  # dev + start:hot in one terminal: reload on every build
npm test         # vitest run
npx tsc --noEmit -p ./.tsconfig    # typecheck the main process
npx webpack --mode=development     # build the renderer once
npm run build:overlay              # the screen recorder's own Vite app
npm run build:speech               # the native STT sidecar (Swift, macOS only)
```

**Hot reload is development-only and opt-in.** `start:hot`
(`scripts/devElectron.mjs`) restarts Electron when `main/` changes and sets
`CARTCUT_HOT_RELOAD=1`; `electron/lib/devReload.ts` then reloads the editor
window on a new renderer bundle (or swaps `style.css` alone in place), but only
when `isDev` is also true. A reload drops the document and the undo history, so
`npm run start` and the e2e harness never get it.

`npm run dev` does **not** build `apps/overlay-record`; build it yourself after
touching it or the recorder windows load a stale bundle. It does build
`native/cartcut-stt` (a staleness check plus two `swiftc` calls) and skips
itself loudly on Windows or without the macOS 26 SDK.

## How editing works

The most important convention in the codebase. Every edit is a **pure function
`(TimelineDocument) => TimelineDocument`**, applied through
`useTimelineStore.withCheckpoint(fn)`, which records one undo step.

**A pure op that declines returns its input, by identity.** `withCheckpoint`
reads that as "nothing happened" and records no step, which is what makes a
split off the end of a clip or a drag into an occupied slot cost the user
nothing. Preserve it in any new op, and give every new op a co-located suite
that covers the decline path as well as the happy one.

```
apps/app/src/@types/timeline.ts          element shapes, FILETYPES, animatable properties
apps/app/src/features/timeline/tracks.ts     TimelineDocument, tracks, z-order
apps/app/src/features/timeline/geometry.ts   trim/duration/speed invariants
apps/app/src/features/timeline/clipOps.ts    split, trim, move, delete, removeRanges
apps/app/src/features/timeline/placement.ts  where a new element lands
apps/app/src/states/timelineStore.ts         the store, undo history
```

Two things about time that are easy to get wrong:

- `trim` is a window into the **source file**, in source ms.
  `duration === trim.endTime - trim.startTime`.
- The clip occupies `[startTime, startTime + duration/speed)` on the
  **timeline**. Use `spanOf`/`spanLength` and `timelineTimeAt`/`sourceTimeAt`;
  never open-code the arithmetic.

`priority` is derived from track order, never authored. Layering is track order:
index 0 is the top row and the front of the composite.

## Conventions that repeat across every feature

Learn these five once and most of the codebase stops needing explanation.

**A new feature is an optional field, and `SCHEMA_VERSION` does not move.**
Project load *refuses* on a version mismatch; it is a compatibility check, not a
migrator. So absent means default, answered on the way in, and setting a field
back to its default **deletes the key** rather than storing it. A project nobody
has used the feature on saves byte-identically to one written before it existed.
`blend`, `lut`, `adjust`, `mask`, `reveal`, `geometry`, `reversed`, `mirror`,
`replaceable` and the conditional keyframe tracks all follow this.

**`normalizeX` guards reads, `coerceX` validates writes.** The first runs on
every draw and must never throw; the second runs once, where a value is stored,
and makes an unusable value unrepresentable from then on. `normalizeFps` /
`coerceFps`, `blendOf` / `coerceBlend`, `maskOf` / `coerceMask`, `adjustOf` /
`coerceAdjustPatch`.

**Anything animatable is an ordinary keyframe track in `element.animation`.**
Never a bespoke field, with exactly one exception. A **speed ramp**
(`speedCurve`, keyed in absolute source ms) cannot be a track: keyframe times
are clip-local *timeline* ms, so a speed keyframe's own position would depend on
the curve it defines, and a track is read from a lane baked at
`bakeRateFor(fps)`, so a frame-rate change would re-integrate the curve and move
the clip. `features/timeline/speedCurve.ts` states it at length.
Everything that rewrites keyframes walks
`Object.keys(animation)` or `animatableProperties(element)`, so split, trim,
move, paste and a frame-rate change carry any track for free. A field of its own
means reimplementing `cloneAnimation`, `rebaseAnimation`, `sliceAnimation` and
`rebakeElement`, and the one anybody forgets fails silently on one edit.
Unconditional tracks are seeded in `emptyAnimation`; conditional ones (the
mask's five, `revealProgress`, `volumeDb`, `intensity`, `fx:<key>`) are minted
by `keyframeOps.trackOrEmpty` when the stopwatch is armed and deleted when the
last curve goes. `keyframes.ts#carriesTrack` is the table of which is which.

**Pure ops never read a store.** `features/timeline/` and `features/animation/`
take `fps` (or `bakeHz`) as an argument, which is what keeps them DOM-free and
node-testable. Only UI components and the agent commands read
`renderOptionStore`.

**DOM logic goes behind a narrow port.** There is no DOM test environment here,
so a rule kept inside a Lit class is a rule nothing can check. Bootstrap, IPC
bridges and `requestAnimationFrame` are each reached through a plain-record port
(`ModalLike`, `TranscribePort`, `FrameScheduler`, `GainSink`, `ProjectPathPort`)
so the behaviour runs under `environment: "node"` against a fake.

Two Lit specifics: **components render into the light DOM** (70 of 70 override
`createRenderRoot` to return `this`), because the global stylesheet does not
cross a shadow boundary. So arbitrary content arrives as a `TemplateResult`
property, never through a `<slot>`. And a custom element with no styles is
`display: inline`, where width and height do nothing; a host that must be
measured needs `display: block` or it measures 0x0 with no error anywhere.

## Rendering and export

Everything visual is composited in the **renderer, on a 2D canvas**, by one
function: `renderTimelineAtTime` -> `paint` -> `renderElement`. The preview, the
in-app export, the offscreen export window, the agent's contact sheet and the
e2e reference render all call it, so preview/export parity is structural rather
than maintained.

**FFmpeg does no video compositing on the v2 path.** `renderTimeline.ts` hands
it finished frames as raw RGBA over a pipe and the video branch is
`[0:v]null[vout]`, a pass-through of already-drawn frames. A new visual property
is a change to `renderElement` and to nothing in `electron/render/`. Audio is
the exception: the filter graph does real work there (`atempo`, the volume
envelope expression, `adelay`, in that order).

The order inside `renderElement`'s isolation layer:

```
drawDirect → tone (baked LUT) → clip LUT → finish → mask → blend
```

Things that bite:

- **A blended clip is drawn in isolation**, onto a scratch layer from the
  injected factory in `renderer/surface.ts`, because `renderText` issues up to
  five overlapping draws per line that would otherwise blend against each other.
  Blend is suspended inside a transition (`ctx` marked `isolated`); the mask and
  the grade are not, because they are properties of the clip.
- **Device space is not project space.** A mask, a vignette and any other
  geometry resolved against the canvas must go through
  `renderer/mask.ts#elementDeviceMatrix`, not `worldMatrixOf`: the preview's
  context carries zoom and DPR on top of the project transform, so the wrong one
  is exact in every node suite (all at identity) and misplaced in the app.
- **`timeline/transform.ts#sampledBoxOf` is the only way to ask how big a clip
  is** at a cursor. Renderer, mask, selection outline, grips, hit test and resize
  origin all go through it; one left reading `element.width` puts the picture in
  one place and the pointer's idea of it in another.
- **An export owns its decoders.** `features/asset/videoScope.ts` holds a named
  handle set and `withVideoScope` makes it answer `getElementVideo` for one
  composite, so editing during a render cannot tear a handle out from under the
  frame loop. This is only safe because every renderer is synchronous; the moment
  one gains an `await` the scope leaks into whatever runs next. No fallback to
  the shared map inside a scope.
- **`export/snapshot.ts` copies the element map and each element, one level
  deep and no further.** The document is immutable by convention, so `animation`
  (36,000 baked samples per lane) is safe to share and a deep clone would not be.

## The project file, and Auto Save

A `.ngt` is a zip of five JSON entries, read and written entirely in the renderer
by `functions/project.ts`: `project.json`, `timeline.json`, `tracks.json`,
`renderOptions.json`, `assetPaths.json`.

> **The in-memory `TimelineDocument` is always absolute.** A relative path
> exists only inside the archive.

Media is referenced by absolute path in `timeline.json` *and*, for anything
inside the project's own folder, by a relative one in `assetPaths.json`. That is
what makes a project folder portable; the absolute path is the fallback for a
`.ngt` moved away from its media, so relinking is a preference and never a
replacement. Conversion happens at the two file boundaries and nowhere else.

`features/project/assetPaths.ts` has **no imports at all**, and path flavour is
an explicit `"posix" | "win32"` parameter: `node:path` only answers for the host
platform, which is the wrong one half the time, and both branches have to be
covered on one CI host. Two facts it exists to survive: `localpath` is **not
percent-encoded** despite usually being a `file://` URL (`functions/path.ts#encode`
escapes `#` and nothing else), and **on Windows the URL is malformed**
(`file://C:\Users\me\a.mp4`, drive letter where a host goes). Anything writing
one must reproduce it, because `mergeOps` compares these strings to decide two
clips share a source.

Auto Save lands every timeline change in a per-project cache within seconds. A
`.ngt` is written **only** by ⌘S, and a successful ⌘S drops that project's cache,
so an empty "File ▸ Auto Save ▸" means nothing anywhere is unsaved. Recovery is
explicit: the File menu is the only way in, and it refuses rather than
overwrites.

```
apps/app/src/features/project/projectDirty.ts    the one owner of "is it dirty"
apps/app/src/features/project/projectDigest.ts   the fingerprint
apps/app/src/features/project/autosaveSession.ts the state machine, over ports
apps/app/src/features/project/recoverAutosave.ts the guard and the load
electron/lib/autosaveCache.ts                    the directory, plain fs
```

Five rules carry it:

- **The anchor is path arithmetic, never an identity.** An autosave's
  `assetPaths.json` is built against the project's SSOT path, not where the
  autosave sits, or `relativizeInside` emits nothing. **It is never adopted as
  the project's path**: recovery leaves `#projectFile` empty so ⌘S opens Save As
  and the original is never touched. `recoverAutosave` holds a `ProjectPathPort`
  it never calls and that throws if called, to keep that a node assertion.
- **One recovery point per project, not a history.** Write the `.part`, rename
  it into place, *then* unlink the superseded one, so there is no instant with no
  recovery point. The filename carries the time, fixed-width and UTC, so a
  lexicographic sort is chronological and the menu opens no zips.
- **Two timers, and they are not the same timer.** 5s idle debounce re-armed by
  every change; 60s ceiling armed on `idle → armed` and **never re-armed**, or a
  ten-minute drag is never written at all. Armed implies a ceiling is pending, so
  `ensureCeiling` is idempotent and the deferral paths call it too.
- **Failure never clears dirt.** A write that rejects or answers `{ ok: false }`
  leaves the session armed and backs off 5/15/45/60s. An autosave is not a save:
  nothing on that path touches `projectDirty`'s baseline, and an *unestablished*
  baseline reads as dirty, so the quit guard still fires.
- **Main owns the directory.** `autosave:write` takes bytes and main mints the
  filename; `autosave:dropRings` takes a key `isValidAutosaveKey` must accept.
  There is no call shape in which the renderer names a path to delete.

Use `ipcFilesystem.writeFileEnsured`, never `writeFile`: the older one calls the
callback form of `fs.writeFile` and returns before it runs, so a failure is
indistinguishable from success, and it does not create parent directories.

## Where the features live

One line each. The code and its co-located suite are the documentation; this is
the index.

```
features/timeline/     clipOps, geometry, placement, mergeOps, frames, rippleMap
features/animation/    keyframes (bake), keyframeOps (mint/arm), presets (19 moves)
features/renderer/     element, video, image, text, shape, template, mask, blend,
                       fx/ (compositor, planFrame), lut/, adjust/
features/project/      the .ngt, autosave, asset paths
features/export/       exportSession, phases, snapshot, the ETA singleton
features/agent/        commit, context, serialize, commands/, what MCP forwards to
features/caption/      the auto-caption panel's every decision, and the session
                       that owns the timeline while it is open
features/window/       docked panels beside a host's content, one tabbed frame per
                       side, splitter, pure layout
features/mask/         one mask per clip: templates, bezier geometry, the pen session
features/shape/        parametric outlines, over mask/geometry.ts unchanged
features/lut/          .cube reading, tetrahedral sampling, atlas, 80 built-ins
features/adjust/       15 sliders: tone bakes into a LUT, effects run a finish pass
features/template/     a whole edit standing in for one clip (.cttpl)
features/record/       the screen recorder's pure logic; the windows are apps/overlay-record
features/reverse/      reversed media files, made by electron/lib/reversePipeline.ts
features/speed/        the ramp's graph editor; the curve is timeline/speedCurve.ts
features/update/       the update card; main's half is electron/lib/updateSession.ts
features/motion/       a damped spring as a CSS linear(): the tour, the tile hover
features/editor/       actions, menuCommands, shortcuts, frameRate
features/extension/    the extension host's editor half: bridge, dispatch, batches
electron/extension/    the extension host, its protocol, the webview sandbox
electron/mcp/          the MCP server, the tools, the bridge to the renderer
electron/render/       ffmpegArgs, the frame pipe, the audio envelope expression
electron/lib/          ffmpeg, menus, autosave cache, recorder, speech, templates,
                       the updater
```

The handful of facts inside those that are worth stating up front:

- **The frame rate is a project setting on `renderOptionStore`**, whole integers
  1 to 240, not in `TimelineDocument` and not in `ExportSettings`. NTSC rates are
  rational and admitting them means carrying a rational through `frames.ts` and
  the exporter. `features/editor/frameRate.ts#setProjectFps` is the only writer
  and sequences the three consequences (re-clamp zoom, re-snap playhead, re-bake
  animation). **Clips do not move**: a rate change is a change of grid, not a
  re-cut. **The grid does not apply to audio** (`frames.ts#isFrameLocked`), on
  drag only, and one gesture is one delta so a picture clip in the selection
  keeps the grid on for everything.
- **A speed ramp is a curve in source time, and `speed` is derived from it.**
  While `speedCurve` is present, `element.speed` holds
  `duration / curveSpanLength(curve, trim)`, so `spanLength` is still
  `duration / speed` and every collision, ripple, placement and layout call site
  is untouched. The curve and the scalar agree **exactly at both clip edges**
  and differ only inside, which is what makes a call site nobody generalised
  show a slightly wrong frame mid-clip rather than a wrong length. Anything
  writing `trim` on a ramped clip has to re-derive the scalar:
  `clipEdit.ts#withTrim` covers trim and split, and `mergeOps`, `reverseOps` and
  `audio.ts`'s detached twin each call `withDerivedSpeed` themselves. FFmpeg
  cannot ramp audio (measured: stepping `atempo` through `asendcmd` loses 21ms
  to 161ms over ten seconds, and loses more the finer the steps), so
  `electron/render/renderedAudio.ts` retimes a ramped clip's sound with our own
  WSOLA before the spawn and hands FFmpeg a 1x input.
- **`size` and `scale` are different things.** `scale` is uniform, in tenths,
  about the centre, and never touches the box. `size` replaces the clip's own
  `width`/`height` in pixels on the way to the renderer, so a keyframed property
  behaves exactly like the static field it keyframes.
- **A group element *is* After Effects' null object.** There is no
  `filetype: "null"` and adding one would break two rules keyed on the string
  `"group"`: `hierarchy.ts#parentOf` admits only a group as a parent, and
  `isVisualTimelineElement` excludes only a group from the paint loop. `setParent`
  rewrites the child's numbers once, at the instant of parenting; after that the
  matrix is composed at draw time and the child's curves are never written again.
- **A template stores a reference, not a copy** (`templateId` + `fills`),
  resolved at draw time from `templateRegistry`, exactly as `lut.presetId`
  resolves. A template that is not installed draws nothing and reports nothing.
  Composed keys are namespaced `outerId::innerKey` or two copies share one
  decoder. `expandTemplates` is for the asset layer, never the renderer.
- **A missing preset, LUT or template renders as a pass-through**, silently.
  That is the contract; do not make one of them throw.
- **Called a LUT, never a "filter".** `VideoElementType.filter` already owns that
  word for the chroma key and the blurs. Likewise **pen** means the mask tool; the
  create menu's click-to-append tool is "Polygon".
- **`speechBin.ts` decides availability in JS before anything is spawned.** The
  STT sidecar is a process, not a N-API module, built at a macOS 12 deployment
  target so its macOS 26 Speech symbols stay weak imports and it can report
  `requires_macos_26` instead of failing at `exec`. Word timings live on the runs
  of the `AttributedString`, not on `Result.range`.
- **The auto-caption panel edits the live timeline, and Apply is the only thing
  that keeps it.** From the moment a transcript lands, the document in the store
  is a *projection* of a held baseline and whatever the panel says
  (`captionProjection.ts`), rebuilt from that baseline on every change and
  written through `previewDocument`, so no intermediate state records an undo
  step. The silences are swept and cut at once, the captions land one at a time
  from 0ms forwards (`captionReveal.ts`), and editing a caption's text reaches
  its clip on the next frame. `applyCaptionCommit` stays as the *definition* of
  the finished edit, and the sequence is tested against arriving where it does.
  - **The silence toggle is not an undo.** `removeRanges` has no inverse; both
    states are built from the same baseline, which is what makes the round trip
    exact down to the element ids.
  - **Ids are minted once and keyed**, a caption's by its line's id and a cut's
    by the cut's index. A running pool would rename every piece on every frame
    of the reveal, and `loadedAssetStore` caches decoders by element id.
  - **Several clips are one session.** The picker
    (`apps/automatic-caption/src/clipPicker.ts`, its own dark overlay, since
    the vendored Bootstrap 5.0.2 has no dark modal) hands over an ordered list.
    Every line carries its clip's `sourceKey`, and `clips.ts` trims each
    transcript to its clip's window. Cuts are tracked **per track** but made
    with each clip's own list on that clip's own pieces: a range merged across
    two clips is clamped to one piece and half of it silently stays. Split ids
    are keyed by clip, then by index within the clip, so an edit in one clip
    never renames another's pieces.
  - **`timelineLockStore` is ephemeral, deliberately.** A `locked?: true` on
    `TimelineTrack` would persist, undo and save for free, and would also
    survive a crash as a lock with no holder and no way to release it. Five
    gates refuse while it is held (`actions.ts#commit`, `agent/commit.ts`, the
    timeline canvas, the preview canvas, `GestureCommit.apply`); the playhead,
    playback and the selection are left alone.
  - **A handler passed into another component's template binds `this` to that
    component.** `Control` builds the panel's template and `<app-window>`
    renders it, so Lit's listener host is the window. All four of the panel's
    handlers are arrow properties for that reason, and `changeCursorType` was
    silently dead as a method.
- **The window system's clamp precedence is `host > window min > content min`.**
  A rect outside the host is invisible rather than small, and invisible in a way
  no `getBoundingClientRect` check can see, because the column carries
  `overflow: hidden`.
- **The screen recorder encodes on a fixed-rate clock**, not as frames arrive,
  so frame `n` *is* at `n / fps` and the bytes need no container: a bare Annex-B
  stream that ffmpeg copies with `-r` and `-c:v copy`. The overlay window is
  `setContentProtection(true)` so the compositor leaves it out of the capture.
- **A menu accelerator fires whatever the page does with the same keystroke**,
  and a renderer `preventDefault` does not cancel it. For a combination the
  renderer already binds, the item carries the accelerator but declines to send
  it (`rendererOwnsKey`, tested against `event.triggeredByAccelerator`), or one
  ⌘Z is two undo steps. Space, the arrows and Delete are not registered at all:
  an accelerator is global to the window and would fire while someone types.

## Extensions

`electron/extension/` runs a **VS Code shaped extension host**: one
`utilityProcess` forked by main, shared by every extension, with no DOM, no
store and no `electronAPI`. That process boundary is the whole protection. A
crashed extension costs the user that extension; the timeline, the undo
history and the unsaved project are somewhere else.

Two ports, and they are not the same port. **Port R** runs host to editor
renderer *directly*, carrying every edit, read and event, so a wedged host
cannot block the process that owns the menu and the windows. **Port M** runs
host to main and carries only what main alone can do: dialogs, the keychain,
the menu, MCP tool registration. `electron/extension/protocol.ts` and `rpc.ts`
are compiled into all three processes, and the renderer reaches them through
the single facade `features/extension/shared.ts`.

```
electron/extension/     host, hostMain, api, rpc, protocol, manifest,
                        permissions, scheme, webviewGuard, viewBridge, services
apps/app/src/features/extension/   bridge, dispatch, transaction, contributions,
                        events, keybindings, views, elementData, projectData
packages/extension-api/ the published `cartcut` .d.ts and its README
tests/fixtures/extensions/hello/   the fixture that exercises every seam
```

Six rules carry it:

- **The editing API *is* the agent command table.** `commands.execute` goes to
  `features/agent/registry.ts`, so an extension's edit is the same code path a
  Claude Code tool call takes: one `commit`, one undo step, lock-respecting,
  whitelisted by `writable.ts` going in and `serialize.ts` coming out. There is
  no second edit path and nothing hands over the document.
- **`commit` is the only thing that records a step.** A batch opens a collector
  (`features/extension/transaction.ts`), `commit` folds into it, and
  `currentDoc` returns the working document so step N sees step N-1. A batch is
  **synchronous and closes in one tick**: an `await` would let an unrelated
  edit land inside somebody else's undo step, so an async command is refused.
  The three commands that used to pair `ensureUndoBaseline` with
  `withCheckpoint` by hand now call `commit.ts#checkpoint`.
- **Renderer extension points are data, never code.** FX presets, templates
  and animation presets go through the existing validators with `origin:
  "extension"`. The compositor is synchronous and "Nothing executes" still
  holds. `PresetName` stays a closed union: a contributed animation preset is
  a `PresetShape` under `ext:<extId>:<name>` and runs through
  `applyPresetShape`, the same function the nineteen built-ins reach, so
  `presetNames()` is unchanged and `tools.test.ts`'s pinned list stays green.
  **Fonts and themes are not contributable**: `@font-face` rules are never
  removed and `fontFaces.ts`'s `registered` set has no unregister, so a
  contributed font could not be unloaded; and there is no token layer to theme,
  six CSS custom properties exist in the whole stylesheet and five are
  geometry. Both need their own groundwork first.
- **Custom UI is a `<webview>`, forced into shape by main.**
  `will-attach-webview` sets `sandbox`, `contextIsolation`, our preload and a
  `persist:ext:<id>` partition, and refuses any `src` that is not
  `cartcut-ext://<an enabled extension>/`. Two things bite: `protocol.handle`
  registers on **one session**, so the handler is installed on each guest
  partition too or a panel's own pages never load; and `did-attach-webview`
  fires **before** the guest navigates, so `guest.getURL()` is empty there and a
  navigation guard keyed on it blocks the panel's first load.
- **Port pairs carry a generation, and the counter never resets.** The fork and
  the page load are not ordered against each other, so two pairs really are in
  flight on a first launch and both ends must converge on the highest. Resetting
  the counter for a new host leaves the renderer ignoring every port the
  replacement sends.
- **Permissions are disclosure and API gating, not a sandbox.** A
  `utilityProcess` has Node and it cannot be taken away; `node:vm` is not a
  boundary and is not used. Main gates Port M against *its own* validated
  manifest rather than anything the host reports.

An extension can **stop an export**. `onWillExport` runs after the destination
is chosen and before any phase is entered, so a veto costs nothing; it is
bounded and fails open, because an export a broken extension could make
impossible is worse than one that ignored a warning. `onDidExport` fires from
`event.ts`'s `PROCESSING_FINISH` and nowhere else: `exportSession`'s
`finalizing` is not the end, FFmpeg is still muxing there.

Extension data is an optional top-level `ext` key on an element, keyed by
extension id, plus a sixth `.ngt` entry `extensions.json`. Both follow the
optional-field rule, so `SCHEMA_VERSION` does not move and a project nobody has
run an extension on saves byte-identically.

`features/extension/imports.test.ts` pins the wall in both directions: which
files may reach into the subsystem, and what the subsystem may reach.

## The Claude Code bridge

`electron/mcp/` runs a Streamable HTTP MCP server on `127.0.0.1:9826/mcp`,
bearer-token authenticated, started with the app. Its tools validate with zod and
forward to `apps/app/src/features/agent/`, which runs the real commands against
the store, so an AI edit takes the same code path and the same undo step as the
user's mouse. Every mutating command goes through `commit(fn, declineReason)`.

Four constraints:

- **`tools.ts` must stay a barrel**, not `tools/index.ts`. Both resolve for
  `import … from "./tools"` and nothing cleans `main/`, so a stale
  `main/mcp/tools.js` would shadow the directory and ship an old tool list.
- **`registerTool`'s generics must stay erased**, through the hand-written
  `Registrar`. Inferring handler arguments from the zod shapes costs about 10s
  per tool and exhausts the compiler's heap. Do not "clean it up".
- **Tool output is capped** (Claude Code warns at 10k tokens, truncates at 25k).
  Never return a raw element; add fields to `serialize.ts`'s whitelist
  deliberately.
- **Hand copies are pinned by `tools/tools.test.ts`**, including `FILETYPES`,
  `ANIMATABLE` and the preset lists against their `@types/timeline.ts` originals.
  Adding a tool is a one-line diff a reviewer sees.

Connect with the command under the ⚡ icon at the bottom right of the app, or set
`CARTCUT_MCP_TOKEN` and use the committed `.mcp.json`.

## Testing

Vitest, suites co-located with sources. `features/timeline/` and
`features/animation/` are deliberately DOM-free and run under
`environment: "node"`; the renderer suites draw onto a real Skia canvas via
`@napi-rs/canvas` and assert on pixels.

Two habits worth copying. **Check against something that shares no code with the
subject**: the LUT and audio-envelope suites run the bundled ffmpeg and compare
it to our own sampler, which is the only way to catch a grade or a fade that is
plausibly wrong rather than broken. And **prove the harness measures something**:
hand the two sides different inputs and require them to disagree.

`@napi-rs/canvas` applies the current transform to `putImageData`, which the spec
says to ignore and Chromium does ignore. Both CPU appliers write back under an
explicit identity; anything new that reads a layer back must do the same.

```
npm run test:e2e:fixtures   # download and derive the media, once
npm run test:e2e:smoke      # ~1 min at 360p30, for iterating
npm run test:e2e            # 5 min at 1080p60, 18,000 frames
npm run test:e2e:check      # typecheck the suite on its own
```

`tests/fixtures/extensions/hello/` is the extension fixture. Load it with
Extensions ▸ Load unpacked; its `crash` and `hang` commands are there to be run,
because surviving them is the claim the whole subsystem makes.

`tests/e2e/` launches the real app, builds a project holding every element type,
clicks the real Render button and checks the delivered file frame by frame. It
lives outside the vitest include patterns and outside the root `tsconfig.json`
(which has no `include`, so `tests` must be excluded explicitly or the harness
lands in the bundle's type program and breaks webpack). Start with
`tests/e2e/README.md`, and `tests/e2e/FINDINGS.md` for what it currently reports,
including a one-frame-in-three seek defect that makes it fail against `main`.

## Known rough edges

- Undo history stores post-edit snapshots only and nothing checkpoints on load,
  so the first edit after opening a project is not undoable. The agent works
  around it in `features/agent/checkpoint.ts`; the app does not.
- **`fluent-ffmpeg` cannot read this ffmpeg's capabilities.** The bundled binary
  is ffmpeg 9, whose `-formats` output puts two spaces between the flag column
  and the name; the 2.1.2 parser expects one. Its capability list comes back
  empty and every `.format(...)` is rejected against a binary whose own
  `-muxers` lists it. Spawn ffmpeg directly for anything new. The wrapper
  survives only in `render/renderMain.ts`, the legacy `RENDER` ipc path that
  nothing calls.
- Video filters (`chromakey`, `blur`, `radialblur`) go through WebGL rather than
  the 2D context, and are the one part of the picture path not confirmed end to
  end. Renderer-side compositing *is* confirmed to reach the delivered file
  (`blend.spec.ts`, `lut.spec.ts`), so the `[0:v]null` branch is a pass-through
  of filtered frames and not a discard, but check `chromakey` yourself before
  relying on it.
- The playback loop reads the wall clock and drives the cursor from
  `requestAnimationFrame`; only the value is quantized
  (`timeline/playbackClock.ts`). It does not drop or pace frames.
- Cross-component calls are frequently `document.querySelector("element-…")`
  followed by direct property access.
