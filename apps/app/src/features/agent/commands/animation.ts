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
 *
 * The other conversion is the bake rate. Every op in `keyframeOps` takes
 * `bakeHz` as a trailing optional defaulting to `BAKE_HZ` (60), and until now
 * nothing here passed one — so in a 120fps project an agent-authored curve was
 * baked at half the project's rate and stepped, visibly, until the file was
 * reloaded. `bakeRateFor` is the rule (`max(60, fps)`); reading the store for
 * it is what an agent command is allowed to do and a pure op is not.
 */

import {
  animatableProperties,
  type AnimatableProperty,
  type TimelineElement,
} from "../../../@types/timeline";
import {
  addKeyframePaired,
  removeKeyframePaired,
  setHandles,
  setTrackActive,
} from "../../animation/keyframeOps";
import {
  easingNames,
  projectEasing,
  resolveEasing,
  type CubicPoints,
} from "../../animation/easing";
import { bakeRateFor, lanesOf } from "../../animation/keyframes";
import {
  applyPreset,
  presetDefaultMs,
  presetIsFocusable,
  presetNames,
  type PresetName,
} from "../../animation/presets";
import { spanLength, spanStart } from "../../timeline/geometry";
import type { TimelineDocument } from "../../timeline/tracks";
import { renderOptionStore } from "../../../states/renderOptionStore";
import { commit } from "../commit";
import { currentDoc, onFrame, requireElement } from "../context";
import { registerCommands } from "../registry";

/** How near a stored keyframe a requested time has to be to mean "that one". */
const MATCH_TOLERANCE_MS = 2;

/** The rate this project's curves must be baked at. See the header. */
function projectBakeHz(): number {
  return bakeRateFor(renderOptionStore.getState().options.fps);
}

/** The keyframe in `lane` sitting at `atMs`, by index, or -1. */
function indexAt(
  doc: TimelineDocument,
  elementId: string,
  property: AnimatableProperty,
  lane: string,
  atMs: number,
): number {
  const list = (doc.elements[elementId] as any)?.animation?.[property]?.[lane];
  if (!Array.isArray(list)) {
    return -1;
  }
  return list.findIndex(
    (keyframe: any) =>
      Math.abs((keyframe?.p?.[0] ?? 0) - atMs) <= MATCH_TOLERANCE_MS,
  );
}

/**
 * Shape one segment with `curve`, on every lane the property has.
 *
 * The two anchors are looked up by time rather than carried from the write,
 * because `addKeyframe` may have merged onto an existing keyframe and the
 * *stored* value is the one the curve has to be projected against. Projecting
 * against the requested value would put the handles on a segment that is not
 * the one being drawn.
 *
 * `position` gets the same curve on both lanes: a single easing describes how
 * the move feels, and giving x and y different shapes would bend the path.
 */
function applyEasing(
  doc: TimelineDocument,
  elementId: string,
  property: AnimatableProperty,
  lanes: string[],
  fromMs: number,
  toMs: number,
  curve: CubicPoints,
  bakeHz: number,
): TimelineDocument {
  let next = doc;

  for (const lane of lanes) {
    const fromIndex = indexAt(next, elementId, property, lane, fromMs);
    const toIndex = indexAt(next, elementId, property, lane, toMs);
    if (fromIndex < 0 || toIndex < 0 || toIndex !== fromIndex + 1) {
      // Not adjacent — something else sits between them, so this is not the
      // segment the caller described. Leaving it alone is the honest answer.
      continue;
    }

    const list = (next.elements[elementId] as any).animation[property][lane];
    const { ce, cs } = projectEasing(
      curve,
      { atMs: list[fromIndex].p[0], value: list[fromIndex].p[1] },
      { atMs: list[toIndex].p[0], value: list[toIndex].p[1] },
    );

    next = setHandles(
      next,
      elementId,
      property,
      lane as any,
      fromIndex,
      { ce },
      bakeHz,
    );
    next = setHandles(
      next,
      elementId,
      property,
      lane as any,
      toIndex,
      { cs },
      bakeHz,
    );
  }

  return next;
}

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
    atMs?: number;
    focus?: { x: number; y: number };
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

    // Each preset carries the length it is meant to have — a punch is under a
    // fifth of a second and a drift is four seconds — so an omitted duration
    // means "the right one", not a shared default.
    const durationMs =
      params.durationMs != null
        ? Math.max(1, params.durationMs)
        : presetDefaultMs(params.preset);

    // A focus on a preset that cannot use it is a misunderstanding worth
    // saying out loud: the caller thinks the zoom will converge somewhere it
    // will not, and silence would leave them believing it.
    if (params.focus != null && !presetIsFocusable(params.preset)) {
      throw new Error(
        `"${params.preset}" does not take a focus — it is not a zoom. ` +
          `Focusable presets: ${presetNames().filter(presetIsFocusable).join(", ")}.`,
      );
    }

    // Where the move begins, if the caller says. Absolute timeline ms in, the
    // element-local ms `applyPreset` wants out — and per clip, since a preset
    // applied across a selection meets each one at a different offset.
    //
    // `localTime` throws for a time outside the clip rather than clamping,
    // which is right here and not in the panel: an agent naming a time has one
    // in mind, and silently moving it would produce an edit that looks like the
    // request and is not. The panel's `playheadAnchor` falls back instead,
    // because there the "time" is wherever the playhead happened to be parked.
    const anchorFor =
      params.atMs == null
        ? () => undefined
        : (id: string) => localTime(requireElement(doc, id), params.atMs as number);

    // Computed before the commit so a bad time is an error, not a half-applied
    // edit with an undo step already recorded.
    const anchors = new Map(ids.map((id) => [id, anchorFor(id)]));

    const bakeHz = projectBakeHz();

    return commit(
      (d) =>
        ids.reduce(
          (next, id) =>
            applyPreset(next, id, params.preset, durationMs, bakeHz, {
              focus: params.focus,
              startAtMs: anchors.get(id),
            }),
          d,
        ),
      "None of those clips can animate what that preset drives, or they already have those keyframes.",
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

    const bakeHz = projectBakeHz();

    return commit(
      (d) =>
        setTrackActive(
          d,
          params.elementId,
          params.property,
          params.active,
          seed,
          bakeHz,
        ),
      params.active
        ? "That property is already animated."
        : "That property is already not animated.",
    );
  },

  add_keyframes: (params: {
    elementId: string;
    property: AnimatableProperty;
    keyframes: Array<{
      atMs: number;
      value?: number;
      x?: number;
      y?: number;
      easing?: unknown;
    }>;
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

      // An unknown easing is refused rather than quietly falling back to the
      // default: a caller that asked for a snap and silently got the soft
      // default has no way to tell, and the whole point of the parameter is
      // that the default is too soft.
      const curve =
        entry.easing == null ? null : resolveEasing(entry.easing);
      if (entry.easing != null && curve == null) {
        throw new Error(
          `"${String(entry.easing)}" is not an easing. Named: ${easingNames().join(", ")}. ` +
            `Or pass [x1, y1, x2, y2] control points, as CSS writes them.`,
        );
      }

      if (paired) {
        if (typeof entry.x !== "number" || typeof entry.y !== "number") {
          throw new Error(
            `"${params.property}" needs both \`x\` and \`y\` on every keyframe.`,
          );
        }
        return { at, curve, values: { x: entry.x, y: entry.y } };
      }

      if (typeof entry.value !== "number" || !Number.isFinite(entry.value)) {
        throw new Error(
          `"${params.property}" needs a numeric \`value\` on every keyframe.` +
            (params.property === "scale"
              ? " Scale is in tenths: 10 is unscaled, 12 is 120%."
              : ""),
        );
      }
      return {
        at,
        curve,
        values: { x: entry.value } as Record<string, number>,
      };
    });

    const bakeHz = projectBakeHz();

    return commit((d: TimelineDocument) => {
      // Activating first: keyframes on an inactive track exist but drive
      // nothing, which reads to an agent as a silent failure.
      let next = setTrackActive(
        d,
        params.elementId,
        params.property,
        true,
        { atMs: writes[0].at },
        bakeHz,
      );

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
            undefined,
            bakeHz,
          );
        }
      }

      // Easing is applied second, and it has to be: a curve is a property of
      // the *segment*, so projecting it needs both anchors to exist and to hold
      // their final values. Doing it inside the add loop would project onto a
      // neighbour that had not been written yet.
      for (let index = 0; index < writes.length - 1; index++) {
        const curve = writes[index].curve;
        if (curve == null) {
          continue;
        }
        next = applyEasing(
          next,
          params.elementId,
          params.property,
          lanes,
          writes[index].at,
          writes[index + 1].at,
          curve,
          bakeHz,
        );
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
    const bakeHz = projectBakeHz();

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
          bakeHz,
        );
      }

      return next;
    }, "There are no keyframes at those times. Use get_keyframes to see what is there.");
  },
});
