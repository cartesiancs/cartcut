/**
 * Keyframe animation.
 *
 * The one conversion this file exists to do: **keyframe times are stored
 * relative to the clip's own start**, in timeline ms, while every tool in this
 * surface speaks absolute timeline ms. `keyframeMarkers.ts` is explicit about
 * the storage convention, and `optionVideo.handleLocation` subtracts
 * `startTime` before calling `addKeyframe` for exactly this reason.
 *
 * Exposing the element-local form to an agent would be a trap: it has just read
 * `list_clips`, which reports absolute times, and nothing in the parameter name
 * would tell it otherwise. So the conversion happens here, the same way
 * `edit.ts` converts absolute times to the deltas the trim ops want.
 *
 * A time outside the clip is refused rather than clamped. A keyframe past the
 * clip's end never plays, so clamping would report success for an edit with no
 * visible effect.
 */

import {
  animatableProperties,
  type AnimatableProperty,
  type TimelineElement,
} from "../../../@types/timeline";
import {
  addKeyframePaired,
  removeKeyframePaired,
  setTrackActive,
} from "../../animation/keyframeOps";
import { lanesOf } from "../../animation/keyframes";
import { applyPreset, type PresetName } from "../../animation/presets";
import { spanLength, spanStart } from "../../timeline/geometry";
import type { TimelineDocument } from "../../timeline/tracks";
import { commit } from "../commit";
import { currentDoc, onFrame, requireElement } from "../context";
import { registerCommands } from "../registry";

/** How near a stored keyframe a requested time has to be to mean "that one". */
const MATCH_TOLERANCE_MS = 2;

function requireAnimatable(
  element: TimelineElement,
  elementId: string,
  property: AnimatableProperty,
): void {
  const available = animatableProperties(element);
  if (available.length === 0) {
    throw new Error(
      `A ${element.filetype} clip carries no animation. Animatable types: video, image, text, shape and group.`,
    );
  }
  if (!available.includes(property)) {
    throw new Error(
      `A ${element.filetype} clip cannot animate "${property}". It supports: ${available.join(", ")}.`,
    );
  }
}

/**
 * An absolute timeline time as an offset from the clip's start, on the grid.
 *
 * Throws rather than clamping when it falls outside the clip — see the header.
 */
function localTime(element: TimelineElement, atMs: number): number {
  const start = spanStart(element);
  const length = spanLength(element);
  const local = onFrame(atMs) - start;

  if (local < 0 || local > length) {
    throw new Error(
      `${Math.round(atMs)}ms is outside the clip, which runs ${Math.round(start)}–${Math.round(
        start + length,
      )}ms. A keyframe outside the clip would never play.`,
    );
  }
  return local;
}

registerCommands({
  apply_animation_preset: (params: {
    elementIds: string[];
    preset: PresetName;
    durationMs?: number;
  }) => {
    const doc = currentDoc();
    const ids = params.elementIds ?? [];
    if (ids.length === 0) {
      throw new Error(
        "apply_animation_preset needs at least one id in `elementIds`.",
      );
    }
    for (const id of ids) {
      requireElement(doc, id);
    }

    const durationMs = Math.max(1, params.durationMs ?? 250);

    return commit(
      (d) =>
        ids.reduce(
          (next, id) => applyPreset(next, id, params.preset, durationMs),
          d,
        ),
      "None of those clips can animate that property, or they already have those keyframes.",
    );
  },

  set_animation: (params: {
    elementId: string;
    property: AnimatableProperty;
    active: boolean;
    seedAtMs?: number;
  }) => {
    const doc = currentDoc();
    const element = requireElement(doc, params.elementId);
    requireAnimatable(element, params.elementId, params.property);

    const seed =
      params.active && params.seedAtMs != null
        ? { atMs: localTime(element, params.seedAtMs) }
        : params.active
          ? { atMs: 0 }
          : undefined;

    return commit(
      (d) =>
        setTrackActive(d, params.elementId, params.property, params.active, seed),
      params.active
        ? "That property is already animated."
        : "That property is already not animated.",
    );
  },

  add_keyframes: (params: {
    elementId: string;
    property: AnimatableProperty;
    keyframes: Array<{ atMs: number; value?: number; x?: number; y?: number }>;
  }) => {
    const doc = currentDoc();
    const element = requireElement(doc, params.elementId);
    requireAnimatable(element, params.elementId, params.property);

    const entries = params.keyframes ?? [];
    if (entries.length === 0) {
      throw new Error("add_keyframes needs at least one entry in `keyframes`.");
    }

    const lanes = lanesOf(params.property);
    const paired = lanes.length > 1;

    // Validated and converted up front, so a batch with one bad entry throws
    // before anything is written rather than half-applying.
    const writes = entries.map((entry) => {
      const at = localTime(element, entry.atMs);

      if (paired) {
        if (typeof entry.x !== "number" || typeof entry.y !== "number") {
          throw new Error(
            `"${params.property}" needs both \`x\` and \`y\` on every keyframe.`,
          );
        }
        return { at, values: { x: entry.x, y: entry.y } };
      }

      if (typeof entry.value !== "number" || !Number.isFinite(entry.value)) {
        throw new Error(
          `"${params.property}" needs a numeric \`value\` on every keyframe.` +
            (params.property === "scale"
              ? " Scale is in tenths: 10 is unscaled, 12 is 120%."
              : ""),
        );
      }
      return { at, values: { x: entry.value } as Record<string, number> };
    });

    return commit((d: TimelineDocument) => {
      // Activating first: keyframes on an inactive track exist but drive
      // nothing, which reads to an agent as a silent failure.
      let next = setTrackActive(d, params.elementId, params.property, true, {
        atMs: writes[0].at,
      });

      for (const write of writes) {
        for (const lane of lanes) {
          const value = write.values[lane];
          if (typeof value !== "number") {
            continue;
          }
          next = addKeyframePaired(
            next,
            params.elementId,
            params.property,
            lane,
            write.at,
            value,
          );
        }
      }
      return next;
    }, "Those keyframes are already there.");
  },

  remove_keyframes: (params: {
    elementId: string;
    property: AnimatableProperty;
    atMs: number[];
  }) => {
    const doc = currentDoc();
    const element = requireElement(doc, params.elementId);
    requireAnimatable(element, params.elementId, params.property);

    const times = params.atMs ?? [];
    if (times.length === 0) {
      throw new Error("remove_keyframes needs at least one time in `atMs`.");
    }

    const start = spanStart(element);
    const wanted = times.map((at) => onFrame(at) - start);
    const lane = lanesOf(params.property)[0];

    return commit((d: TimelineDocument) => {
      let next = d;

      for (const target of wanted) {
        // Resolved against the document as it stands each time round, because
        // every removal shifts the indices after it. Descending order would
        // work too; looking the index up is simply harder to get wrong.
        const track = (next.elements[params.elementId] as any)?.animation?.[
          params.property
        ];
        const list = track?.[lane];
        if (!Array.isArray(list)) {
          continue;
        }

        const index = list.findIndex(
          (keyframe: any) =>
            Math.abs((keyframe?.p?.[0] ?? 0) - target) <= MATCH_TOLERANCE_MS,
        );
        if (index < 0) {
          continue;
        }

        next = removeKeyframePaired(
          next,
          params.elementId,
          params.property,
          lane,
          index,
        );
      }

      return next;
    }, "There are no keyframes at those times. Use get_keyframes to see what is there.");
  },
});
