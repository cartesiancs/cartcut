/**
 * A contributed preset against the real machinery.
 *
 * The claim worth pinning is that it is not a second kind of move. A preset an
 * extension shipped has to land the same keyframes, decline in the same cases
 * and draw the same thumbnail as one of the nineteen, because it runs through
 * the same function: only the lookup differs.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { applyPreset, applyPresetShape, type PresetShape } from "../animation/presets";
import { previewSamples, shapePreviewSamples } from "../animation/presetPreview";
import { SCHEMA_VERSION, createTrack, normalizeDocument } from "../timeline/tracks";
import { useTimelineStore } from "../../states/timelineStore";
import { getCommand } from "../agent/registry";
import { videoElement } from "../renderer/testing";
import {
  __clearAnimationPresetsForTesting,
  setAnimationPresetsOf,
  validateAnimationPreset,
} from "./animationPresets";

import "../agent/commands/animation";
import "./commands";

const WOBBLE = {
  schema: 1,
  name: "wobble",
  label: "Wobble",
  defaultMs: 600,
  rotation: [
    { at: 0, value: 0, easing: "ease_out" },
    { at: 0.5, value: -5 },
    { at: 1, value: 0 },
  ],
};

function shapeOf(json: unknown): PresetShape {
  const result = validateAnimationPreset("acme.hello", "w.json", json);
  if (!result.ok) {
    throw new Error(result.errors.join("; "));
  }
  return result.preset.shape;
}

function seed(): string {
  const store = useTimelineStore.getState();
  store.clearTimeline();
  store.patchDocument(
    normalizeDocument({
      schemaVersion: SCHEMA_VERSION,
      tracks: [createTrack("v1", "video", 0)],
      elements: {
        clip: { ...videoElement({ startTime: 0, duration: 5_000 }), trackId: "v1" } as never,
      },
    }),
  );
  return "clip";
}

describe("a contributed shape and a built-in name", () => {
  it("write the same document when they describe the same move", () => {
    // `fade_in` is `opacity: 0 -> 100 over 250ms`. A contributed preset saying
    // exactly that has to produce exactly that, or the two tables are not
    // running the same code.
    const id = seed();
    const doc = useTimelineStore.getState().getDocument();

    const viaName = applyPreset(doc, id, "fade_in", 250, 60, { startAtMs: 0 });
    const viaShape = applyPresetShape(
      doc,
      id,
      shapeOf({
        schema: 1,
        name: "fade-in",
        defaultMs: 250,
        opacity: [
          { at: 0, value: 0 },
          { at: 1, value: 100 },
        ],
      }),
      250,
      60,
      { startAtMs: 0 },
    );

    expect(JSON.stringify(viaShape.elements[id])).toBe(JSON.stringify(viaName.elements[id]));
  });

  it("declines by identity on a clip that cannot animate it", () => {
    const id = seed();
    const doc = useTimelineStore.getState().getDocument();
    // An audio clip animates volume and nothing this move drives.
    const audioDoc = {
      ...doc,
      elements: { [id]: { ...doc.elements[id], filetype: "audio" } as never },
    };
    expect(applyPresetShape(audioDoc, id, shapeOf(WOBBLE), 600, 60)).toBe(audioDoc);
  });

  it("declines by identity for a clip that is not there", () => {
    const doc = useTimelineStore.getState().getDocument();
    expect(applyPresetShape(doc, "nobody", shapeOf(WOBBLE), 600, 60)).toBe(doc);
  });
});

describe("the thumbnail", () => {
  it("samples a contributed shape the way it samples a built-in", () => {
    const contributed = shapePreviewSamples("ext:acme.hello:wobble", shapeOf(WOBBLE));
    const builtin = previewSamples("fade_in");
    expect(contributed.length).toBe(builtin.length);
    expect(contributed.length).toBeGreaterThan(1);
  });

  it("moves, rather than drawing the same pose every step", () => {
    // A tile that sampled nothing would still return a full array of the
    // resting pose, and would look like a working thumbnail of a broken move.
    const samples = shapePreviewSamples("ext:acme.hello:wobble2", shapeOf(WOBBLE));
    const distinct = new Set(samples.map((sample) => JSON.stringify(sample)));
    expect(distinct.size).toBeGreaterThan(1);
  });
});

describe("apply_animation_preset", () => {
  beforeEach(() => {
    __clearAnimationPresetsForTesting();
    seed();
  });

  it("applies one an extension contributed, by its namespaced id", () => {
    setAnimationPresetsOf("acme.hello", [{ fileName: "w.json", json: WOBBLE }]);
    const result = getCommand("apply_animation_preset")?.({
      elementIds: ["clip"],
      preset: "ext:acme.hello:wobble",
    }) as { ok?: boolean };

    expect(result?.ok).toBe(true);
    const element = useTimelineStore.getState().getDocument().elements.clip as never as {
      animation?: { rotation?: { x?: unknown[] } };
    };
    expect(element.animation?.rotation?.x).toHaveLength(3);
  });

  it("says so when the extension that provided it is not running", () => {
    // The alternative is a silent decline, which reads as "that preset does
    // nothing on this clip" and sends the user looking in the wrong place.
    expect(() =>
      getCommand("apply_animation_preset")?.({
        elementIds: ["clip"],
        preset: "ext:ghost.ext:missing",
      }),
    ).toThrow(/not a preset any loaded extension contributes/);
  });

  it("still applies a built-in by name", () => {
    const result = getCommand("apply_animation_preset")?.({
      elementIds: ["clip"],
      preset: "fade_in",
    }) as { ok?: boolean };
    expect(result?.ok).toBe(true);
  });

  it("refuses a focus on a contributed preset that cannot take one", () => {
    setAnimationPresetsOf("acme.hello", [{ fileName: "w.json", json: WOBBLE }]);
    expect(() =>
      getCommand("apply_animation_preset")?.({
        elementIds: ["clip"],
        preset: "ext:acme.hello:wobble",
        focus: { x: 50, y: 50 },
      }),
    ).toThrow(/does not take a focus/);
  });
});
