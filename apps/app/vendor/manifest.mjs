// What apps/app/vendor/ holds, and where each file came from.
//
// One list, read by both `scripts/syncVendor.mjs` (which writes the copies) and
// `apps/app/src/vendorSync.test.ts` (which proves they still match). Adding a
// vendored file means adding one entry here and a <script>/<link> to whichever
// HTML needs it.
//
// Plain `.mjs` rather than TypeScript so the script can import it without a
// build step; the test reaches it through the same specifier.

/**
 * Copied verbatim out of an installed package. The test hashes both sides, so
 * these cannot drift from `node_modules` without `npm test` saying so.
 */
export const VENDORED_FILES = [
  {
    source: "node_modules/bootstrap/dist/css/bootstrap.min.css",
    vendored: "apps/app/vendor/bootstrap.min.css",
  },
  {
    // The `bundle` build, which has Popper inside it. Bootstrap's dropdowns
    // need Popper and the editor uses three of them.
    source: "node_modules/bootstrap/dist/js/bootstrap.bundle.min.js",
    vendored: "apps/app/vendor/bootstrap.bundle.min.js",
  },
];

/**
 * The DeVent design system, which is **not** on npm — it was loaded from
 * `cdn.jsdelivr.net/gh/Team-DeVent/devent-designsystem`, unpinned, so what the
 * app rendered with was whatever that repo's default branch held at the moment
 * the window opened. These are those bytes, frozen.
 *
 * It is not decoration. It restyles `.btn`, `b`, `i`, `.form-control`,
 * `.dropdown-*`, `.modal-*`, `.toast`, `.offcanvas` and `.nav-link` across the
 * whole editor, none of which shows up in a search for class names the app
 * "uses" — which is exactly how it got dropped once already.
 *
 * The hash is here so an accidental edit is caught; there is no upstream to
 * compare against without going back to the network, which is the thing this
 * whole change exists to stop.
 */
export const FROZEN_FILES = [
  {
    vendored: "apps/app/vendor/devent-designsystem.css",
    upstream:
      "https://cdn.jsdelivr.net/gh/Team-DeVent/devent-designsystem/dist/style.css",
    sha256:
      "49388902e7de19b40b3569d6f7d2fbfa1c4c3cd9534c435465deb9acc5d70739",
  },
  {
    vendored: "apps/app/vendor/devent-designsystem.js",
    upstream:
      "https://cdn.jsdelivr.net/gh/Team-DeVent/devent-designsystem/dist/main.js",
    sha256:
      "23e311d2045f36d08c071a514a44e0e9c2dff35242e795c8df83699e5e935be2",
  },
];

/**
 * Noto Sans KR, rebuilt from `@fontsource-variable/noto-sans-kr` — the same
 * Google font, split into the same `unicode-range` subsets that
 * `fonts.googleapis.com` served, so the browser still fetches only the chunks a
 * page's text actually needs.
 *
 * Two rewrites are applied to the package's stylesheet, and both are load-
 * bearing:
 *
 *  - **`Noto Sans KR Variable` -> `Noto Sans KR`.** Every rule that asks for
 *    this font, in the app's SCSS and inside the frozen DeVent stylesheet,
 *    names it without the suffix. The suffix is fontsource's convention for
 *    "this is the variable cut", not part of the font's identity.
 *  - **`./files/` -> `./noto-sans-kr/`**, because the woff2 files are copied
 *    next to the stylesheet rather than left in `node_modules`.
 *
 * It has to be a *variable* face. The old Google request asked for discrete
 * weights and the UI uses three of them — 400 on `b` and `.btn`, 500 on
 * `.font-weight-md`, 700 on `.font-weight-lg` and `.text-title`. One static
 * face aliased across all three renders 400 too heavy and too wide, which is
 * visible as buttons that no longer match their labels.
 */
export const FONT_SOURCE = {
  packageCss: "node_modules/@fontsource-variable/noto-sans-kr/index.css",
  packageFiles: "node_modules/@fontsource-variable/noto-sans-kr/files",
  css: "apps/app/vendor/noto-sans-kr.css",
  filesDir: "apps/app/vendor/noto-sans-kr",
  from: "Noto Sans KR Variable",
  to: "Noto Sans KR",
};
