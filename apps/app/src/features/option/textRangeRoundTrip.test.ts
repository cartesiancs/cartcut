/**
 * Every per-range control, applied and taken back again, in every combination.
 *
 * This suite exists because of one bug and the shape of it matters more than
 * the instance: pressing **B** on a stretch that was already yellow and larger,
 * and then pressing it again, threw the colour and the size away with the
 * weight. The cause was treating "this field now matches the clip" as "clear
 * this range" rather than as "stop overriding this one field", and every
 * control could hit it, not only the toggles.
 *
 * So the suite is combinatorial rather than illustrative. It drives the real
 * chain a click takes, short of the DOM:
 *
 *     control -> planTextStyleWrite -> setTextRangeStyle -> document
 *
 * and asserts the two properties that together rule the whole class out:
 *
 *  - **Taking one property back leaves every other one exactly as it was.**
 *  - **Taking them all back deletes the field**, so the document is byte
 *    identical to one nobody ever styled. That is what keeps the compatibility
 *    promise `SCHEMA_VERSION` rests on.
 */

import { describe, expect, it } from "vitest";

import type { TextElementType, TextRun } from "../../@types/timeline";
import { elementRunStyle, runsOf, type RunStyleKey } from "../text/runs";
import { imageElement, textElement } from "../renderer/testing";
import { setTextRangeStyle } from "../timeline/textRunOps";
import {
  SCHEMA_VERSION,
  createTrack,
  normalizeDocument,
  type TimelineDocument,
} from "../timeline/tracks";
import {
  planTextStyleWrite,
  textControlsDisplay,
  valueOr,
  type TextStyleControl,
} from "./textRangeControls";

const BODY = "Hello brave world";
/** "brave". The stretch every case is applied to unless it says otherwise. */
const RANGE = { from: 6, to: 11 };

function doc(): TimelineDocument {
  return normalizeDocument({
    schemaVersion: SCHEMA_VERSION,
    tracks: [createTrack("v0", "video", 0)],
    elements: {
      text: textElement({
        trackId: "v0",
        startTime: 0,
        duration: 4000,
        text: BODY,
        textcolor: "#ffffff",
        fontsize: 88,
        fontname: "Inter-Regular",
        fontpath: "/fonts/Inter-Regular.ttf",
        fonttype: "ttf",
        fontweight: "400",
        options: {
          isBold: false,
          isItalic: false,
          align: "left",
          outline: { enable: false, size: 2, color: "#000000" },
        },
      }),
      picture: imageElement({ trackId: "v0", startTime: 4000, duration: 1000 }),
    },
  });
}

const elementOf = (d: TimelineDocument) => d.elements.text as TextElementType;
const stored = (d: TimelineDocument) =>
  (elementOf(d) as TextElementType & { runs?: TextRun[] }).runs;

/** The one control the panel would send, through the one path it goes down. */
function apply(
  d: TimelineDocument,
  control: TextStyleControl,
  range = RANGE,
): TimelineDocument {
  const plan = planTextStyleWrite(range, control);
  if (plan.kind !== "range") {
    throw new Error("a live range must plan a range write");
  }
  return setTextRangeStyle(d, "text", plan.from, plan.to, plan.patch);
}

/**
 * One control, in both directions.
 *
 * `away` is a value the clip does not have; `back` is the clip's own, which is
 * what the widget shows once the user has undone their change by hand. `keys`
 * is what the run should be carrying in between.
 */
type Case = {
  name: string;
  keys: RunStyleKey[];
  away: TextStyleControl;
  back: (element: TextElementType) => TextStyleControl;
};

const CASES: Case[] = [
  {
    name: "colour",
    keys: ["color"],
    away: { kind: "color", value: "#ffd21e" },
    back: (el) => ({ kind: "color", value: el.textcolor }),
  },
  {
    name: "size",
    keys: ["fontsize"],
    away: { kind: "fontsize", value: 140 },
    back: (el) => ({ kind: "fontsize", value: el.fontsize }),
  },
  {
    name: "bold",
    keys: ["bold"],
    away: { kind: "bold", value: true },
    back: () => ({ kind: "bold", value: false }),
  },
  {
    name: "italic",
    keys: ["italic"],
    away: { kind: "italic", value: true },
    back: () => ({ kind: "italic", value: false }),
  },
  {
    name: "the outline toggle",
    keys: ["outlineEnable"],
    away: { kind: "outlineEnable", value: true },
    back: () => ({ kind: "outlineEnable", value: false }),
  },
  {
    name: "the outline width",
    keys: ["outlineSize"],
    away: { kind: "outlineSize", value: 9 },
    back: (el) => ({
      kind: "outlineSize",
      value: elementRunStyle(el).outlineSize,
    }),
  },
  {
    name: "the outline colour",
    keys: ["outlineColor"],
    away: { kind: "outlineColor", value: "#00e5ff" },
    back: (el) => ({
      kind: "outlineColor",
      value: elementRunStyle(el).outlineColor,
    }),
  },
  {
    name: "the face",
    keys: ["fontname", "fontpath", "fonttype", "fontweight"],
    // Every one of the four differs from the clip's, `fonttype` included, so
    // the case exercises all of them. A face that shares a field with the clip
    // correctly overrides only the rest; there is a case for that below.
    away: {
      kind: "face",
      fontname: "Inter-Bold",
      fontpath: "/fonts/Inter-Bold.otf",
      fonttype: "otf",
      fontweight: 700,
    },
    back: (el) => ({
      kind: "face",
      fontname: el.fontname,
      fontpath: el.fontpath,
      fonttype: el.fonttype,
      fontweight: elementRunStyle(el).fontweight,
    }),
  },
];

/** The keys the run covering `RANGE` is overriding, sorted. */
function overriddenKeys(d: TimelineDocument): RunStyleKey[] {
  const run = runsOf(elementOf(d)).find(
    (r) => r.from <= RANGE.from && r.to >= RANGE.to,
  );
  return run == null
    ? []
    : (Object.keys(run.style) as RunStyleKey[]).sort();
}

describe("one control, there and back", () => {
  it.each(CASES.map((c) => [c.name, c] as const))(
    "%s leaves nothing behind",
    (_name, testCase) => {
      const pristine = doc();
      const styled = apply(pristine, testCase.away);
      expect(overriddenKeys(styled).length).toBeGreaterThan(0);

      const back = apply(styled, testCase.back(elementOf(pristine)));
      expect(stored(back)).toBeUndefined();
      expect("runs" in (back.elements.text as object)).toBe(false);
      // The whole document, not just the field: this is the compatibility
      // promise, and it is only worth anything stated at that width.
      expect(JSON.stringify(back)).toBe(JSON.stringify(pristine));
    },
  );

  it.each(CASES.map((c) => [c.name, c] as const))(
    "%s declines by identity when it was never applied",
    (_name, testCase) => {
      const pristine = doc();
      expect(apply(pristine, testCase.back(elementOf(pristine)))).toBe(pristine);
    },
  );

  it.each(CASES.map((c) => [c.name, c] as const))(
    "%s declines by identity when applied twice",
    (_name, testCase) => {
      const styled = apply(doc(), testCase.away);
      expect(apply(styled, testCase.away)).toBe(styled);
    },
  );
});

/**
 * The bug, generalised: every ordered pair of controls.
 *
 * Apply A, apply B, take A back. B must still be there, and A must be gone.
 * Fifty-six cases, which is the point: the original failure was not about bold
 * or about colour, it was about the shape of "back to the clip's value".
 */
describe("two controls, one taken back", () => {
  const pairs = CASES.flatMap((a) =>
    CASES.filter((b) => b !== a).map((b) => [a, b] as const),
  );

  it.each(pairs.map(([a, b]) => [`${a.name} then ${b.name}`, a, b] as const))(
    "%s: taking the first back keeps the second",
    (_label, first, second) => {
      const pristine = doc();
      let d = apply(pristine, first.away);
      d = apply(d, second.away);
      expect(overriddenKeys(d)).toEqual(
        [...first.keys, ...second.keys].sort(),
      );

      const back = apply(d, first.back(elementOf(pristine)));
      expect(overriddenKeys(back)).toEqual([...second.keys].sort());
    },
  );

  it.each(pairs.map(([a, b]) => [`${a.name} then ${b.name}`, a, b] as const))(
    "%s: taking both back leaves the document untouched",
    (_label, first, second) => {
      const pristine = doc();
      let d = apply(pristine, first.away);
      d = apply(d, second.away);
      d = apply(d, first.back(elementOf(pristine)));
      d = apply(d, second.back(elementOf(pristine)));
      expect(JSON.stringify(d)).toBe(JSON.stringify(pristine));
    },
  );
});

describe("all of them at once", () => {
  const allKeys = [...new Set(CASES.flatMap((c) => c.keys))].sort();

  const styleAll = (pristine: TimelineDocument) =>
    CASES.reduce((d, testCase) => apply(d, testCase.away), pristine);

  it("carries every override on one run", () => {
    expect(overriddenKeys(styleAll(doc()))).toEqual(allKeys);
  });

  it.each(CASES.map((c) => [c.name, c] as const))(
    "taking %s back leaves all the others",
    (_name, testCase) => {
      const pristine = doc();
      const back = apply(styleAll(pristine), testCase.back(elementOf(pristine)));
      expect(overriddenKeys(back)).toEqual(
        allKeys.filter((key) => !testCase.keys.includes(key)),
      );
    },
  );

  it("comes back to nothing, whatever order they are taken back in", () => {
    const pristine = doc();
    // Every rotation of the list, which is enough to catch an order the
    // implementation happens to depend on without paying for 8! of them.
    for (let offset = 0; offset < CASES.length; offset += 1) {
      const order = CASES.map(
        (_, i) => CASES[(i + offset) % CASES.length],
      );
      let d = styleAll(pristine);
      for (const testCase of order) {
        d = apply(d, testCase.back(elementOf(pristine)));
      }
      expect(JSON.stringify(d)).toBe(JSON.stringify(pristine));
    }
  });

  it("reports every value back through the panel while it is styled", () => {
    const styled = styleAll(doc());
    const shown = textControlsDisplay(elementOf(styled), RANGE);
    expect(valueOr(shown.color, "")).toBe("#ffd21e");
    expect(valueOr(shown.fontsize, 0)).toBe(140);
    expect(valueOr(shown.bold, false)).toBe(true);
    expect(valueOr(shown.italic, false)).toBe(true);
    expect(valueOr(shown.outlineEnable, false)).toBe(true);
    expect(valueOr(shown.outlineSize, 0)).toBe(9);
    expect(valueOr(shown.outlineColor, "")).toBe("#00e5ff");
    expect(valueOr(shown.fontname, "")).toBe("Inter-Bold");
    expect(valueOr(shown.fontweight, 0)).toBe(700);
  });
});

/**
 * The panel presses a toggle by flipping what it is *showing*, not what the
 * clip says, so these drive that decision rather than a hard-coded value. It is
 * how the real second press knows it is a second press.
 */
describe("a toggle pressed twice, the way the panel presses it", () => {
  const toggles = [
    ["bold", "bold"],
    ["italic", "italic"],
    ["the outline", "outlineEnable"],
  ] as const;

  const pressToggle = (
    d: TimelineDocument,
    key: "bold" | "italic" | "outlineEnable",
  ) => {
    const shown = textControlsDisplay(elementOf(d), RANGE);
    const next = !valueOr(shown[key], false);
    const control = { kind: key, value: next } as TextStyleControl;
    return apply(d, control);
  };

  it.each(toggles)("%s comes back to the clip and nothing else", (_label, key) => {
    const pristine = doc();
    // The reported case: already coloured and resized, then toggled twice.
    let d = apply(pristine, CASES[0].away);
    d = apply(d, CASES[1].away);
    const before = overriddenKeys(d);

    d = pressToggle(d, key);
    expect(overriddenKeys(d)).toEqual([...before, key].sort());

    d = pressToggle(d, key);
    expect(overriddenKeys(d)).toEqual(before);
    expect(valueOr(textControlsDisplay(elementOf(d), RANGE).color, "")).toBe(
      "#ffd21e",
    );
    expect(valueOr(textControlsDisplay(elementOf(d), RANGE).fontsize, 0)).toBe(
      140,
    );
  });

  it.each(toggles)("%s survives a third and fourth press", (_label, key) => {
    const pristine = doc();
    let d = apply(pristine, CASES[0].away);
    for (let i = 0; i < 4; i += 1) {
      d = pressToggle(d, key);
    }
    expect(overriddenKeys(d)).toEqual(["color"]);
  });

  it.each(toggles)("%s on its own leaves the document untouched", (_label, key) => {
    const pristine = doc();
    const d = pressToggle(pressToggle(pristine, key), key);
    expect(JSON.stringify(d)).toBe(JSON.stringify(pristine));
  });
});

describe("a range inside a range", () => {
  const inner = { from: 8, to: 10 };

  it("keeps the outer overrides on the pieces either side", () => {
    let d = apply(doc(), CASES[0].away);
    d = apply(d, CASES[2].away, inner);
    const runs = runsOf(elementOf(d));
    expect(runs).toHaveLength(3);
    expect(runs.map((r) => [r.from, r.to])).toEqual([
      [6, 8],
      [8, 10],
      [10, 11],
    ]);
    expect(runs[1].style).toEqual({ color: "#ffd21e", bold: true });
  });

  it("merges the pieces back together when the inner edit is taken back", () => {
    const pristine = doc();
    let d = apply(pristine, CASES[0].away);
    d = apply(d, CASES[2].away, inner);
    d = apply(d, CASES[2].back(elementOf(pristine)), inner);

    const runs = runsOf(elementOf(d));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toEqual({ from: 6, to: 11, style: { color: "#ffd21e" } });
  });

  it("comes back to nothing through the nested route as well", () => {
    const pristine = doc();
    let d = apply(pristine, CASES[0].away);
    d = apply(d, CASES[2].away, inner);
    d = apply(d, CASES[2].back(elementOf(pristine)), inner);
    d = apply(d, CASES[0].back(elementOf(pristine)));
    expect(JSON.stringify(d)).toBe(JSON.stringify(pristine));
  });
});

describe("neighbouring ranges", () => {
  const left = { from: 0, to: 5 };
  const right = { from: 6, to: 11 };

  it("does not let one range's edit reach the other", () => {
    const pristine = doc();
    let d = apply(pristine, CASES[0].away, left);
    d = apply(d, CASES[1].away, right);

    // Taking the colour back on the left must not touch the size on the right.
    d = apply(d, CASES[0].back(elementOf(pristine)), left);
    const runs = runsOf(elementOf(d));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toEqual({ from: 6, to: 11, style: { fontsize: 140 } });
  });

  it("merges two ranges that end up saying the same thing", () => {
    let d = apply(doc(), CASES[0].away, { from: 0, to: 5 });
    d = apply(d, CASES[0].away, { from: 5, to: 11 });
    const runs = runsOf(elementOf(d));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toEqual({ from: 0, to: 11, style: { color: "#ffd21e" } });
  });
});

describe("the clip's own value is not always the default", () => {
  /** A clip that is already bold, italic and outlined. */
  const loud = (): TimelineDocument =>
    normalizeDocument({
      schemaVersion: SCHEMA_VERSION,
      tracks: [createTrack("v0", "video", 0)],
      elements: {
        text: textElement({
          trackId: "v0",
          startTime: 0,
          duration: 4000,
          text: BODY,
          textcolor: "#ff0000",
          fontsize: 40,
          options: {
            isBold: true,
            isItalic: true,
            align: "left",
            outline: { enable: true, size: 6, color: "#00ff00" },
          },
        }),
      },
    });

  it("stores the override when a range is turned *off* against a loud clip", () => {
    // Un-bolding a bold clip's range is a real override, not a removal.
    const pristine = loud();
    const d = setTextRangeStyle(pristine, "text", 6, 11, { bold: false });
    expect(runsOf(elementOf(d))[0].style).toEqual({ bold: false });
  });

  it("removes it again when the range is turned back on", () => {
    const pristine = loud();
    let d = setTextRangeStyle(pristine, "text", 6, 11, { bold: false });
    d = setTextRangeStyle(d, "text", 6, 11, { bold: true });
    expect(JSON.stringify(d)).toBe(JSON.stringify(pristine));
  });

  it("keeps a second override while the first is turned back on", () => {
    const pristine = loud();
    let d = setTextRangeStyle(pristine, "text", 6, 11, { bold: false });
    d = setTextRangeStyle(d, "text", 6, 11, { color: "#0000ff" });
    d = setTextRangeStyle(d, "text", 6, 11, { bold: true });
    expect(runsOf(elementOf(d))[0].style).toEqual({ color: "#0000ff" });
  });
});

describe("a face that only partly differs", () => {
  it("overrides the fields that differ and no others", () => {
    // Sparse means sparse. Picking a face that happens to be the same file
    // type as the clip's stores three fields, not four, and the fourth goes on
    // reading from the clip - which is the same answer and one key smaller.
    const d = apply(doc(), {
      kind: "face",
      fontname: "Inter-Bold",
      fontpath: "/fonts/Inter-Bold.ttf",
      fonttype: "ttf",
      fontweight: 700,
    });
    expect(runsOf(elementOf(d))[0].style).toEqual({
      fontname: "Inter-Bold",
      fontpath: "/fonts/Inter-Bold.ttf",
      fontweight: 700,
    });
  });

  it("still resolves the shared field to the same value", () => {
    const d = apply(doc(), {
      kind: "face",
      fontname: "Inter-Bold",
      fontpath: "/fonts/Inter-Bold.ttf",
      fonttype: "ttf",
      fontweight: 700,
    });
    expect(valueOr(textControlsDisplay(elementOf(d), RANGE).fonttype, "")).toBe(
      "ttf",
    );
  });

  it("comes back to nothing all the same", () => {
    const pristine = doc();
    let d = apply(pristine, {
      kind: "face",
      fontname: "Inter-Bold",
      fontpath: "/fonts/Inter-Bold.ttf",
      fonttype: "ttf",
      fontweight: 700,
    });
    d = apply(d, CASES[7].back(elementOf(pristine)));
    expect(JSON.stringify(d)).toBe(JSON.stringify(pristine));
  });
});

describe("a range that is not uniform to begin with", () => {
  /** Colour on "Hello", size on "brave", nothing on " ". */
  const patchwork = () => {
    let d = apply(doc(), CASES[0].away, { from: 0, to: 5 });
    return apply(d, CASES[1].away, { from: 6, to: 11 });
  };

  it("reports mixed for what differs and one value for what does not", () => {
    const shown = textControlsDisplay(elementOf(patchwork()), { from: 0, to: 11 });
    expect(shown.color).toEqual({ kind: "mixed" });
    expect(shown.fontsize).toEqual({ kind: "mixed" });
    // Nothing in the range overrides the weight, so it is the clip's.
    expect(shown.bold).toEqual({ kind: "one", value: false });
  });

  it("applies a new override across every piece without disturbing them", () => {
    const d = apply(patchwork(), CASES[2].away, { from: 0, to: 11 });
    const runs = runsOf(elementOf(d));
    expect(runs.map((r) => [r.from, r.to, r.style])).toEqual([
      [0, 5, { color: "#ffd21e", bold: true }],
      [5, 6, { bold: true }],
      [6, 11, { fontsize: 140, bold: true }],
    ]);
  });

  it("takes that override back off every piece and leaves the rest", () => {
    const pristine = doc();
    let d = apply(patchwork(), CASES[2].away, { from: 0, to: 11 });
    d = apply(d, CASES[2].back(elementOf(pristine)), { from: 0, to: 11 });
    const runs = runsOf(elementOf(d));
    expect(runs.map((r) => [r.from, r.to, r.style])).toEqual([
      [0, 5, { color: "#ffd21e" }],
      [6, 11, { fontsize: 140 }],
    ]);
  });

  it("straddles two runs and the gap between them", () => {
    // [3,8) covers the tail of the colour run, the unstyled space, and the head
    // of the size run. Four pieces come out, each keeping what it had.
    const d = apply(patchwork(), CASES[3].away, { from: 3, to: 8 });
    expect(runsOf(elementOf(d)).map((r) => [r.from, r.to, r.style])).toEqual([
      [0, 3, { color: "#ffd21e" }],
      [3, 5, { color: "#ffd21e", italic: true }],
      [5, 6, { italic: true }],
      [6, 8, { fontsize: 140, italic: true }],
      [8, 11, { fontsize: 140 }],
    ]);
  });

  it("puts the straddling pieces back together when it is taken back", () => {
    const pristine = doc();
    let d = apply(patchwork(), CASES[3].away, { from: 3, to: 8 });
    d = apply(d, CASES[3].back(elementOf(pristine)), { from: 3, to: 8 });
    expect(JSON.stringify(elementOf(d).runs)).toBe(
      JSON.stringify(elementOf(patchwork()).runs),
    );
  });

  it("clears back to a pristine document from the patchwork too", () => {
    const pristine = doc();
    let d = patchwork();
    d = apply(d, CASES[0].back(elementOf(pristine)), { from: 0, to: 5 });
    d = apply(d, CASES[1].back(elementOf(pristine)), { from: 6, to: 11 });
    expect(JSON.stringify(d)).toBe(JSON.stringify(pristine));
  });

  it("clears back even when the taking-back range is wider than the runs", () => {
    const pristine = doc();
    let d = patchwork();
    d = apply(d, CASES[0].back(elementOf(pristine)), { from: 0, to: 17 });
    d = apply(d, CASES[1].back(elementOf(pristine)), { from: 0, to: 17 });
    expect(JSON.stringify(d)).toBe(JSON.stringify(pristine));
  });
});

describe("a toggle over a range that disagrees with itself", () => {
  /** Bold on "bra", nothing on "ve". */
  const halfBold = () => apply(doc(), CASES[2].away, { from: 6, to: 9 });

  it("reports mixed", () => {
    expect(textControlsDisplay(elementOf(halfBold()), RANGE).bold).toEqual({
      kind: "mixed",
    });
  });

  it("turns the whole range on with the first press", () => {
    // What every editor does, and the reason `valueOr(..., false)` is the
    // direction: a mixed selection resolves to on, not to off.
    const shown = textControlsDisplay(elementOf(halfBold()), RANGE);
    const d = apply(halfBold(), {
      kind: "bold",
      value: !valueOr(shown.bold, false),
    });
    const runs = runsOf(elementOf(d));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toEqual({ from: 6, to: 11, style: { bold: true } });
  });

  it("turns the whole range off with the second, and does not restore the mix", () => {
    // Deliberate, and worth stating: the first press made the range uniform,
    // so the second has a uniform range to turn off. Undo is what brings the
    // mix back, not a third press.
    let d = halfBold();
    for (let i = 0; i < 2; i += 1) {
      const shown = textControlsDisplay(elementOf(d), RANGE);
      d = apply(d, { kind: "bold", value: !valueOr(shown.bold, false) });
    }
    expect(stored(d)).toBeUndefined();
  });

  it("leaves a second property alone through both presses", () => {
    let d = apply(halfBold(), CASES[0].away);
    for (let i = 0; i < 2; i += 1) {
      const shown = textControlsDisplay(elementOf(d), RANGE);
      d = apply(d, { kind: "bold", value: !valueOr(shown.bold, false) });
    }
    const runs = runsOf(elementOf(d));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toEqual({ from: 6, to: 11, style: { color: "#ffd21e" } });
  });
});
