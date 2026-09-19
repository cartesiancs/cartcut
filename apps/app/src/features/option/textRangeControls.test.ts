/**
 * What the text panel's style controls write and show.
 *
 * The suite's centre of gravity is the no-range case. Every one of those
 * assertions names the exact `{ path, value }` list the panel wrote before runs
 * existed, because "with nothing selected the panel behaves as it always did"
 * is the promise this feature makes to everybody who is not using it, and the
 * only way to keep a promise like that is to write it down.
 */

import { describe, expect, it } from "vitest";

import type { TextElementType } from "../../@types/timeline";
import {
  controlForPath,
  isMixed,
  keepsFieldFocus,
  planTextStyleWrite,
  rangeOfField,
  textControlsDisplay,
  valueOr,
  type TextRangeField,
  type TextStyleControl,
} from "./textRangeControls";

const text = (over: Partial<TextElementType> = {}): TextElementType =>
  ({
    filetype: "text",
    text: "Hello world",
    textcolor: "#ffffff",
    fontsize: 52,
    fontpath: "/fonts/Inter-Regular.ttf",
    fontname: "Inter-Regular",
    fontweight: "400",
    fonttype: "ttf",
    letterSpacing: 0,
    options: {
      isBold: false,
      isItalic: false,
      align: "left",
      outline: { enable: false, size: 1, color: "#000000" },
    },
    background: { enable: false, color: "#000000" },
    widthInner: 200,
    ...over,
  }) as TextElementType;

describe("rangeOfField", () => {
  const focused = (over: Partial<TextRangeField> = {}): TextRangeField => ({
    selectionStart: 2,
    selectionEnd: 7,
    valueLength: 11,
    hasFocus: true,
    ...over,
  });

  it.each([
    ["a collapsed caret", focused({ selectionStart: 4, selectionEnd: 4 })],
    ["a field never focused", focused({ selectionStart: null, selectionEnd: null })],
    ["only one end", focused({ selectionEnd: null })],
    ["a caret at the end", focused({ selectionStart: 11, selectionEnd: 11 })],
  ])("answers nothing for %s", (_label, field) => {
    expect(rangeOfField(field)).toBeNull();
  });

  it("answers the selected stretch", () => {
    expect(rangeOfField(focused())).toEqual({ from: 2, to: 7 });
  });

  it("orders its ends", () => {
    expect(
      rangeOfField(focused({ selectionStart: 7, selectionEnd: 2 })),
    ).toEqual({ from: 2, to: 7 });
  });

  it("clamps to the value it was measured against", () => {
    expect(
      rangeOfField(focused({ selectionStart: -3, selectionEnd: 99 })),
    ).toEqual({ from: 0, to: 11 });
  });

  // The rule the user asked for, stated as the only one that can keep it: the
  // preview highlights exactly what the field is painting, and a blurred field
  // paints nothing however much its offsets still remember.
  it("answers nothing for a blurred field, whatever its offsets say", () => {
    expect(rangeOfField(focused({ hasFocus: false }))).toBeNull();
  });

  it("answers again the moment focus comes back", () => {
    const offsets = { selectionStart: 2, selectionEnd: 7, valueLength: 11 };
    expect(rangeOfField({ ...offsets, hasFocus: false })).toBeNull();
    expect(rangeOfField({ ...offsets, hasFocus: true })).toEqual({
      from: 2,
      to: 7,
    });
  });

  it("is the same answer the highlight is drawn from", () => {
    // `optionText` publishes this and nothing else, and `previewCanvas` draws
    // from what was published, so "in sync" is this function being the single
    // source of both.
    const blurred = rangeOfField(focused({ hasFocus: false }));
    const live = rangeOfField(focused());
    expect(blurred).toBeNull();
    expect(live).not.toBeNull();
  });
});

/**
 * Control, and the element writes the panel made for it before this feature.
 *
 * Copied from the handlers themselves: `changeTextColor`, `changeTextSize`,
 * `changeTextFont` and the three `renderEffects` rows in `optionText.ts`.
 */
const LEGACY: [string, TextStyleControl, { path: string[]; value: unknown }[]][] = [
  [
    "colour",
    { kind: "color", value: "#ff0000" },
    [{ path: ["textcolor"], value: "#ff0000" }],
  ],
  [
    "size",
    { kind: "fontsize", value: 72 },
    [{ path: ["fontsize"], value: 72 }],
  ],
  [
    "face",
    {
      kind: "face",
      fontname: "Inter-Bold",
      fontpath: "/fonts/Inter-Bold.ttf",
      fonttype: "ttf",
      fontweight: 700,
    },
    [
      { path: ["fontpath"], value: "/fonts/Inter-Bold.ttf" },
      { path: ["fontname"], value: "Inter-Bold" },
      { path: ["fonttype"], value: "ttf" },
      { path: ["fontweight"], value: 700 },
    ],
  ],
  [
    "bold",
    { kind: "bold", value: true },
    [{ path: ["options", "isBold"], value: true }],
  ],
  [
    "italic",
    { kind: "italic", value: true },
    [{ path: ["options", "isItalic"], value: true }],
  ],
  [
    "the outline toggle",
    { kind: "outlineEnable", value: true },
    [{ path: ["options", "outline", "enable"], value: true }],
  ],
  [
    "the outline width",
    { kind: "outlineSize", value: 6 },
    [{ path: ["options", "outline", "size"], value: 6 }],
  ],
  [
    "the outline colour",
    { kind: "outlineColor", value: "#00e5ff" },
    [{ path: ["options", "outline", "color"], value: "#00e5ff" }],
  ],
];

describe("with no range selected", () => {
  it.each(LEGACY)("writes %s exactly where it always did", (_label, control, writes) => {
    expect(planTextStyleWrite(null, control)).toEqual({
      kind: "element",
      writes,
    });
  });

  it("never reaches for a range", () => {
    for (const [, control] of LEGACY) {
      expect(planTextStyleWrite(null, control).kind).toBe("element");
    }
  });
});

describe("with a range selected", () => {
  const range = { from: 2, to: 7 };

  it.each([
    ["colour", { kind: "color", value: "#ff0000" }, { color: "#ff0000" }],
    ["size", { kind: "fontsize", value: 72 }, { fontsize: 72 }],
    ["bold", { kind: "bold", value: true }, { bold: true }],
    ["italic", { kind: "italic", value: false }, { italic: false }],
    [
      "the outline toggle",
      { kind: "outlineEnable", value: true },
      { outlineEnable: true },
    ],
    ["the outline width", { kind: "outlineSize", value: 6 }, { outlineSize: 6 }],
    [
      "the outline colour",
      { kind: "outlineColor", value: "#00e5ff" },
      { outlineColor: "#00e5ff" },
    ],
  ] as [string, TextStyleControl, Record<string, unknown>][])(
    "patches %s onto the range",
    (_label, control, patch) => {
      expect(planTextStyleWrite(range, control)).toEqual({
        kind: "range",
        from: 2,
        to: 7,
        patch,
      });
    },
  );

  it("moves all four font fields together", () => {
    // Splitting them would leave the run naming a family nothing registered an
    // `@font-face` for, and the stretch would draw in the fallback.
    const plan = planTextStyleWrite(range, {
      kind: "face",
      fontname: "Inter-Bold",
      fontpath: "/fonts/Inter-Bold.ttf",
      fonttype: "ttf",
      fontweight: 700,
    });
    expect(plan).toEqual({
      kind: "range",
      from: 2,
      to: 7,
      patch: {
        fontname: "Inter-Bold",
        fontpath: "/fonts/Inter-Bold.ttf",
        fonttype: "ttf",
        fontweight: 700,
      },
    });
  });

  it("carries the range's own ends", () => {
    const plan = planTextStyleWrite(
      { from: 0, to: 11 },
      { kind: "bold", value: true },
    );
    expect(plan).toMatchObject({ from: 0, to: 11 });
  });
});

describe("textControlsDisplay", () => {
  it("shows the clip's own values with no range", () => {
    const shown = textControlsDisplay(text(), null);
    expect(shown.color).toEqual({ kind: "one", value: "#ffffff" });
    expect(shown.fontsize).toEqual({ kind: "one", value: 52 });
    expect(shown.fontname).toEqual({ kind: "one", value: "Inter-Regular" });
    expect(shown.bold).toEqual({ kind: "one", value: false });
    expect(shown.outlineSize).toEqual({ kind: "one", value: 1 });
  });

  it("shows the clip's own values for a range nothing has styled", () => {
    expect(textControlsDisplay(text(), { from: 0, to: 5 }).color).toEqual({
      kind: "one",
      value: "#ffffff",
    });
  });

  it("shows the run's value for a range inside one run", () => {
    const element = text({
      runs: [{ from: 0, to: 5, style: { color: "#ff0000", fontsize: 90 } }],
    } as Partial<TextElementType>);
    const shown = textControlsDisplay(element, { from: 1, to: 4 });
    expect(shown.color).toEqual({ kind: "one", value: "#ff0000" });
    expect(shown.fontsize).toEqual({ kind: "one", value: 90 });
    // A field the run does not override still reports the clip's.
    expect(shown.bold).toEqual({ kind: "one", value: false });
  });

  it("reports mixed where the range leaves the run", () => {
    const element = text({
      runs: [{ from: 0, to: 5, style: { color: "#ff0000" } }],
    } as Partial<TextElementType>);
    const shown = textControlsDisplay(element, { from: 0, to: 9 });
    expect(isMixed(shown.color)).toBe(true);
    // Only the field that actually differs is mixed.
    expect(isMixed(shown.fontsize)).toBe(false);
  });

  it("reports mixed where two runs disagree", () => {
    const element = text({
      runs: [
        { from: 0, to: 5, style: { color: "#ff0000" } },
        { from: 5, to: 9, style: { color: "#0000ff" } },
      ],
    } as Partial<TextElementType>);
    expect(isMixed(textControlsDisplay(element, { from: 0, to: 9 }).color)).toBe(
      true,
    );
  });

  it("ignores a run the range does not touch", () => {
    const element = text({
      runs: [{ from: 6, to: 11, style: { color: "#ff0000" } }],
    } as Partial<TextElementType>);
    expect(textControlsDisplay(element, { from: 0, to: 5 }).color).toEqual({
      kind: "one",
      value: "#ffffff",
    });
  });

  it("is unbothered by a hand-edited runs field", () => {
    const element = text({ runs: "nonsense" } as unknown as Partial<TextElementType>);
    expect(() => textControlsDisplay(element, { from: 0, to: 5 })).not.toThrow();
    expect(textControlsDisplay(element, null).color).toEqual({
      kind: "one",
      value: "#ffffff",
    });
  });
});

describe("valueOr", () => {
  it("hands back the value where there is one", () => {
    expect(valueOr({ kind: "one", value: 7 }, 0)).toBe(7);
  });

  it("falls back where the range is mixed", () => {
    expect(valueOr({ kind: "mixed" }, 0)).toBe(0);
  });
});

describe("controlForPath", () => {
  it.each([
    ["textcolor", ["textcolor"], "#ff0000", "color"],
    ["the font size", ["fontsize"], 72, "fontsize"],
    ["bold", ["options", "isBold"], true, "bold"],
    ["italic", ["options", "isItalic"], false, "italic"],
    ["the outline toggle", ["options", "outline", "enable"], true, "outlineEnable"],
    ["the outline width", ["options", "outline", "size"], 6, "outlineSize"],
    ["the outline colour", ["options", "outline", "color"], "#00e5ff", "outlineColor"],
  ])("maps %s", (_label, path, value, kind) => {
    expect(controlForPath(path, value)?.kind).toBe(kind);
  });

  it.each([
    ["alignment", ["options", "align"], "center"],
    ["line spacing", ["options", "lineHeight"], 1.6],
    ["letter spacing", ["letterSpacing"], 4],
    ["text opacity", ["textOpacity"], 50],
    ["letter case", ["options", "textTransform"], "uppercase"],
    ["the outline's opacity", ["options", "outline", "opacity"], 60],
    ["the background", ["background", "enable"], true],
    ["the shadow", ["options", "shadow", "blur"], 12],
    ["the glow", ["options", "glow", "size"], 20],
    ["the fill", ["fill", "angle"], 45],
  ])("leaves %s to the whole clip", (_label, path, value) => {
    // Not an oversight. These are properties of a text block rather than of a
    // stretch of characters, and a range write for them would have nowhere
    // sensible to land.
    expect(controlForPath(path, value)).toBeNull();
  });

  it("refuses a value of the wrong type", () => {
    expect(controlForPath(["fontsize"], "72")).toBeNull();
    expect(controlForPath(["textcolor"], 16711680)).toBeNull();
    expect(controlForPath(["options", "isBold"], 1)).toBeNull();
  });

  it("round-trips back to the same element write", () => {
    // The interception in `optionText#set` is only safe because a control that
    // came from a path writes that path back when no range is selected.
    for (const [path, value] of [
      [["textcolor"], "#ff0000"],
      [["fontsize"], 72],
      [["options", "isBold"], true],
      [["options", "outline", "size"], 6],
    ] as [string[], unknown][]) {
      const control = controlForPath(path, value)!;
      expect(planTextStyleWrite(null, control)).toEqual({
        kind: "element",
        writes: [{ path, value }],
      });
    }
  });
});

describe("keepsFieldFocus", () => {
  const target = (
    tagName: string,
    type: string | null = null,
    isContentEditable = false,
    isScrubbable = false,
  ) => ({ tagName, type, isContentEditable, isScrubbable });

  it.each([
    ["a button", target("BUTTON")],
    ["a colour swatch", target("INPUT", "color")],
    ["a checkbox", target("INPUT", "checkbox")],
    ["a label", target("LABEL")],
    ["a div", target("DIV")],
    ["a list row", target("LI")],
    ["an icon span", target("SPAN")],
    ["a lower-cased tag name", target("button")],
  ])("cancels the mousedown on %s", (_label, t) => {
    expect(keepsFieldFocus(t)).toBe(true);
  });

  it.each([
    ["the text field itself", target("TEXTAREA")],
    ["a select", target("SELECT")],
    ["an option", target("OPTION")],
    ["a number field", target("INPUT", "number")],
    ["a slider", target("INPUT", "range")],
    ["a search box", target("INPUT", "text")],
    ["an input with no type", target("INPUT")],
    ["a contenteditable", target("DIV", null, true)],
  ])("lets %s take focus", (_label, t) => {
    expect(keepsFieldFocus(t)).toBe(false);
  });

  it("keeps the colour picker usable", () => {
    // The picker opens from the click that follows the mousedown, so cancelling
    // the mousedown costs it nothing and saves the field's selection.
    expect(keepsFieldFocus(target("INPUT", "color"))).toBe(true);
  });

  it("never cancels on a slider, whose thumb drags from the mousedown", () => {
    expect(keepsFieldFocus(target("INPUT", "range"))).toBe(false);
  });

  it("cancels on a scrubbable number field", () => {
    // The panel's size, spacing and effect numbers are dragged rather than
    // typed into, and `beginInputScrub` focuses them itself for a plain click.
    // Letting the press move focus is what used to empty the field of the very
    // selection the new size was about to be applied to.
    expect(keepsFieldFocus(target("INPUT", "number", false, true))).toBe(true);
  });

  it("still lets a plain number field take the caret", () => {
    expect(keepsFieldFocus(target("INPUT", "number", false, false))).toBe(false);
  });

  it("does not extend that to other scrubbable-looking inputs", () => {
    // Only a number field carries the scrub adapter. A slider marked the same
    // way still drags its thumb from the default mousedown.
    expect(keepsFieldFocus(target("INPUT", "range", false, true))).toBe(false);
    expect(keepsFieldFocus(target("INPUT", "text", false, true))).toBe(false);
  });
});
