# apps/app/vendor

Third-party browser assets, served from disk. **Do not hand-edit these files.**

| File | Source | Version |
| --- | --- | --- |
| `bootstrap.min.css` | `node_modules/bootstrap/dist/css/bootstrap.min.css` | 5.0.2 |
| `bootstrap.bundle.min.js` | `node_modules/bootstrap/dist/js/bootstrap.bundle.min.js` | 5.0.2 |

Regenerate with `npm run vendor:sync`. `apps/app/src/vendorSync.test.ts` compares
these against `node_modules` by sha256, so a drift fails `npm test`.

## Why a copy and not `node_modules` or the webpack bundle

The app has to work with the machine offline, so these used to come from
jsDelivr and now cannot. Three routes were possible; this is the one that keeps
the load semantics the HTML already had.

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

## Why not the fonts too

They are in the webpack bundle instead: `apps/app/src/sass/style.scss` declares
the faces and webpack emits the files into `apps/app/dist/`. That keeps a 4 MB
`.woff2` out of git, and the pages get it for free since they already link
`../dist/style.css`. See the comments at the top of that file.
