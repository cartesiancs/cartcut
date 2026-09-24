/**
 * Authoring keyframes, in bulk.
 *
 * `add_keyframes` takes one clip and one property, which is the shape a single
 * gesture has and not the shape a piece of motion graphics has. A card wheel of
 * a dozen cards with opacity and scale on each is 24 tool calls and 24 undo
 * steps through that door; the same edit is one call here, and one step.
 *
 * Split into a validation pass and a write pass because **the validation has to
 * finish before the document is touched**. `commit` runs its transform twice —
 * once to probe, once for real — and a throw from inside it after some writes
 * had landed would leave the caller unable to say what happened. So a bad time
 * or a bad easing anywhere in the batch is an error before anything is written,
 * which is the rule `add_keyframes` already followed within one property and
 * this extends across all of them.
 *
 * Four things move across from the single-property version, and each is load
 * bearing:
 *
 *  - **The track is activated first**, seeded at that track's own first write.
 *    Keyframes on an inactive track exist and drive nothing, which reads to a
 *    caller as a silent failure.
 *  - **Easing is a second pass**, after every anchor exists and holds its final
 *    value. A curve is a property of the *segment*, so projecting it inside the
 *    add loop would project onto a neighbour that had not been written yet.
 *  - **Anchors are found by time, not by carried index**, within
 *    `MATCH_TOLERANCE_MS`, and shaped only when they come out adjacent.
 *    `addKeyframe` may have merged onto an existing keyframe, so the *stored*
 *    keyframe is the one the curve has to be projected against.
 *  - **`position` gets one curve on both lanes.** A single easing describes how
 *    a move feels; giving x and y different shapes bends the path.
 *
 * `animation/presets.ts#writeTrack` is a second implementation of the same
 * "handles in a second pass, matched by time" rule, with a tolerance of 1 where
 * this uses 2. The two have not been merged: a preset writes a whole shape at
 * fractions of a duration and this writes times a caller named, and the shared
 * part is small enough that unifying them would mostly move the difference
 * somewhere less obvious.
 */

import {
  animatableProperties,
  type AnimatableProperty,
  type TimelineElement,
} from "../../../@types/timeline";
import {
  easingNames,
  projectEasing,
  resolveEasing,
  type CubicPoints,
} from "../../animation/easing";
import { lanesOf } from "../../animation/keyframes";
import { isLinkableProperty, linkOf } from "../../animation/link";
import {
  addKeyframePaired,
  removeKeyframePaired,
  setHandles,
  setTrackActive,
} from "../../animation/keyframeOps";
import type { TimelineDocument } from "../../timeline/tracks";
import { localTime } from "../context";

/** How near a stored keyframe a requested time has to be to mean "that one". */
export const MATCH_TOLERANCE_MS = 2;

/** One keyframe, as a caller writes it. Times are absolute timeline ms. */
export type KeyframeEntry = {
  atMs: number;
  value?: number;
  x?: number;
  y?: number;
  easing?: unknown;
};

/** One property of one clip, and the keyframes to put on it. */
export type KeyframeWrite = {
  elementId: string;
  property: AnimatableProperty;
  keyframes: KeyframeEntry[];
};

/** A write with every time converted and every easing resolved. */
export type PreparedWrite = {
  elementId: string;
  property: AnimatableProperty;
  lanes: string[];
  entries: Array<{
    at: number;
    curve: CubicPoints | null;
    values: Record<string, number>;
  }>;
};

/**
 * Why this clip cannot animate this property, as a sentence, or `null`.
 *
 * A sentence rather than a boolean because the useful part is what it *can*
 * animate: a caller told only "no" guesses again.
 */
export function animatableRefusal(
  element: TimelineElement,
  property: AnimatableProperty,
): string | null {
  // A driven property is derived, so authoring keyframes on it would be
  // writing numbers nothing reads — After Effects greys out an expression-
  // driven property for the same reason. The existing keyframes are kept, so
  // clearing the link brings them back.
  if (isLinkableProperty(property) && linkOf(element, property) != null) {
    return (
      `"${property}" on that clip is driven by a link, so keyframes on it would ` +
      "not be read. Clear it with clear_property_link first; its existing " +
      "keyframes are still there and will drive it again."
    );
  }

  const available = animatableProperties(element);
  if (available.length === 0) {
    return (
      `A ${element.filetype} clip carries no animation. ` +
      `Animatable types: video, image, text, shape, group and audio.`
    );
  }
  if (available.includes(property)) {
    return null;
  }
  /*
   * The one case the tool list advertises and nothing could reach. The MCP
   * `ANIMATABLE` enum carries `revealProgress`, so the schema accepts it, but
   * `animatableProperties` only offers it once the clip has a `reveal` to
   * progress through. Without this the answer names five properties and none
   * of the two tools that would fix it.
   */
  if (property === "revealProgress" && element.filetype === "text") {
    return (
      'A text clip can animate "revealProgress" only once it has a reveal. ' +
      "Give it one with set_text_reveal, or use apply_typewriter to write the whole move at once."
    );
  }
  return (
    `A ${element.filetype} clip cannot animate "${property}". ` +
    `It supports: ${available.join(", ")}.`
  );
}

/**
 * Validate and convert every write, touching nothing.
 *
 * `where` names the offending write in a message — the index in the batch, or
 * nothing at all for the single-property tools, whose caller has only one write
 * to look at.
 */
export function prepareWrites(
  doc: TimelineDocument,
  writes: KeyframeWrite[],
  lookup: (elementId: string) => TimelineElement,
  where: (index: number) => string = () => "",
): PreparedWrite[] {
  if (writes.length === 0) {
    throw new Error("`writes` needs at least one entry.");
  }

  return writes.map((write, index) => {
    const at = where(index);
    const element = lookup(write.elementId);

    const refusal = animatableRefusal(element, write.property);
    if (refusal != null) {
      throw new Error(at === "" ? refusal : `${at}: ${refusal}`);
    }

    const entries = write.keyframes ?? [];
    if (entries.length === 0) {
      throw new Error(
        `${at === "" ? "" : at + ": "}needs at least one entry in \`keyframes\`.`,
      );
    }

    const lanes = lanesOf(write.property);
    const paired = lanes.length > 1;

    return {
      elementId: write.elementId,
      property: write.property,
      lanes,
      entries: entries.map((entry) => {
        // Throws for a time outside the clip rather than clamping: a keyframe
        // past the clip's end never plays, so clamping would report success
        // for an edit with no visible effect. Re-thrown with the write's
        // position, because in a batch "100ms is outside the clip" names
        // neither the clip nor which of twenty writes asked for it.
        let local: number;
        try {
          local = localTime(element, entry.atMs);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(
            at === "" ? message : `${at} (${write.elementId}): ${message}`,
          );
        }

        // An unknown easing is refused rather than quietly falling back to the
        // default: a caller that asked for a snap and silently got the soft
        // default has no way to tell, and the whole point of the parameter is
        // that the default is too soft.
        const curve = entry.easing == null ? null : resolveEasing(entry.easing);
        if (entry.easing != null && curve == null) {
          throw new Error(
            `${at === "" ? "" : at + ": "}"${String(entry.easing)}" is not an easing. ` +
              `Named: ${easingNames().join(", ")}. ` +
              `Or pass [x1, y1, x2, y2] control points, as CSS writes them.`,
          );
        }

        if (paired) {
          if (typeof entry.x !== "number" || typeof entry.y !== "number") {
            throw new Error(
              `${at === "" ? "" : at + ": "}"${write.property}" needs both \`x\` and \`y\` on every keyframe.`,
            );
          }
          return { at: local, curve, values: { x: entry.x, y: entry.y } };
        }

        if (typeof entry.value !== "number" || !Number.isFinite(entry.value)) {
          throw new Error(
            `${at === "" ? "" : at + ": "}"${write.property}" needs a numeric \`value\` on every keyframe.` +
              (write.property === "scale"
                ? " Scale is in tenths: 10 is unscaled, 12 is 120%."
                : ""),
          );
        }
        return {
          at: local,
          curve,
          values: { x: entry.value } as Record<string, number>,
        };
      }),
    };
  });
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

    next = setHandles(next, elementId, property, lane as any, fromIndex, { ce }, bakeHz);
    next = setHandles(next, elementId, property, lane as any, toIndex, { cs }, bakeHz);
  }

  return next;
}

/**
 * Write every prepared entry. Pure, and declines by identity.
 *
 * Writes are applied in the order given, so a batch naming the same track twice
 * behaves like two calls — the later one wins where they collide, which is what
 * a caller listing a correction after a sweep means.
 */
export function applyWrites(
  doc: TimelineDocument,
  prepared: PreparedWrite[],
  bakeHz: number,
): TimelineDocument {
  let next = doc;

  for (const write of prepared) {
    // Activating first: keyframes on an inactive track exist but drive
    // nothing, which reads to an agent as a silent failure.
    next = setTrackActive(
      next,
      write.elementId,
      write.property,
      true,
      { atMs: write.entries[0].at },
      bakeHz,
    );

    for (const entry of write.entries) {
      for (const lane of write.lanes) {
        const value = entry.values[lane];
        if (typeof value !== "number") {
          continue;
        }
        next = addKeyframePaired(
          next,
          write.elementId,
          write.property,
          lane as any,
          entry.at,
          value,
          undefined,
          bakeHz,
        );
      }
    }

    // Second pass — see the module header.
    for (let index = 0; index < write.entries.length - 1; index++) {
      const curve = write.entries[index].curve;
      if (curve == null) {
        continue;
      }
      next = applyEasing(
        next,
        write.elementId,
        write.property,
        write.lanes,
        write.entries[index].at,
        write.entries[index + 1].at,
        curve,
        bakeHz,
      );
    }
  }

  return next;
}

/**
 * Empty one property's keyframes, leaving the track itself in place.
 *
 * Removal rather than a direct lane write, so the pairing, the re-bake and the
 * minted-track deletion all stay in `keyframeOps` where they are tested. The
 * loop is bounded by the list it started with: `removeKeyframePaired` declines
 * by identity, so a keyframe it will not take would otherwise spin forever.
 */
export function clearTrack(
  doc: TimelineDocument,
  elementId: string,
  property: AnimatableProperty,
  bakeHz: number,
): TimelineDocument {
  const lane = lanesOf(property)[0];
  const list = (doc.elements[elementId] as any)?.animation?.[property]?.[lane];
  if (!Array.isArray(list) || list.length === 0) {
    return doc;
  }

  let next = doc;
  for (let remaining = list.length; remaining > 0; remaining -= 1) {
    const after = removeKeyframePaired(
      next,
      elementId,
      property,
      lane as any,
      0,
      bakeHz,
    );
    if (after === next) {
      break;
    }
    next = after;
  }
  return next;
}
