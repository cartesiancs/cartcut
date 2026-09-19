/**
 * Per-range text style, as data.
 *
 * Every claim here is about the shape of the list rather than about pixels, so
 * none of it needs a canvas or a font. The three that carry the most weight
 * elsewhere in the codebase:
 *
 * - **`runsOf` never throws.** It runs inside the layout and its input can be a
 *   hand-edited file, so the junk table below is the contract and not a
 *   courtesy.
 * - **The writers decline by identity.** `timeline/textRunOps.ts` turns that
 *   into "no undo step", so `toBe` is deliberate everywhere it appears and
 *   `toEqual` would pass while the feature was broken.
 * - **An empty style is not a style.** That is what lets a range styled back to
 *   the clip's own values delete the field entirely.
 */

import { describe, expect, it } from "vitest";

import type { TextElementType, TextRun } from "../../@types/timeline";
import {
  applyRunStyle,
  clearRunStyle,
  coerceRunStyle,
  diffEdit,
  elementRunStyle,
  hasRuns,
  rangeStyleSummary,
  resolvedStyleAt,
  runStyleAt,
  runsOf,
  runsOutlineBleed,
  sameRunStyle,
  sameRuns,
  shiftRuns,
  snapRange,
} from "./runs";

function text(over: Partial<TextElementType> = {}): TextElementType {
  return {
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
  } as TextElementType;
}

const RED = { color: "#ff0000" };
const BLUE = { color: "#0000ff" };

describe("runsOf", () => {
  it.each([
    ["absent", undefined],
    ["empty", []],
    ["a string", "nonsense"],
    ["a number", 42],
    ["null", null],
    ["an array of nothing", [null, 7, "x"]],
    ["a run with no style", [{ from: 0, to: 3 }]],
    ["a run with an empty style", [{ from: 0, to: 3, style: {} }]],
    ["a run with an unreadable style", [{ from: 0, to: 3, style: { color: "red" } }]],
    ["a collapsed run", [{ from: 2, to: 2, style: RED }]],
    ["a run past the end", [{ from: 40, to: 50, style: RED }]],
    ["non-numeric offsets", [{ from: "a", to: "b", style: RED }]],
  ])("answers nothing for %s", (_label, runs) => {
    expect(runsOf(text({ runs } as Partial<TextElementType>))).toEqual([]);
  });

  it("orders the ends of an inverted run rather than dropping it", () => {
    // `snapRange` is the one place a pair of offsets becomes a span, and it
    // orders them. Dropping here instead would make a hand-edited file behave
    // differently from a right-to-left drag, which reaches the same function.
    expect(runsOf(text({ runs: [{ from: 5, to: 1, style: RED }] } as any))).toEqual([
      { from: 1, to: 5, style: RED },
    ]);
  });

  it("never throws on anything at all", () => {
    for (const runs of [undefined, null, 0, "x", [{}], [[]], { from: 1 }]) {
      expect(() =>
        runsOf(text({ runs } as unknown as Partial<TextElementType>)),
      ).not.toThrow();
    }
  });

  it("answers nothing for a clip with no text, whatever it stores", () => {
    expect(runsOf(text({ text: "", runs: [{ from: 0, to: 3, style: RED }] } as any))).toEqual([]);
  });

  it("clamps a run that reaches past the end of the string", () => {
    const runs = runsOf(text({ text: "abc", runs: [{ from: 1, to: 99, style: RED }] } as any));
    expect(runs).toEqual([{ from: 1, to: 3, style: RED }]);
  });

  it("sorts an out-of-order list", () => {
    const runs = runsOf(
      text({
        runs: [
          { from: 6, to: 9, style: BLUE },
          { from: 0, to: 3, style: RED },
        ],
      } as any),
    );
    expect(runs.map((run) => run.from)).toEqual([0, 6]);
  });

  it("merges adjacent runs that say the same thing", () => {
    const runs = runsOf(
      text({
        runs: [
          { from: 0, to: 3, style: RED },
          { from: 3, to: 6, style: { color: "#ff0000" } },
        ],
      } as any),
    );
    expect(runs).toEqual([{ from: 0, to: 6, style: RED }]);
  });

  it("does not merge adjacent runs that disagree", () => {
    const runs = runsOf(
      text({
        runs: [
          { from: 0, to: 3, style: RED },
          { from: 3, to: 6, style: BLUE },
        ],
      } as any),
    );
    expect(runs).toHaveLength(2);
  });

  it("resolves an overlap with the later run", () => {
    const runs = runsOf(
      text({
        runs: [
          { from: 0, to: 6, style: RED },
          { from: 3, to: 9, style: BLUE },
        ],
      } as any),
    );
    expect(runs).toEqual([
      { from: 0, to: 3, style: RED },
      { from: 3, to: 9, style: BLUE },
    ]);
  });

  it("leaves no run overlapping another", () => {
    const runs = runsOf(
      text({
        runs: [
          { from: 0, to: 9, style: RED },
          { from: 2, to: 4, style: BLUE },
          { from: 3, to: 7, style: { bold: true } },
        ],
      } as any),
    );
    for (let i = 1; i < runs.length; i += 1) {
      expect(runs[i].from).toBeGreaterThanOrEqual(runs[i - 1].to);
    }
  });

  it("snaps a boundary off the inside of a surrogate pair", () => {
    // "a" + a musical symbol (two code units) + "b".
    const body = `a\u{1D11E}b`;
    const runs = runsOf(text({ text: body, runs: [{ from: 2, to: 3, style: RED }] } as any));
    // The selection landed inside the pair; the run covers the whole glyph.
    expect(runs).toEqual([{ from: 1, to: 3, style: RED }]);
    expect(body.slice(runs[0].from, runs[0].to)).toBe("\u{1D11E}");
  });

  it("does not allocate for the common case", () => {
    expect(runsOf(text())).toBe(runsOf(text({ runs: [] } as any)));
  });
});

describe("hasRuns", () => {
  it("is the branch the renderer takes", () => {
    expect(hasRuns(text())).toBe(false);
    expect(hasRuns(text({ runs: [] } as any))).toBe(false);
    expect(hasRuns(text({ runs: [{ from: 2, to: 2, style: RED }] } as any))).toBe(false);
    expect(hasRuns(text({ runs: [{ from: 0, to: 3, style: RED }] } as any))).toBe(true);
  });
});

describe("coerceRunStyle", () => {
  it.each([
    ["not an object", 7],
    ["null", null],
    ["empty", {}],
    ["only unknown keys", { nope: 1, letterSpacing: 4 }],
    ["a named colour", { color: "red" }],
    ["an empty colour", { color: "" }],
    ["a four-digit colour", { color: "#fffa" }],
    ["a zero size", { fontsize: 0 }],
    ["a negative size", { fontsize: -12 }],
    ["an unreadable size", { fontsize: "big" }],
    ["an empty font name", { fontname: "" }],
    ["a non-boolean bold", { bold: "yes" }],
    ["a negative outline", { outlineSize: -1 }],
  ])("refuses %s", (_label, value) => {
    expect(coerceRunStyle(value)).toBeNull();
  });

  it.each([
    ["#fff", { color: "#fff" }],
    ["#ffffff", { color: "#ffffff" }],
    ["upper case", { color: "#FFAA00" }],
  ])("accepts %s", (_label, value) => {
    expect(coerceRunStyle(value)).toEqual(value);
  });

  it("keeps only the fields it could read", () => {
    expect(
      coerceRunStyle({ color: "#ff0000", fontsize: "big", bold: true, nope: 1 }),
    ).toEqual({ color: "#ff0000", bold: true });
  });

  it("keeps a false as readily as a true", () => {
    expect(coerceRunStyle({ bold: false })).toEqual({ bold: false });
    expect(coerceRunStyle({ outlineEnable: false })).toEqual({ outlineEnable: false });
  });

  it("snaps a weight to the ladder", () => {
    expect(coerceRunStyle({ fontweight: 437 })?.fontweight).toBe(400);
  });

  it("clamps rather than refuses a size past the ceiling", () => {
    expect(coerceRunStyle({ fontsize: 99999 })?.fontsize).toBe(2000);
    expect(coerceRunStyle({ outlineSize: 5000 })?.outlineSize).toBe(200);
  });
});

describe("sameRunStyle and sameRuns", () => {
  it("compares content, not identity", () => {
    expect(sameRunStyle({ color: "#fff", bold: true }, { bold: true, color: "#fff" })).toBe(true);
  });

  it("sees one differing field", () => {
    expect(sameRunStyle({ color: "#fff" }, { color: "#000" })).toBe(false);
    expect(sameRunStyle({ color: "#fff" }, { color: "#fff", bold: true })).toBe(false);
  });

  it("treats an absent list as an empty one", () => {
    expect(sameRuns(undefined, [])).toBe(true);
    expect(sameRuns([], undefined)).toBe(true);
    expect(sameRuns(undefined, [{ from: 0, to: 1, style: RED }])).toBe(false);
  });

  it("compares offsets too", () => {
    expect(
      sameRuns([{ from: 0, to: 3, style: RED }], [{ from: 0, to: 4, style: RED }]),
    ).toBe(false);
  });
});

describe("applyRunStyle", () => {
  const body = "Hello world";
  const none: readonly TextRun[] = [];

  it("creates a run where there was none", () => {
    expect(applyRunStyle(none, 0, 5, RED, body)).toEqual([
      { from: 0, to: 5, style: RED },
    ]);
  });

  it.each([
    ["a collapsed range", 3, 3],
    ["an inverted range that collapses", 3, 3],
    ["a range past the end", 40, 50],
  ])("declines by identity for %s", (_label, from, to) => {
    expect(applyRunStyle(none, from, to, RED, body)).toBe(none);
  });

  it("declines by identity for an unreadable patch", () => {
    expect(applyRunStyle(none, 0, 5, { color: "red" }, body)).toBe(none);
    expect(applyRunStyle(none, 0, 5, {}, body)).toBe(none);
  });

  it("declines by identity when the patch is already in force", () => {
    const runs = applyRunStyle(none, 0, 5, RED, body);
    expect(applyRunStyle(runs, 0, 5, RED, body)).toBe(runs);
    expect(applyRunStyle(runs, 1, 4, RED, body)).toBe(runs);
  });

  it("normalizes an inverted range rather than refusing it", () => {
    expect(applyRunStyle(none, 5, 0, RED, body)).toEqual([
      { from: 0, to: 5, style: RED },
    ]);
  });

  it("splits a run when a patch lands inside it", () => {
    const runs = applyRunStyle(none, 0, 9, RED, body);
    expect(applyRunStyle(runs, 3, 6, BLUE, body)).toEqual([
      { from: 0, to: 3, style: RED },
      { from: 3, to: 6, style: BLUE },
      { from: 6, to: 9, style: RED },
    ]);
  });

  it("merges a patch onto an existing run rather than replacing it", () => {
    const runs = applyRunStyle(none, 0, 5, RED, body);
    expect(applyRunStyle(runs, 0, 5, { bold: true }, body)).toEqual([
      { from: 0, to: 5, style: { color: "#ff0000", bold: true } },
    ]);
  });

  it("merges neighbours a patch has made equal", () => {
    let runs = applyRunStyle(none, 0, 3, RED, body);
    runs = applyRunStyle(runs, 6, 9, RED, body);
    expect(runs).toHaveLength(2);
    expect(applyRunStyle(runs, 3, 6, RED, body)).toEqual([
      { from: 0, to: 9, style: RED },
    ]);
  });

  it("covers a range wider than every run it crosses", () => {
    let runs = applyRunStyle(none, 0, 3, RED, body);
    runs = applyRunStyle(runs, 6, 9, BLUE, body);
    expect(applyRunStyle(runs, 0, 11, { bold: true }, body)).toEqual([
      { from: 0, to: 3, style: { color: "#ff0000", bold: true } },
      { from: 3, to: 6, style: { bold: true } },
      { from: 6, to: 9, style: { color: "#0000ff", bold: true } },
      { from: 9, to: 11, style: { bold: true } },
    ]);
  });

  it("never mutates the list it was given", () => {
    const runs = applyRunStyle(none, 0, 9, RED, body);
    const before = JSON.stringify(runs);
    applyRunStyle(runs, 3, 6, BLUE, body);
    expect(JSON.stringify(runs)).toBe(before);
  });
});

describe("clearRunStyle", () => {
  const body = "Hello world";

  it("removes an override and leaves nothing behind", () => {
    const runs = applyRunStyle([], 0, 5, RED, body);
    expect(clearRunStyle(runs, 0, 5, body)).toEqual([]);
  });

  it("clears only the part it covers", () => {
    const runs = applyRunStyle([], 0, 9, RED, body);
    expect(clearRunStyle(runs, 3, 6, body)).toEqual([
      { from: 0, to: 3, style: RED },
      { from: 6, to: 9, style: RED },
    ]);
  });

  it("declines by identity when there is nothing to clear", () => {
    const runs = applyRunStyle([], 0, 3, RED, body);
    expect(clearRunStyle(runs, 6, 9, body)).toBe(runs);
    expect(clearRunStyle(runs, 3, 3, body)).toBe(runs);
  });
});

describe("diffEdit", () => {
  it("reports nothing for an unchanged string", () => {
    expect(diffEdit("abc", "abc")).toBeNull();
  });

  it.each([
    ["an insert in the middle", "abc", "abXc", { at: 2, removed: 0, inserted: 1 }],
    ["an insert at the start", "abc", "Xabc", { at: 0, removed: 0, inserted: 1 }],
    ["an insert at the end", "abc", "abcX", { at: 3, removed: 0, inserted: 1 }],
    ["a delete in the middle", "abc", "ac", { at: 1, removed: 1, inserted: 0 }],
    ["a replacement", "abc", "aXc", { at: 1, removed: 1, inserted: 1 }],
    ["a paste over a selection", "abcdef", "aZZf", { at: 1, removed: 4, inserted: 2 }],
    ["everything", "abc", "", { at: 0, removed: 3, inserted: 0 }],
    ["from nothing", "", "abc", { at: 0, removed: 0, inserted: 3 }],
  ])("reports %s", (_label, before, after, edit) => {
    expect(diffEdit(before, after)).toEqual(edit);
  });

  it("resolves a repeated character at the prefix boundary", () => {
    expect(diffEdit("aa", "aaa")).toEqual({ at: 2, removed: 0, inserted: 1 });
  });

  it("round-trips: applying the splice rebuilds the new string", () => {
    for (const [before, after] of [
      ["Hello world", "Hello brave world"],
      ["Hello world", "Hell"],
      ["Hello world", "Goodbye world"],
      ["Hello world", ""],
    ] as const) {
      const edit = diffEdit(before, after)!;
      const rebuilt =
        before.slice(0, edit.at) +
        after.slice(edit.at, edit.at + edit.inserted) +
        before.slice(edit.at + edit.removed);
      expect(rebuilt).toBe(after);
    }
  });
});

describe("shiftRuns", () => {
  const run = (from: number, to: number): TextRun[] => [{ from, to, style: RED }];

  it("declines by identity when nothing moved", () => {
    const runs = run(4, 8);
    expect(shiftRuns(runs, { at: 0, removed: 0, inserted: 0 })).toBe(runs);
    expect(shiftRuns([], { at: 0, removed: 0, inserted: 3 })).toEqual([]);
  });

  it("declines by identity for an edit entirely after every run", () => {
    const runs = run(0, 4);
    expect(shiftRuns(runs, { at: 8, removed: 0, inserted: 3 })).toBe(runs);
  });

  it("moves a run when text is inserted before it", () => {
    expect(shiftRuns(run(4, 8), { at: 0, removed: 0, inserted: 2 })).toEqual(run(6, 10));
  });

  it("grows a run when text is inserted inside it", () => {
    expect(shiftRuns(run(4, 8), { at: 6, removed: 0, inserted: 2 })).toEqual(run(4, 10));
  });

  it("grows a run when text is typed at its end", () => {
    expect(shiftRuns(run(4, 8), { at: 8, removed: 0, inserted: 2 })).toEqual(run(4, 10));
  });

  it("moves a run when text is typed at its start", () => {
    expect(shiftRuns(run(4, 8), { at: 4, removed: 0, inserted: 2 })).toEqual(run(6, 10));
  });

  it("gives text typed between two runs to the one on the left", () => {
    const runs: TextRun[] = [
      { from: 0, to: 4, style: RED },
      { from: 4, to: 8, style: BLUE },
    ];
    expect(shiftRuns(runs, { at: 4, removed: 0, inserted: 2 })).toEqual([
      { from: 0, to: 6, style: RED },
      { from: 6, to: 10, style: BLUE },
    ]);
  });

  it("shrinks a run when part of it is deleted", () => {
    expect(shiftRuns(run(4, 8), { at: 5, removed: 2, inserted: 0 })).toEqual(run(4, 6));
  });

  it("drops a run whose every character is deleted", () => {
    expect(shiftRuns(run(4, 8), { at: 4, removed: 4, inserted: 0 })).toEqual([]);
    expect(shiftRuns(run(4, 8), { at: 0, removed: 20, inserted: 0 })).toEqual([]);
  });

  it("clamps a run the delete overlaps at the head", () => {
    expect(shiftRuns(run(4, 8), { at: 2, removed: 4, inserted: 0 })).toEqual(run(2, 4));
  });

  it("clamps a run the delete overlaps at the tail", () => {
    expect(shiftRuns(run(4, 8), { at: 6, removed: 4, inserted: 0 })).toEqual(run(4, 6));
  });

  it("merges two pieces of one run the delete brought together", () => {
    const runs: TextRun[] = [
      { from: 0, to: 4, style: RED },
      { from: 8, to: 12, style: RED },
    ];
    expect(shiftRuns(runs, { at: 4, removed: 4, inserted: 0 })).toEqual([
      { from: 0, to: 8, style: RED },
    ]);
  });

  it("handles a replacement as one splice", () => {
    expect(shiftRuns(run(4, 8), { at: 0, removed: 2, inserted: 5 })).toEqual(run(7, 11));
  });
});

describe("elementRunStyle and resolvedStyleAt", () => {
  it("says the clip's own values in the run vocabulary", () => {
    expect(elementRunStyle(text())).toEqual({
      fontname: "Inter-Regular",
      fontpath: "/fonts/Inter-Regular.ttf",
      fonttype: "ttf",
      fontweight: 400,
      fontsize: 52,
      color: "#ffffff",
      bold: false,
      italic: false,
      outlineEnable: false,
      outlineSize: 1,
      outlineColor: "#000000",
    });
  });

  it("overlays the run in force at an offset", () => {
    const element = text({ runs: [{ from: 0, to: 5, style: RED }] } as any);
    const runs = runsOf(element);
    expect(resolvedStyleAt(element, runs, 2).color).toBe("#ff0000");
    expect(resolvedStyleAt(element, runs, 7).color).toBe("#ffffff");
    // Half open: the offset at `to` belongs to what follows.
    expect(resolvedStyleAt(element, runs, 5).color).toBe("#ffffff");
  });

  it("answers an empty override where there is no run", () => {
    expect(runStyleAt([], 3)).toEqual({});
  });
});

describe("rangeStyleSummary", () => {
  it("reports the clip's own values for an unstyled range", () => {
    const element = text();
    expect(rangeStyleSummary(element, runsOf(element), 0, 5).color).toEqual({
      kind: "one",
      value: "#ffffff",
    });
  });

  it("reports the run's value where the range is uniform", () => {
    const element = text({ runs: [{ from: 0, to: 5, style: RED }] } as any);
    expect(rangeStyleSummary(element, runsOf(element), 1, 4).color).toEqual({
      kind: "one",
      value: "#ff0000",
    });
  });

  it("reports mixed where the range crosses a boundary", () => {
    const element = text({ runs: [{ from: 0, to: 5, style: RED }] } as any);
    expect(rangeStyleSummary(element, runsOf(element), 0, 9).color).toEqual({
      kind: "mixed",
    });
  });

  it("reports mixed where two runs disagree", () => {
    const element = text({
      runs: [
        { from: 0, to: 5, style: RED },
        { from: 5, to: 9, style: BLUE },
      ],
    } as any);
    expect(rangeStyleSummary(element, runsOf(element), 0, 9).color).toEqual({
      kind: "mixed",
    });
  });

  it("leaves the fields the range does not touch uniform", () => {
    const element = text({ runs: [{ from: 0, to: 5, style: RED }] } as any);
    const summary = rangeStyleSummary(element, runsOf(element), 0, 9);
    expect(summary.fontsize).toEqual({ kind: "one", value: 52 });
    expect(summary.bold).toEqual({ kind: "one", value: false });
  });
});

describe("runsOutlineBleed", () => {
  it("is nothing without runs", () => {
    expect(runsOutlineBleed(text())).toBe(0);
  });

  it("ignores a run whose outline is off", () => {
    expect(
      runsOutlineBleed(
        text({ runs: [{ from: 0, to: 5, style: { outlineSize: 40 } }] } as any),
      ),
    ).toBe(0);
  });

  it("reports the widest stroke any run asks for", () => {
    expect(
      runsOutlineBleed(
        text({
          runs: [
            { from: 0, to: 5, style: { outlineEnable: true, outlineSize: 12 } },
            { from: 6, to: 9, style: { outlineEnable: true, outlineSize: 40 } },
          ],
        } as any),
      ),
    ).toBe(40);
  });

  it("falls back to the clip's own width for a run that only turns it on", () => {
    expect(
      runsOutlineBleed(
        text({
          options: {
            isBold: false,
            isItalic: false,
            align: "left",
            outline: { enable: false, size: 9, color: "#000000" },
          },
          runs: [{ from: 0, to: 5, style: { outlineEnable: true } }],
        } as any),
      ),
    ).toBe(9);
  });
});

describe("snapRange", () => {
  it("answers null for a range that covers nothing", () => {
    expect(snapRange("abc", 1, 1)).toBeNull();
    expect(snapRange("abc", 9, 9)).toBeNull();
  });

  it("orders its ends", () => {
    expect(snapRange("abcdef", 4, 1)).toEqual({ from: 1, to: 4 });
  });
});
