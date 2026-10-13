import { describe, expect, it } from "vitest";
import { groupElement, videoElement } from "../renderer/testing";
import { frameToMs } from "../timeline/frames";
import { rigOf } from "../timeline/rig";
import {
  SCHEMA_VERSION,
  createTrack,
  normalizeDocument,
  type TimelineDocument,
} from "../timeline/tracks";
import { applyPoint, createMemo, worldMatrixOf } from "../timeline/transform";
import { stabilize } from "./stabilizeOp";
import { createNullFromTrack, seatRun, stabilizeFromTrack, type TrackedClip } from "./trackEdits";
import type { TrackSample } from "./tracker";
import { toDisplayedPath } from "./trackToTimeline";

const W = 192;
const H = 108;

/** 30fps footage, every frame tracked, a feature on a curve in working px. */
function samples(): TrackSample[] {
  return Array.from({ length: 120 }, (_, j) => ({
    sourceMs: (j * 1000) / 30,
    x: 96 + 20 * Math.sin(j * 0.13),
    y: 54 + 9 * Math.cos(j * 0.11),
    confidence: 1,
  }));
}

function tracked(over: Partial<TrackedClip> = {}): TrackedClip {
  return {
    clipId: "foot",
    samples: samples(),
    frameWidth: W,
    frameHeight: H,
    sourceFrameMs: 1000 / 30,
    fps: 60,
    ...over,
  };
}

function baseDoc(extra: Record<string, any> = {}): TimelineDocument {
  return normalizeDocument({
    schemaVersion: SCHEMA_VERSION,
    tracks: [createTrack("v1", "video", 0)],
    elements: {
      foot: videoElement({ key: "foot", trackId: "v1", width: 1920, height: 1080 }),
      ...extra,
    },
  } as any);
}

const stabilizeParams = {
  target: { x: 960, y: 540 },
  frame: { width: 1920, height: 1080 },
  autoZoom: true,
  zoomId: "zoom",
  cameraId: "cam",
  trackIds: { zoom: "g-zoom", camera: "g-cam" },
};

const centre = (doc: TimelineDocument, id: string, t: number) => {
  const element = doc.elements[id] as any;
  return applyPoint(worldMatrixOf(doc.elements, id, t, createMemo()), {
    x: element.width / 2,
    y: element.height / 2,
  });
};

describe("createNullFromTrack", () => {
  it("places a null on the frame the picture shows, frame by frame", () => {
    const doc = createNullFromTrack(baseDoc(), tracked(), { nullId: "n1", trackId: "g1" });
    const path = toDisplayedPath(samples(), {
      elements: baseDoc().elements,
      clipId: "foot",
      frameWidth: W,
      frameHeight: H,
      fps: 60,
      sourceFrameMs: 1000 / 30,
    });

    expect(doc.elements.n1).toBeDefined();
    expect(path.length).toBe(240);
    // Within the thinning's half pixel of every displayed sample.
    for (const point of path) {
      const at = centre(doc, "n1", point.tMs);
      expect(Math.hypot(at.x - point.x, at.y - point.y)).toBeLessThanOrEqual(0.5 + 1e-9);
    }
  });

  it("measures a stabilized clip without its camera, and puts the null in the camera", () => {
    const first = createNullFromTrack(baseDoc(), tracked(), { nullId: "n1", trackId: "g1" });
    const rigged = stabilize(first, { ...stabilizeParams, clipId: "foot", nullId: "n1", fps: 60 }).doc;
    const again = createNullFromTrack(rigged, tracked(), { nullId: "n2", trackId: "g2" });

    expect(again.elements.n2.parentId).toBe("cam");
    expect((again.elements.n2 as any).animation.position).toEqual(
      (first.elements.n1 as any).animation.position,
    );
    expect(again.elements.n2.location).toEqual(first.elements.n1.location);
    // Every frame of it sits on the target, as the first null's does.
    for (let k = 0; k < 239; k++) {
      const at = centre(again, "n2", frameToMs(k, 60));
      expect(Math.hypot(at.x - 960, at.y - 540)).toBeLessThan(1e-9);
    }
  });

  it("would have read the stabilized picture through the live map (negative control)", () => {
    const first = createNullFromTrack(baseDoc(), tracked(), { nullId: "n1", trackId: "g1" });
    const rigged = stabilize(first, { ...stabilizeParams, clipId: "foot", nullId: "n1", fps: 60 }).doc;
    const live = toDisplayedPath(samples(), {
      elements: rigged.elements,
      clipId: "foot",
      frameWidth: W,
      frameHeight: H,
      fps: 60,
      sourceFrameMs: 1000 / 30,
    });
    // Through the camera the feature barely moves: only the thinning's half
    // pixel is left, magnified by the zoom. Without it, it crosses the frame.
    const zoom = ((rigged.elements.zoom as any).scale ?? 10) / 10;
    const spread = Math.max(...live.map((p) => Math.hypot(p.x - 960, p.y - 540)));
    expect(spread).toBeLessThanOrEqual(0.5 * zoom + 1e-9);
    const pre = toDisplayedPath(samples(), {
      elements: baseDoc().elements,
      clipId: "foot",
      frameWidth: W,
      frameHeight: H,
      fps: 60,
      sourceFrameMs: 1000 / 30,
    });
    expect(Math.max(...pre.map((p) => Math.hypot(p.x - 960, p.y - 540)))).toBeGreaterThan(50);
  });

  it("declines by identity when there is no clip or nothing to place", () => {
    const d = baseDoc();
    expect(createNullFromTrack(d, tracked({ clipId: "nope" }), { nullId: "n", trackId: "g" })).toBe(d);
    expect(createNullFromTrack(d, tracked({ samples: [] }), { nullId: "n", trackId: "g" })).toBe(d);
  });
});

describe("stabilizeFromTrack", () => {
  const ids = (reuseNullId: string | null = null) => ({ reuseNullId, nullId: "fresh", nullTrackId: "g-fresh" });

  it("makes the null and the rig in one go", () => {
    const result = stabilizeFromTrack(baseDoc(), tracked(), ids(), stabilizeParams);

    expect(result.outcome.ok).toBe(true);
    expect(result.nullId).toBe("fresh");
    expect(rigOf(result.doc.elements, "fresh")).toEqual({ zoomId: "zoom", cameraId: "cam" });
  });

  it("gives the null, the zoom and the camera a row each", () => {
    const result = stabilizeFromTrack(baseDoc(), tracked(), ids(), stabilizeParams);
    const rows = ["fresh", "zoom", "cam"].map((id) => result.doc.elements[id].trackId);

    expect(new Set(rows).size).toBe(3);
    expect(rows).toEqual(["g-fresh", "g-zoom", "g-cam"]);
    for (const row of rows) {
      expect(result.doc.tracks.some((track) => track.id === row)).toBe(true);
    }
  });

  it("reuses the null Create Null made, rather than leaving two", () => {
    const made = createNullFromTrack(baseDoc(), tracked(), { nullId: "n1", trackId: "g1" });
    const result = stabilizeFromTrack(made, tracked(), ids("n1"), stabilizeParams);

    expect(result.nullId).toBe("n1");
    expect(result.doc.elements.fresh).toBeUndefined();
    expect(result.doc.elements.n1.parentId).toBe("cam");
  });

  it("makes a new null when the remembered one is gone", () => {
    const result = stabilizeFromTrack(baseDoc(), tracked(), ids("deleted"), stabilizeParams);
    expect(result.nullId).toBe("fresh");
    expect(result.outcome.ok).toBe(true);
  });

  it("takes nothing at all when it refuses, the new null included", () => {
    const boxed = baseDoc({
      box: groupElement({ key: "box", trackId: "gb" } as any),
    });
    const inBox = normalizeDocument({
      ...boxed,
      elements: { ...boxed.elements, foot: { ...boxed.elements.foot, parentId: "box" } as any },
    });
    const result = stabilizeFromTrack(inBox, tracked(), ids(), stabilizeParams);

    expect(result.doc).toBe(inBox);
    expect(result.outcome).toEqual({ ok: false, reason: "clip-parented" });
    expect(result.nullId).toBeNull();
  });
});

describe("seatRun", () => {
  const at = (sourceMs: number, x = 0): TrackSample => ({ sourceMs, x, y: 0, confidence: 1 });
  const frame = 1000 / 24;

  it("moves the seed onto the frame its seek showed and drops the old sample for it", () => {
    const kept = [at(0, 1), at(frame, 2), at(16 * frame, 3)];
    const run = [at(700, 9), at(17 * frame, 10)];
    const joined = seatRun(kept, run, 700, [17 * frame, 18 * frame], frame);

    expect(joined.map((s) => s.sourceMs)).toEqual([0, frame, 16 * frame, 17 * frame].map((v, i) =>
      i === 2 ? expect.closeTo(16 * frame, 9) : v,
    ));
    expect(joined.map((s) => s.x)).toEqual([1, 2, 9, 10]);
  });

  it("changes nothing it does not have to", () => {
    const kept = [at(0, 1)];
    const run = [at(700, 9)];
    expect(seatRun(kept, [], 700, [], null)).toBe(kept);
    // No arrivals and no frame: the seek stands, and kept is passed through.
    expect(seatRun(kept, run, 700, [], null)).toEqual([at(0, 1), at(700, 9)]);
  });
});
