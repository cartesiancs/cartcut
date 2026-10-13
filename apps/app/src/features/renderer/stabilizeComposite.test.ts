/**
 * Stabilize, through the compositor every picture goes through.
 *
 * `stabilizeOp.test.ts` proves the lock with matrices. This proves it with
 * pixels: the real `renderTimelineAtTime` and the real image renderer draw a
 * shaking picture with a red dot on it, stabilized on a null that follows the
 * dot, and the dot's centroid is measured in the frame that comes out. The
 * preview, the in-app export and the offscreen export all call this one
 * function, so this is what reaches the file.
 *
 * Two negative controls keep it honest: without the rig the dot wanders, and
 * without the zoom the frame's edge shows.
 */

import { describe, expect, it, vi } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import type { Timeline } from "../../@types/timeline";
import { bakeTrack } from "../animation/keyframes";
import { frameToMs } from "../timeline/frames";
import {
  SCHEMA_VERSION,
  createTrack,
  normalizeDocument,
  type TimelineDocument,
} from "../timeline/tracks";
import { applyPoint, worldMatrixOf } from "../timeline/transform";
import { stabilize } from "../track/stabilizeOp";
import { createTrackNull } from "../track/trackNullOp";
import { imageElement, keys } from "./testing";

const W = 160;
const H = 90;
const FPS = 30;
const TARGET = { x: 80, y: 45 };
/**
 * The picture is bigger than the frame and placed over it, as handheld
 * footage effectively is: however it shakes, the frame stays covered before
 * stabilizing, so covering it after is the zoom's job.
 */
const PW = 200;
const PH = 130;
const ORIGIN = { x: -20, y: -20 };
/**
 * Where the dot is in the picture's own pixels: (40, 25) on the frame at rest,
 * well left of the centre. Holding it on the centre slides the picture right
 * by 40px, uncovering the frame's left edge, so the zoom has real work to do.
 */
const DOT = { x: 60, y: 45 };
const BACKGROUND = "#101020";

/** A flat grey picture with a red dot on it. */
function picture() {
  const canvas = createCanvas(PW, PH);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#808080";
  ctx.fillRect(0, 0, PW, PH);
  ctx.fillStyle = "#ff0000";
  ctx.beginPath();
  ctx.arc(DOT.x, DOT.y, 3, 0, Math.PI * 2);
  ctx.fill();
  return canvas;
}

const store = { getImage: () => picture() };
vi.mock("../asset/loadedAssetStore", () => ({
  loadedAssetStore: { getState: () => store },
}));

const { renderTimelineAtTime } = await import("./timeline");
const { renderImage } = await import("./image");

const renderers = {
  image: renderImage,
  shape: () => {},
  video: () => {},
  gif: () => {},
  text: () => {},
} as unknown as Parameters<typeof renderTimelineAtTime>[3];

const instants = Array.from({ length: 60 }, (_, k) => frameToMs(k, FPS));

/** The footage, shaken by its own position track, one key per frame. */
function shaken(): TimelineDocument {
  const xs = keys(...instants.map((t): [number, number] => [t, ORIGIN.x + 12 * Math.sin(t / 150)]));
  const ys = keys(...instants.map((t): [number, number] => [t, ORIGIN.y + 7 * Math.cos(t / 110)]));
  return normalizeDocument({
    schemaVersion: SCHEMA_VERSION,
    tracks: [createTrack("v1", "video", 0)],
    elements: {
      foot: imageElement({
        key: "foot",
        trackId: "v1",
        location: { ...ORIGIN },
        width: PW,
        height: PH,
        startTime: 0,
        duration: 2000,
        animation: {
          ...imageElement().animation,
          position: { isActivate: true, x: xs, y: ys, ax: bakeTrack(xs), ay: bakeTrack(ys) },
        } as any,
      }),
    },
  } as any);
}

/** A null on the dot, as a perfect tracker would place it. */
function tracked(): TimelineDocument {
  const doc = shaken();
  const samples = instants.map((tMs) => ({
    tMs,
    ...applyPoint(worldMatrixOf(doc.elements, "foot", tMs), DOT),
  }));
  return createTrackNull(doc, {
    samples,
    nullId: "trk",
    newTrackId: "g-trk",
    endMs: 2000,
    bakeHz: 60,
  });
}

function stabilized(autoZoom = true): TimelineDocument {
  const result = stabilize(tracked(), {
    clipId: "foot",
    nullId: "trk",
    target: TARGET,
    frame: { width: W, height: H },
    fps: FPS,
    autoZoom,
    zoomId: "zoom",
    cameraId: "cam",
    trackIds: { zoom: "g-zoom", camera: "g-cam" },
  });
  expect(result.outcome).toMatchObject(
    autoZoom ? { ok: true, covered: true } : { ok: true, zoomSkipped: "off" },
  );
  return result.doc;
}

function frame(elements: Timeline, t: number): Uint8ClampedArray {
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d") as unknown as CanvasRenderingContext2D;
  renderTimelineAtTime(ctx, elements, t, renderers, BACKGROUND, W, H);
  return canvas.getContext("2d").getImageData(0, 0, W, H).data as unknown as Uint8ClampedArray;
}

/** The red dot's centre, weighted by how red each pixel is over the grey. */
function redCentroid(data: Uint8ClampedArray): { x: number; y: number } {
  let sum = 0;
  let sx = 0;
  let sy = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const redness = data[i] - (data[i + 1] + data[i + 2]) / 2;
      if (redness > 20) {
        sum += redness;
        sx += redness * (x + 0.5);
        sy += redness * (y + 0.5);
      }
    }
  }
  expect(sum).toBeGreaterThan(0);
  return { x: sx / sum, y: sy / sum };
}

/** Whether pixel `x, y` is the background showing through. */
function isBackground(data: Uint8ClampedArray, x: number, y: number): boolean {
  const i = (y * W + x) * 4;
  return data[i] === 16 && data[i + 1] === 16 && data[i + 2] === 32;
}

const CORNERS: Array<[number, number]> = [
  [0, 0],
  [W - 1, 0],
  [0, H - 1],
  [W - 1, H - 1],
];

describe("a stabilized picture, composited", () => {
  it("holds the dot on the centre of every frame and covers every corner", () => {
    const doc = stabilized();
    expect((doc.elements.zoom as any).scale).toBeGreaterThan(12);
    for (const t of instants) {
      const data = frame(doc.elements, t);
      const dot = redCentroid(data);
      expect(Math.hypot(dot.x - TARGET.x, dot.y - TARGET.y), `t=${t}`).toBeLessThan(0.5);
      for (const [x, y] of CORNERS) {
        expect(isBackground(data, x, y), `t=${t} corner ${x},${y}`).toBe(false);
      }
    }
  });

  it("wanders without the rig (negative control)", () => {
    const doc = tracked();
    const drift = Math.max(
      ...instants.map((t) => {
        const dot = redCentroid(frame(doc.elements, t));
        return Math.hypot(dot.x - TARGET.x, dot.y - TARGET.y);
      }),
    );
    expect(drift).toBeGreaterThan(10);
  });

  it("shows the edge without the zoom (negative control)", () => {
    const doc = stabilized(false);
    const exposed = instants.some((t) => {
      const data = frame(doc.elements, t);
      return CORNERS.some(([x, y]) => isBackground(data, x, y));
    });
    expect(exposed).toBe(true);
    // And the lock does not depend on the zoom.
    const dot = redCentroid(frame(doc.elements, instants[17]));
    expect(Math.hypot(dot.x - TARGET.x, dot.y - TARGET.y)).toBeLessThan(0.5);
  });
});
