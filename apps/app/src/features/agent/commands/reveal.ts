/**
 * Showing a text clip's lettering a piece at a time, from the agent surface.
 *
 * Two commands, sharing their ops with the Animation tab rather than
 * reimplementing them: `setClipTextRevealMany` and `setClipTextRevealFieldsMany`
 * in `features/timeline/textRevealOps.ts`, and `applyTypewriter` in
 * `features/text/typewriter.ts`, which is the same function the panel's
 * Typewriter button calls.
 *
 * ## Why a reveal is not an `update_clip` patch
 *
 * `update_clip` is a path whitelist: `flatten` the patch, check `RANGES` and
 * `ENUMS`, `setIn`. Admitting `reveal` there would break three things, the
 * first decisively.
 *
 * A raw `setIn` writes the field and **cannot seed the keyframe track**.
 * `keyframeOps.isMintableTrack` covers `intensity`, `fx:*` and `volumeDb` and
 * nothing else; `textRevealOps.withReveal` is the only thing that seeds
 * `revealProgress`. So the clip would end up with a reveal that
 * `animatableProperties` advertises and every keyframe op then declines on, by
 * identity and in silence. Today's dead end at least says so out loud.
 *
 * `coerceReveal` would also never run, so a `fade: 0` would be stored where the
 * rule is to delete the key, and a project nobody had used the feature on would
 * stop saving byte-identically. And "clear the reveal" has no representation:
 * `flatten` recurses into objects, so a `["reveal"]` leaf never matches a
 * nested patch, and a leaf cannot mean "remove the whole field".
 *
 * `blend`, `lut`, `adjust`, `mask`, the filters, the fonts and the speed all
 * sit outside the whitelist with their own tool for the same reasons.
 * `volumeDb` is the exception that proves it: its track *is* mintable, so a raw
 * write cannot strand it.
 *
 * ## Why both commands validate their own arguments
 *
 * zod ran in main for an MCP call. It did not run at all for an extension
 * reaching this same registry through `commands.execute`. `mask.ts` carries
 * `checkNumbers` for that reason and so does this.
 */

import { REVEAL_UNITS, type RevealUnit } from "../../../@types/timeline";
import {
  easingNames,
  resolveEasing,
  type EasingName,
} from "../../animation/easing";
import { coerceRevealUnit } from "../../text/reveal";
import { applyTypewriter } from "../../text/typewriter";
import {
  REVEALABLE_FILETYPES,
  isRevealable,
  revealRefOf,
  setClipTextRevealFieldsMany,
  setClipTextRevealMany,
  type RevealFieldPatch,
} from "../../timeline/textRevealOps";
import type { TimelineDocument } from "../../timeline/tracks";
import { commit } from "../commit";
import {
  currentDoc,
  localTime,
  projectBakeHz,
  requireElement,
} from "../context";
import { registerCommands } from "../registry";

type ApplyTypewriterParams = {
  elementIds: string[];
  unit?: RevealUnit;
  durationMs?: number;
  unitsPerSecond?: number;
  atMs?: number;
  easing?: EasingName;
};

type SetTextRevealParams = {
  elementIds: string[];
  unit?: RevealUnit | null;
  progress?: number;
  fade?: number;
  /** `null` removes the movement and keeps the reveal. */
  animate?: null;
  animateWindow?: number;
  animateScale?: number;
  animateOffsetX?: number;
  animateOffsetY?: number;
  animateRotation?: number;
  animateBlur?: number;
  animateOpacity?: number;
  animateEasing?: string;
};

/** The ids, checked for existence and for carrying a reveal at all. */
function requireRevealable(
  doc: TimelineDocument,
  name: string,
  ids: string[],
): void {
  if (ids.length === 0) {
    throw new Error(`${name} needs at least one id in \`elementIds\`.`);
  }
  const wrongType = ids
    .map((id) => requireElement(doc, id))
    .filter((element) => !isRevealable(element));

  if (wrongType.length > 0) {
    throw new Error(
      `Only ${REVEALABLE_FILETYPES.join(", ")} clips carry a reveal; ` +
        `got ${wrongType.map((element) => element.filetype).join(", ")}.`,
    );
  }
}

/** Every numeric field, checked together so one call reports every mistake. */
function checkNumbers(
  name: string,
  params: Record<string, unknown>,
  keys: readonly string[],
): void {
  for (const key of keys) {
    const value = params[key];
    if (
      value !== undefined &&
      (typeof value !== "number" || !Number.isFinite(value))
    ) {
      throw new Error(`${name}'s \`${key}\` must be a finite number.`);
    }
  }
}

/** The span the written keyframes cover, or 0 when they are not there. */
function typedLengthMs(doc: TimelineDocument, elementId: string): number {
  const list = (doc.elements[elementId] as any)?.animation?.revealProgress?.x;
  if (!Array.isArray(list) || list.length < 2) {
    return 0;
  }
  return (list[list.length - 1]?.p?.[0] ?? 0) - (list[0]?.p?.[0] ?? 0);
}

/** Whether the reveal is driven by a live curve rather than by its own number. */
function isKeyedReveal(doc: TimelineDocument, elementId: string): boolean {
  const track = (doc.elements[elementId] as any)?.animation?.revealProgress;
  return track?.isActivate === true && (track?.x?.length ?? 0) > 0;
}

registerCommands({
  apply_typewriter: (params: ApplyTypewriterParams) => {
    const doc = currentDoc();
    const ids = params.elementIds ?? [];
    requireRevealable(doc, "apply_typewriter", ids);
    checkNumbers("apply_typewriter", params as Record<string, unknown>, [
      "durationMs",
      "unitsPerSecond",
      "atMs",
    ]);

    if (params.unit !== undefined && coerceRevealUnit(params.unit) == null) {
      throw new Error(
        `apply_typewriter's \`unit\` must be one of ${REVEAL_UNITS.join(", ")}.`,
      );
    }
    for (const key of ["durationMs", "unitsPerSecond"] as const) {
      const value = params[key];
      if (value !== undefined && value <= 0) {
        throw new Error(
          `apply_typewriter's \`${key}\` must be greater than 0.`,
        );
      }
    }
    // Refused rather than quietly defaulted, the rule `add_keyframes` keeps: a
    // caller that asked for a curve and silently got another cannot tell, and
    // the fallback here is the soft arrival the linear default exists to avoid.
    if (params.easing != null && resolveEasing(params.easing) == null) {
      throw new Error(
        `"${String(params.easing)}" is not an easing. Named: ${easingNames().join(", ")}.`,
      );
    }

    // Absolute timeline ms in, element-local ms out, per clip: one anchor meets
    // each clip at a different offset. Computed before the commit, so a time
    // outside a clip is an error rather than a half-applied edit with an undo
    // step already recorded.
    const anchors = new Map(
      ids.map((id) => [
        id,
        params.atMs == null
          ? undefined
          : localTime(requireElement(doc, id), params.atMs),
      ]),
    );
    const bakeHz = projectBakeHz();

    const result = commit(
      (d) =>
        ids.reduce(
          (next, id) =>
            applyTypewriter(next, id, {
              unit: params.unit,
              durationMs: params.durationMs,
              unitsPerSecond: params.unitsPerSecond,
              startAtMs: anchors.get(id),
              easing: params.easing,
              bakeHz,
            }),
          d,
        ),
      // Hard to reach: `applyTypewriter` empties the progress lane before it
      // rewrites it, so a second identical call produces a new document, the
      // same way a second click of the panel's button does. `commit` needs a
      // reason regardless, and this is what one would mean.
      "Those clips already type on exactly like that.",
    );

    // Compressed, not refused, and nothing else would say so. The anchor is the
    // one thing an anchor is for, so typing that will not fit is shortened
    // rather than slid backwards to start earlier.
    if (result.ok && params.durationMs != null) {
      const after = currentDoc();
      const short = ids.filter(
        (id) => typedLengthMs(after, id) < (params.durationMs as number) - 1,
      );
      if (short.length > 0) {
        return {
          ...result,
          warning:
            `${short.length} of those clips end before ${Math.round(params.durationMs)}ms of typing would, ` +
            "so it was compressed to fit rather than started earlier. Lengthen the clip, or ask for less time.",
        };
      }
    }
    return result;
  },

  set_text_reveal: (params: SetTextRevealParams) => {
    const doc = currentDoc();
    const ids = params.elementIds ?? [];
    requireRevealable(doc, "set_text_reveal", ids);
    checkNumbers("set_text_reveal", params as Record<string, unknown>, [
      "progress",
      "fade",
      "animateWindow",
      "animateScale",
      "animateOffsetX",
      "animateOffsetY",
      "animateRotation",
      "animateBlur",
      "animateOpacity",
    ]);

    if (
      params.unit !== undefined &&
      params.unit !== null &&
      coerceRevealUnit(params.unit) == null
    ) {
      throw new Error(
        `set_text_reveal's \`unit\` must be one of ${REVEAL_UNITS.join(", ")}, ` +
          "or null to remove the reveal.",
      );
    }

    const patch: RevealFieldPatch = {};
    if (params.progress !== undefined) {
      patch.progress = params.progress;
    }
    if (params.fade !== undefined) {
      patch.fade = params.fade;
    }

    // The animator arrives as flat `animate*` arguments, for the reason
    // `set_shape` takes `arcStart`/`arcSweep` flat: an agent changing how far a
    // word rises should not have to restate its scale. They are folded into one
    // object here and merged over the stored animator by the op.
    const animate: Record<string, unknown> = {};
    for (const [key, value] of [
      ["window", params.animateWindow],
      ["scale", params.animateScale],
      ["offsetX", params.animateOffsetX],
      ["offsetY", params.animateOffsetY],
      ["rotation", params.animateRotation],
      ["blur", params.animateBlur],
      ["opacity", params.animateOpacity],
      ["easing", params.animateEasing],
    ] as const) {
      if (value !== undefined) {
        animate[key] = value;
      }
    }

    if (params.animate === null) {
      patch.animate = null;
    } else if (Object.keys(animate).length > 0) {
      patch.animate = animate;
    }

    const hasPatch = Object.keys(patch).length > 0;

    if (params.unit === undefined && !hasPatch) {
      throw new Error(
        "set_text_reveal needs a `unit`, a `progress`, a `fade` or an `animate*` field. " +
          "Pass unit:null to remove the reveal, or animate:null to remove just the movement.",
      );
    }

    /*
     * Named before the commit, because "there is nothing to adjust" and "that
     * is already what it says" are different facts and only the document knows
     * which applies. `setClipTextRevealFields` declines on a clip with no
     * reveal, and an agent told only "already" would try the same call again.
     */
    const declineReason =
      params.unit === null
        ? "Those clips have no reveal to remove."
        : params.unit === undefined &&
            ids.every((id) => revealRefOf(doc, id) == null)
          ? "Those clips have no reveal to adjust. Pass a `unit` to give them one, " +
            "or apply_typewriter to type the text on."
          : "Those clips already reveal exactly like that.";

    const result = commit((d) => {
      // The unit first: it is what creates or removes the reveal, and the
      // numbers have nowhere to land until it has. One document, so a unit and
      // a progress given together are one undo step.
      const shaped =
        params.unit === undefined
          ? d
          : setClipTextRevealMany(d, ids, params.unit);
      return hasPatch ? setClipTextRevealFieldsMany(shaped, ids, patch) : shaped;
    }, declineReason);

    // Written, and overridden at every frame. `sampledRevealProgress` reads the
    // static `progress` only as the fallback, so on a clip whose curve is on
    // and keyed this number is invisible and nothing else would say why.
    if (result.ok && params.progress !== undefined) {
      const after = currentDoc();
      const keyed = ids.filter((id) => isKeyedReveal(after, id));
      if (keyed.length > 0) {
        return {
          ...result,
          warning:
            `revealProgress is keyframed on ${keyed.length === 1 ? "that clip" : `${keyed.length} of those clips`}, ` +
            "so the curve sets the progress at every frame and this number is only what it falls back to. " +
            "Use add_keyframes to re-time it, or set_animation to switch the track off.",
        };
      }
    }
    return result;
  },
});
