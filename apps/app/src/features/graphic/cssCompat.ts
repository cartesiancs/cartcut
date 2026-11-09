/**
 * Writing a graphic's CSS in a form the oldest browsers the editor runs on can
 * read, where they cannot read it as written.
 *
 * Only `inset` so far: 116 of the 117 graphics centre their stage with
 * `inset: 0`, and Chrome before 87 does not know the property, so in Chrome 85
 * and 86 every one of them was drawn small against the top left corner. It is
 * a pure shorthand for `top`, `right`, `bottom` and `left`, so writing those
 * instead changes nothing where `inset` works; it is still only done where it
 * does not (`needsInsetLonghands`), so the CSS a current browser parses is the
 * program's own. DOM-free apart from that one question.
 */

import postcss, { type Container, type Declaration } from "postcss";
import { splitTopLevel } from "./snapshot/snapshotCss";

/** `top right bottom left` for an `inset` value, by the margin rule; `null` when it cannot be split. */
export function insetSides(value: string): [string, string, string, string] | null {
  const parts = splitTopLevel(value.trim(), " ");
  switch (parts.length) {
    case 1:
      return [parts[0], parts[0], parts[0], parts[0]];
    case 2:
      return [parts[0], parts[1], parts[0], parts[1]];
    case 3:
      return [parts[0], parts[1], parts[2], parts[1]];
    case 4:
      return [parts[0], parts[1], parts[2], parts[3]];
    default:
      return null;
  }
}

function expand(container: Container): void {
  container.walkDecls((decl: Declaration) => {
    if (decl.prop.toLowerCase() !== "inset") {
      return;
    }
    const sides = insetSides(decl.value);
    if (sides == null) {
      return;
    }
    const names = ["top", "right", "bottom", "left"];
    decl.replaceWith(
      names.map((prop, i) => decl.clone({ prop, value: sides[i] })),
    );
  });
}

/** A stylesheet with every `inset` written as its four longhands, keyframes included. */
export function expandInsetInStylesheet(css: string): string {
  if (!/inset\s*:/i.test(css)) {
    return css;
  }
  const root = postcss.parse(css);
  expand(root);
  return root.toString();
}

/** The same for a `style` attribute. */
export function expandInsetInStyle(style: string): string {
  if (!/inset\s*:/i.test(style)) {
    return style;
  }
  const root = postcss.parse(`x{${style}}`);
  expand(root);
  const rule = root.first as Container;
  return (rule.nodes ?? []).map((node) => node.toString()).join(";");
}

let longhands: boolean | null = null;

/** Whether this browser needs `inset` written out (Chrome before 87). */
export function needsInsetLonghands(): boolean {
  if (longhands == null) {
    try {
      longhands = typeof CSS !== "undefined" && typeof CSS.supports === "function" && !CSS.supports("inset", "0");
    } catch {
      longhands = false;
    }
  }
  return longhands;
}
