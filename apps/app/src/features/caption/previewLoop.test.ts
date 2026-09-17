import { describe, expect, it } from "vitest";
import { ChromeGate, chromeKey, chromeKeyAt, chromeStateOf } from "./previewLoop";
import { linesFromWordGroups } from "./lines";
import { playheadLabel } from "../media/playback";

/**
 * The re-render gate.
 *
 * `PreviewLoop` used to be tested here too, and it was the reason this file
 * existed: two animation-frame handles cancelled in different combinations by
 * four methods, none of it reachable from a test. The loop went with the
 * panel's canvas, and what is left is the part that still matters now that the
 * panel follows the app's own playhead: deciding when a cursor change is worth
 * a re-render at all.
 */

describe("chromeKey", () => {
  const lines = () =>
    linesFromWordGroups([
      [
        { word: "hello", start: 0, end: 1 },
        { word: "there", start: 2, end: 3 },
      ],
      [{ word: "again", start: 4, end: 5 }],
    ]);

  it("names the line and the word", () => {
    expect(chromeKey(lines(), 0.5)).toBe("0:0");
    expect(chromeKey(lines(), 2.5)).toBe("0:1");
    expect(chromeKey(lines(), 4.5)).toBe("1:0");
  });

  it("uses -1 for a line with no word being spoken", () => {
    expect(chromeKey(lines(), 1.5)).toBe("0:-1");
  });

  it("uses -1 for both outside every line", () => {
    expect(chromeKey(lines(), 99)).toBe("-1:-1");
    expect(chromeKey([], 0)).toBe("-1:-1");
  });

  it("never collides with the gate's initial empty string", () => {
    // `ChromeGate` starts at "", so the first call must always look different —
    // otherwise the very first frame of a transcript does not render.
    for (const t of [-1, 0, 1.5, 4.5, 99]) {
      expect(chromeKey(lines(), t)).not.toBe("");
    }
  });
});

describe("ChromeGate", () => {
  it("re-renders the first time it is asked", () => {
    expect(new ChromeGate().changed("0:0", "0:01 / 0:05")).toBe(true);
  });

  it("declines an unchanged frame", () => {
    const gate = new ChromeGate();
    gate.changed("0:0", "0:01");
    expect(gate.changed("0:0", "0:01")).toBe(false);
  });

  it("declines the same frame however many times it is asked", () => {
    const gate = new ChromeGate();
    gate.changed("0:0", "0:01");
    for (let i = 0; i < 60; i += 1) {
      expect(gate.changed("0:0", "0:01")).toBe(false);
    }
  });

  it("re-renders when the highlighted word moves", () => {
    const gate = new ChromeGate();
    gate.changed("0:0", "0:01");
    expect(gate.changed("0:1", "0:01")).toBe(true);
  });

  it("re-renders when only the readout moves", () => {
    const gate = new ChromeGate();
    gate.changed("0:0", "0:01");
    expect(gate.changed("0:0", "0:02")).toBe(true);
  });

  it("re-renders again after going back to a previous state", () => {
    // It remembers only the last frame, not a history — scrubbing backwards has
    // to repaint.
    const gate = new ChromeGate();
    gate.changed("0:0", "0:01");
    gate.changed("0:1", "0:02");
    expect(gate.changed("0:0", "0:01")).toBe(true);
  });
});

describe("chromeStateOf", () => {
  const lines = () => linesFromWordGroups([[{ word: "hi", start: 0, end: 1 }]]);

  it("pairs the key with the label the template renders", () => {
    expect(chromeStateOf(lines(), 0.5, 10)).toEqual({
      active: "0:0",
      label: playheadLabel(0.5, 10),
    });
  });

  it("gates on the rendered label, so it changes where the readout does", () => {
    // `formatPlayhead` floors. Gating on `Math.round` would hold the re-render
    // back across the very boundary the readout changes at, leaving it a second
    // stale — which is why the label itself is the key.
    const gate = new ChromeGate();
    const at = (t: number) => chromeStateOf(lines(), t, 10);

    const a = at(0.9);
    expect(gate.changed(a.active, a.label)).toBe(true);

    // Still 0:00 — floored — so nothing re-renders even though Math.round would
    // have called 0.9 a different second from 0.4.
    const b = at(0.4);
    expect(b.label).toBe(a.label);
    expect(gate.changed(b.active, b.label)).toBe(false);

    // Crossing 1.0 is where the readout actually changes.
    const c = at(1.05);
    expect(c.label).not.toBe(a.label);
    expect(gate.changed(c.active, c.label)).toBe(true);
  });

  it("drops about two orders of magnitude of re-renders across a still second", () => {
    // The reason the gate exists: sixty frames of a second in which nothing the
    // template shows has changed must produce one re-render, not sixty.
    const gate = new ChromeGate();
    let renders = 0;
    for (let frame = 0; frame < 60; frame += 1) {
      const { active, label } = chromeStateOf(lines(), 0.1 + frame / 1000, 10);
      if (gate.changed(active, label)) renders += 1;
    }
    expect(renders).toBe(1);
  });
});

describe("chromeKeyAt", () => {
  const tagged = () => [
    { ...linesFromWordGroups([[{ word: "a", start: 1, end: 2 }]], () => "a")[0], sourceKey: "x" },
    { ...linesFromWordGroups([[{ word: "b", start: 1, end: 2 }]], () => "b")[0], sourceKey: "y" },
  ];

  it("keys the gap between clips like a moment with nothing lit", () => {
    expect(chromeKeyAt(tagged(), [])).toBe("-1:-1");
  });

  it("lights the line of the clip under the playhead, not its twin", () => {
    expect(chromeKeyAt(tagged(), [{ key: "y", seconds: 1.5 }])).toBe("1:0");
  });

  // Two chosen clips on two tracks play at once. A key that folded them into
  // one would hold the re-render back when only the second one moved.
  it("changes when either of two positions changes", () => {
    const ls = tagged();
    const both = chromeKeyAt(ls, [
      { key: "x", seconds: 1.5 },
      { key: "y", seconds: 1.5 },
    ]);
    const moved = chromeKeyAt(ls, [
      { key: "x", seconds: 1.5 },
      { key: "y", seconds: 3 },
    ]);
    expect(both).not.toBe(moved);
  });
});
