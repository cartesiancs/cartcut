/**
 * Document-level edits to a text clip's reveal.
 *
 * Deliberately shaped like `maskOps.ts`, `lutOps.ts` and `blendOps.ts`, because
 * the same three rules apply and only one of them is obvious:
 *
 *  1. **Not every element can carry a reveal.** A reveal counts units of text,
 *     and only a text clip has any. Writing the field onto a video would put it
 *     in the saved project, through every undo snapshot and into the agent's
 *     serialiser, where nothing would ever read it.
 *  2. **Clearing deletes the key rather than storing a null.** A `.ngt` is
 *     written by `JSON.stringify`, which drops an `undefined` — but
 *     `structuredClone`, which the copy path uses, keeps it. Storing a default
 *     would make the saved project and the in-memory one disagree about whether
 *     the clip had ever been revealed.
 *  3. **Declining returns the document by identity**, the contract every op in
 *     `clipOps` holds — `withCheckpoint` reads identity to mean "nothing
 *     happened" and records no undo step. Picking the unit a clip already has
 *     costs the user nothing.
 *
 * ## A reveal and its keyframe track are seeded and removed together
 *
 * `revealProgress` exists on a clip only while it has a reveal —
 * `animatableProperties` gates on `element.reveal != null`, which is what makes
 * `keyframeOps.resolve` refuse a reveal keyframe on a plain text clip with no
 * extra guard. So applying a reveal seeds the empty track and clearing one
 * removes it, in the same transform, and a document is never left with either
 * half alone. The mask does exactly this, for exactly this reason.
 *
 * The track is seeded **only where absent**, so changing the unit on a clip
 * whose progress the user has already keyed leaves those curves where they are.
 * Switching from typing by character to typing by word is a change of cadence,
 * not a reason to throw away the timing.
 *
 * ## What is deliberately not here
 *
 * There is no `startMs` and no `durationMs`. A reveal's timing lives in
 * `element.animation.revealProgress`, where `rebaseAnimation`,
 * `sliceAnimation` and `rebakeElement` already carry it through split, trim,
 * duplicate, paste and a project frame-rate change. Storing times on the field
 * instead would mean reimplementing every one of those in `clipOps`, and the
 * one that was forgotten would fail silently on one edit.
 */

import type {
  RevealUnit,
  TextReveal,
  TimelineElement,
} from "../../@types/timeline";
import { TEXT_ANIMATABLE_PROPERTIES } from "../../@types/timeline";
import { emptyRevealAnimation } from "../animation/keyframes";
import {
  DEFAULT_REVEAL_FADE,
  DEFAULT_REVEAL_PROGRESS,
  coerceReveal,
  coerceRevealUnit,
  defaultReveal,
  revealOf,
  sameReveal,
} from "../text/reveal";
import type { TimelineDocument } from "./tracks";

/**
 * The filetypes that can carry a reveal.
 *
 * One, and it is a list anyway so that the agent command and the option panel
 * can name it in an error rather than restating it.
 */
export const REVEALABLE_FILETYPES = ["text"] as const;

const REVEALABLE = new Set<string>(REVEALABLE_FILETYPES);

export function isRevealable(
  element: TimelineElement | undefined | null,
): boolean {
  return element != null && REVEALABLE.has(element.filetype);
}

/** The reveal on a clip, or `null`. */
export function revealRefOf(
  doc: TimelineDocument,
  elementId: string,
): TextReveal | null {
  return revealOf(doc.elements[elementId]);
}

/** A copy sharing nothing with its input. */
function copyReveal(reveal: TextReveal): TextReveal {
  const next: TextReveal = { unit: reveal.unit, progress: reveal.progress };
  if ((reveal.fade ?? DEFAULT_REVEAL_FADE) > 0) {
    next.fade = reveal.fade;
  }
  return next;
}

/**
 * The single write path: set, change or clear a clip's reveal, seeding or
 * stripping its keyframe track to match.
 */
function withReveal(
  doc: TimelineDocument,
  elementId: string,
  next: TextReveal | null,
): TimelineDocument {
  const element = doc.elements[elementId];
  if (!isRevealable(element)) {
    return doc;
  }
  if (sameReveal(revealOf(element), next)) {
    return doc;
  }

  const source = element as TimelineElement & {
    reveal?: TextReveal;
    animation?: Record<string, unknown>;
  };

  let updated: any;
  if (next == null) {
    // Removed, not set to `undefined` — see rule 2 in this module's header.
    const { reveal: _cleared, ...rest } = source;
    updated = rest;
  } else {
    updated = { ...source, reveal: copyReveal(next) };
  }

  // Text is always animatable, but the guard costs nothing and states the
  // dependency: an element with no animation block must not be given one here.
  if (source.animation != null) {
    if (next == null) {
      const animation: Record<string, unknown> = {};
      for (const [property, track] of Object.entries(source.animation)) {
        if (
          !(TEXT_ANIMATABLE_PROPERTIES as readonly string[]).includes(property)
        ) {
          animation[property] = track;
        }
      }
      updated.animation = animation;
    } else {
      // Seeded only where absent, so changing the unit leaves curves the user
      // has already drawn exactly where they were.
      const seeds = emptyRevealAnimation();
      const animation = { ...source.animation };
      let seeded = false;
      for (const [property, track] of Object.entries(seeds)) {
        if (animation[property] == null) {
          animation[property] = track;
          seeded = true;
        }
      }
      if (seeded) {
        updated.animation = animation;
      }
    }
  }

  return { ...doc, elements: { ...doc.elements, [elementId]: updated } };
}

/**
 * Give a clip a reveal counting `unit`, or clear it with `null`.
 *
 * The progress and the fade carry over across a unit change, the way
 * `setClipMask` carries a mask's placement across a shape change: trying
 * character, then word, then line should compare three cadences of the same
 * move rather than reset the panel twice.
 */
export function setClipTextReveal(
  doc: TimelineDocument,
  elementId: string,
  unit: RevealUnit | null,
): TimelineDocument {
  if (unit == null) {
    return withReveal(doc, elementId, null);
  }
  const known = coerceRevealUnit(unit);
  if (known == null) {
    return doc;
  }
  const existing = revealRefOf(doc, elementId);
  if (existing == null) {
    return withReveal(doc, elementId, defaultReveal(known));
  }
  return withReveal(doc, elementId, { ...existing, unit: known });
}

/** The fields a panel or an agent may patch on an existing reveal. */
export type RevealFieldPatch = {
  progress?: number;
  fade?: number;
};

/**
 * Patch a reveal's numbers.
 *
 * Declines on a clip with no reveal: a progress with nothing to progress
 * through is a field nothing would read. Unreadable numbers are dropped rather
 * than stored, and the result is re-validated through `coerceReveal` so this
 * cannot be the one write path that produces a reveal the reader would refuse.
 */
export function setClipTextRevealFields(
  doc: TimelineDocument,
  elementId: string,
  patch: RevealFieldPatch,
): TimelineDocument {
  const existing = revealRefOf(doc, elementId);
  if (existing == null) {
    return doc;
  }

  const merged: Record<string, unknown> = { ...existing };
  for (const key of ["progress", "fade"] as const) {
    const value = patch[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      merged[key] = value;
    }
  }

  const next = coerceReveal(merged);
  if (next == null) {
    return doc;
  }
  return withReveal(doc, elementId, next);
}

/** Fold over several clips. Folding preserves the decline contract for free. */
export function setClipTextRevealMany(
  doc: TimelineDocument,
  elementIds: string[],
  unit: RevealUnit | null,
): TimelineDocument {
  return elementIds.reduce(
    (acc, elementId) => setClipTextReveal(acc, elementId, unit),
    doc,
  );
}

export function setClipTextRevealFieldsMany(
  doc: TimelineDocument,
  elementIds: string[],
  patch: RevealFieldPatch,
): TimelineDocument {
  return elementIds.reduce(
    (acc, elementId) => setClipTextRevealFields(acc, elementId, patch),
    doc,
  );
}

/** The values a panel shows for a clip with no reveal yet. */
export const REVEAL_FIELD_DEFAULTS = {
  unit: "character" as RevealUnit,
  progress: DEFAULT_REVEAL_PROGRESS,
  fade: DEFAULT_REVEAL_FADE,
};
