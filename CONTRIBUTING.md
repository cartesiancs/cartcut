# Contributing to Cartcut

Thanks for wanting to work on CartCut. It is an Electron video editor. Lit web
components and vanilla zustand in the renderer, plain TypeScript in the main
process, FFmpeg for export.

This file covers getting the app running, the conventions that are genuinely
load-bearing, and what a reviewable change looks like.
[CLAUDE.md](./CLAUDE.md) is the long-form architecture document: it explains why
each feature is shaped the way it is, and the section covering whatever you are
about to touch is worth reading first.

## Before you start

- Bugs and ideas go in [Issues](https://github.com/cartesiancs/cartcut/issues).
  Both templates ask for a version; please fill it in.
- For anything larger than a small fix, open an issue before writing code. This
  codebase has a lot of load-bearing invariants, and a five minute conversation
  is cheaper than a rewritten pull request.
- [docs/ROADMAP.md](./docs/ROADMAP.md) says where the project is heading.
- Taking part means agreeing to the
  [Code of Conduct](./CODE_OF_CONDUCT.md).
- Security problems do not go in the issue tracker. See
  [SECURITY.md](./SECURITY.md).

## Getting set up

### Node

`.node-version` pins **24.14.0**, which is what the release builds use.

It has to be at least 22.12.0. Electron 44 declares `node >= 22.12.0`, and
electron-builder 26 reaches `@noble/hashes` through a bare `require()` of an ES
module, which only works from 22.12.0 on: on Node 20 a release build dies at
`ERR_REQUIRE_ESM` before it packs anything.

### Dependencies

```
npm install
```

### FFmpeg binaries

FFmpeg is not committed. Download `ffmpeg` and `ffprobe` from
[ffmpeg4nugget](https://github.com/cartesiancs/ffmpeg4nugget) and put them in
the folder named for the target:

```
bin/
  darwin-arm64/{ffmpeg,ffprobe}       Apple Silicon
  darwin-x64/{ffmpeg,ffprobe}         Intel Mac
  win32-x64/{ffmpeg.exe,ffprobe.exe}
```

`electron/lib/ffmpeg.ts` picks the directory from `process.arch`, so only the
one matching your machine is needed to run locally. Then grant permission:

```
chmod -R 777 bin
```

On Apple Silicon the binaries have to be **native arm64**. An x86_64 build runs
under Rosetta at roughly half speed and says nothing about it: measured through
the app's own pipeline at 1080p60, H.264 goes from 112 to 240 fps and H.265 from
32 to 102 fps purely by being the right architecture.

```
lipo -archs bin/darwin-arm64/ffmpeg      # must print arm64
```

The build also has to carry `libx264`, `libx265`, `libvpx-vp9`, `prores_ks` and
the VideoToolbox encoders. `ffmpeg -encoders` lists them.

## Running the app

Two terminals:

```
npm run dev      # tsc --watch for main, webpack --watch for the renderer
npm run start    # electron .
```

Or one terminal, with the app kept on the latest build:

```
npm run dev:hot
```

A new renderer bundle reloads the editor window (a stylesheet-only change is
swapped in place, and keeps the open project), and a new `main/` build restarts
Electron. Either one throws away the open project and its undo history, and
Auto Save's recovery point is the way back. `npm run start:hot` is the app half
alone, next to an `npm run dev` you already have running. None of this exists in
a packaged build.

`npm run dev` does **not** build `apps/overlay-record`, the screen recorder's
own Vite app: it has its own lockfile and its own tsc. Build it by hand after
changing anything under it, or the recorder windows load a stale bundle.

```
npm run build:overlay
```

It **does** build `native/cartcut-stt`, the Swift speech sidecar. That is a
staleness check and two `swiftc` calls, so it costs nothing after the first run,
and it skips itself, loudly, on Windows or without the macOS 26 SDK.

## The build layout, which catches everyone once

`electron/` is **source**. `main/` is its **compiled output**, and
`package.json` points `"main"` at `main/main.js`. Edit `electron/`, never
`main/`: an edit there vanishes the next time tsc runs, and `main/` is
gitignored so it never shows up in a diff either way.

`.tsconfig/tsconfig.json` pins `rootDir: ../electron` deliberately. If any file
under `electron/` imports from `apps/app/src`, `rootDir` widens, the whole build
relocates from `main/` to `main/electron/`, and the app stops finding its entry
point. That is why the MCP tools talk to the renderer over IPC instead of
calling the editing functions directly, and why the recorder's tray menu crosses
that boundary as data rather than as a shared module.

`apps/app` has no `package.json`; the root webpack config builds it. The folders
under `apps/` and `packages/` that do have one are standalone apps with their own
lockfiles. This is not an npm workspace.

## Where things live

```
apps/app/src/@types/timeline.ts   the element shapes
apps/app/src/features/            the renderer's logic, one folder per feature
apps/app/src/states/              the zustand stores
apps/app/src/ui/                  the Lit components
apps/automatic-caption/           the caption panel, compiled by root webpack
apps/overlay-record/              the screen recorder, standalone Vite
electron/ipc/                     the IPC surface
electron/lib/                     main-process services
electron/mcp/                     the Claude Code bridge
electron/render/                  the FFmpeg half of export
native/cartcut-stt/               the Swift speech sidecar, macOS only
scripts/                          build and release tooling
tests/e2e/                        Playwright: the real app, real exports
```

## Conventions to know before writing anything

### Every timeline edit is a pure function

`(TimelineDocument) => TimelineDocument`, applied through
`useTimelineStore.withCheckpoint(fn)`, which records exactly one undo step.

A pure op that declines an edit **returns its input by identity**.
`withCheckpoint` reads that as "nothing happened" and records no step, which is
what makes a split off the end of a clip, or a drag into an occupied slot, cost
the user nothing. Preserve it in any new op, and cover it in the tests.

Those ops live in `apps/app/src/features/timeline/` and are deliberately
DOM-free, so they run under vitest's node environment. They never read a store:
values like the project frame rate arrive as arguments.

### Time has two coordinate systems

- `trim` is a window into the **source file**, in source milliseconds, and
  `duration === trim.endTime - trim.startTime`.
- The clip occupies `[startTime, startTime + duration / speed)` on the
  **timeline**.

Use `spanOf` / `spanLength` and `timelineTimeAt` / `sourceTimeAt` from
`features/timeline/geometry.ts` instead of open-coding the arithmetic.

### A new field never moves `SCHEMA_VERSION`

Loading a `.ngt` refuses outright on a `schemaVersion` mismatch: it is a
compatibility check, not a migrator. So new state goes in as an optional field
whose absence means the default, answered on the way in, and clearing it deletes
the key, so a project nobody has touched with your feature saves
byte-identically to one written before it existed. Nearly every feature section
in `CLAUDE.md` records "SCHEMA_VERSION did not move" for this reason.

### Writing rules

These apply to code comments, documentation, UI strings and commit messages
alike:

- **No em-dash and no middle dot, anywhere.** Both are strong markers of
  machine-written prose, and the comments here are meant to read as though a
  person wrote them for the next person. An em-dash always stands in for
  something with an actual meaning, so write that instead: a comma or brackets
  for an aside, a colon for a consequence, a semicolon or two sentences for two
  joined thoughts, `1 to 10` for a range, `a * b` for multiplication, a real
  list for a list. A hyphen is a hyphen and is always fine.
- **A comment earns its length by naming a specific failure that a specific
  line prevents.** No rhetorical flourish where a fact belongs, and no
  "it is not X, it is Y" constructions: say what it is.

The full version is at the top of [CLAUDE.md](./CLAUDE.md).

## Tests

```
npm test           # vitest run, roughly 280 suites
npm run test:watch
npm run test:cov
```

Suites are co-located with their sources. `features/timeline/` and
`features/animation/` run under `environment: "node"`; the renderer suites draw
onto a real Skia canvas through `@napi-rs/canvas` and assert on pixels rather
than on recorded calls.

There is **no DOM test environment in this repo**, so a rule that lives inside a
Lit class is a rule nothing can check. The pattern used throughout is to put the
decision in a pure module under `features/` and reach the DOM, IPC or
`requestAnimationFrame` through a narrow port the suite can fake.
`features/caption/` and `features/mask/penSession.ts` are the examples to copy.

A new pure op should get a co-located suite covering the **decline** path,
returning its input by identity, as well as the happy one.

### End to end

`tests/e2e/` launches the real app, builds a project holding every element type,
clicks the real Render button, and checks the delivered file frame by frame.

```
npm run test:e2e:fixtures   # download and derive the media, once, ~150 MB
npm run test:e2e:smoke      # ~1 min at 360p30, for iterating
npm run test:e2e:smoke120   # the same project at 120fps
npm run test:e2e            # 5 min at 1080p60, 18,000 frames
npm run test:e2e:check      # typecheck the suite on its own
```

It runs against an isolated `--user-data-dir`, so your own projects, settings
and MCP token are untouched. Start with
[tests/e2e/README.md](./tests/e2e/README.md), and `tests/e2e/FINDINGS.md` for
what it currently reports, including findings that are open against `main`.

## Typechecking and formatting

```
npx tsc --noEmit -p ./.tsconfig    # the main process
npx webpack --mode=development     # the renderer, which webpack typechecks
npm run test:e2e:check             # the Playwright suite
```

The renderer has no `tsc` pass of its own. The root `tsconfig.json` carries no
`include`, so it takes in every `.ts` file under the repo root and is what
`ts-loader` compiles against: running webpack is how you find out whether
renderer types are sound.

Formatting is Prettier, configured in `.prettierrc`: two spaces, double quotes,
semicolons, trailing commas everywhere. There is no `format` or `lint` script.
`prettier` is not a dependency, and `eslint.config.mjs` imports
`typescript-eslint`, which the lockfile does not carry, so `npx eslint` does not
currently run. Match the file you are editing, and let the recommended VS Code
extension in `.vscode/extensions.json` apply the config.

## Commits

Conventional Commits, with an optional scope, as the history shows:

```
feat: add on-device speech-to-text functionality with per-word timings
feat(caption): implement silence detection and cutting logic
fix: correct wording in recovery messages
refactor: keyframe controls into a reusable component
chore: bump version to 0.5.4 in package.json
style: adjust button padding for keyframe navigation controls
```

`feat`, `fix`, `refactor`, `chore` and `style` are the types in use. The writing
rules above apply to the message.

## Pull requests

Open it against `main`. A reviewable change:

- does one thing, and says in the description what it does **and why the shape
  was chosen**. The "why" is what the rest of this repo's prose is made of.
- passes `npm test` and both typechecks.
- adds a co-located suite for new pure logic, decline path included.
- leaves `main/`, `dist/` and `bin/` alone. All three are gitignored build
  output.
- updates the relevant section of `CLAUDE.md` when it changes an invariant
  described there, and `docs/ROADMAP.md` when it completes a roadmap item.

If the change touches export, the timeline model or the project file format, say
in the description how you checked it. "The parity suite agrees within one 8-bit
step" is the kind of answer this codebase is built around, and several of those
suites exist precisely so that answer is available.

## The Claude Code bridge

`electron/mcp/` runs an MCP server on `127.0.0.1:9826/mcp`, started with the
app, whose tools drive the same commands the mouse does and record the same undo
steps. If you use Claude Code, the committed `.mcp.json` connects to it once
`CARTCUT_MCP_TOKEN` is set; the app shows the exact command under the lightning
icon at the bottom right.

## Reporting bugs

Use the templates in `.github/ISSUE_TEMPLATE/`, and include the Cartcut version,
your OS and the steps. A project file or a short screen recording usually saves
a round trip.

Security issues go to the private contact in [SECURITY.md](./SECURITY.md), never
to the tracker.

## License

MIT, see [LICENSE](./LICENSE). Contributions are accepted under the same terms.
