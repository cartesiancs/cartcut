/**
 * What a style control in the text panel writes, and what it shows.
 *
 * Both questions have exactly one interesting input, the live selection, and
 * both would otherwise live inside a Lit class where nothing can check them.
 * There is no DOM test environment here, so the rules are stated over plain
 * records instead, the way `caption/editor.ts` states a text field's keystroke
 * rules. `optionText` reads the field and dispatches; every decision is here.
 *
 * The rule the whole module exists to hold: **with no range selected, a control
 * writes exactly what it wrote before this feature existed.** Not something
 * equivalent, the same `{ path, value }` list, handed to the same
 * `commitStyle`. That is why `planTextStyleWrite` returns paths rather than
 * calling anything: it makes "the untouched path is untouched" a thing a test
 * can assert rather than a thing a reviewer has to believe.
 *
 * DOM-free and store-free, so it runs under `environment: "node"`.
 */

import type { TextElementType, TextRunStyle } from "../../@types/timeline";
import {
  rangeStyleSummary,
  runsOf,
  type RangeValue,
  type RunStyleValues,
} from "../text/runs";

/** The part of the `<textarea>` this module reads. */
export type TextRangeField = {
  selectionStart: number | null;
  selectionEnd: number | null;
  valueLength: number;
  /**
   * Whether the field holds focus.
   *
   * Load-bearing, not informational. A blurred `<textarea>` paints no
   * selection, so a range read off one is a highlight on the preview with
   * nothing on screen to explain it.
   */
  hasFocus: boolean;
};

/** A selected stretch, or null for a collapsed caret. */
export type TextRange = { from: number; to: number };

/**
 * The range a field is reporting, or null.
 *
 * `selectionStart` is null on a field that has never been focused, and the DOM
 * orders the pair itself, but both are normalized here anyway: this is also
 * reached from a stored value and from the agent, and one ordering function is
 * cheaper than one bug.
 *
 * **A blurred field has no range**, whatever its offsets still say. The
 * offsets outlive the focus, the painted selection does not, and the preview's
 * highlight has to follow what the user can see rather than what the DOM
 * remembers. This is the whole of "the two are never out of step", and it is
 * here rather than in the panel so that it is a rule a test can hold.
 */
export function rangeOfField(field: TextRangeField): TextRange | null {
  if (!field.hasFocus) {
    return null;
  }

  const start = field.selectionStart;
  const end = field.selectionEnd;
  if (start == null || end == null) {
    return null;
  }

  const lo = Math.max(0, Math.min(start, end));
  const hi = Math.min(field.valueLength, Math.max(start, end));
  return lo < hi ? { from: lo, to: hi } : null;
}

/**
 * One control's intent, said once, independently of which widget produced it.
 *
 * `face` is one intent rather than four because the font's path, name, type and
 * weight have to move together or the clip draws in the fallback -
 * `elementControl#changeTextFont` and the agent's `set_text_font` both say so.
 */
export type TextStyleControl =
  | { kind: "color"; value: string }
  | { kind: "fontsize"; value: number }
  | {
      kind: "face";
      fontname: string;
      fontpath: string;
      fonttype: string;
      fontweight: number;
    }
  | { kind: "bold"; value: boolean }
  | { kind: "italic"; value: boolean }
  | { kind: "outlineEnable"; value: boolean }
  | { kind: "outlineSize"; value: number }
  | { kind: "outlineColor"; value: string };

/** Where a control's value goes: onto the clip, or onto a range of it. */
export type TextStyleWrite =
  | { kind: "element"; writes: { path: string[]; value: unknown }[] }
  | { kind: "range"; from: number; to: number; patch: TextRunStyle };

/**
 * Given the live range and a control, what gets written.
 *
 * With `range == null` the answer is the element paths the panel has always
 * written. With a range it is a sparse patch for `setTextRangeStyle`, which
 * drops anything the clip already says and so can still decide the write is a
 * no-op.
 */
export function planTextStyleWrite(
  range: TextRange | null,
  control: TextStyleControl,
): TextStyleWrite {
  if (range == null) {
    return { kind: "element", writes: elementWritesFor(control) };
  }
  return { kind: "range", from: range.from, to: range.to, patch: patchFor(control) };
}

function elementWritesFor(
  control: TextStyleControl,
): { path: string[]; value: unknown }[] {
  switch (control.kind) {
    case "color":
      return [{ path: ["textcolor"], value: control.value }];
    case "fontsize":
      return [{ path: ["fontsize"], value: control.value }];
    case "face":
      return [
        { path: ["fontpath"], value: control.fontpath },
        { path: ["fontname"], value: control.fontname },
        { path: ["fonttype"], value: control.fonttype },
        { path: ["fontweight"], value: control.fontweight },
      ];
    case "bold":
      return [{ path: ["options", "isBold"], value: control.value }];
    case "italic":
      return [{ path: ["options", "isItalic"], value: control.value }];
    case "outlineEnable":
      return [{ path: ["options", "outline", "enable"], value: control.value }];
    case "outlineSize":
      return [{ path: ["options", "outline", "size"], value: control.value }];
    case "outlineColor":
      return [{ path: ["options", "outline", "color"], value: control.value }];
  }
}

function patchFor(control: TextStyleControl): TextRunStyle {
  switch (control.kind) {
    case "color":
      return { color: control.value };
    case "fontsize":
      return { fontsize: control.value };
    case "face":
      return {
        fontname: control.fontname,
        fontpath: control.fontpath,
        fonttype: control.fonttype,
        fontweight: control.fontweight,
      };
    case "bold":
      return { bold: control.value };
    case "italic":
      return { italic: control.value };
    case "outlineEnable":
      return { outlineEnable: control.value };
    case "outlineSize":
      return { outlineSize: control.value };
    case "outlineColor":
      return { outlineColor: control.value };
  }
}

/**
 * The part of a mousedown's target this module reads.
 *
 * A plain record rather than an `HTMLElement`, so the rule below is checkable
 * in the node environment. `type` is the `<input>` type lowercased, or null for
 * anything that is not an input.
 */
export type FocusTarget = {
  tagName: string;
  type: string | null;
  isContentEditable: boolean;
  /**
   * Whether the control is one of the panel's drag-to-scrub number fields
   * (`input/inputScrub.ts`, the `scrub-number` class).
   *
   * They are the one input that does not need the caret to be *used*: the
   * value is dragged, and `beginInputScrub` focuses the field itself when the
   * press turns out to be a plain click rather than a drag. So they can be
   * left unfocused on the mousedown and still work both ways.
   */
  isScrubbable: boolean;
};

/**
 * Inputs that are useless without the caret. Every other kind is operated
 * entirely by the pointer.
 *
 * `range` is here because a slider's thumb is dragged from its mousedown, and
 * `color` is not because its picker opens from the click that follows one.
 */
const NEEDS_CARET = new Set([
  "text",
  "number",
  "range",
  "search",
  "email",
  "password",
  "url",
  "tel",
  "date",
  "time",
  "datetime-local",
  "month",
  "week",
  "file",
]);

/**
 * Whether a mousedown on this control should be stopped from moving focus.
 *
 * A `<textarea>` paints its selection only while it has focus, so the moment a
 * colour swatch or a bold button takes it the range the user dragged out simply
 * vanishes from the field while the preview goes on highlighting it. The two
 * are then telling the user different things about the same state.
 *
 * Cancelling the mousedown is the fix every rich-text toolbar uses: focus never
 * moves, the selection stays painted, and the click still reaches the control,
 * because `preventDefault` on a mousedown cancels focus and the drag that would
 * start a selection, and nothing else.
 *
 * It cannot be done to a control that needs the caret. A `<select>` opens its
 * popup from the mousedown, a slider drags from it, and a number field has to
 * be typed into. Those take focus, and `optionText` hands it back when they are
 * finished.
 */
export function keepsFieldFocus(target: FocusTarget): boolean {
  if (target.isContentEditable) {
    return false;
  }
  switch (target.tagName.toUpperCase()) {
    case "TEXTAREA":
    case "SELECT":
    case "OPTION":
      return false;
    case "INPUT": {
      const type = (target.type ?? "text").toLowerCase();
      // A scrubbable number field is dragged, not typed into, and it takes
      // focus for itself on a click. Cancelling its mousedown is what stops
      // "make this bigger" from emptying the field of the selection it is
      // about to be applied to: the press moves focus, the scrub then blurs
      // that, and focus lands on the body - outside the panel, which reads as
      // the user having left it.
      if (type === "number" && target.isScrubbable) {
        return true;
      }
      return !NEEDS_CARET.has(type);
    }
    default:
      return true;
  }
}

/**
 * The control a style path stands for, or null when the path is not one.
 *
 * The panel's generic row builders write `{ path, value }` and know nothing
 * about runs, so this is where a write turns back into an intent. Only the
 * core set maps: a path that is not here falls through to the whole clip,
 * which is the behaviour for `options.align`, `options.lineHeight`,
 * `letterSpacing`, `textOpacity`, `options.textTransform`, the background,
 * the shadow, the glow, the fill and the outline's opacity. Those are
 * properties of a text block rather than of a stretch of characters, and
 * CapCut keeps them whole-clip for the same reason.
 */
export function controlForPath(
  path: readonly string[],
  value: unknown,
): TextStyleControl | null {
  const key = path.join(".");
  switch (key) {
    case "textcolor":
      return typeof value === "string" ? { kind: "color", value } : null;
    case "fontsize":
      return typeof value === "number" ? { kind: "fontsize", value } : null;
    case "options.isBold":
      return typeof value === "boolean" ? { kind: "bold", value } : null;
    case "options.isItalic":
      return typeof value === "boolean" ? { kind: "italic", value } : null;
    case "options.outline.enable":
      return typeof value === "boolean" ? { kind: "outlineEnable", value } : null;
    case "options.outline.size":
      return typeof value === "number" ? { kind: "outlineSize", value } : null;
    case "options.outline.color":
      return typeof value === "string" ? { kind: "outlineColor", value } : null;
    default:
      return null;
  }
}

/**
 * What the panel's controls should display.
 *
 * With no range that is the clip's own values, which is what the panel showed
 * before this feature. With one it is the range's, or "mixed" where the range
 * spans two different answers - a control showing one of two values would send
 * the other one back the moment anybody touched anything else on the panel.
 */
export function textControlsDisplay(
  element: TextElementType,
  range: TextRange | null,
): { [K in keyof RunStyleValues]: RangeValue<RunStyleValues[K]> } {
  const runs = runsOf(element);
  const span = range ?? { from: 0, to: 0 };
  return rangeStyleSummary(element, runs, span.from, span.to);
}

/** The value where a control has one, or `fallback` where the range is mixed. */
export function valueOr<T>(shown: RangeValue<T>, fallback: T): T {
  return shown.kind === "one" ? shown.value : fallback;
}

/** Whether a control should show itself as reporting more than one answer. */
export function isMixed(shown: RangeValue<unknown>): boolean {
  return shown.kind === "mixed";
}
