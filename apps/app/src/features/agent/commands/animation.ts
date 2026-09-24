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
 *
 * Both conversions live in `context.ts` now, as `localTime` and
 * `projectBakeHz`. The reveal commands write to the same `revealProgress`
 * track and need exactly these two answers, and a second copy is how one of
 * the two families quietly stops snapping to the grid.
 */

import {
  animatableProperties,
  type AnimatableProperty,
  type TimelineElement,
} from "../../../@types/timeline";
import {
  removeKeyframePaired,
  setTrackActive,
} from "../../animation/keyframeOps";

import { lanesOf } from "../../animation/keyframes";
import {
  applyPreset,
  applyPresetShape,
  presetDefaultMs,
  presetIsFocusable,
  presetNames,
  type PresetName,
} from "../../animation/presets";
import { spanStart } from "../../timeline/geometry";
import type { TimelineDocument } from "../../timeline/tracks";
import { animationPresetById, isExtensionPresetId } from "../../extension/animationPresets";
import { commit } from "../commit";
import {
  currentDoc,
  localTime,
  onFrame,
  projectBakeHz,
  requireElement,
} from "../context";
import { registerCommands } from "../registry";
import {
  MATCH_TOLERANCE_MS,
  animatableRefusal,
  applyWrites,
  clearTrack,
  prepareWrites,
} from "./keyframeWrites";

function requireAnimatable(
  element: TimelineElement,
  _elementId: string,
  property: AnimatableProperty,
): void {
  const refusal = animatableRefusal(element, property);
  if (refusal != null) {
    throw new Error(refusal);
  }
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

    /*
     * A preset is either one of the nineteen this app ships or one an
     * extension contributed, and the two are told apart by the `ext:` prefix
     * on the name. They resolve to the same thing: a shape.
     *
     * Only the *lookup* branches. Everything below, and everything inside
     * `applyPresetShape`, is shared, so a contributed preset is not a second
     * kind of move that happens to behave similarly.
     */
    const contributed = isExtensionPresetId(params.preset)
      ? animationPresetById(params.preset)
      : null;

    if (isExtensionPresetId(params.preset) && contributed == null) {
      throw new Error(
        `"${params.preset}" is not a preset any loaded extension contributes. ` +
          "It may have been disabled, or the extension that provided it may not be running.",
      );
    }

    const shape = contributed?.shape ?? null;

    // Each preset carries the length it is meant to have: a punch is under a
    // fifth of a second and a drift is four seconds, so an omitted duration
    // means "the right one", not a shared default.
    const durationMs =
      params.durationMs != null
        ? Math.max(1, params.durationMs)
        : (shape?.defaultMs ?? presetDefaultMs(params.preset));

    // A focus on a preset that cannot use it is a misunderstanding worth
    // saying out loud: the caller thinks the zoom will converge somewhere it
    // will not, and silence would leave them believing it.
    const focusable = shape != null ? shape.focusable === true : presetIsFocusable(params.preset);
    if (params.focus != null && !focusable) {
      throw new Error(
        `"${params.preset}" does not take a focus, because it is not a zoom. ` +
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
            shape != null
              ? applyPresetShape(next, id, shape, durationMs, bakeHz, {
                  focus: params.focus,
                  startAtMs: anchors.get(id),
                })
              : applyPreset(next, id, params.preset, durationMs, bakeHz, {
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
    // The one-track shape of `set_keyframes`, kept because every saved prompt
    // and skill that authors a single move names it.
    const doc = currentDoc();
    const prepared = prepareWrites(
      doc,
      [
        {
          elementId: params.elementId,
          property: params.property,
          keyframes: params.keyframes ?? [],
        },
      ],
      (id) => requireElement(doc, id),
    );
    const bakeHz = projectBakeHz();

    return commit(
      (d: TimelineDocument) => applyWrites(d, prepared, bakeHz),
      "Those keyframes are already there.",
    );
  },

  set_keyframes: (params: {
    writes: Array<{
      elementId: string;
      property: AnimatableProperty;
      keyframes: Array<{
        atMs: number;
        value?: number;
        x?: number;
        y?: number;
        easing?: unknown;
      }>;
      replace?: boolean;
    }>;
  }) => {
    const doc = currentDoc();
    const writes = params.writes ?? [];
    if (writes.length === 0) {
      throw new Error("set_keyframes needs at least one entry in `writes`.");
    }

    // Every write validated against the document as it stands, before any of
    // them is applied. One bad time refuses the batch rather than leaving half
    // an edit with an undo step already recorded.
    const prepared = prepareWrites(
      doc,
      writes,
      (id) => requireElement(doc, id),
      (index) => `writes[${index}]`,
    );

    const cleared = writes
      .map((write, index) => (write.replace === true ? prepared[index] : null))
      .filter((write): write is NonNullable<typeof write> => write != null);

    const bakeHz = projectBakeHz();

    return commit((d: TimelineDocument) => {
      // Cleared first, all of them, then written. Interleaving would let a
      // later `replace` wipe a track an earlier write in the same batch had
      // just authored, which is never what listing two writes on one track
      // means.
      let next = cleared.reduce(
        (doc2, write) => clearTrack(doc2, write.elementId, write.property, bakeHz),
        d,
      );
      return applyWrites(next, prepared, bakeHz);
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
