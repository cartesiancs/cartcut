import { describe, expect, it } from "vitest";
import type { TextElementType } from "../../@types/timeline";
import type { CaptionIds } from "../caption/applyCaptions";
import { videoElement } from "../renderer/testing";
import { spanOf, timelineTimeAt } from "../timeline/geometry";
import {
  SCHEMA_VERSION,
  createTrack,
  normalizeDocument,
  type TimelineDocument,
} from "../timeline/tracks";
import type { SubtitleCue } from "./cues";
import { cueRows, importSubtitles, type SubtitleImportPlan } from "./importCues";

const FRAME = { w: 1920, h: 1080 };

function doc(over: Record<string, unknown> = {}): TimelineDocument {
  return normalizeDocument({
    schemaVersion: SCHEMA_VERSION,
    tracks: [createTrack("v1", "video", 0)],
    elements: {
      clip: videoElement({
        trackId: "v1",
        startTime: 0,
        duration: 10_000,
        trim: { startTime: 0, endTime: 10_000 },
        sourceDuration: 10_000,
        speed: 1,
        ...over,
      }),
    },
  });
}

/** Printable ids, so a failure names the cue rather than a uuid. */
function ids(count: number): CaptionIds[] {
  return Array.from({ length: count }, (_, n) => ({
    element: `caption${n + 1}`,
    track: `text${n + 1}`,
  }));
}

const cues = (...spans: Array<[number, number, string?]>): SubtitleCue[] =>
  spans.map(([startMs, endMs, text], n) => ({
    startMs,
    endMs,
    text: text ?? `line ${n + 1}`,
  }));

function plan(over: Partial<SubtitleImportPlan> = {}): SubtitleImportPlan {
  const list = over.cues ?? cues([1000, 2000], [3000, 4000]);
  return {
    cues: list,
    frame: FRAME,
    sourceKey: null,
    ids: ids(list.length),
    ...over,
  };
}

const textElements = (d: TimelineDocument) =>
  Object.entries(d.elements).filter(([, e]) => e.filetype === "text");

describe("cueRows", () => {
  it("turns each cue's two timestamps into a start and a duration", () => {
    const rows = cueRows(plan({ cues: cues([1000, 2500], [3000, 4000]) }));

    expect(rows.map((r) => [r.startTime, r.duration])).toEqual([
      [1000, 1500],
      [3000, 1000],
    ]);
  });

  it("gives every row the same style, sized off the frame", () => {
    const rows = cueRows(plan({ frame: { w: 1080, h: 1920 } }));

    // `captionLayout` derives everything from the frame's height, which is what
    // makes a vertical project's captions fit rather than run off the bottom.
    expect(rows[0].fontsize).toBe(Math.round(1920 / 20));
    expect(rows[0].width).toBe(1080);
    expect(rows.every((r) => r.fontsize === rows[0].fontsize)).toBe(true);
  });

  it("places captions in the lower third by default and honours a choice", () => {
    const lower = cueRows(plan())[0];
    const centre = cueRows(plan({ placement: "center" }))[0];

    expect(centre.locationY).toBeLessThan(lower.locationY);
  });

  it("names every row distinctly, so nothing downstream collides", () => {
    const rows = cueRows(plan({ cues: cues([0, 1], [1, 2], [2, 3]) }));

    expect(new Set(rows.map((r) => r.lineId)).size).toBe(3);
  });

  it("carries the source key onto every row", () => {
    expect(cueRows(plan({ sourceKey: "clip" })).every((r) => r.sourceKey === "clip")).toBe(
      true,
    );
  });
});

describe("importSubtitles with timeline times", () => {
  it("places every cue where the file said", () => {
    const next = importSubtitles(
      doc(),
      plan({ cues: cues([1000, 2500], [3000, 4000]) }),
    );

    expect(
      textElements(next).map(([, e]) => spanOf(e)).map((s) => [s.start, s.end]),
    ).toEqual([
      [1000, 2500],
      [3000, 4000],
    ]);
  });

  it("carries each cue's words onto its clip", () => {
    const next = importSubtitles(doc(), plan({ cues: cues([0, 1000, "hello"]) }));

    expect((textElements(next)[0][1] as TextElementType).text).toBe("hello");
  });

  it("keeps a multi-line cue as one clip with a break in it", () => {
    // `text/lines.ts#splitParagraphs` is what gives that break a meaning at draw
    // time, so the string is stored exactly as the file had it.
    const next = importSubtitles(doc(), plan({ cues: cues([0, 1000, "two\nlines"]) }));

    expect((textElements(next)[0][1] as TextElementType).text).toBe("two\nlines");
  });

  it("puts non-overlapping cues on one text track", () => {
    const next = importSubtitles(
      doc(),
      plan({ cues: cues([0, 1000], [2000, 3000], [4000, 5000]) }),
    );

    const tracks = new Set(textElements(next).map(([, e]) => e.trackId));
    expect(tracks.size).toBe(1);
    expect(next.tracks.filter((t) => t.kind === "text")).toHaveLength(1);
  });

  it("gives overlapping cues a track each, since a track holds no overlap", () => {
    // Both formats permit overlap, so a file can ask for it and the timeline has
    // to answer with two rows rather than dropping one.
    const next = importSubtitles(doc(), plan({ cues: cues([0, 5000], [1000, 2000]) }));

    expect(new Set(textElements(next).map(([, e]) => e.trackId)).size).toBe(2);
  });

  it("uses the ids it was handed and mints none of its own", () => {
    // `applyCaptionCommit` runs inside a transform an agent commit performs
    // twice, so an id minted in here would differ between the two runs.
    const next = importSubtitles(doc(), plan({ cues: cues([0, 1000], [2000, 3000]) }));

    expect(textElements(next).map(([id]) => id).sort()).toEqual([
      "caption1",
      "caption2",
    ]);
  });

  it("moves nothing that was already on the timeline", () => {
    // By value, not by reference: every op ends in `normalizeDocument`, and
    // `derivePriorities` spreads every element to restamp `priority`, so no op
    // in this codebase preserves an untouched element's identity.
    const d = doc();
    const next = importSubtitles(d, plan());

    expect(spanOf(next.elements.clip)).toEqual(spanOf(d.elements.clip));
    expect(next.elements.clip.trackId).toBe(d.elements.clip.trackId);
  });
});

describe("importSubtitles with one clip's source times", () => {
  // Trimmed five seconds in and running at half speed, so a naive import is
  // wrong in both directions and the two errors do not cancel.
  const retimed = () =>
    doc({
      startTime: 2000,
      trim: { startTime: 5000, endTime: 9000 },
      duration: 4000,
      speed: 0.5,
    });

  it("maps both edges through the clip, rather than scaling the duration", () => {
    const d = retimed();
    const next = importSubtitles(
      d,
      plan({ cues: cues([6000, 7000]), sourceKey: "clip" }),
    );

    // Checked against `geometry.ts` rather than against a literal: the point is
    // that the import agrees with the one module that owns this conversion.
    const source = d.elements.clip as never;
    const span = spanOf(textElements(next)[0][1]);
    expect(span.start).toBe(Math.round(timelineTimeAt(source, 6000)));
    expect(span.end).toBe(
      Math.round(timelineTimeAt(source, 6000)) +
        Math.round(timelineTimeAt(source, 7000) - timelineTimeAt(source, 6000)),
    );
  });

  it("lands somewhere a timeline-based import would not", () => {
    // Proves the case above measures something: without the clip the same cue
    // goes to 6000ms flat.
    const d = retimed();
    const viaClip = importSubtitles(
      d,
      plan({ cues: cues([6000, 7000]), sourceKey: "clip" }),
    );
    const viaTimeline = importSubtitles(d, plan({ cues: cues([6000, 7000]) }));

    expect(spanOf(textElements(viaClip)[0][1]).start).not.toBe(
      spanOf(textElements(viaTimeline)[0][1]).start,
    );
  });

  it("is a caller error to name a clip that is gone, and cannot be detected here", () => {
    // `applyCaptionCommit` guards with `sourceKey != null && !sources.has(key)`,
    // so a key that is listed but absent from `elements` passes the guard,
    // resolves to undefined and is quietly read as a timeline time. The
    // orchestrator resolves the element first and passes null; this pins why.
    const next = importSubtitles(
      doc(),
      plan({ cues: cues([6000, 7000]), sourceKey: "no-such-clip" }),
    );

    expect(spanOf(textElements(next)[0][1]).start).toBe(6000);
  });
});

describe("importSubtitles declines", () => {
  it("returns its input by identity when there are no cues", () => {
    // `withCheckpoint` reads identity as "nothing happened", which is what stops
    // an import of an empty file costing the user an undo press.
    const d = doc();

    expect(importSubtitles(d, plan({ cues: [], ids: [] }))).toBe(d);
  });
});
