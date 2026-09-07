# apps/app/vendor

Third-party browser assets, served from disk. **Do not hand-edit these files.**

| File | Source | Version |
| --- | --- | --- |
| `bootstrap.min.css` | `node_modules/bootstrap/dist/css/bootstrap.min.css` | 5.0.2 |
| `bootstrap.bundle.min.js` | `node_modules/bootstrap/dist/js/bootstrap.bundle.min.js` | 5.0.2 |
| `noto-sans-kr.css` + `noto-sans-kr/` | `node_modules/@fontsource-variable/noto-sans-kr`, rewritten | 5.x |
| `devent-designsystem.css` / `.js` | frozen from jsDelivr — no package, see below | — |

`npm run vendor:sync` regenerates everything except the DeVent pair.
`apps/app/src/vendorSync.test.ts` hashes all of it, so drift fails `npm test`.

These load in a fixed order, and **the order is the cascade**: Bootstrap, then
Noto Sans KR, then the design system, then the app's own `dist/style.css`. It is
the order the CDN tags were in. Material Symbols is the exception — it is
declared in `src/sass/style.scss` and webpack emits it beside `dist/style.css`,
which keeps a 4 MB `.woff2` out of git.

## Why a copy and not `node_modules` or the webpack bundle

The app has to work with the machine offline, so these used to come from
jsDelivr and Google Fonts and now cannot. Three routes were possible; this is
the one that keeps the load semantics the HTML already had.

**Not `node_modules/` by relative path.** `apps/app/page/*.html` would have to
reach `../../../node_modules/…`, which is true in a checkout and a coincidence
in a packaged app — and `scripts/buildWeb.mjs` stages a fixed list of
directories into `dist-web/`, which does not and should not include
`node_modules`.

**Not the webpack bundle.** `import` declarations in `apps/app/src/index.ts` are
hoisted, so a `window.bootstrap = …` assignment there would run *after* all ~45
imported modules evaluate; any one of them throwing takes `bootstrap` with it.
That is not hypothetical — the Credit window is created without a preload
(`electron/lib/menu.ts`), so `event.ts`'s module-scope `window.electronAPI`
registrations throw and the bundle dies mid-evaluation there today. A plain
`<script>` is independent of all of that, which is also what lets
`tests/e2e/harness/launch.ts` keep waiting on `bootstrap.Modal` and
`window.CARTCUT` as two separate signals: dependencies loaded, then bundle
evaluated.

It is `bootstrap.bundle.min.js` rather than `bootstrap.min.js` because Popper is
baked into it, and Popper is genuinely needed — `data-bs-toggle="dropdown"`
appears in `features/option/optionText.ts` and `features/preview/previewTopBar.ts`.
The two CDN `<script>` tags this replaces were exactly Popper + Bootstrap.

## The DeVent design system is frozen, not synced

It was loaded from `cdn.jsdelivr.net/gh/Team-DeVent/devent-designsystem`,
**unpinned** — so what the editor rendered with was whatever that repository's
default branch held at the moment the window opened. There is no npm package and
no version to pin, so these are those bytes, kept, with their hashes recorded in
`manifest.mjs`.

Keep them. The stylesheet was dropped once during this work on the strength of a
search for the class names the app "uses", which found nothing — because it
contributes almost entirely through *element selectors and Bootstrap component
overrides*, which such a search cannot see: `.btn` (border radius, padding, font
size), `b`, `i`, `.form-control`, `.dropdown-menu`, `.dropdown-item`,
`.modal-content`, `.modal-body`, `.toast`, `.offcanvas`, `.nav-link`, `.close`
and the table resets. Removing it changes the size of every button in the app.

## Noto Sans KR has to be the variable cut

`noto-sans-kr.css` is `@fontsource-variable/noto-sans-kr`'s stylesheet with two
rewrites — the family renamed off fontsource's `… Variable` convention, and the
file paths pointed at `./noto-sans-kr/`. Both are done by `syncVendor.mjs` and
explained in `manifest.mjs`.

It keeps fontsource's `unicode-range` split, which is the same split
`fonts.googleapis.com` served: 124 files on disk, of which a session showing no
Korean text loads exactly one.

A single static face aliased across every weight was tried first and is wrong.
The UI uses three — 400 on `b` and `.btn`, 500 on `.font-weight-md`, 700 on
`.font-weight-lg` and `.text-title` — and one face standing in for all of them
renders 400 heavier and wider, which pushes out every button label and resizes
the pill around it. The `notosanskr` face in `src/sass/style.scss` is a
different thing and is still there: it is the canvas text default, not UI
chrome.
