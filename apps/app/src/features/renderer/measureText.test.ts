/**
 * The measurement `measure_text` reports, against a real canvas.
 *
 * The claim worth pinning is the one the tool exists to settle: **`fontsize` is
 * the em size, and the letters are smaller than it.** An agent that measured a
 * screenshot and concluded the renderer was scaling its type had no way to tell
 * the two apart, so the numbers are asserted here rather than described.
 */

import { describe, expect, it } from "vitest";

import { scene, textElement } from "./testing";
import { measureTextDetail } from "./text";

/** A face every host has, so the ratios below are not about one font file. */
const FACE = "sans-serif";

function measure(overrides: Record<string, unknown> = {}) {
  const { ctx } = scene(600, 400);
  return measureTextDetail(
    ctx,
    textElement({ fontname: FACE, ...overrides }) as any,
  );
}

describe("measureTextDetail", () => {
  it("reports the em size it was given, untouched", () => {
    // Nothing in the picture path scales `fontsize`. If this ever fails, the
    // agent's original complaint was right after all.
    expect(measure({ text: "Hello", fontsize: 57 }).emSize).toBe(57);
  });

  it("reports a cap height well under the em — the 57 vs 43 discrepancy", () => {
    const metrics = measure({ text: "Hello", fontsize: 57 });

    // Measured across sans-serif, Helvetica and Arial at 57px: 41-44px of ink.
    // The window is deliberately wide: the exact ratio is the face's business
    // and the claim is only that the ink is materially smaller than the em.
    expect(metrics.capHeight).toBeGreaterThan(57 * 0.6);
    expect(metrics.capHeight).toBeLessThan(57 * 0.9);
  });

  it("scales the cap height with the em, so dividing once is enough", () => {
    // This is what makes the tool useful rather than merely informative: an
    // agent that wants 43px of capital can read the ratio at any size and
    // multiply. A face whose ink did not scale linearly would break that.
    const small = measure({ text: "Hello", fontsize: 40 });
    const large = measure({ text: "Hello", fontsize: 80 });

    expect(large.capHeight / small.capHeight).toBeCloseTo(2, 1);
  });

  it("measures each line and the widest of them", () => {
    const metrics = measure({
      text: "short\nmuch much longer",
      fontsize: 40,
      width: 2000,
    });

    expect(metrics.lines.map((line) => line.text)).toEqual([
      "short",
      "much much longer",
    ]);
    expect(metrics.lines[1].width).toBeGreaterThan(metrics.lines[0].width);
    // The block's width is the widest line, not the wrap box it was given.
    expect(metrics.blockWidth).toBe(metrics.lines[1].width);
    expect(metrics.blockWidth).toBeLessThan(2000);
  });

  it("puts the first baseline one em below the top", () => {
    expect(measure({ text: "Hello", fontsize: 57 }).firstBaseline).toBe(57);
  });

  it("advances lines by the leading, as a multiple of the size", () => {
    const metrics = measure({
      text: "one\ntwo\nthree",
      fontsize: 50,
      width: 2000,
    });
    // The default leading is 1.2, so 60px between baselines.
    expect(metrics.lineAdvance).toBeCloseTo(60, 5);
    expect(metrics.lines).toHaveLength(3);
  });

  it("wraps to the box it is given", () => {
    const wide = measure({ text: "one two three four", fontsize: 30, width: 2000 });
    const narrow = measure({ text: "one two three four", fontsize: 30, width: 120 });

    // Handed different inputs, the two must disagree — otherwise this suite
    // would pass against a measurer that ignored `width` entirely.
    expect(wide.lines).toHaveLength(1);
    expect(narrow.lines.length).toBeGreaterThan(1);
    expect(narrow.blockHeight).toBeGreaterThan(wide.blockHeight);
  });
});
