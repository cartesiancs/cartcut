import { describe, expect, it } from "vitest";
import {
  NOTE_PIN_PX,
  noteAnchorAt,
  notePinAt,
  placeNotePins,
  type NotePin,
} from "./notePins";
import { layoutTimeline, timeAtX, xAtTime } from "../timeline/layout";
import {
  SCHEMA_VERSION,
  createTrack,
  normalizeDocument,
} from "../timeline/tracks";
import type { TimelineNote } from "./notes";

const RANGE = 0.9; // 45px per second
const VIEWPORT = { w: 1000, h: 500 };

function layout(trackIds: string[], over: { hScroll?: number; vScroll?: number } = {}) {
  return layoutTimeline({
    doc: normalizeDocument({
      schemaVersion: SCHEMA_VERSION,
      tracks: trackIds.map((id, index) => createTrack(id, "video", index)),
      elements: {},
    }),
    range: RANGE,
    hScroll: over.hScroll ?? 0,
    vScroll: over.vScroll ?? 0,
    viewportW: VIEWPORT.w,
    viewportH: VIEWPORT.h,
    topOffset: 0,
  });
}

const note = (id: string, trackId: string, atMs: number): TimelineNote => ({
  id,
  trackId,
  atMs,
  text: id,
});

describe("noteAnchorAt", () => {
  it("takes the row under the point and the time at its x", () => {
    const l = layout(["v1", "v2"]);
    const row = l.rows[1];
    const anchor = noteAnchorAt(l, 90, row.top + 1, RANGE, 0);
    expect(anchor).toEqual({ trackId: "v2", atMs: Math.round(timeAtX(90, RANGE, 0)) });
  });

  it("gives a point below the last row to the last row", () => {
    const l = layout(["v1", "v2"]);
    expect(noteAnchorAt(l, 10, 490, RANGE, 0)?.trackId).toBe("v2");
  });

  it("gives a point between rows to the nearer one", () => {
    const l = layout(["v1", "v2"]);
    const [a, b] = l.rows;
    const gapTop = a.top + a.height;
    expect(b.top).toBeGreaterThan(gapTop + 1);
    expect(noteAnchorAt(l, 10, gapTop + 0.1, RANGE, 0)?.trackId).toBe("v1");
    expect(noteAnchorAt(l, 10, b.top - 0.1, RANGE, 0)?.trackId).toBe("v2");
  });

  it("clamps a time before the start to zero", () => {
    const l = layout(["v1"]);
    expect(noteAnchorAt(l, -200, l.rows[0].top + 1, RANGE, 0)?.atMs).toBe(0);
  });

  it("offers nothing when there is no row", () => {
    expect(noteAnchorAt(layout([]), 10, 10, RANGE, 0)).toBeNull();
  });
});

describe("placeNotePins", () => {
  it("puts the tip at the note's time, centred on its row", () => {
    const l = layout(["v1", "v2"]);
    const [pin] = placeNotePins([note("a", "v2", 2000)], l, RANGE, 0, VIEWPORT);
    const row = l.rows[1];
    expect(pin.x).toBeCloseTo(xAtTime(2000, RANGE, 0));
    expect(pin.y + NOTE_PIN_PX / 2).toBeCloseTo(row.top + row.height / 2);
  });

  it("follows the horizontal and vertical scroll", () => {
    const still = placeNotePins([note("a", "v1", 2000)], layout(["v1"]), RANGE, 0, VIEWPORT);
    const moved = placeNotePins(
      [note("a", "v1", 2000)],
      layout(["v1"], { hScroll: 30, vScroll: 5 }),
      RANGE,
      30,
      VIEWPORT,
    );
    expect(moved[0].x).toBeCloseTo(still[0].x - 30);
    expect(moved[0].y).toBeCloseTo(still[0].y - 5);
  });

  it("numbers in the order the notes were made, skipping a deleted track", () => {
    const pins = placeNotePins(
      [note("a", "v1", 0), note("b", "gone", 0), note("c", "v1", 3000)],
      layout(["v1"]),
      RANGE,
      0,
      VIEWPORT,
    );
    expect(pins.map((pin) => [pin.id, pin.n])).toEqual([
      ["a", 1],
      ["c", 2],
    ]);
  });

  it("leaves out pins outside the viewport but keeps their numbers", () => {
    const farMs = timeAtX(VIEWPORT.w + 50, RANGE, 0);
    const pins = placeNotePins(
      [note("a", "v1", farMs), note("b", "v1", 0)],
      layout(["v1"]),
      RANGE,
      0,
      VIEWPORT,
    );
    expect(pins.map((pin) => [pin.id, pin.n])).toEqual([["b", 2]]);
  });
});

describe("notePinAt", () => {
  const pins: NotePin[] = [
    { id: "a", n: 1, x: 100, y: 10 },
    { id: "b", n: 2, x: 110, y: 10 },
  ];

  it("finds the pin under the point", () => {
    expect(notePinAt(pins, 101, 11)).toBe("a");
  });

  it("misses outside every pin", () => {
    expect(notePinAt(pins, 99, 11)).toBeNull();
    expect(notePinAt(pins, 140, 11)).toBeNull();
    expect(notePinAt(pins, 101, 10 + NOTE_PIN_PX + 1)).toBeNull();
  });

  it("gives an overlap to the pin drawn last", () => {
    expect(notePinAt(pins, 115, 15)).toBe("b");
  });
});
