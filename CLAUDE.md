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

FFmpeg and ffprobe binaries must be in `./bin` — see the README.

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

## The Claude Code bridge

`electron/mcp/` runs a Streamable HTTP MCP server on `127.0.0.1:9826/mcp`,
bearer-token authenticated, started with the app. Its tools validate with zod
and forward to `apps/app/src/features/agent/`, which runs the real commands
against the store — so an AI edit takes the same code path, and the same undo
step, as the user's own mouse.

```
electron/mcp/server.ts      transport, sessions, auth
electron/mcp/tools.ts       barrel: assembles the 36 tools Claude Code sees
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
npm run test:e2e:smoke      # ~1 min, for iterating
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
  path, which nothing in the renderer calls any more. Traced through the source,
  not yet confirmed by running an export — do that before relying on it.
- Transitions do not exist in the data model; the transition tab is an empty
  panel.
- Cross-component calls are frequently `document.querySelector("element-…")`
  followed by direct property access.
