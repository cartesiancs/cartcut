import { describe, it, expect } from "vitest";
import { fittedHeightWith, withFittedTextHeights } from "./textFit";
import { scene, textElement, imageElement } from "../renderer/testing";
import { defaultTextHeight } from "../text/metrics";
import type { TimelineDocument } from "../timeline/tracks";

const ctx = () => scene(400, 400).ctx;

const base = (over: Record<string, unknown> = {}) =>
  textElement({
    location: { x: 0, y: 0 },
    width: 200,
    height: 60,
    fontsize: 40,
    text: "AB",
    textcolor: "#ffffff",
    ...over,
  });

const docOf = (elements: Record<string, unknown>): TimelineDocument =>
  ({ schemaVersion: 1, tracks: [], elements }) as unknown as TimelineDocument;

describe("fittedHeightWith", () => {
  it("is a one-line box for one line of text", () => {
    // Close to the no-canvas estimate, which is what creation uses before
    // anything can be measured.
    const fitted = fittedHeightWith(ctx(), base());
    expect(Math.abs(fitted - defaultTextHeight(40))).toBeLessThan(8);
  });

  it("grows by one advance per line", () => {
    const one = fittedHeightWith(ctx(), base({ text: "A" }));
    const two = fittedHeightWith(ctx(), base({ text: "A\nB" }));
    const three = fittedHeightWith(ctx(), base({ text: "A\nB\nC" }));

    // fontsize 40 × the default 1.2 leading.
    expect(two - one).toBeCloseTo(48, 5);
    expect(three - two).toBeCloseTo(48, 5);
  });

  it("counts lines the wrap added, not just the ones the author typed", () => {
    const wide = fittedHeightWith(ctx(), base({ text: "AAAA BBBB CCCC" }));
    const narrow = fittedHeightWith(
      ctx(),
      base({ text: "AAAA BBBB CCCC", width: 60 }),
    );

    expect(narrow).toBeGreaterThan(wide);
  });

  it("follows the line height", () => {
    const options = base().options;
    const tight = fittedHeightWith(
      ctx(),
      base({ text: "A\nB", options: { ...options, lineHeight: 1 } }),
    );
    const loose = fittedHeightWith(
      ctx(),
      base({ text: "A\nB", options: { ...options, lineHeight: 2 } }),
    );

    expect(loose - tight).toBeCloseTo(40, 5);
  });

  it("does not read the element's current height", () => {
    // Otherwise fitting would be a fixed point of whatever was there already.
    expect(fittedHeightWith(ctx(), base({ text: "A\nB", height: 300 }))).toBe(
      fittedHeightWith(ctx(), base({ text: "A\nB", height: 12 })),
    );
  });

  it("is a whole number of pixels, and never zero", () => {
    const fitted = fittedHeightWith(ctx(), base({ text: "" }));
    expect(Number.isInteger(fitted)).toBe(true);
    expect(fitted).toBeGreaterThan(0);
  });
});

describe("withFittedTextHeights", () => {
  const fit = (doc: TimelineDocument, ids: string[]) =>
    withFittedTextHeights(doc, ids, ctx());

  it("writes the measured height onto the named clips", () => {
    const doc = docOf({ a: base({ text: "A\nB\nC", height: 60 }) });
    const next = fit(doc, ["a"]);

    expect((next.elements.a as any).height).toBe(
      fittedHeightWith(ctx(), base({ text: "A\nB\nC" })),
    );
  });

  it("returns the document by identity when every height already fits", () => {
    // The `withCheckpoint` contract: an op that changes nothing records no
    // undo step. Auto-fitting runs on edits that often do not move the box.
    const fitted = fittedHeightWith(ctx(), base({ text: "A\nB" }));
    const doc = docOf({ a: base({ text: "A\nB", height: fitted }) });

    expect(fit(doc, ["a"])).toBe(doc);
  });

  it("leaves clips that are not text alone", () => {
    const doc = docOf({ pic: imageElement({ height: 999 }) });
    expect(fit(doc, ["pic"])).toBe(doc);
    expect((doc.elements.pic as any).height).toBe(999);
  });

  it("ignores ids that are not in the document", () => {
    const doc = docOf({ a: base({ height: 60 }) });
    expect(fit(doc, ["missing"])).toBe(doc);
  });

  it("does not disturb the clips it was not asked about", () => {
    const doc = docOf({
      a: base({ text: "A\nB", height: 60 }),
      b: base({ text: "A\nB", height: 60 }),
    });
    const next = fit(doc, ["a"]);

    expect((next.elements.a as any).height).not.toBe(60);
    expect(next.elements.b).toBe(doc.elements.b);
  });

  it("fits several clips in one pass", () => {
    const doc = docOf({
      a: base({ text: "A\nB", height: 60 }),
      b: base({ text: "A\nB\nC", height: 60 }),
    });
    const next = fit(doc, ["a", "b"]);

    expect((next.elements.b as any).height).toBeGreaterThan(
      (next.elements.a as any).height,
    );
  });
});
