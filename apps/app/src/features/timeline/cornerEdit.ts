/**
 * What the Corners field does with a number, as a pure function.
 *
 * Out of `option/controlClipCorners.ts` so the rule can be checked in node,
 * and out of `cornerOps.ts` because it needs `keyframeOps`, which already
 * imports `cornerOps` for its static value.
 *
 * The rule is `controlAudioVolume.ts#handleVolume`'s. A keyframe is written
 * **only where the track is already armed**, so the one box is both the static
 * control and the curve's authoring surface with no mode switch. The keyframe
 * goes first and the static field second, in one document, so the two land in
 * one undo step and the field holds the value the curve falls back to once its
 * last key is gone.
 */

import { addKeyframe } from "../animation/keyframeOps";
import { coerceCornerRadius, isRoundable, setCornerRadius } from "./cornerOps";
import type { TimelineDocument } from "./tracks";

export function editCornerRadius(
  doc: TimelineDocument,
  elementId: string,
  radius: number,
  cursorMs: number,
  bakeHz: number,
): TimelineDocument {
  const element: any = doc.elements[elementId];
  const value = coerceCornerRadius(radius);
  if (!isRoundable(element) || value == null) {
    return doc;
  }
  const keyed =
    element.animation?.cornerRadius?.isActivate === true
      ? addKeyframe(
          doc,
          elementId,
          "cornerRadius",
          "x",
          cursorMs - element.startTime,
          value,
          undefined,
          bakeHz,
        )
      : doc;
  return setCornerRadius(keyed, elementId, value);
}
