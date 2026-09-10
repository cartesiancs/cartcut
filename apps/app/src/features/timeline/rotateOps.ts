/**
 * Quantized rotation — the "turn it 90°" button, as a pure op.
 *
 * `rotation` has existed on every visual element all along, editable as a
 * free-form number in the sidebar and by dragging in the preview. What was
 * missing is the one move people actually want most of the time: footage shot
 * sideways, turned upright in a single click.
 *
 * Degrees, not radians. `features/math/geom.ts#toRadian` converts once at draw
 * time, and everything that authors the field — the sidebar spinner, the
 * preview's rotate handle — writes degrees. So a quarter turn is `+90`.
 *
 * The one subtlety is animated rotation. Reading `element.rotation` when a
 * rotation track is active would rotate away from a value that is not the one
 * on screen, so the base comes from the same sampler the sidebar reads
 * (`controlDefaultTransform#getRotation`) and the new value is planted as a
 * keyframe as well as written to the static field — mirroring what that panel's
 * `commitValue` does, so the two paths cannot disagree.
 */

import type { AnimatableProperty, TimelineElement } from "../../@types/timeline";
import { sampleTrack } from "../animation/keyframes";
import { addKeyframe } from "../animation/keyframeOps";
import { setIn } from "../../utils/immutable";
import { normalizeDocument, type TimelineDocument } from "./tracks";

const ROTATION: AnimatableProperty = "rotation";

/** Elements that can be turned. Audio has no transform; everything else does. */
function hasRotation(
  element: TimelineElement | undefined | null,
): element is TimelineElement & { rotation: number } {
  return typeof (element as any)?.rotation === "number";
}

function rotationTrack(element: TimelineElement) {
  return (element as any)?.animation?.[ROTATION];
}

function isRotationAnimated(element: TimelineElement): boolean {
  return rotationTrack(element)?.isActivate === true;
}

/**
 * Fold into `[0, 360)`.
 *
 * Without this, four clicks of a "rotate 90°" button leave the field reading
 * 360 rather than 0, and a hundred clicks leave it reading 9000 — the clip
 * looks right and the sidebar looks broken.
 */
export function normalizeDegrees(deg: number): number {
  const wrapped = deg % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

/** Whether `rotateClips` would turn anything. */
export function canRotateClips(
  doc: TimelineDocument,
  elementIds: string[],
): boolean {
  return elementIds.some((id) => hasRotation(doc.elements[id]));
}

/**
 * Turn every rotatable clip in the selection by `deltaDeg`.
 *
 * Declines by identity when nothing in the selection can be turned — an
 * audio-only selection, or ids that are not in the document — so the button
 * costs no undo step.
 *
 * Rotating a group turns its children with it, which is correct: `parentId` is
 * a coordinate-space parent, and that is the whole point of grouping clips
 * before rotating them as one.
 */
export function rotateClips(
  doc: TimelineDocument,
  elementIds: string[],
  deltaDeg: number,
  cursorMs: number,
  bakeHz?: number,
): TimelineDocument {
  const targets = [...new Set(elementIds)].filter((id) =>
    hasRotation(doc.elements[id]),
  );
  if (targets.length === 0) {
    return doc;
  }

  let next = doc;

  for (const id of targets) {
    const element = next.elements[id];
    if (!hasRotation(element)) {
      continue;
    }

    const animated = isRotationAnimated(element);
    const base = animated
      ? sampleTrack(
          rotationTrack(element),
          element.startTime,
          cursorMs,
          element.rotation,
        )
      : element.rotation;

    const turned = normalizeDegrees(base + deltaDeg);

    if (animated) {
      // Keyframe times are relative to the clip's own start, as everywhere
      // else that authors one.
      next = addKeyframe(
        next,
        id,
        ROTATION,
        "x",
        cursorMs - element.startTime,
        turned,
        undefined,
        // Threaded in, never read from the store: this module is DOM-free and
        // node-tested. The op's own default is 60Hz, which under-bakes a
        // 120fps project and makes the turn step.
        bakeHz,
      );
    }

    next = {
      ...next,
      elements: {
        ...next.elements,
        [id]: setIn(next.elements[id], ["rotation"], turned),
      },
    };
  }

  return normalizeDocument(next);
}
