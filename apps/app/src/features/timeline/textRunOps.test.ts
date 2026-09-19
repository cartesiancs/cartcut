/**
 * Per-range text style, at the document level.
 *
 * The claims that matter most here are the two the rest of the app depends on
 * without ever naming them:
 *
 * - **Declining returns the document by identity**, so `withCheckpoint` records
 *   no undo step. Every such assertion is `toBe`, never `toEqual`, because
 *   `toEqual` would pass against a build that had lost the contract entirely.
 * - **A clip nobody has styled a range in saves byte-identically** to one
 *   written before this feature existed. `SCHEMA_VERSION` did not move, so that
 *   is the whole of the compatibility story.
 */

import { describe, expect, it } from "vitest";

import type { TextElementType, TextRun } from "../../@types/timeline";
import { runsOf } from "../text/runs";
import {
  audioElement,
  imageElement,
  textElement,
} from "../renderer/testing";
import { pasteClips, splitClip } from "./clipOps";
import {
  RUN_STYLABLE_FILETYPES,
  clearTextRangeStyle,
  clearTextRuns,
  isRunStylable,
  setTextRangeStyle,
  setTextRangeStyleMany,
  setTextWithRuns,
} from "./textRunOps";
import {
  SCHEMA_VERSION,
  createTrack,
  normalizeDocument,
  type TimelineDocument,
} from "./tracks";

/** "Hello world", so an offset in a test reads as a word rather than a number. */
const BODY = "Hello world";

function doc(): TimelineDocument {
  return normalizeDocument({
    schemaVersion: SCHEMA_VERSION,
    tracks: [createTrack("v0", "video", 0), createTrack("a0", "audio", 1)],
    elements: {
      text: textElement({
        trackId: "v0",
        startTime: 0,
        duration: 4000,
        text: BODY,
        textcolor: "#ffffff",
        fontsize: 40,
      }),
      image: imageElement({ trackId: "v0", startTime: 4000, duration: 1000 }),
      sound: audioElement({ trackId: "a0", startTime: 0, duration: 4000 }),
    },
  });
}

const stored = (d: TimelineDocument, id = "text") =>
  (d.elements[id] as TextElementType & { runs?: TextRun[] }).runs;

const RED = { color: "#ff0000" };

describe("RUN_STYLABLE_FILETYPES", () => {
  it("is exactly the types that carry a string to style", () => {
    expect([...RUN_STYLABLE_FILETYPES]).toEqual(["text"]);
  });

  it("recognises a text clip and nothing else", () => {
    const d = doc();
    expect(isRunStylable(d.elements.text)).toBe(true);
    expect(isRunStylable(d.elements.image)).toBe(false);
    expect(isRunStylable(d.elements.sound)).toBe(false);
    expect(isRunStylable(undefined)).toBe(false);
  });
});

describe("setTextRangeStyle", () => {
  it("writes a run where there was none", () => {
    const after = setTextRangeStyle(doc(), "text", 0, 5, RED);
    expect(stored(after)).toEqual([{ from: 0, to: 5, style: RED }]);
  });

  it("leaves every other clip alone", () => {
    const before = doc();
    const after = setTextRangeStyle(before, "text", 0, 5, RED);
    expect(after.elements.image).toBe(before.elements.image);
    expect(after.elements.sound).toBe(before.elements.sound);
    expect(after.tracks).toBe(before.tracks);
  });

  it("merges a second patch onto the first", () => {
    let d = setTextRangeStyle(doc(), "text", 0, 5, RED);
    d = setTextRangeStyle(d, "text", 0, 5, { bold: true });
    expect(stored(d)).toEqual([
      { from: 0, to: 5, style: { color: "#ff0000", bold: true } },
    ]);
  });
});

describe("declining by identity", () => {
  it.each([
    ["a missing clip", "nope"],
    ["an image", "image"],
    ["an audio clip", "sound"],
  ])("declines for %s", (_label, id) => {
    const before = doc();
    expect(setTextRangeStyle(before, id, 0, 5, RED)).toBe(before);
    expect(clearTextRangeStyle(before, id, 0, 5)).toBe(before);
    expect(clearTextRuns(before, id)).toBe(before);
    expect(setTextWithRuns(before, id, "anything")).toBe(before);
  });

  it.each([
    ["a collapsed range", 3, 3],
    ["a range past the end", 40, 50],
  ])("declines for %s", (_label, from, to) => {
    const before = doc();
    expect(setTextRangeStyle(before, "text", from, to, RED)).toBe(before);
  });

  it("declines for a patch with nothing readable in it", () => {
    const before = doc();
    expect(setTextRangeStyle(before, "text", 0, 5, {})).toBe(before);
    expect(setTextRangeStyle(before, "text", 0, 5, { color: "red" })).toBe(before);
  });

  it("declines for a patch already in force", () => {
    const styled = setTextRangeStyle(doc(), "text", 0, 5, RED);
    expect(setTextRangeStyle(styled, "text", 0, 5, RED)).toBe(styled);
    expect(setTextRangeStyle(styled, "text", 1, 4, RED)).toBe(styled);
  });

  it("declines for a clip that has no runs to clear", () => {
    const before = doc();
    expect(clearTextRuns(before, "text")).toBe(before);
    expect(clearTextRangeStyle(before, "text", 0, 5)).toBe(before);
  });

  it("declines when the text did not change", () => {
    const before = doc();
    expect(setTextWithRuns(before, "text", BODY)).toBe(before);
  });
});

describe("the patch that is really a removal", () => {
  it("declines for a patch that only names the clip's own values", () => {
    // White on a clip that is already white. The panel sends this every time
    // somebody reopens the colour picker and presses the swatch it is showing.
    const before = doc();
    expect(setTextRangeStyle(before, "text", 0, 5, { color: "#ffffff" })).toBe(
      before,
    );
  });

  it("removes a run when the range is styled back to the clip's own value", () => {
    const styled = setTextRangeStyle(doc(), "text", 0, 5, RED);
    const back = setTextRangeStyle(styled, "text", 0, 5, { color: "#ffffff" });
    expect(stored(back)).toBeUndefined();
  });

  it("deletes the key rather than storing undefined", () => {
    const styled = setTextRangeStyle(doc(), "text", 0, 5, RED);
    const cleared = clearTextRuns(styled, "text");
    expect("runs" in (cleared.elements.text as object)).toBe(false);
  });
});

describe("byte identity", () => {
  it("leaves an unstyled clip identical to one that never had a run", () => {
    const pristine = doc();
    const roundTripped = clearTextRuns(
      setTextRangeStyle(pristine, "text", 0, 5, RED),
      "text",
    );
    expect(JSON.stringify(roundTripped.elements.text)).toBe(
      JSON.stringify(pristine.elements.text),
    );
  });

  it("survives a save and load of the whole document", () => {
    const pristine = doc();
    const styled = setTextRangeStyle(pristine, "text", 0, 5, RED);
    const cleared = clearTextRangeStyle(styled, "text", 0, 5);
    expect(JSON.stringify(cleared)).toBe(JSON.stringify(pristine));
  });
});

describe("clearTextRangeStyle", () => {
  it("clears only what it covers", () => {
    const styled = setTextRangeStyle(doc(), "text", 0, 9, RED);
    const after = clearTextRangeStyle(styled, "text", 3, 6);
    expect(stored(after)).toEqual([
      { from: 0, to: 3, style: RED },
      { from: 6, to: 9, style: RED },
    ]);
  });
});

describe("setTextRangeStyleMany", () => {
  it("is one write across several clips", () => {
    const base = normalizeDocument({
      schemaVersion: SCHEMA_VERSION,
      tracks: [createTrack("v0", "video", 0)],
      elements: {
        a: textElement({ trackId: "v0", startTime: 0, duration: 1000, text: BODY }),
        b: textElement({ trackId: "v0", startTime: 1000, duration: 1000, text: BODY }),
      },
    });
    const after = setTextRangeStyleMany(base, ["a", "b"], 0, 5, RED);
    expect(stored(after, "a")).toEqual([{ from: 0, to: 5, style: RED }]);
    expect(stored(after, "b")).toEqual([{ from: 0, to: 5, style: RED }]);
  });

  it("declines by identity when no id can carry a run", () => {
    const before = doc();
    expect(setTextRangeStyleMany(before, ["image", "sound"], 0, 5, RED)).toBe(
      before,
    );
  });
});

describe("setTextWithRuns", () => {
  it("writes the text and the shifted runs together", () => {
    const styled = setTextRangeStyle(doc(), "text", 6, 11, RED);
    const after = setTextWithRuns(styled, "text", "Hello brave world");
    expect((after.elements.text as TextElementType).text).toBe("Hello brave world");
    expect(stored(after)).toEqual([{ from: 12, to: 17, style: RED }]);
  });

  it("keeps a style the user is typing inside", () => {
    const styled = setTextRangeStyle(doc(), "text", 0, 5, RED);
    const after = setTextWithRuns(styled, "text", "Helllo world");
    expect(stored(after)).toEqual([{ from: 0, to: 6, style: RED }]);
  });

  it("drops a run whose every character is deleted", () => {
    const styled = setTextRangeStyle(doc(), "text", 0, 5, RED);
    const after = setTextWithRuns(styled, "text", " world");
    expect(stored(after)).toBeUndefined();
    expect("runs" in (after.elements.text as object)).toBe(false);
  });

  /**
   * The contract every caller has to keep, written down because it was broken
   * once: the panel wrote the string with `updateTimeline` on each keystroke
   * and called this only at the commit, by which time the stored text *was* the
   * new text, the diff was empty, and every styled stretch stayed on the
   * characters it had started on. Call it with each value the field passes
   * through, not with the last one.
   */
  it("follows a keystroke stream one value at a time", () => {
    let d = setTextRangeStyle(doc(), "text", 6, 11, RED);
    for (const value of [
      "OHello world",
      "OhHello world",
      "Oh,Hello world",
      "Oh, Hello world",
    ]) {
      d = setTextWithRuns(d, "text", value);
    }
    expect((d.elements.text as TextElementType).text).toBe("Oh, Hello world");
    expect(stored(d)).toEqual([{ from: 10, to: 15, style: RED }]);
    // The run still covers the same characters it was given.
    expect("Oh, Hello world".slice(10, 15)).toBe("world");
  });

  it("does nothing useful when handed only the final value", () => {
    // The shape of the bug above, kept as a statement of what goes wrong: the
    // text is written without this function, and the later call sees no edit.
    const styled = setTextRangeStyle(doc(), "text", 6, 11, RED);
    const bypassed = {
      ...styled,
      elements: {
        ...styled.elements,
        text: { ...styled.elements.text, text: "Oh, Hello world" },
      },
    } as TimelineDocument;
    expect(setTextWithRuns(bypassed, "text", "Oh, Hello world")).toBe(bypassed);
    expect(stored(bypassed)).toEqual([{ from: 6, to: 11, style: RED }]);
  });

  it("leaves a clip with no runs carrying none", () => {
    const after = setTextWithRuns(doc(), "text", "Something else");
    expect("runs" in (after.elements.text as object)).toBe(false);
  });
});

describe("runs and the clip ops", () => {
  it("rides through a split without being shared with the other half", () => {
    const styled = setTextRangeStyle(doc(), "text", 0, 5, RED);
    const after = splitClip(styled, "text", 2000);
    const ids = Object.keys(after.elements).filter(
      (id) => after.elements[id].filetype === "text",
    );
    expect(ids.length).toBe(2);
    for (const id of ids) {
      expect(runsOf(after.elements[id] as TextElementType)).toEqual([
        { from: 0, to: 5, style: RED },
      ]);
    }
    // Writing to one half must not reach the other. They come out of a spread,
    // so this is the case `copyRuns` exists for.
    const edited = setTextRangeStyle(after, ids[0], 0, 5, { bold: true });
    expect(stored(edited, ids[1])).toEqual([{ from: 0, to: 5, style: RED }]);
  });

  it("survives a paste", () => {
    const styled = setTextRangeStyle(doc(), "text", 0, 5, RED);
    let minted = 0;
    const after = pasteClips(
      styled,
      { text: styled.elements.text },
      3000,
      () => `copy${(minted += 1)}`,
    );
    const pasted = Object.keys(after.elements).find(
      (id) => id !== "text" && after.elements[id].filetype === "text",
    );
    expect(pasted).toBeDefined();
    expect(runsOf(after.elements[pasted!] as TextElementType)).toEqual([
      { from: 0, to: 5, style: RED },
    ]);
  });
});

describe("immutability", () => {
  it("never mutates the document it was given", () => {
    const before = doc();
    const snapshot = JSON.stringify(before);
    const styled = setTextRangeStyle(before, "text", 0, 5, RED);
    setTextRangeStyle(styled, "text", 3, 8, { bold: true });
    setTextWithRuns(styled, "text", "different");
    clearTextRuns(styled, "text");
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it("does not share its run array with the document it came from", () => {
    const styled = setTextRangeStyle(doc(), "text", 0, 5, RED);
    const next = setTextRangeStyle(styled, "text", 6, 9, { bold: true });
    expect(stored(next)).not.toBe(stored(styled));
    expect(stored(next)![0].style).not.toBe(stored(styled)![0].style);
  });
});
