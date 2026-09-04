/**
 * What a preset tile draws, computed from the preset itself.
 *
 * The preset grid needs to show what each move *does*, and there are two ways
 * to get that: describe each one a second time in whatever the tile can draw,
 * or run the real thing and read it back. This is the second. `previewSamples`
 * builds a throwaway one-clip document, applies the **real `applyPreset`** to
 * it, and reads the result through the **real `localSampleAt`** — the same
 * function the renderer calls on every frame.
 *
 * That is the same argument `fx/fxPreviewProvider.ts` makes for rendering its
 * thumbnails through the actual compositor, and it buys the same thing: the
 * tile cannot drift from the preset, because there is nothing to drift. Change
 * a curve in `presets.ts` and the thumbnail changes with it; there is no second
 * table to forget to update.
 *
 * It is arithmetic rather than GL because these presets are transforms and
 * nothing else — no shader, no source frame — so the whole library costs a few
 * hundred `sampleBaked` lookups, done once and memoised.
 *
 * DOM-free, like the rest of `features/animation/`: the drawing lives in
 * `features/option/animationPresetBrowser.ts`, which is the only part that
 * needs a canvas.
 */

import type { TimelineElement } from "../../@types/timeline";
import type { TimelineDocument } from "../timeline/tracks";
import { SCHEMA_VERSION, createTrack } from "../timeline/tracks";
import { localSampleAt } from "../timeline/transform";
import { emptyAnimation } from "./keyframes";
import { applyPreset, presetDefaultMs, type PresetName } from "./presets";

/**
 * How many frames a preset's motion is quantised to.
 *
 * The same count `fxPreviewProvider` uses, for the same reason: enough that a
 * hovered tile reads as motion, few enough that one preset's whole loop is a
 * short array computed once.
 */
export const PREVIEW_STEPS = 24;

/**
 * The side of the box every preview is measured in.
 *
 * Offsets come back in these units, so a tile multiplies by `tileSize /
 * PREVIEW_BOX` and needs to know nothing else. A `"box"` preset that travels
 * one box length therefore reports exactly `PREVIEW_BOX`.
 */
export const PREVIEW_BOX = 100;

/** How long the synthetic clip is. Longer than the longest preset (`drift`). */
const PREVIEW_CLIP_MS = 6_000;

/**
 * Rate the preview's own tracks are baked at.
 *
 * Not `BAKE_HZ`. The baked lanes are read by nearest-sample lookup, so a rate
 * below the sampling rate hands consecutive steps the same value — and the
 * shortest preset here is a 180ms punch, which at 60Hz holds eleven samples for
 * twenty-four steps and would render as a stutter rather than a punch. 240 is
 * the top of the project frame-rate band, so nothing the app can ask for is
 * finer than the preview it drew.
 */
const PREVIEW_BAKE_HZ = 240;

export type PreviewSample = {
  /** Offset from the resting position, in `PREVIEW_BOX` units. */
  x: number;
  y: number;
  /** A multiplier — 1 is unscaled. Not the tenths the track stores. */
  scale: number;
  rotationDeg: number;
  /** 0-100, as everywhere else. */
  opacity: number;
};

/**
 * The clip every preview is computed against.
 *
 * Built as a literal rather than borrowed from `features/renderer/testing.ts`,
 * which is a test helper and installs a canvas surface factory as a side effect
 * of being imported. Only the fields `applyPreset` and `localSampleAt` actually
 * read are here; `filetype: "text"` because that is what carries the full
 * animation block and what the tiles are drawn to look like.
 */
function previewElement(): TimelineElement {
  return {
    key: "preview",
    filetype: "text",
    localpath: "",
    trackId: "t",
    priority: 1,
    blob: "",
    startTime: 0,
    duration: PREVIEW_CLIP_MS,
    location: { x: 0, y: 0 },
    timelineOptions: { color: "#ffffff" },
    width: PREVIEW_BOX,
    height: PREVIEW_BOX,
    ratio: 1,
    opacity: 100,
    rotation: 0,
    animation: emptyAnimation("text"),
    text: "TITLE",
    textcolor: "#ffffff",
    fontsize: 52,
    fontpath: "",
    fontname: "",
    fontweight: "normal",
    fonttype: "",
    letterSpacing: 0,
    widthInner: PREVIEW_BOX,
    options: { isBold: true, isItalic: false, align: "center" },
    background: { enable: false, color: "#000000" },
  } as unknown as TimelineElement;
}

function previewDocument(): TimelineDocument {
  return {
    schemaVersion: SCHEMA_VERSION,
    tracks: [createTrack("t", "text", 0)],
    elements: { preview: previewElement() },
  } as TimelineDocument;
}

const cache = new Map<PresetName, PreviewSample[]>();

/**
 * The preset's motion, sampled evenly across its own duration.
 *
 * Anchored at 0 rather than at any playhead: the tile is showing the *move*,
 * not where a particular click would put it. An unknown preset answers `[]`,
 * the same "not installed grades nothing" contract `lutFor` gives — the tile
 * then draws its resting pose and the panel stays up.
 *
 * Memoised on the default step count only. A caller asking for a different
 * number is asking a one-off question and should not evict the panel's answer.
 */
export function previewSamples(
  preset: PresetName,
  steps: number = PREVIEW_STEPS,
): PreviewSample[] {
  if (steps === PREVIEW_STEPS) {
    const hit = cache.get(preset);
    if (hit != null) {
      return hit;
    }
  }

  const samples = computeSamples(preset, steps);
  if (steps === PREVIEW_STEPS) {
    cache.set(preset, samples);
  }
  return samples;
}

function computeSamples(preset: PresetName, steps: number): PreviewSample[] {
  const durationMs = presetDefaultMs(preset);
  const before = previewDocument();
  const after = applyPreset(
    before,
    "preview",
    preset,
    durationMs,
    PREVIEW_BAKE_HZ,
    { startAtMs: 0 },
  );

  // Declined by identity: an unknown preset, or one this element cannot
  // animate. Nothing to show, and nothing to invent.
  if (after === before) {
    return [];
  }

  const element = after.elements.preview;
  const count = Math.max(2, Math.floor(steps));
  const out: PreviewSample[] = [];

  for (let step = 0; step < count; step++) {
    // The clip starts at 0, so the element-local cursor is the timeline one.
    const cursor = (step / (count - 1)) * durationMs;
    const sample = localSampleAt(element, cursor);
    out.push({
      x: sample.x,
      y: sample.y,
      scale: sample.scale,
      rotationDeg: sample.rotationDeg,
      opacity: sample.opacity,
    });
  }

  return out;
}
