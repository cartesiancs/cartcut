/**
 * Stabilize, from pixels to the lock: the real tracker on synthetic frames,
 * then everything the panel's Stabilize button does to the document.
 *
 * The other suites hand the op a perfect null. This one lets the tracker find
 * the feature in a moving texture, so the error that reaches the frame is the
 * whole chain's: the tracker's own, the thinning's half pixel, both magnified
 * by the zoom. It is compared against where the texture really put the
 * feature, which no part of the chain is told.
 */

import { describe, expect, it } from "vitest";
import { videoElement } from "../renderer/testing";
import { frameToMs } from "../timeline/frames";
import {
  SCHEMA_VERSION,
  createTrack,
  normalizeDocument,
} from "../timeline/tracks";
import { applyPoint, createMemo, worldMatrixOf } from "../timeline/transform";
import { makeTexture, shift } from "./testFixtures";
import { stabilizeFromTrack } from "./trackEdits";
import { trackSequence, type TrackFrame } from "./tracker";

const W = 320;
const H = 240;
const FPS = 30;
const COUNT = 60;
const SEED = { x: 160, y: 120 };
const TARGET = { x: 160, y: 120 };

/** How far the texture has moved at source frame `j`: a wandering shake. */
const motion = (j: number) => ({
  x: 25 * Math.sin(j * 0.2),
  y: 15 * Math.cos(j * 0.17) - 15,
});

/** Where the seeded feature really is in frame `j`, in the clip's own pixels. */
const truth = (j: number) => ({ x: SEED.x + motion(j).x, y: SEED.y + motion(j).y });

function frames(): TrackFrame[] {
  const base = makeTexture(W, H, 5);
  return Array.from({ length: COUNT }, (_, j) => ({
    sourceMs: (j * 1000) / FPS,
    image: shift(base, motion(j).x, motion(j).y),
  }));
}

function footage() {
  return normalizeDocument({
    schemaVersion: SCHEMA_VERSION,
    tracks: [createTrack("v1", "video", 0)],
    elements: {
      foot: videoElement({
        key: "foot",
        trackId: "v1",
        width: W,
        height: H,
        duration: 2000,
        trim: { startTime: 0, endTime: 2000 },
      }),
    },
  } as any);
}

describe("stabilize from a real track", () => {
  const state = trackSequence(frames(), SEED);
  const tracked = {
    clipId: "foot",
    samples: state.samples,
    frameWidth: W,
    frameHeight: H,
    sourceFrameMs: 1000 / FPS,
    fps: FPS,
  };

  it("tracks the whole run", () => {
    expect(state.status).toBe("completed");
    expect(state.samples).toHaveLength(COUNT);
  });

  it("lands the true feature on the target, within the chain's own error, on every frame", () => {
    const result = stabilizeFromTrack(
      footage(),
      tracked,
      { reuseNullId: null, nullId: "trk", nullTrackId: "g-trk" },
      {
        target: TARGET,
        frame: { width: W, height: H },
        autoZoom: true,
        zoomId: "zoom",
        cameraId: "cam",
        trackIds: { zoom: "g-zoom", camera: "g-cam" },
      },
    );
    expect(result.outcome).toMatchObject({ ok: true, covered: true });
    const zoom = (result.outcome as any).zoom as number;
    expect(zoom).toBeGreaterThan(1.2);

    // The tracker's bound on this kind of pan (`tracker.test.ts`), plus the
    // thinning's half pixel, both scaled by the zoom.
    const bound = (0.45 + 0.5) * zoom;
    let worst = 0;
    for (let j = 0; j < COUNT; j++) {
      const t = frameToMs(j, FPS);
      const at = applyPoint(worldMatrixOf(result.doc.elements, "foot", t, createMemo()), truth(j));
      worst = Math.max(worst, Math.hypot(at.x - TARGET.x, at.y - TARGET.y));
    }
    expect(worst).toBeLessThan(bound);

    // Without the rig the feature wanders the whole shake (negative control).
    const before = footage();
    const drift = Math.max(
      ...Array.from({ length: COUNT }, (_, j) => {
        const at = applyPoint(worldMatrixOf(before.elements, "foot", frameToMs(j, FPS)), truth(j));
        return Math.hypot(at.x - TARGET.x, at.y - TARGET.y);
      }),
    );
    expect(drift).toBeGreaterThan(20);
  });
});
