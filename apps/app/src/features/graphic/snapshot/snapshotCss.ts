/**
 * The stylesheets a graphic's SVG snapshot carries, made from the ones its live
 * mount uses.
 *
 * The live graphic sits in a closed shadow root, so its sheets reach nothing
 * outside it. The snapshot is one flat XML document whose scaffold (`svg`,
 * `foreignObject`, the host element) is in the same tree as the graphic, so a
 * program's `* {}`, `svg {}` or `:root {}` would style the scaffold too, and
 * `svg { width: 0 }` alone draws nothing. Every selector is therefore put under
 * `cc-host`, the element that plays the shadow host, the way the shadow root
 * scoped it:
 *
 *  - `:host` becomes `cc-host`, `:host(X)` becomes `cc-host:is(X)`;
 *  - `:root`, `:scope` outside `@scope`, `:host-context()`, `::slotted()` and
 *    `::part()` match nothing in a shadow root's own sheet, and are dropped;
 *  - every other selector gains a leading `cc-host `, a custom tag so no type
 *    selector in a program can match it, and the same (0,0,1) for every rule so
 *    the program's own order of precedence stands;
 *  - type selectors naming an HTML element are lowercased, because an XML
 *    document matches them case-sensitively and an HTML one does not.
 *
 * Keyframe selectors, `@property` and the other descriptor blocks are left as
 * they are; an `@scope` has its root selector scoped and its rules left alone.
 * Nested rules are relative to a scoped parent already. Known gap: a nested
 * rule that puts `&` after another compound (`div & {}`) can still reach the
 * scaffold. DOM-free.
 */

import postcss, { type AtRule, type ChildNode, type Container, type Declaration } from "postcss";
import selectorParser from "postcss-selector-parser";
import { HTML_ELEMENTS } from "../sanitizeHtml";

export const HOST_TAG = "cc-host";

/** At-rules whose blocks hold descriptors or keyframes rather than style rules. */
const NO_SELECTORS = new Set([
  "keyframes",
  "-webkit-keyframes",
  "font-face",
  "property",
  "counter-style",
  "font-feature-values",
  "font-palette-values",
  "page",
]);

/** Pseudo-classes and elements that match nothing from a shadow root's own sheet. */
const NEVER_MATCH = new Set([":root", ":scope", ":host-context", "::slotted", "::part"]);

type SelectorNode = selectorParser.Selector;

/** The first compound of a complex selector: every node before the first combinator. */
function firstCompound(selector: SelectorNode): selectorParser.Node[] {
  const out: selectorParser.Node[] = [];
  for (const node of selector.nodes) {
    if (node.type === "combinator") {
      break;
    }
    out.push(node);
  }
  return out;
}

function scopeComplex(selector: SelectorNode): boolean {
  let drop = false;
  selector.walkPseudos((pseudo) => {
    if (NEVER_MATCH.has(pseudo.value.toLowerCase())) {
      drop = true;
    }
  });
  if (drop) {
    return false;
  }
  selector.walkTags((tag) => {
    const lower = tag.value.toLowerCase();
    if (lower !== tag.value && HTML_ELEMENTS.has(lower)) {
      tag.value = lower;
    }
  });
  const head = firstCompound(selector);
  const host = head.find(
    (node) => node.type === "pseudo" && node.value.toLowerCase() === ":host",
  ) as selectorParser.Pseudo | undefined;
  // A `:host` anywhere but the head names an element that cannot be below
  // itself, so nothing matches.
  let elsewhere = false;
  selector.walkPseudos((pseudo) => {
    if (pseudo.value.toLowerCase() === ":host" && pseudo !== host) {
      elsewhere = true;
    }
  });
  if (elsewhere) {
    return false;
  }
  if (host != null) {
    const args = host.nodes.map((node) => node.toString()).join(",");
    const tag = selectorParser.tag({ value: HOST_TAG });
    if (args.trim() !== "") {
      host.replaceWith(tag, selectorParser.pseudo({ value: `:is(${args})` }) as never);
    } else {
      host.replaceWith(tag);
    }
    // A tag must lead its compound.
    tag.remove();
    selector.prepend(tag);
    return true;
  }
  // The list's own spacing ("a, b") lives on the first node; it moves in
  // front of the host tag so the descendant combinator stays one space.
  const first = selector.first;
  const lead = first?.spaces.before ?? "";
  if (first != null) {
    first.spaces.before = "";
  }
  const tag = selectorParser.tag({ value: HOST_TAG });
  tag.spaces.before = lead;
  selector.prepend(selectorParser.combinator({ value: " " }));
  selector.prepend(tag);
  return true;
}

/** One rule's selector list under `cc-host`, or `null` when none of it can match. */
export function scopeSelector(selectorList: string): string | null {
  let kept = 0;
  const out = selectorParser((root) => {
    for (const selector of [...root.nodes]) {
      if (scopeComplex(selector)) {
        kept += 1;
      } else {
        selector.remove();
      }
    }
  }).processSync(selectorList);
  // Trimmed: a dropped first selector leaves the next one's leading space.
  return kept === 0 ? null : out.trim();
}

function scopeContainer(container: Container): void {
  for (const node of [...(container.nodes ?? [])] as ChildNode[]) {
    if (node.type === "rule") {
      const scoped = scopeSelector(node.selector);
      if (scoped == null) {
        node.remove();
      } else {
        node.selector = scoped;
      }
      continue;
    }
    if (node.type === "atrule") {
      const at = node as AtRule;
      const name = at.name.toLowerCase();
      if (NO_SELECTORS.has(name)) {
        continue;
      }
      if (name === "scope") {
        const match = /^\s*\(([^)]*)\)([\s\S]*)$/.exec(at.params);
        if (match != null) {
          const start = scopeSelector(match[1]);
          if (start == null) {
            at.remove();
          } else {
            at.params = `(${start})${match[2]}`;
          }
        }
        continue;
      }
      scopeContainer(at);
    }
  }
}

/** A whole stylesheet with every selector put under `cc-host`. */
export function scopeStylesheet(css: string): string {
  const root = postcss.parse(css);
  scopeContainer(root);
  return root.toString();
}

// ---------------------------------------------------------------------------
// Shadow offsets (WebKit draws box-shadow and text-shadow Y-flipped in an SVG
// image; `tests/e2e/FINDINGS.md` section 11).

/** `value` split on `separator` where it is not inside brackets or a string. */
export function splitTopLevel(value: string, separator: "," | " "): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = "";
  let current = "";
  for (const ch of value) {
    if (quote !== "") {
      current += ch;
      if (ch === quote) {
        quote = "";
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "(") depth += 1;
    if (ch === ")") depth = Math.max(0, depth - 1);
    const isSeparator = separator === " " ? /\s/.test(ch) : ch === ",";
    if (isSeparator && depth === 0) {
      if (current.trim() !== "" || separator === ",") {
        out.push(current.trim());
      }
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim() !== "" || (separator === "," && out.length > 0)) {
    out.push(current.trim());
  }
  return out;
}

const MATH = /^(calc|min|max|clamp|round|mod|rem|abs|sign|sin|cos|tan|asin|acos|atan|atan2|pow|sqrt|hypot|log|exp)\(/i;
const NUMBER = /^[+-]?(\d|\.\d)/;

/** A token that is certainly a length, a token that may be one, or neither. */
function kindOf(token: string): "length" | "maybe" | "other" {
  if (NUMBER.test(token) || MATH.test(token)) {
    return "length";
  }
  if (/^(var|env|attr)\(/i.test(token)) {
    return "maybe";
  }
  return "other";
}

function negated(token: string): string {
  if (/^[+-]?0*(\.0+)?([a-z%]*)$/i.test(token)) {
    return token;
  }
  if (NUMBER.test(token)) {
    return token.startsWith("-") ? token.slice(1) : "-" + token.replace(/^\+/, "");
  }
  return `calc(-1 * ${token})`;
}

/**
 * One `box-shadow` or `text-shadow` value with every Y offset negated. The Y
 * offset is the second of the run of lengths; a `var()` counts as a length
 * there, so `var(--colour) 2px 4px` is misread (a colour variable leading the
 * shadow), which no graphic writes.
 */
export function negateShadowY(value: string): string {
  if (value.trim().toLowerCase() === "none") {
    return value;
  }
  return splitTopLevel(value, ",")
    .map((shadow) => {
      const tokens = splitTopLevel(shadow, " ");
      let seen = 0;
      for (let i = 0; i < tokens.length; i += 1) {
        const kind = kindOf(tokens[i]);
        if (kind === "other") {
          if (seen > 0) break;
          continue;
        }
        seen += 1;
        if (seen === 2) {
          tokens[i] = negated(tokens[i]);
          break;
        }
      }
      return tokens.join(" ");
    })
    .join(", ");
}

const SHADOW_PROPS = new Set(["box-shadow", "-webkit-box-shadow", "text-shadow"]);

function negateDeclarations(container: Container): void {
  container.walkDecls((decl: Declaration) => {
    if (SHADOW_PROPS.has(decl.prop.toLowerCase())) {
      decl.value = negateShadowY(decl.value);
    }
  });
}

/** A stylesheet with every shadow's Y offset negated, keyframes included. */
export function negateShadowsInStylesheet(css: string): string {
  const root = postcss.parse(css);
  negateDeclarations(root);
  return root.toString();
}

/** The same for a `style` attribute. */
export function negateShadowsInStyle(style: string): string {
  if (!/shadow/i.test(style)) {
    return style;
  }
  const root = postcss.parse(`x{${style}}`);
  negateDeclarations(root);
  const rule = root.first as Container;
  return (rule.nodes ?? []).map((node) => node.toString()).join(";");
}

// ---------------------------------------------------------------------------
// URLs. An SVG image loads nothing, so each must become a `data:` URL first.

const URL_TOKEN = /url\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^)'"\s]*))\s*\)/gi;

/** Every `url()` in `css` that is not a fragment or already a `data:` URL. */
export function cssUrls(css: string): string[] {
  const out = new Set<string>();
  for (const match of css.matchAll(URL_TOKEN)) {
    const raw = match[1] ?? match[2] ?? match[3] ?? "";
    if (raw !== "" && !raw.startsWith("#") && !/^data:/i.test(raw)) {
      out.add(raw);
    }
  }
  return [...out];
}

/** `css` with each `url()` answered by `replace` swapped for its answer; `null` keeps it. */
export function rewriteCssUrls(css: string, replace: (raw: string) => string | null): string {
  return css.replace(URL_TOKEN, (whole, a, b, c) => {
    const raw = a ?? b ?? c ?? "";
    if (raw === "" || raw.startsWith("#")) {
      return whole;
    }
    const next = replace(raw);
    return next == null ? whole : `url("${next}")`;
  });
}
