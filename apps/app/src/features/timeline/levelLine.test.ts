import { describe, expect, it } from "vitest";
import {
  LEVEL_GRAB_PX,
  LEVEL_KNEE_DB,
  dbPerPx,
  LEVEL_MIN_BAND_PX,
  LEVEL_TOP_INSET_PX,
  dbAtX,
  dbToY,
  hasLevelEnvelope,
  hitLevelLine,
  levelBandOf,
  levelPoints,
  levelPolyline,
  yToDb,
} from "./levelLine";
import { MAX_VOLUME_DB, MIN_VOLUME_DB } from "./audio";
import { TRACK_HEIGHT, hitTest, layoutTimeline, type ClipRect } from "./layout";
import {
  SCHEMA_VERSION,
  createTrack,
  normalizeDocument,
  type TimelineDocument,
} from "./tracks";
import { bakeTrack } from "../animation/keyframes";
import {
  audioElement,
  imageElement,
  keys,
  videoElement,
} from "../renderer/testing";

const RANGE = 0.9; // 45px per second

const rect = (over: Partial<ClipRect> = {}): ClipRect => ({
  elementId: "a",
  trackId: "a1",
  x: 100,
  y: 40,
  w: 180,
  h: TRACK_HEIGHT,
  ...over,
});

/** One live level track built from `[localMs, dB]` pairs. */
function envelope(pairs: Array<[number, number]>, isActivate = true) {
  const authored = keys(...pairs);
  return { isActivate, x: authored, ax: bakeTrack(authored) };
}

const plain = audioElement({ startTime: 0, duration: 4000 });
const keyed = audioElement({
  startTime: 0,
  duration: 4000,
  animation: { volumeDb: envelope([[0, 0], [4000, -60]]) },
} as any);

const band = levelBandOf(rect(), plain)!;

describe("levelBandOf", () => {
  it("clears the label and any keyframe lane", () => {
    expect(levelBandOf(rect(), plain)).toEqual({
      top: 40 + LEVEL_TOP_INSET_PX,
      height: TRACK_HEIGHT - LEVEL_TOP_INSET_PX,
    });
    // The band runs all the way down, keyframe lane included. Reserving for
    // the lane as well would leave 11px on a 40px row, under the minimum, so
    // the line would vanish the moment a keyframe was added.
    expect(levelBandOf(rect(), plain)!.height).toBeGreaterThanOrEqual(
      LEVEL_MIN_BAND_PX,
    );
  });

  it("is absent on a clip with no sound to level", () => {
    // The same gate the waveform uses, so the line and the trace appear and
    // disappear together.
    expect(levelBandOf(rect(), imageElement())).toBeNull();
    expect(
      levelBandOf(rect(), videoElement({ isExistAudio: false })),
    ).toBeNull();
    expect(
      levelBandOf(
        rect(),
        videoElement({ isExistAudio: true, audioDetached: true }),
      ),
    ).toBeNull();
    expect(
      levelBandOf(rect(), videoElement({ isExistAudio: true })),
    ).not.toBeNull();
  });

  it("is absent when the band is too short to aim at", () => {
    const short = LEVEL_TOP_INSET_PX + LEVEL_MIN_BAND_PX;
    expect(levelBandOf(rect({ h: short - 1 }), plain)).toBeNull();
    expect(levelBandOf(rect({ h: short }), plain)).not.toBeNull();
  });
});

describe("dbToY / yToDb", () => {
  it("are exact inverses", () => {
    for (let db = MIN_VOLUME_DB; db <= MAX_VOLUME_DB; db += 0.5) {
      expect(yToDb(dbToY(db, band), band)).toBeCloseTo(db, 6);
    }
  });

  it("puts the ceiling at the top and the floor at the bottom", () => {
    // Both ends exact, so the fader reaches silence at the bottom of the band
    // rather than somewhere near it.
    expect(dbToY(MAX_VOLUME_DB, band)).toBeCloseTo(band.top, 6);
    expect(dbToY(MIN_VOLUME_DB, band)).toBeCloseTo(band.top + band.height, 6);
    expect(dbToY(0, band)).toBeGreaterThan(band.top + 1);
  });

  it("is monotone, so the line never doubles back", () => {
    let previous = -Infinity;
    for (let db = MAX_VOLUME_DB; db >= MIN_VOLUME_DB; db -= 0.25) {
      const y = dbToY(db, band);
      expect(y).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = y;
    }
  });

  it("spends most of the band on the range people work in", () => {
    // The taper, and the measurement that made it necessary. On a 40px row the
    // band is 23px and the range is 72 dB; straight, -18 dB lands six pixels
    // below unity, which is not a difference anyone can see between a clip at
    // full level and one turned down by two thirds.
    const working = dbToY(LEVEL_KNEE_DB, band) - dbToY(MAX_VOLUME_DB, band);
    expect(working / band.height).toBeCloseTo(0.75, 2);
    // Which leaves 0 and -18 about ten pixels apart rather than six.
    expect(dbToY(-18, band) - dbToY(0, band)).toBeGreaterThan(9);
  });
});

describe("dbPerPx", () => {
  it("is the local rate, so a drag tracks the pointer everywhere", () => {
    // One averaged rate would make the line lag the pointer near unity and
    // outrun it near the floor, which is the one thing a direct-manipulation
    // control must not do.
    const near = dbPerPx(band, 0);
    const deep = dbPerPx(band, -40);
    expect(deep).toBeGreaterThan(near * 2);
    // And it is the slope of the segment it belongs to, in dB per pixel:
    // the reciprocal of the pixels the scale spends on those six decibels.
    expect(near).toBeCloseTo(6 / (dbToY(-6, band) - dbToY(0, band)), 6);
  });

  it("clamps rather than running off the band", () => {
    expect(dbToY(99, band)).toBeCloseTo(band.top, 6);
    expect(yToDb(band.top - 500, band)).toBe(MAX_VOLUME_DB);
    expect(yToDb(band.top + band.height + 500, band)).toBe(MIN_VOLUME_DB);
  });
});

describe("levelPolyline", () => {
  it("is two points for a clip with no envelope", () => {
    // The common case, and it has to cost nothing: most clips are never keyed.
    const line = levelPolyline(rect(), plain, band, RANGE, 1000);
    expect(line).toHaveLength(2);
    expect(line[0].y).toBeCloseTo(line[1].y, 6);
  });

  it("follows the envelope, sampled through the same function the preview asks", () => {
    const line = levelPolyline(rect(), keyed, band, RANGE, 1000);
    expect(line.length).toBeGreaterThan(2);
    // A fade to silence: the line descends across the clip.
    expect(line.at(-1)!.y).toBeGreaterThan(line[0].y + 5);
    for (let i = 1; i < line.length; i++) {
      expect(line[i].y).toBeGreaterThanOrEqual(line[i - 1].y - 0.01);
    }
  });

  it("draws nothing for a clip scrolled off the viewport", () => {
    expect(levelPolyline(rect({ x: 5000 }), keyed, band, RANGE, 1000)).toEqual(
      [],
    );
  });
});

describe("levelPoints", () => {
  it("is empty without an envelope, and one per keyframe with one", () => {
    expect(levelPoints(rect(), plain, band, RANGE)).toEqual([]);
    expect(levelPoints(rect(), keyed, band, RANGE)).toHaveLength(2);
  });

  it("drops keyframes a trim has pushed outside the clip", () => {
    // Kept in the document, so dragging the edge back out restores them, but
    // with nowhere to draw. `keyframeMarkers.ts` states the same rule.
    const trimmed = audioElement({
      startTime: 0,
      duration: 1000,
      animation: { volumeDb: envelope([[0, 0], [4000, -60]]) },
    } as any);
    expect(levelPoints(rect(), trimmed, band, RANGE)).toHaveLength(1);
  });
});

describe("hitLevelLine", () => {
  it("grabs the line within the tolerance and not beyond it", () => {
    const y = dbToY(dbAtX(rect(), plain, 150), band);
    expect(hitLevelLine(rect(), plain, band, RANGE, 150, y)).toEqual({
      kind: "line",
    });
    expect(
      hitLevelLine(rect(), plain, band, RANGE, 150, y + LEVEL_GRAB_PX - 0.5),
    ).toEqual({ kind: "line" });
    expect(
      hitLevelLine(rect(), plain, band, RANGE, 150, y + LEVEL_GRAB_PX + 1),
    ).toBeNull();
  });

  it("prefers a point to the line, because it is the more specific intent", () => {
    const [first] = levelPoints(rect(), keyed, band, RANGE);
    expect(hitLevelLine(rect(), keyed, band, RANGE, first.x, first.y)).toEqual({
      kind: "point",
      index: 0,
    });
  });
});

describe("hasLevelEnvelope", () => {
  it("ignores a track that is switched off", () => {
    expect(hasLevelEnvelope(plain)).toBe(false);
    expect(hasLevelEnvelope(keyed)).toBe(true);
    const disarmed = audioElement({
      animation: { volumeDb: envelope([[0, 0], [1000, -20]], false) },
    } as any);
    expect(hasLevelEnvelope(disarmed)).toBe(false);
  });
});

describe("hitTest, with the band in play", () => {
  function layoutOf(element: any) {
    const doc: TimelineDocument = normalizeDocument({
      schemaVersion: SCHEMA_VERSION,
      tracks: [createTrack("a1", "audio", 0)],
      elements: { a: element },
    });
    return {
      doc,
      layout: layoutTimeline({
        doc,
        range: RANGE,
        hScroll: 0,
        vScroll: 0,
        viewportW: 1000,
        viewportH: 400,
      }),
    };
  }

  const clip = audioElement({
    trackId: "a1",
    startTime: 0,
    duration: 4000,
    trim: { startTime: 0, endTime: 4000 },
    sourceDuration: 4000,
  });

  it("reports nothing new when the caller passes no document", () => {
    // Every existing caller passes three arguments and must behave as it did.
    const { layout } = layoutOf(clip);
    const r = layout.clips[0];
    const y = dbToY(0, levelBandOf(r, clip)!);
    expect(hitTest(layout, r.x + r.w / 2, y)).toMatchObject({ zone: "body" });
  });

  it("reports the line when it does", () => {
    const { doc, layout } = layoutOf(clip);
    const r = layout.clips[0];
    const y = dbToY(0, levelBandOf(r, clip)!);
    expect(
      hitTest(layout, r.x + r.w / 2, y, doc.elements, RANGE),
    ).toMatchObject({ zone: "level" });
  });

  it("lets the trim handles win at the edges", () => {
    // The line runs the full width of the clip, under both handles included.
    // Asking it first would lose trimming on every clip whose line happens to
    // cross an edge at the height the pointer is at, which is most of them.
    const { doc, layout } = layoutOf(clip);
    const r = layout.clips[0];
    const y = dbToY(0, levelBandOf(r, clip)!);
    expect(hitTest(layout, r.x + 1, y, doc.elements, RANGE)).toMatchObject({
      zone: "trimStart",
    });
    expect(
      hitTest(layout, r.x + r.w - 1, y, doc.elements, RANGE),
    ).toMatchObject({ zone: "trimEnd" });
  });

  it("leaves the rest of the clip as body", () => {
    const { doc, layout } = layoutOf(clip);
    const r = layout.clips[0];
    const band = levelBandOf(r, clip)!;
    // Well below the line, which sits at unity, but still inside the clip:
    // `hitTest`'s bottom edge is exclusive, so the floor itself is `none`.
    const far = dbToY(-30, band);
    expect(
      hitTest(layout, r.x + r.w / 2, far, doc.elements, RANGE),
    ).toMatchObject({ zone: "body" });
  });
});
