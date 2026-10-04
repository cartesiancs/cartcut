/**
 * The stylesheet of an HTML graphic, reduced to what may be mounted.
 *
 * The first of two passes over every program's CSS, and the one that is tested:
 * it parses with postcss, so it runs under `environment: "node"` and the rules
 * that keep a program from loading anything or drawing differently on another
 * machine are pinned by a suite rather than trusted to the browser. The host
 * runs the browser's own parser over the result as a second check
 * (`htmlHost.ts`), which catches anything the two parsers read differently.
 *
 * Three families of rule, each answering one failure:
 *
 *  - **No I/O.** `@import`, `@font-face` and every `url()` that is not a
 *    fragment (`#id`, same tree) or a declared `asset:<name>` are removed. A
 *    graphic is mounted in the editor's own document, beside
 *    `window.electronAPI`, and a stylesheet that could fetch is a stylesheet
 *    that could report what it found.
 *  - **The same frame on every machine.** Transitions run on the wall clock,
 *    scroll and view timelines on a scroll position nothing sets, `random()` on
 *    nothing at all, viewport units and window-size media queries on the
 *    editor's window, and system colours and `prefers-*` on the user's theme.
 *    The host seeks every animation to the program's own time; each of these
 *    would make the delivered frame depend on something else.
 *  - **Nothing hides from the first two.** A CSS escape outside a string can
 *    spell `url(` or `transition` in a form neither check would see, so any
 *    backslash outside a quoted string removes the declaration.
 *
 * `@property` is pulled out rather than kept: a registration inside a shadow
 * root's adopted sheet is ignored by Chromium 152 (tests/e2e/FINDINGS.md
 * section 10), so the host hoists these to the document under per-program
 * names (`renameCustomProperties`).
 */

import postcss, { type AtRule, type ChildNode, type Container, type Declaration, type Rule } from "postcss";
import type { Diagnostic } from "../fx/inlineProgram";

export type CssFilterOptions = {
  /** Names `asset:<name>` may refer to. Anything else in url() is removed. */
  assetNames: ReadonlySet<string>;
  /** File name for diagnostics, e.g. "style.css". */
  file?: string;
};

export type FilteredCss = {
  /** The stylesheet minus everything refused and minus @property rules. */
  css: string;
  /** Only the @property rules, serialised, to be hoisted to the document by the host. */
  propertyRules: string;
  /** Custom property names those rules register, e.g. ["--angle"]. */
  propertyNames: string[];
  /** Everything removed, one diagnostic each, with line numbers when known. */
  removed: Diagnostic[];
};

/** Host-owned custom properties that a program may not register with @property. */
export const RESERVED_CUSTOM_PROPERTIES: readonly string[] = [
  "--t",
  "--progress",
  "--dur",
  "--w",
  "--h",
  "--seed",
  "--rand",
  "--from-center",
  "--char-index",
  "--char-count",
  "--char-in-word",
  "--word-index",
  "--word-count",
  "--line-index",
  "--line-count",
  "--fit",
];

/** The most one stylesheet may be, in UTF-8 bytes. The inline program's source cap. */
export const MAX_CSS_BYTES = 512 * 1024;

/**
 * At-rules kept, and walked into. Everything else is removed: `@import` and
 * `@font-face` fetch, `@namespace` and `@page` mean nothing here, and an unknown
 * one is a name a future Chromium might give meaning to.
 */
const KEPT_AT_RULES = new Set([
  "keyframes",
  "-webkit-keyframes",
  "media",
  "supports",
  "layer",
  "container",
  "font-feature-values",
  "font-palette-values",
  "counter-style",
  "scope",
  "starting-style",
]);

/**
 * Media features that answer from the editor's window or the user's machine
 * rather than from the graphic's own box. A `@media` rule mentioning one is
 * removed whole: the same project would render differently in a resized window
 * or on a colleague's laptop.
 */
const MACHINE_MEDIA = /prefers-|width|height|resolution|aspect-ratio|orientation|device-|hover|pointer|color-gamut|display-mode|scripting/i;

/** Properties removed outright, with the reason the author is told. */
const REMOVED_PROPERTIES: Array<[RegExp, string]> = [
  [
    /^transition(-|$)/,
    "transitions run on the wall clock, not the program's; animate with @keyframes",
  ],
  [
    /^animation-timeline$/,
    "scroll and view timelines follow a scroll position nothing in a graphic sets",
  ],
  [
    /^animation-play-state$/,
    "the host pauses every animation and seeks it to the program's time",
  ],
  [/^behavior$/, "a legacy script hook"],
  [/^-moz-binding$/, "a legacy script hook"],
];

/**
 * Functions that load something, or answer differently on every evaluation.
 * Matched after anything quoted has been blanked out, and only where the name
 * is not the tail of a longer identifier.
 */
const FORBIDDEN_FUNCTION =
  /(^|[^\w-])(-webkit-image-set|image-set|-moz-element|element|src|expression|random|paint)\s*\(/i;

/**
 * Viewport-relative units, directly after a number. They resolve against the
 * editor's window, not the graphic's box; `cqw`/`cqh` resolve against the box,
 * because the host makes the root a size container.
 */
const VIEWPORT_UNIT =
  /\d(?:svmin|svmax|lvmin|lvmax|dvmin|dvmax|vmin|vmax|svw|svh|lvw|lvh|dvw|dvh|svi|svb|lvi|lvb|dvi|dvb|vw|vh|vi|vb)(?![\w-])/i;

/** CSS system colours: the user's theme, not the program's palette. */
const SYSTEM_COLOR =
  /(^|[^\w-])(canvas|canvastext|linktext|visitedtext|activetext|buttonface|buttontext|buttonborder|field|fieldtext|highlight|highlighttext|selecteditem|selecteditemtext|mark|marktext|graytext|accentcolor|accentcolortext)(?![\w-])/i;

/**
 * Properties whose identifiers are names rather than colours. `font-family:
 * Mark Pro` is a typeface, and checking it for system colours would remove a
 * perfectly good font choice.
 */
const NAME_VALUED = new Set([
  "font-family",
  "font",
  "font-palette",
  "content",
  "quotes",
  "animation",
  "animation-name",
  "counter-reset",
  "counter-increment",
  "counter-set",
  "list-style",
  "list-style-type",
  "grid-area",
  "grid-row",
  "grid-column",
  "grid-template-areas",
  "container",
  "container-name",
  "view-transition-name",
  "anchor-name",
  "position-anchor",
  "will-change",
]);

const CUSTOM_PROPERTY_NAME = /^--[A-Za-z_][\w-]*$/;
const FRAGMENT = /^#[A-Za-z_][\w-]*$/;

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Every quoted string blanked to `""`, so a check cannot fire on text inside one. */
function withoutStrings(value: string): string {
  return value.replace(/"(?:[^"\\\n]|\\[\s\S])*"|'(?:[^'\\\n]|\\[\s\S])*'/g, '""');
}

/**
 * The argument of every `url(...)` in `value`, unquoted and trimmed, or `null`
 * when one is not closed: an unterminated `url(` is not something to reason
 * about, it is something to remove.
 */
export function urlArguments(value: string): string[] | null {
  const out: string[] = [];
  const pattern = /url\(/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value)) != null) {
    let at = match.index + match[0].length;
    while (at < value.length && /\s/.test(value[at])) {
      at += 1;
    }
    const quote = value[at];
    let arg: string;
    if (quote === '"' || quote === "'") {
      const end = value.indexOf(quote, at + 1);
      if (end < 0) {
        return null;
      }
      arg = value.slice(at + 1, end);
      const close = value.indexOf(")", end);
      if (close < 0) {
        return null;
      }
      pattern.lastIndex = close + 1;
    } else {
      const close = value.indexOf(")", at);
      if (close < 0) {
        return null;
      }
      arg = value.slice(at, close);
      pattern.lastIndex = close + 1;
    }
    out.push(arg.trim());
  }
  return out;
}

/** Whether a url() argument names something a graphic may use. */
function allowedUrl(arg: string, assetNames: ReadonlySet<string>): boolean {
  if (FRAGMENT.test(arg)) {
    return true;
  }
  if (arg.startsWith("asset:")) {
    return assetNames.has(arg.slice("asset:".length));
  }
  return false;
}

/**
 * Why a declaration may not stay, or `null` when it may. Shared by stylesheets,
 * inline `style` attributes and `@property`'s `initial-value`.
 */
export function declarationProblem(
  prop: string,
  value: string,
  assetNames: ReadonlySet<string>,
): string | null {
  // An escape in the property name can spell `transition` in a form the
  // pattern below would not see, and there is no reason to write one.
  if (prop.includes("\\")) {
    return "an escaped property name";
  }
  const name = prop.toLowerCase();
  for (const [pattern, reason] of REMOVED_PROPERTIES) {
    if (pattern.test(name)) {
      return "`" + prop + "`: " + reason;
    }
  }

  const bare = withoutStrings(value);
  // Outside a string an escape can spell `url(` as `u\72l(`. Inside one it is
  // how a typographer writes a curly quote (`content: "\201C"`) and spells
  // nothing that loads: a string is only fetched through `url()`, whose
  // argument is checked literally below.
  if (bare.includes("\\")) {
    return "`" + prop + "`: a CSS escape outside a string, which could hide a url()";
  }

  const urls = urlArguments(value);
  if (urls == null) {
    return "`" + prop + "`: an unterminated url()";
  }
  for (const arg of urls) {
    if (!allowedUrl(arg, assetNames)) {
      return (
        "`" +
        prop +
        "`: url(" +
        arg +
        ") is neither a #fragment nor a declared asset; a graphic loads nothing else"
      );
    }
  }

  const fn = FORBIDDEN_FUNCTION.exec(bare);
  if (fn != null) {
    return "`" + prop + "`: " + fn[2] + "() loads something or changes every time it is read";
  }
  if (VIEWPORT_UNIT.test(bare)) {
    return (
      "`" +
      prop +
      "`: viewport units follow the editor's window; use cqw and cqh, the root is a size container"
    );
  }
  if (!NAME_VALUED.has(name) && SYSTEM_COLOR.test(bare)) {
    return "`" + prop + "`: a system colour comes from the machine's theme, not the program";
  }
  return null;
}

type Context = {
  options: CssFilterOptions;
  removed: Diagnostic[];
  propertyRules: string[];
  propertyNames: string[];
};

function remember(context: Context, node: ChildNode | undefined, message: string): void {
  const line = node?.source?.start?.line;
  context.removed.push({
    ...(context.options.file != null ? { file: context.options.file } : {}),
    ...(line != null ? { line } : {}),
    message,
  });
}

function filterDeclaration(decl: Declaration, context: Context): void {
  const problem = declarationProblem(decl.prop, decl.value, context.options.assetNames);
  if (problem != null) {
    remember(context, decl, problem);
    decl.remove();
    return;
  }
  // An important `animation` would beat the host's paused `!important`
  // play-state and run on the wall clock between the seek and the paint.
  if (decl.important && /^animation$/i.test(decl.prop)) {
    remember(context, decl, "`animation`: !important dropped, the host owns play-state");
    decl.important = false;
  }
}

function filterProperty(rule: AtRule, context: Context, topLevel: boolean): void {
  const name = rule.params.trim();
  if (!topLevel) {
    remember(context, rule, "@property is only read at the top level of the stylesheet");
    rule.remove();
    return;
  }
  if (!CUSTOM_PROPERTY_NAME.test(name)) {
    remember(context, rule, "@property " + name + ": not a custom property name");
    rule.remove();
    return;
  }
  if (RESERVED_CUSTOM_PROPERTIES.includes(name)) {
    remember(
      context,
      rule,
      "@property " + name + ": the host sets this one, registering it would change what it means",
    );
    rule.remove();
    return;
  }
  for (const child of rule.nodes ?? []) {
    if (child.type !== "decl") {
      remember(context, rule, "@property " + name + ": holds something other than descriptors");
      rule.remove();
      return;
    }
    const problem = declarationProblem(child.prop, child.value, context.options.assetNames);
    if (problem != null) {
      remember(context, rule, "@property " + name + ": " + problem);
      rule.remove();
      return;
    }
  }
  if (!context.propertyNames.includes(name)) {
    context.propertyNames.push(name);
    context.propertyRules.push(rule.toString());
  }
  rule.remove();
}

function filterAtRule(rule: AtRule, context: Context, topLevel: boolean): void {
  const name = rule.name.toLowerCase();
  if (name === "property") {
    filterProperty(rule, context, topLevel);
    return;
  }
  if (!KEPT_AT_RULES.has(name)) {
    remember(context, rule, "@" + rule.name + " is not allowed in a graphic");
    rule.remove();
    return;
  }
  // An escape in the prelude can hide `prefers-` from the media check.
  if (rule.params.includes("\\")) {
    remember(context, rule, "@" + rule.name + ": an escaped prelude");
    rule.remove();
    return;
  }
  if (name === "media" && MACHINE_MEDIA.test(rule.params)) {
    remember(
      context,
      rule,
      "@media " +
        rule.params +
        ": asks about the editor's window or the machine, not the graphic; use @container",
    );
    rule.remove();
    return;
  }
  if (rule.nodes != null) {
    filterChildren(rule, context, false);
  }
}

function filterRule(rule: Rule, context: Context): void {
  // A visited link is never painted the same way twice, and there are no
  // links here to visit.
  if (/:visited/i.test(rule.selector)) {
    remember(context, rule, "a :visited selector");
    rule.remove();
    return;
  }
  filterChildren(rule, context, false);
}

function filterChildren(container: Container, context: Context, topLevel: boolean): void {
  // A copy: removing a node while iterating the live list skips its sibling.
  for (const node of [...(container.nodes ?? [])]) {
    if (node.type === "decl") {
      filterDeclaration(node, context);
    } else if (node.type === "atrule") {
      filterAtRule(node, context, topLevel);
    } else if (node.type === "rule") {
      filterRule(node, context);
    }
    // Comments stay: they load nothing and mean nothing.
  }
}

function parseError(error: unknown, file: string | undefined): Diagnostic {
  const e = error as { line?: number; reason?: string; message?: string };
  return {
    ...(file != null ? { file } : {}),
    ...(typeof e?.line === "number" ? { line: e.line } : {}),
    message: "not valid CSS: " + (e?.reason ?? e?.message ?? String(error)),
  };
}

export function filterStylesheet(css: string, options: CssFilterOptions): FilteredCss {
  const empty = (removed: Diagnostic[]): FilteredCss => ({
    css: "",
    propertyRules: "",
    propertyNames: [],
    removed,
  });
  const source = typeof css === "string" ? css : "";
  if (byteLength(source) > MAX_CSS_BYTES) {
    return empty([
      {
        ...(options.file != null ? { file: options.file } : {}),
        message: "more than " + MAX_CSS_BYTES + " bytes of CSS",
      },
    ]);
  }
  let root;
  try {
    root = postcss.parse(source);
  } catch (error) {
    return empty([parseError(error, options.file)]);
  }
  const context: Context = { options, removed: [], propertyRules: [], propertyNames: [] };
  filterChildren(root, context, true);
  return {
    css: root.toString(),
    propertyRules: context.propertyRules.join("\n"),
    propertyNames: context.propertyNames,
    removed: context.removed,
  };
}

/**
 * A `style=""` attribute's declarations, by the same value rules. Anything that
 * is not a declaration (a rule smuggled in after a `}`, an at-rule) is refused,
 * and an unbalanced brace is a parse error rather than an escape from the
 * attribute.
 */
export function filterInlineStyle(
  declarations: string,
  options: CssFilterOptions,
): { css: string; removed: Diagnostic[] } {
  const source = typeof declarations === "string" ? declarations : "";
  if (byteLength(source) > MAX_CSS_BYTES) {
    return {
      css: "",
      removed: [
        {
          ...(options.file != null ? { file: options.file } : {}),
          message: "a style attribute of more than " + MAX_CSS_BYTES + " bytes",
        },
      ],
    };
  }
  let root;
  try {
    root = postcss.parse(source);
  } catch (error) {
    return { css: "", removed: [parseError(error, options.file)] };
  }
  const context: Context = { options, removed: [], propertyRules: [], propertyNames: [] };
  const kept: string[] = [];
  for (const node of [...root.nodes]) {
    if (node.type === "comment") {
      continue;
    }
    if (node.type !== "decl") {
      remember(context, node, "a style attribute holds declarations only");
      continue;
    }
    filterDeclaration(node, context);
    if (node.parent != null) {
      kept.push(node.prop + ": " + node.value + (node.important ? " !important" : ""));
    }
  }
  return { css: kept.join("; "), removed: context.removed };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Rename every custom property in `names` to `prefix + name.slice(2)`, so
 * `--angle` with prefix `--g1a2b3c4d-` becomes `--g1a2b3c4d-angle`.
 *
 * Text-level, on CSS that `filterStylesheet` has already serialised, which is
 * what lets it reach declarations, `var()` references, keyframes and the
 * `@property` prelude alike. A name is matched only as a whole token, neither
 * preceded nor followed by an identifier character, so `--anglexyz` and an
 * already prefixed name are left alone.
 */
export function renameCustomProperties(
  css: string,
  names: readonly string[],
  prefix: string,
): string {
  const valid = names.filter((name) => CUSTOM_PROPERTY_NAME.test(name));
  if (valid.length === 0) {
    return css;
  }
  const ordered = [...new Set(valid)].sort((a, b) => b.length - a.length);
  const pattern = new RegExp(
    "(?<![\\w-])(" + ordered.map(escapeRegExp).join("|") + ")(?![\\w-])",
    "g",
  );
  return css.replace(pattern, (name: string) => prefix + name.slice(2));
}
