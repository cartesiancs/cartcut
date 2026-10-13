import { describe, expect, it } from "vitest";
import type { ImageElementType } from "../../@types/timeline";
import { bakeRateFor, bakeTrack } from "../animation/keyframes";
import { rebakeAnimations } from "../animation/keyframeOps";
import { createNullElement } from "../element/nullElement";
import {
  audioElement,
  groupElement,
  imageElement,
  keys,
  mulberry32,
  transitionElement,
} from "../renderer/testing";
import { splitClip } from "../timeline/clipOps";
import { frameToMs, msToFrameCeil } from "../timeline/frames";
import { adoptIntoRig } from "../timeline/groupOps";
import { placeNewElement } from "../timeline/placement";
import {
  SCHEMA_VERSION,
  createTrack,
  normalizeDocument,
  type TimelineDocument,
} from "../timeline/tracks";
import {
  applyPoint,
  createMemo,
  localSampleAt,
  worldCornersOf,
  worldMatrixOf,
  type Point,
} from "../timeline/transform";
import {
  DEFAULT_MAX_STABILIZE_ZOOM,
  coverZoom,
  frameInstants,
  refusalMessage,
  stabilize,
  stabilizePairOf,
  stabilizeRefusal,
  zoomMessage,
  type Quad,
  type StabilizeParams,
  type StabilizeRefusal,
} from "./stabilizeOp";
import { createTrackNull } from "./trackNullOp";
import { deleteClips } from "../timeline/clipOps";
import { ingestDocument } from "../timeline/ingest";

const FRAME = { width: 1920, height: 1080 };
const T = { x: 960, y: 540 };

/** The tracked feature, in the footage's own pixels, at timeline `t`. */
const feature = (t: number): Point => ({
  x: 900 + 120 * Math.sin(t / 400),
  y: 500 + 60 * Math.cos(t / 310),
});

/** Project frame instants in `[from, to)`, exactly as the export samples. */
function instants(from: number, to: number, fps: number): number[] {
  const out: number[] = [];
  for (let k = msToFrameCeil(from, fps); frameToMs(k, fps) < to; k++) {
    out.push(frameToMs(k, fps));
  }
  return out;
}

function footage(over: Partial<ImageElementType> = {}): ImageElementType {
  return imageElement({
    key: "foot",
    trackId: "v1",
    location: { x: 0, y: 0 },
    width: 1920,
    height: 1080,
    startTime: 0,
    duration: 4000,
    ...over,
  });
}

function baseDoc(elements: Record<string, any> = { foot: footage() }): TimelineDocument {
  return normalizeDocument({
    schemaVersion: SCHEMA_VERSION,
    tracks: [createTrack("v1", "video", 0)],
    elements,
  } as any);
}

/**
 * A tracking null on `feature`, measured through the footage's own transform
 * as `toDisplayedPath` measures it: one sample per frame instant, unsimplified,
 * so the null's keyframes are the feature exactly.
 */
function withNull(
  doc: TimelineDocument,
  fps: number,
  options: { from?: number; to?: number; id?: string; shift?: Point } = {},
): TimelineDocument {
  const from = options.from ?? 0;
  const to = options.to ?? 4000;
  const shift = options.shift ?? { x: 0, y: 0 };
  const samples = instants(from, to, fps).map((tMs) => {
    const world = applyPoint(worldMatrixOf(doc.elements, "foot", tMs), feature(tMs));
    return { tMs, x: world.x + shift.x, y: world.y + shift.y };
  });
  return createTrackNull(doc, {
    samples,
    nullId: options.id ?? "trk",
    newTrackId: `g-${options.id ?? "trk"}`,
    endMs: to,
    bakeHz: bakeRateFor(fps),
  });
}

function params(fps: number, over: Partial<StabilizeParams> = {}): StabilizeParams {
  return {
    clipId: "foot",
    nullId: "trk",
    target: T,
    frame: FRAME,
    fps,
    autoZoom: true,
    zoomId: "zoom",
    cameraId: "cam",
    trackIds: { zoom: "g-zoom", camera: "g-cam" },
    ...over,
  };
}

/** Where the footage puts the feature on the canvas. */
function featureAt(doc: TimelineDocument, t: number, id = "foot"): Point {
  return applyPoint(worldMatrixOf(doc.elements, id, t, createMemo()), feature(t));
}

/** Where the null's centre is on the canvas: the lock's own statement. */
function nullCentreAt(doc: TimelineDocument, t: number, id = "trk"): Point {
  const element = doc.elements[id] as any;
  return applyPoint(worldMatrixOf(doc.elements, id, t, createMemo()), {
    x: element.width / 2,
    y: element.height / 2,
  });
}

const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

function stabilized(fps = 60, over: Partial<StabilizeParams> = {}, doc = withNull(baseDoc(), fps)) {
  const result = stabilize(doc, params(fps, over));
  expect(result.outcome.ok).toBe(true);
  return result;
}

describe("stabilize: the lock", () => {
  it.each([24, 30, 60, 120])("holds the feature on the target at every %ifps frame", (fps) => {
    const { doc } = stabilized(fps);

    const times = instants(0, 4000, fps);
    expect(times.length).toBe(4 * fps);
    for (const t of times) {
      expect(distance(featureAt(doc, t), T)).toBeLessThan(1e-9);
      expect(distance(nullCentreAt(doc, t), T)).toBeLessThan(1e-9);
    }
  });

  it("is a lock the footage really moves for (negative control)", () => {
    const before = withNull(baseDoc(), 60);
    const drift = Math.max(...instants(0, 4000, 60).map((t) => distance(featureAt(before, t), T)));
    expect(drift).toBeGreaterThan(100);
  });

  it("makes the camera exactly K minus the null at any cursor, inside and outside its bar", () => {
    const { doc } = stabilized(30, {}, withNull(baseDoc(), 30, { from: 1000, to: 3000 }));
    const camera = doc.elements.cam as any;
    const tracked = doc.elements.trk as any;
    const k = { x: 50 - tracked.width / 2, y: 50 - tracked.height / 2 };
    const random = mulberry32(7);

    for (let i = 0; i < 1000; i++) {
      const cursor = -500 + random() * 5000;
      const c = localSampleAt(camera, cursor);
      const n = localSampleAt(tracked, cursor);
      expect(c.x).toBe(k.x - n.x);
      expect(c.y).toBe(k.y - n.y);
    }
  });

  it("holds the first offset before a null that starts mid-clip and the last after it", () => {
    const { doc } = stabilized(30, {}, withNull(baseDoc(), 30, { from: 1000, to: 3000 }));
    const camera = doc.elements.cam as any;

    expect(localSampleAt(camera, 500)).toEqual(localSampleAt(camera, 1000));
    expect(localSampleAt(camera, 0)).toEqual(localSampleAt(camera, 1000));
    expect(localSampleAt(camera, 3900)).toEqual(localSampleAt(camera, frameToMs(89, 30)));
    for (const t of instants(1000, 3000, 30)) {
      expect(distance(featureAt(doc, t), T)).toBeLessThan(1e-9);
    }
  });

  it("holds through the footage's own position, scale, rotation and size tracks", () => {
    const px = keys([0, 0], [4000, -200]);
    const py = keys([0, 0], [4000, 50]);
    const sc = keys([0, 11], [4000, 13]);
    const rot = keys([0, 0], [4000, 8]);
    const sx = keys([0, 1920], [4000, 2100]);
    const sy = keys([0, 1080], [4000, 1200]);
    const moving = footage({
      animation: {
        ...footage().animation,
        position: { isActivate: true, x: px, y: py, ax: bakeTrack(px), ay: bakeTrack(py) },
        scale: { isActivate: true, x: sc, ax: bakeTrack(sc) },
        rotation: { isActivate: true, x: rot, ax: bakeTrack(rot) },
        size: { isActivate: true, x: sx, y: sy, ax: bakeTrack(sx), ay: bakeTrack(sy) },
      } as any,
    });
    const tracked = withNull(baseDoc({ foot: moving }), 60);
    const { doc } = stabilized(60, {}, tracked);

    const check = (d: TimelineDocument) => {
      for (const t of instants(0, 4000, 60)) {
        expect(distance(featureAt(d, t), T)).toBeLessThan(1e-8);
      }
    };
    check(doc);

    // A hand-set zoom and a rotation on the zoom group: the target is its
    // fixed point, so neither may move the feature.
    const zoom = doc.elements.zoom as any;
    check({ ...doc, elements: { ...doc.elements, zoom: { ...zoom, scale: 17, rotation: 15 } } });
  });
});

describe("stabilize: what it builds", () => {
  it("leaves the footage and the null exactly as they were, but for the parent", () => {
    const before = withNull(baseDoc(), 60);
    const { doc } = stabilized(60, {}, before);
    const strip = ({ parentId: _p, priority: _q, ...rest }: any) => rest;

    expect(doc.elements.foot.parentId).toBe("cam");
    expect(doc.elements.trk.parentId).toBe("cam");
    expect(strip(doc.elements.foot)).toEqual(strip(before.elements.foot));
    expect(strip(doc.elements.trk)).toEqual(strip(before.elements.trk));
  });

  it("puts the zoom at the root on the target and the camera inside it", () => {
    const { doc, outcome } = stabilized(60);
    const zoom = doc.elements.zoom as any;
    const camera = doc.elements.cam as any;

    expect(zoom.rig).toBe("stabilize-zoom");
    expect(zoom.parentId).toBeUndefined();
    expect(zoom.location.x + zoom.width / 2).toBe(T.x);
    expect(zoom.location.y + zoom.height / 2).toBe(T.y);
    expect(camera.rig).toBe("stabilize-camera");
    expect(camera.parentId).toBe("zoom");
    expect(camera.startTime).toBe(doc.elements.trk.startTime);
    expect(camera.duration).toBe(doc.elements.trk.duration);
    expect(camera.rotation).toBe(0);
    expect(camera.scale).toBeUndefined();
    expect(outcome).toMatchObject({ ok: true, zoomId: "zoom", cameraId: "cam" });
  });

  it("gives each new bar a row of its own", () => {
    const { doc } = stabilized(60);
    expect(doc.elements.zoom.trackId).toBe("g-zoom");
    expect(doc.elements.cam.trackId).toBe("g-cam");
    expect(doc.tracks.map((t) => t.id)).toEqual(
      expect.arrayContaining(["v1", "g-trk", "g-zoom", "g-cam"]),
    );
  });

  it("uses a free group row before adding one", () => {
    const tracked = withNull(baseDoc(), 60);
    const withFree = normalizeDocument({
      ...tracked,
      tracks: [...tracked.tracks, createTrack("free", "group", tracked.tracks.length)],
    });
    const { doc } = stabilized(60, {}, withFree);

    expect(doc.elements.zoom.trackId).toBe("free");
    expect(doc.elements.cam.trackId).toBe("g-cam");
  });
});

describe("stabilize: refusals return the document untouched", () => {
  const tracked = () => withNull(baseDoc(), 60);

  function expectRefused(
    doc: TimelineDocument,
    reason: StabilizeRefusal,
    over: Partial<StabilizeParams> = {},
  ) {
    const result = stabilize(doc, params(60, over));
    expect(result.doc).toBe(doc);
    expect(result.outcome).toEqual({ ok: false, reason });
    expect(refusalMessage(reason)).toMatch(/\S/);
  }

  it("missing-clip", () => expectRefused(tracked(), "missing-clip", { clipId: "nope" }));

  it("clip-not-visual", () => {
    expectRefused(tracked(), "clip-not-visual", { clipId: "trk", nullId: "trk" });
    const d = withNull(baseDoc({ foot: footage(), snd: audioElement({ trackId: "v1" }) }), 60);
    expectRefused(d, "clip-not-visual", { clipId: "snd" });
  });

  it("clip-parented", () => {
    const d = withNull(
      baseDoc({
        foot: footage({ parentId: "box" } as any),
        box: groupElement({ trackId: "gb", location: { x: 0, y: 0 } } as any),
      }),
      60,
    );
    expectRefused(d, "clip-parented");
  });

  it("missing-null", () => expectRefused(tracked(), "missing-null", { nullId: "nope" }));

  it("not-a-null", () => {
    expectRefused(tracked(), "not-a-null", { nullId: "foot" });
    const { doc } = stabilized(60);
    const other = withNull(
      { ...doc, elements: { ...doc.elements, foot2: footage({ key: "foot2", startTime: 5000 }) } },
      60,
    );
    expectRefused(other, "not-a-null", { clipId: "foot2", nullId: "zoom", zoomId: "z2", cameraId: "c2" });
  });

  it("null-not-tracked", () => {
    const d = placeNewElement(baseDoc(), "still", createNullElement({ center: T }), 0, "g-still");
    expectRefused(d, "null-not-tracked", { nullId: "still" });
  });

  it("null-linked", () => {
    const d = tracked();
    const linked = {
      ...d,
      elements: {
        ...d.elements,
        trk: {
          ...d.elements.trk,
          link: { position: { from: { elementId: "foot", property: "position" }, in: [0, 1], out: [0, 1] } },
        },
      },
    } as TimelineDocument;
    expectRefused(linked, "null-linked");
  });

  it("null-sized", () => {
    const d = tracked();
    const trk = d.elements.trk as any;
    const sized = {
      ...d,
      elements: {
        ...d.elements,
        trk: { ...trk, animation: { ...trk.animation, size: { ...trk.animation.size, isActivate: true } } },
      },
    } as TimelineDocument;
    expectRefused(sized, "null-sized");
  });

  it("null-parented", () => {
    const d = tracked();
    const boxed = normalizeDocument({
      ...d,
      elements: {
        ...d.elements,
        box: groupElement({ trackId: "gb", startTime: 0, duration: 4000 } as any),
        trk: { ...d.elements.trk, parentId: "box" } as any,
      },
    });
    expectRefused(boxed, "null-parented");

    // A rigged clip takes only a null already in its camera.
    const { doc } = stabilized(60);
    const second = withNull(doc, 60, { id: "root2", shift: { x: 3, y: 0 } });
    expectRefused(second, "null-parented", { nullId: "root2" });
  });

  it("depth", () => {
    // Seven groups below the null: 2 + 7 is past the cap of 8; six is not.
    const chain = (n: number) => {
      const d = tracked();
      const extra: Record<string, any> = {};
      let parent = "trk";
      for (let i = 0; i < n; i++) {
        extra[`n${i}`] = groupElement({ trackId: `gn${i}`, parentId: parent } as any);
        parent = `n${i}`;
      }
      return normalizeDocument({ ...d, elements: { ...d.elements, ...extra } });
    };
    expectRefused(chain(7), "depth");
    expect(stabilize(chain(6), params(60)).outcome.ok).toBe(true);
  });

  it("bad-target and bad-ids", () => {
    expectRefused(tracked(), "bad-target", { target: { x: Number.NaN, y: 0 } });
    expectRefused(tracked(), "bad-ids", { zoomId: "same", cameraId: "same" });
    expectRefused(tracked(), "bad-ids", { zoomId: "foot" });
    expectRefused(tracked(), "bad-ids", { cameraId: "" });
  });

  it("answers the same structural refusals without building anything", () => {
    const d = tracked();
    expect(stabilizeRefusal(d, "foot", "trk")).toBeNull();
    expect(stabilizeRefusal(d, "foot", "foot")).toBe("not-a-null");
    expect(stabilizeRefusal(d, "nope", "trk")).toBe("missing-clip");
  });
});

describe("stabilize: re-run", () => {
  it("re-aims the rig it is already in, changing nothing when nothing changed", () => {
    const first = stabilized(60).doc;
    const again = stabilize(first, params(60, { zoomId: "other", cameraId: "other2" }));

    expect(again.outcome).toMatchObject({ ok: true, zoomId: "zoom", cameraId: "cam" });
    expect(again.doc.elements).toEqual(first.elements);
    expect(again.doc.tracks).toEqual(first.tracks);
  });

  it("keeps a moved target and the zoom's rotation, and follows a new null", () => {
    const first = stabilized(60).doc;
    const zoom = first.elements.zoom as any;
    const moved = {
      ...first,
      elements: {
        ...first.elements,
        zoom: { ...zoom, location: { x: zoom.location.x + 100, y: zoom.location.y - 50 }, rotation: 15 },
      },
    } as TimelineDocument;

    // A second null adopted into the camera, as Create Null on a rigged clip
    // does. Whatever path it holds, the re-aimed camera holds its centre on
    // the moved target.
    const second = adoptIntoRig(
      withNull(moved, 60, { id: "trk2", shift: { x: 3, y: 0 } }),
      "cam",
      ["trk2"],
    );
    const result = stabilize(second, params(60, { nullId: "trk2" }));
    expect(result.outcome.ok).toBe(true);

    const target = { x: T.x + 100, y: T.y - 50 };
    const after = result.doc.elements.zoom as any;
    expect(after.rotation).toBe(15);
    expect(after.location).toEqual({ x: zoom.location.x + 100, y: zoom.location.y - 50 });
    for (const t of instants(0, 4000, 60)) {
      expect(distance(nullCentreAt(result.doc, t, "trk2"), target)).toBeLessThan(1e-9);
    }
  });

  it("keeps a hand-set zoom when auto-zoom is off", () => {
    const first = stabilized(60).doc;
    const set = {
      ...first,
      elements: { ...first.elements, zoom: { ...first.elements.zoom, scale: 17 } as any },
    } as TimelineDocument;
    const result = stabilize(set, params(60, { autoZoom: false }));

    expect((result.doc.elements.zoom as any).scale).toBe(17);
    expect(result.outcome).toMatchObject({ ok: true, zoom: 1.7, zoomSkipped: "off" });
  });

  it("moves a bar whose new span collides on its row, keeping the parents", () => {
    const first = stabilized(60, {}, withNull(baseDoc(), 60, { from: 0, to: 2000 })).doc;
    // Something else on the camera's row, after the camera's current bar.
    const blocker = groupElement({ key: "blk", trackId: "g-cam", startTime: 2500, duration: 1000 } as any);
    const blocked = normalizeDocument({ ...first, elements: { ...first.elements, blk: blocker } });
    // A longer null, adopted, that the camera now has to span.
    const longer = adoptIntoRig(withNull(blocked, 60, { id: "long", from: 0, to: 4000 }), "cam", ["long"]);
    const result = stabilize(longer, params(60, { nullId: "long", trackIds: { zoom: "g-z2", camera: "g-c2" } }));

    expect(result.outcome.ok).toBe(true);
    const camera = result.doc.elements.cam as any;
    expect(camera.trackId).toBe("g-c2");
    expect(camera.parentId).toBe("zoom");
    expect(result.doc.elements.foot.parentId).toBe("cam");
    expect(result.doc.elements.trk.parentId).toBe("cam");
  });
});

describe("stabilize: frame-rate changes, splits", () => {
  it("stays locked after the project is re-baked at 120fps", () => {
    const { doc } = stabilized(60);
    const rebaked = rebakeAnimations(doc, bakeRateFor(120));

    expect(rebaked).not.toBe(doc);
    for (const t of instants(0, 4000, 120)) {
      expect(distance(nullCentreAt(rebaked, t), T)).toBeLessThan(1e-9);
    }
  });

  it("keeps both halves of a split clip in the camera, locked", () => {
    const { doc } = stabilized(60);
    const split = splitClip(doc, "foot", 2000, "foot2");

    expect(split.elements.foot.parentId).toBe("cam");
    expect(split.elements.foot2.parentId).toBe("cam");
    for (const t of instants(0, 2000, 60)) {
      expect(distance(featureAt(split, t, "foot"), T)).toBeLessThan(1e-9);
    }
    for (const t of instants(2000, 4000, 60)) {
      expect(distance(featureAt(split, t, "foot2"), T)).toBeLessThan(1e-9);
    }

    // A re-run measures the zoom over both pieces and comes to the same one.
    const again = stabilize(split, params(60));
    expect((again.doc.elements.zoom as any).scale).toBe((doc.elements.zoom as any).scale);
  });
});

describe("stabilize: the zoom", () => {
  it("is the closed form for footage that only translates", () => {
    const { doc, outcome } = stabilized(60);
    let dx = 0;
    let dy = 0;
    for (const t of instants(0, 4000, 60)) {
      const f = feature(t);
      dx = Math.max(dx, Math.abs(T.x - f.x));
      dy = Math.max(dy, Math.abs(T.y - f.y));
    }
    const expected = Math.max((960 + 1) / (960 - dx), (540 + 1) / (540 - dy));

    expect(outcome).toMatchObject({ ok: true, covered: true });
    expect((outcome as any).zoom).toBeCloseTo(expected, 12);
    expect((doc.elements.zoom as any).scale).toBeCloseTo(expected * 10, 11);
  });

  it("covers every frame corner, and a hair less zoom does not", () => {
    const { doc, outcome } = stabilized(60);
    const zoom = (outcome as any).zoom as number;
    const corners: Point[] = [
      { x: -1, y: -1 },
      { x: 1921, y: -1 },
      { x: 1921, y: 1081 },
      { x: -1, y: 1081 },
    ];
    const inside = (quad: Quad, p: Point) =>
      quad.every((a, i) => {
        const b = quad[(i + 1) % 4];
        return (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x) >= -1e-6;
      });

    const at = (scale: number) => {
      const d = { ...doc, elements: { ...doc.elements, zoom: { ...doc.elements.zoom, scale: scale * 10 } as any } };
      return instants(0, 4000, 60).every((t) =>
        corners.every((c) => inside(worldCornersOf(d.elements, "foot", t, createMemo()), c)),
      );
    };
    expect(at(zoom)).toBe(true);
    expect(at(zoom * (1 - 1e-4))).toBe(false);
  });

  it("skips footage that never filled the frame", () => {
    const small = withNull(baseDoc({ foot: footage({ width: 1280, height: 720 }) }), 60);
    const { doc, outcome } = stabilized(60, {}, small);

    expect(outcome).toMatchObject({ ok: true, zoom: 1, covered: false, zoomSkipped: "not-full-frame" });
    expect("scale" in (doc.elements.zoom as any)).toBe(false);
    expect(zoomMessage(outcome)).toMatch(/does not fill/);
  });

  it("counts footage exactly the frame's size as filling it", () => {
    expect(stabilized(60).outcome).not.toHaveProperty("zoomSkipped");
  });

  it("caps the zoom and says so", () => {
    const far = (t: number) => ({ x: 960 + 700 * Math.sin(t / 300), y: 540 });
    const d = baseDoc();
    const samples = instants(0, 4000, 60).map((tMs) => ({ tMs, ...far(tMs) }));
    const tracked = createTrackNull(d, { samples, nullId: "trk", newTrackId: "g-trk", endMs: 4000, bakeHz: 60 });
    const { outcome } = stabilized(60, {}, tracked);

    expect(outcome).toMatchObject({ ok: true, zoom: DEFAULT_MAX_STABILIZE_ZOOM, covered: false });
    expect((outcome as any).zoomNeeded).toBeGreaterThan(3);
    expect(zoomMessage(outcome)).toMatch(/past the 200% limit/);
  });

  it("is silent when every edge is covered", () => {
    expect(zoomMessage(stabilized(60).outcome)).toBeNull();
  });
});

describe("coverZoom", () => {
  const W = 1920;
  const H = 1080;
  const rect = (dx: number, dy: number): Quad => [
    { x: dx, y: dy },
    { x: W + dx, y: dy },
    { x: W + dx, y: H + dy },
    { x: dx, y: H + dy },
  ];

  it("solves translated footage in closed form", () => {
    const offsets: Array<[number, number]> = [[0, 0], [120, -40], [-300, 10], [50, 200]];
    const solved = coverZoom(offsets.map(([x, y]) => rect(x, y)), FRAME, T, 4);
    const expected = Math.max(
      ...offsets.map(([x, y]) => Math.max((960 + 1) / (960 - Math.abs(x)), (540 + 1) / (540 - Math.abs(y)))),
    );

    expect(solved.zoom).toBeCloseTo(expected, 12);
    expect(solved.covered).toBe(true);
    expect(solved.outside).toBe(0);
  });

  it("agrees with a brute-force search on rotated, scaled footage", () => {
    const rotated = (deg: number, s: number, shift: Point): Quad => {
      const r = (deg * Math.PI) / 180;
      return rect(0, 0).map((p) => {
        const x = (p.x - T.x) * s;
        const y = (p.y - T.y) * s;
        return {
          x: T.x + x * Math.cos(r) - y * Math.sin(r) + shift.x,
          y: T.y + x * Math.sin(r) + y * Math.cos(r) + shift.y,
        };
      }) as Quad;
    };
    const quads = [rotated(5, 1.3, { x: 40, y: -20 }), rotated(-3, 1.1, { x: -10, y: 30 })];
    const solved = coverZoom(quads, FRAME, T, 4);

    const covers = (s: number) =>
      quads.every((quad) =>
        [
          { x: -1, y: -1 },
          { x: W + 1, y: -1 },
          { x: W + 1, y: H + 1 },
          { x: -1, y: H + 1 },
        ].every((c) => {
          const p = { x: T.x + (c.x - T.x) / s, y: T.y + (c.y - T.y) / s };
          return quad.every((a, i) => {
            const b = quad[(i + 1) % 4];
            return (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x) >= 0;
          });
        }),
      );
    let s = 1;
    while (!covers(s)) {
      s += 1e-5;
    }

    expect(Math.abs(solved.zoom - s)).toBeLessThan(2e-5);
  });

  it("caps, and reports what covering would have taken", () => {
    const solved = coverZoom([rect(678, 0)], FRAME, T, 2);
    expect(solved.zoom).toBe(2);
    expect(solved.covered).toBe(false);
    expect(solved.zoomNeeded).toBeCloseTo(961 / 282, 9);
  });

  it("counts footage the target is off, without dragging the zoom to the cap", () => {
    const solved = coverZoom([rect(0, 0), rect(1500, 0)], FRAME, T, 2);
    expect(solved.outside).toBe(1);
    expect(solved.covered).toBe(false);
    expect(solved.zoom).toBeCloseTo(Math.max(961 / 960, 541 / 540), 12);
  });
});

describe("frameInstants", () => {
  it("includes the instants a transition holds a clip past its own end", () => {
    const d = baseDoc({
      foot: footage(),
      next: footage({ key: "next", startTime: 4000 }),
      tr: transitionElement({ trackId: "v1", fromId: "foot", toId: "next", startTime: 3600, duration: 800 }),
    });
    const times = frameInstants(d.elements, "foot", 60);

    expect(times[0]).toBe(0);
    expect(times[times.length - 1]).toBe(frameToMs(263, 60));
    expect(times.filter((t) => t >= 4000).length).toBe(24);
  });
});

describe("stabilize: the file and taking it apart", () => {
  it("survives a save and a load, which re-bakes everything, still locked", () => {
    const { doc } = stabilized(60);
    const loaded = ingestDocument(JSON.parse(JSON.stringify(doc)), bakeRateFor(60));

    expect((loaded.elements.zoom as any).rig).toBe("stabilize-zoom");
    expect((loaded.elements.cam as any).rig).toBe("stabilize-camera");
    for (const t of instants(0, 4000, 60)) {
      expect(distance(nullCentreAt(loaded, t), T)).toBeLessThan(1e-9);
      expect(distance(featureAt(loaded, t), T)).toBeLessThan(1e-9);
    }
  });

  it("gives back exactly what it was given when the Stabilize bar is deleted", () => {
    const before = withNull(baseDoc(), 60);
    const { doc } = stabilized(60, {}, before);
    const after = deleteClips(doc, ["zoom"]);
    const strip = ({ priority: _p, ...rest }: any) => rest;

    expect(Object.keys(after.elements).sort()).toEqual(Object.keys(before.elements).sort());
    for (const id of Object.keys(before.elements)) {
      expect(strip(after.elements[id])).toEqual(strip(before.elements[id]));
    }
    for (const t of instants(0, 4000, 60)) {
      expect(featureAt(after, t)).toEqual(featureAt(before, t));
    }
  });
});

describe("stabilizePairOf", () => {
  it("is the clip and the null, in either order, when stabilizing would go ahead", () => {
    const d = withNull(baseDoc(), 60);
    expect(stabilizePairOf(d, ["foot", "trk"])).toEqual({ clipId: "foot", nullId: "trk" });
    expect(stabilizePairOf(d, ["trk", "foot"])).toEqual({ clipId: "foot", nullId: "trk" });
  });

  it("is nothing for any other selection", () => {
    const d = withNull(baseDoc(), 60);
    expect(stabilizePairOf(d, ["foot"])).toBeNull();
    expect(stabilizePairOf(d, ["foot", "trk", "foot"])).toEqual({ clipId: "foot", nullId: "trk" });
    expect(stabilizePairOf(d, ["foot", "nope"])).toBeNull();
    const still = placeNewElement(d, "still", createNullElement({ center: T }), 0, "g-still");
    expect(stabilizePairOf(still, ["foot", "still"])).toBeNull();
    expect(stabilizePairOf(still, ["trk", "still"])).toBeNull();
    // A rig group is not a null to stabilize on.
    const { doc } = stabilized(60);
    expect(stabilizePairOf(doc, ["foot", "zoom"])).toBeNull();
  });
});
