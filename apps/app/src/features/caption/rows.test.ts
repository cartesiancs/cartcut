import { describe, expect, it } from "vitest";
import { createTextElement } from "../element/textElement";
import { captionStyle } from "./layout";
import { linesFromWordGroups, setLineText, type CaptionWord } from "./lines";
import { captionRows } from "./rows";

/**
 * The panel's contract with the rest of the app.
 *
 * `ui/control/Control.ts#_handleComplateAutoCaption` is the only consumer: it
 * takes `sourceKey` off each row, resolves the clip, and spreads
 * `captionToTimeline` over what is left before calling `addText`. So the two
 * things worth pinning are the **key set** — anything missing is a caption
 * placed with a default instead of the author's choice — and the **times**,
 * which have to still be in the source clock when they leave here.
 */

const FRAME = { w: 1920, h: 1080 };

/** "hello there world", one second each. */
const WORDS: CaptionWord[] = [
  { word: "hello", start: 0, end: 1 },
  { word: "there", start: 1, end: 2 },
  { word: "world", start: 2, end: 3 },
];

const twoLines = () =>
  linesFromWordGroups([WORDS, [{ word: "again", start: 4, end: 5 }]]);

describe("captionRows", () => {
  it("emits one row per caption, in order", () => {
    const rows = captionRows(twoLines(), "clip-1", FRAME);

    expect(rows.map((row) => row.text)).toEqual(["hello there world", "again"]);
  });

  it("carries the source clip's key on every row", () => {
    const rows = captionRows(twoLines(), "clip-1", FRAME);

    expect(rows.every((row) => row.sourceKey === "clip-1")).toBe(true);
  });

  it("passes a null key through rather than inventing one", () => {
    // `Control` reads `sourceKey ? timeline[sourceKey] : undefined`, and an
    // absent clip means the non-dynamic branch of `captionToTimeline`.
    expect(captionRows(twoLines(), null, FRAME)[0].sourceKey).toBeNull();
  });

  it("keeps times in the source file's clock, in milliseconds", () => {
    // The conversion to timeline time is `Control`'s job, through
    // `captionToTimeline`. Doing it here would make the rows untranslatable.
    const rows = captionRows(twoLines(), "clip-1", FRAME);

    expect(rows[0]).toMatchObject({ startTime: 0, duration: 3000 });
    expect(rows[1]).toMatchObject({ startTime: 4000, duration: 1000 });
  });

  it("gives every row the same style", () => {
    const rows = captionRows(twoLines(), "clip-1", FRAME, "center");
    const { fontsize, height, width, locationX, locationY } = captionStyle(
      FRAME,
      "center",
    );

    for (const row of rows) {
      expect(row).toMatchObject({
        fontsize,
        height,
        width,
        locationX,
        locationY,
        textcolor: "#ffffff",
        optionsAlign: "center",
        backgroundEnable: true,
      });
    }
  });

  it("carries the placement through to locationY", () => {
    const low = captionRows(twoLines(), "k", FRAME, "lowerThird")[0];
    const mid = captionRows(twoLines(), "k", FRAME, "center")[0];

    expect(low.locationY).toBeGreaterThan(mid.locationY);
  });

  it("emits exactly the keys Control and addText expect", () => {
    // Pinned as a set, because a missing key is silently replaced by
    // `createTextElement`'s own default — a caption placed 500px wide and
    // left-aligned instead of across the frame and centred.
    expect(new Set(Object.keys(captionRows(twoLines(), "k", FRAME)[0]))).toEqual(
      new Set([
        "sourceKey",
        "fontsize",
        "height",
        "width",
        "locationX",
        "locationY",
        "textcolor",
        "optionsAlign",
        "backgroundEnable",
        "text",
        "startTime",
        "duration",
      ]),
    );
  });

  it("produces a row that createTextElement accepts whole", () => {
    // The row minus `sourceKey` is what `addText` is handed, so every field has
    // to be a real `TextElementOptions` key. A stray one would be ignored
    // silently rather than rejected.
    const { sourceKey, ...options } = captionRows(twoLines(), "k", FRAME)[0];
    const element = createTextElement(options);

    expect(element.text).toBe("hello there world");
    expect(element.fontsize).toBe(captionStyle(FRAME).fontsize);
    expect(element.options.align).toBe("center");
    expect(element.background.enable).toBe(true);
    expect(sourceKey).toBe("k");
  });

  it("drops a line the user emptied", () => {
    // `captionsFrom` does it: an empty text element on the timeline is invisible
    // and unfindable.
    const emptied = setLineText(twoLines(), 0, "   ");

    expect(captionRows(emptied, "k", FRAME).map((r) => r.text)).toEqual(["again"]);
  });

  it("still styles the surviving rows correctly after one is dropped", () => {
    // The defect this function's shape exists to prevent. The panel computed the
    // style from the index of the *filtered* list while reading the *unfiltered*
    // one, so from the first emptied line onwards it was a line out. With the
    // style shared there is no index to get wrong — and the text on each
    // surviving row must still be that row's own.
    const emptied = setLineText(
      linesFromWordGroups([
        [{ word: "first", start: 0, end: 1 }],
        [{ word: "second", start: 1, end: 2 }],
        [{ word: "third", start: 2, end: 3 }],
      ]),
      0,
      "",
    );
    const rows = captionRows(emptied, "k", FRAME);

    expect(rows.map((r) => r.text)).toEqual(["second", "third"]);
    expect(rows.map((r) => r.startTime)).toEqual([1000, 2000]);
    expect(rows[0]).toMatchObject(captionStyle(FRAME));
  });

  it("trims the text it places", () => {
    // `captionsFrom` trims. Worth pinning here because the preview draws the
    // untrimmed string, so the two differ for a line with edge whitespace —
    // see the trailing-space case in preview's parity suite.
    const padded = setLineText(twoLines(), 0, "  hello there  ");

    expect(captionRows(padded, "k", FRAME)[0].text).toBe("hello there");
  });

  it("answers an empty list for no lines", () => {
    expect(captionRows([], "k", FRAME)).toEqual([]);
  });

  it("answers an empty list when every line was emptied", () => {
    const blank = setLineText(
      setLineText(twoLines(), 0, ""),
      1,
      "",
    );

    expect(captionRows(blank, "k", FRAME)).toEqual([]);
  });

  it("floors a zero-length caption at 1ms", () => {
    // `captionsFrom`'s MIN_DURATION_MS. A caption with no duration would be
    // placed and then be impossible to select.
    const instant = linesFromWordGroups([[{ word: "blink", start: 2, end: 2 }]]);

    expect(captionRows(instant, "k", FRAME)[0].duration).toBe(1);
  });
});
