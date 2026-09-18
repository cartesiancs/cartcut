/**
 * Reframing a clip to part of its source.
 *
 * The read half (`cropOf`) answers what part of the frame a clip shows; the
 * write half (`setClipCrop`) changes it. They are shaped like `mirrorOps.ts` and
 * `blendOps.ts` and hold the same three rules: only video and image can carry
 * one, cropping back to the whole frame **deletes the key** rather than storing
 * `{0, 0, 1, 1}`, and declining returns the document by identity so
 * `withCheckpoint` records no undo step.
 *
 * Where it is drawn is `renderer/crop.ts`, inside the element's box beside the
 * mirror, so no per-type renderer had to learn about it.
 *
 * ## The box shrinks, and the picture does not move
 *
 * This is the whole design, and it is what "crop" means to a person: the edges
 * you cut off disappear and everything else stays exactly where it was. So a
 * crop is not one field but three, written together: the rect, the box, and the
 * location. Leave the box alone and the kept region would be stretched across
 * the old one, distorting; leave the location alone and the picture would jump
 * by whatever the crop's offset happened to be.
 *
 * Shrinking the box rather than keeping it is also what makes the *rest* of the
 * app right for free. `sampledBoxOf` is the one way anything asks how big a clip
 * is, so the selection outline, the eight grips, the hit test and the resize
 * origin all move onto the cropped picture without knowing this feature exists.
 * That is the opposite trade from `mirror.ts`, which deliberately keeps the box:
 * a flip is symmetric about the box centre and a crop is not.
 *
 * ## Why the location is not simply an offset
 *
 * `transform.ts#localMatrixOf` composes as `location + centre + RS*(p - centre)`.
 * It turns the box about **the centre of the box**, and that centre moves the
 * instant `width` or `height` change. So holding the kept picture still by
 * adding the crop's offset to `location` only works while the clip is upright;
 * rotate or scale it and the picture swings around the moving centre.
 *
 * Writing the composition out for a point before and after, and requiring the
 * two to land on the same parent-space point, gives the term `anchoredAt` in
 * `preview/resizeMath.ts` also carries. See `recroppedBox` below.
 *
 * ## A mask is compensated, or left alone, never half of each
 *
 * `MaskType.location` and `size` are percentages of the element box, so a
 * shrinking box would slide the mask across the picture it was drawn on. The
 * static pair is therefore rewritten by the same correction. When any of the
 * five mask tracks is armed those fields are dead data, because the baked lane
 * wins at draw time, so the mask is left entirely alone instead and the user re-aims
 * it. Correcting one half of a pair nothing reads would be worse than
 * correcting neither.
 *
 * `feather` is in element-local *pixels* and is deliberately untouched: a crop
 * does not change pixel scale, only how much of the picture is kept.
 */

import type {
  CropRect,
  MaskType,
  TimelineElement,
} from "../../@types/timeline";
import { maskOf } from "../mask/maskShape";
import { mirrorOf } from "./mirrorOps";
import { addKeyframe } from "../animation/keyframeOps";
import {
  applyVector,
  localMatrixOf,
  localSampleAt,
  sampledBoxOf,
  type Mat,
  type Point,
} from "./transform";
import type { TimelineDocument } from "./tracks";

/**
 * The element types that have a source frame to take a part of.
 *
 * Exactly the members of the `Croppable` mixin, and exactly `MIRRORABLE_FILETYPES`.
 * Kept as a value so a caller can name them in an error message rather than
 * repeating the list.
 */
export const CROPPABLE_FILETYPES = ["video", "image"] as const;

const CROPPABLE = new Set<string>(CROPPABLE_FILETYPES);

/** The whole frame: what an uncropped clip shows, and what deletes the key. */
export const FULL_CROP: CropRect = { x: 0, y: 0, width: 1, height: 1 };

/**
 * The smallest fraction of the frame a crop may keep, per axis.
 *
 * Not a taste limit. `renderer/crop.ts` divides by `width` and `height`, and the
 * crop tool derives the whole frame's box as `box.width / crop.width`, so a
 * fraction near zero makes both explode. One percent of the frame is far below
 * anything usable and far above where the arithmetic gets fragile.
 */
export const MIN_CROP = 0.01;

/**
 * How close to the whole frame still counts as uncropped.
 *
 * A drag that lands a hair away from the edge must not leave a clip permanently
 * carrying a crop key that changes no pixel, because that key is the difference
 * between a project that saves byte-identically to one written before this
 * feature and one that does not.
 */
const CROP_EPSILON = 1e-6;

/** Whether this element is one a crop can be set on. */
export function isCroppable(
  element: TimelineElement | undefined | null,
): boolean {
  return element != null && CROPPABLE.has(element.filetype);
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

/**
 * Put a rect inside the frame, whatever it arrived as.
 *
 * Both halves of the pair go through here, which is what keeps `cropOf` and
 * `coerceCrop` from disagreeing about what a usable rect is. The order matters:
 * the size is clamped first, because clamping the origin against an oversized
 * width would push it negative.
 */
function normalizeCrop(raw: Record<string, unknown>): CropRect {
  const width = clamp(finiteOr(raw.width, 1), MIN_CROP, 1);
  const height = clamp(finiteOr(raw.height, 1), MIN_CROP, 1);
  return {
    x: clamp(finiteOr(raw.x, 0), 0, 1 - width),
    y: clamp(finiteOr(raw.y, 0), 0, 1 - height),
    width,
    height,
  };
}

/**
 * What part of its frame this clip shows. The read guard: absent, malformed or
 * unusable all read as the whole frame, so this runs on every draw and can
 * never throw.
 */
export function cropOf(element: TimelineElement | undefined | null): CropRect {
  const raw = (element as { crop?: unknown } | undefined | null)?.crop;
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return FULL_CROP;
  }
  return normalizeCrop(raw as Record<string, unknown>);
}

/** Whether this rect actually cuts anything away. */
export function isCropped(crop: CropRect): boolean {
  return (
    crop.x > CROP_EPSILON ||
    crop.y > CROP_EPSILON ||
    crop.width < 1 - CROP_EPSILON ||
    crop.height < 1 - CROP_EPSILON
  );
}

/**
 * Validate a rect on the way in. The write half: `null` for anything that is not
 * a rect at all, and a clamped rect for one that is merely out of range.
 */
export function coerceCrop(value: unknown): CropRect | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  for (const key of ["x", "y", "width", "height"] as const) {
    const found = raw[key];
    if (typeof found !== "number" || !Number.isFinite(found)) {
      return null;
    }
  }
  if ((raw.width as number) <= 0 || (raw.height as number) <= 0) {
    return null;
  }
  return normalizeCrop(raw);
}

/** Whether two rects mean the same framing. */
export function sameCrop(a: CropRect, b: CropRect): boolean {
  return (
    Math.abs(a.x - b.x) <= CROP_EPSILON &&
    Math.abs(a.y - b.y) <= CROP_EPSILON &&
    Math.abs(a.width - b.width) <= CROP_EPSILON &&
    Math.abs(a.height - b.height) <= CROP_EPSILON
  );
}

/**
 * The box the **whole source frame** would occupy, given a clip's drawn box and
 * the crop that produced it.
 *
 * The single derivation of the uncropped extent. Nothing stores it: the crop
 * tool, the overlay and every op ask here, so none of them can hold a stale copy
 * of a number the others have moved on from.
 */
export function frameBoxOf(
  box: { width: number; height: number },
  crop: CropRect,
): { width: number; height: number } {
  return { width: box.width / crop.width, height: box.height / crop.height };
}

/**
 * How far the new box's corner sits from the old one, in the clip's own local
 * pixels, before any rotation or scale is applied to it.
 *
 * **A mirrored axis measures from the other edge**, and that is not a special
 * case bolted on: `renderer/mirror.ts` flips the picture *inside the box*, about
 * the box's centre, and the box's centre moves when the box shrinks. So on a
 * flipped axis the part of the frame that stays still is the one against the
 * far edge, and the corner has to move by the change in the distance from
 * *that* edge rather than from the near one.
 *
 * Writing it out for a horizontally mirrored clip: a source point `u` is drawn
 * at `L + W - u*Wf`, so holding it still across a crop needs
 * `L1 = L0 + Wf*(1 - to.x - to.width)`, which is this function's mirrored branch.
 *
 * The mask goes through here too. A mask is resolved before the mirror and so
 * lives in unflipped box coordinates, but what it has to follow is where the
 * *box* went, which is exactly this.
 */
function originShift(
  from: CropRect,
  to: CropRect,
  frame: { width: number; height: number },
  mirror: { h: boolean; v: boolean },
): Point {
  return {
    x: mirror.h
      ? (from.x + from.width - (to.x + to.width)) * frame.width
      : (to.x - from.x) * frame.width,
    y: mirror.v
      ? (from.y + from.height - (to.y + to.height)) * frame.height
      : (to.y - from.y) * frame.height,
  };
}

/** What a crop does to a clip's rectangle, in the space `location` lives in. */
export type RecropInput = {
  /** The drawn box now: `sampledBoxOf`, never `element.width`. */
  box: { width: number; height: number };
  /** Where the clip is drawn in parent space now. */
  drawnAt: Point;
  /** The crop the clip has now. */
  from: CropRect;
  /** The crop it is being given. */
  to: CropRect;
  /**
   * The element's own local matrix (`localMatrixOf`), the one the renderer draws
   * with. Only its linear part is read, so the rotation and scale it carries are
   * what matter.
   */
  linear: Mat;
  /**
   * Which axes the clip's picture is flipped on. Absent means neither.
   *
   * Load-bearing rather than a detail: see `originShift`. Without it a mirrored
   * clip's picture slides by twice the crop's offset, which is invisible in
   * every axis-aligned test and obvious the moment anyone crops a flipped shot.
   */
  mirror?: { h: boolean; v: boolean };
};

/**
 * Where the box and its corner go, so the kept picture does not move.
 *
 * With `Wf = W0 / from.width` the whole frame's width, `d` the new box's origin
 * expressed in the old box's own coordinates, and `C` each box's centre:
 *
 * ```
 * W1 = to.width * Wf                       H1 = to.height * Hf
 * d  = ((to.x - from.x)*Wf, (to.y - from.y)*Hf)
 * L1 = L0 + C0 - C1 + RS*(C1 + d - C0)
 * ```
 *
 * The derivation: a box-local point `p` lands at `L + C + RS*(p - C)`. The same
 * picture point sits at `p` in the old box and at `p − d` in the new one.
 * Requiring both to reach the same parent-space point, for every `p`, leaves
 * exactly the line above, and every `p` term cancels, which is the check that
 * it is a rigid move rather than an approximation.
 *
 * At `RS = I` it collapses to `L1 = L0 + d`, the obvious answer, which is what
 * makes an upright clip behave exactly as one would guess.
 */
export function recroppedBox(input: RecropInput): {
  width: number;
  height: number;
  location: Point;
} {
  const { box, drawnAt, from, to, linear } = input;

  const frame = frameBoxOf(box, from);
  const width = to.width * frame.width;
  const height = to.height * frame.height;

  const d = originShift(
    from,
    to,
    frame,
    input.mirror ?? { h: false, v: false },
  );

  const halfOld = { x: box.width / 2, y: box.height / 2 };
  const halfNew = { x: width / 2, y: height / 2 };

  const swing = applyVector(linear, {
    x: halfNew.x + d.x - halfOld.x,
    y: halfNew.y + d.y - halfOld.y,
  });

  return {
    width,
    height,
    location: {
      x: drawnAt.x + halfOld.x - halfNew.x + swing.x,
      y: drawnAt.y + halfOld.y - halfNew.y + swing.y,
    },
  };
}

/**
 * The mask this clip should carry after a crop, or `null` to leave it alone.
 *
 * Percentages of the box, so they have to be re-expressed against the new one.
 * `null` both for a clip with no mask and for one whose mask is animated: see
 * this file's header for why a half-corrected mask is worse than an uncorrected
 * one.
 */
function recroppedMask(
  element: TimelineElement,
  before: { width: number; height: number },
  after: { width: number; height: number },
  d: Point,
): MaskType | null {
  const mask = maskOf(element);
  if (mask == null) {
    return null;
  }
  if (!(after.width > 0) || !(after.height > 0)) {
    return null;
  }

  const animation = (element as { animation?: Record<string, any> }).animation;
  if (animation != null) {
    for (const property of [
      "maskPosition",
      "maskSize",
      "maskRotation",
      "maskFeather",
      "maskRoundness",
    ]) {
      if (animation[property]?.isActivate === true) {
        return null;
      }
    }
  }

  // Centre and size in element-local pixels, moved by the same offset the box
  // moved by, then re-expressed against the box they now sit in.
  const centreX = (mask.location.x / 100) * before.width - d.x;
  const centreY = (mask.location.y / 100) * before.height - d.y;

  return {
    ...mask,
    location: {
      x: (centreX / after.width) * 100,
      y: (centreY / after.height) * 100,
    },
    size: {
      width: ((mask.size.width / 100) * before.width / after.width) * 100,
      height: ((mask.size.height / 100) * before.height / after.height) * 100,
    },
  };
}

/**
 * Reframe one clip, or clear its crop.
 *
 * Declines, returning `doc` itself, for an id that is not in the document, an
 * element that cannot be cropped, a rect that is not usable, and a framing the
 * clip already has.
 *
 * `cursor` is the timeline cursor in milliseconds; `atMs` inside is the clip's
 * own time, which is the space a keyframe lives in. Both `cursor` and `bakeHz`
 * are arguments rather than store reads, which is what keeps this module
 * DOM-free and node-testable.
 */
export function setClipCrop(
  doc: TimelineDocument,
  elementId: string,
  next: CropRect,
  cursor: number,
  bakeHz?: number,
): TimelineDocument {
  const element = doc.elements[elementId];
  if (!isCroppable(element)) {
    return doc;
  }

  const to = coerceCrop(next);
  if (to == null) {
    return doc;
  }

  const from = cropOf(element);
  if (sameCrop(from, to)) {
    return doc;
  }

  const box = sampledBoxOf(element, cursor);
  if (!(box.width > 0) || !(box.height > 0)) {
    // A clip with no extent has no frame to take a part of, and dividing by its
    // box would put the whole document at NaN.
    return doc;
  }

  const any = element as any;

  // Where the clip is *drawn* now, which is not its `location` field once a
  // position track is armed. Keeping both is what lets the write stay absolute
  // without mixing the two spaces, exactly as `resizeMath.ts#resizedDocument`
  // does: one is where the track puts the clip at this cursor, the other is the
  // field the correction has to be written back into.
  const sample = localSampleAt(element, cursor);

  const mirror = mirrorOf(element);
  const drawn = recroppedBox({
    box,
    drawnAt: { x: sample.x, y: sample.y },
    from,
    to,
    linear: localMatrixOf(element, cursor),
    mirror,
  });

  // The correction, measured against the drawn rect and applied to the static
  // field, so the animated and static positions never mix.
  const d = {
    x: drawn.location.x - sample.x,
    y: drawn.location.y - sample.y,
  };

  // The box's own move, in the clip's **local** space, for the mask. Not the
  // same vector as `d`, which is in the parent's space with the rotation and
  // scale already applied to it. Through `originShift` like the box, so a
  // mirrored clip's mask follows its box rather than sliding the other way.
  const localOffset = originShift(from, to, frameBoxOf(box, from), mirror);

  const mask = recroppedMask(
    element,
    box,
    { width: drawn.width, height: drawn.height },
    localOffset,
  );

  // The keyframes at the playhead, where the clip's box or position is animated
  // the same pairing `preview/resizeMath.ts#resizedDocument` makes, and for
  // the same reason: without them the outline and the grips would move while the
  // picture stayed put, because a sampled value overrides the static field at
  // draw time.
  //
  // `atMs` is the clip's own time, which is the space a keyframe lives in.
  const atMs = cursor - (any.startTime ?? 0);
  let withKeyframes = doc;
  if (Number.isFinite(atMs) && any.animation?.size?.isActivate === true) {
    withKeyframes = addKeyframe(
      addKeyframe(
        withKeyframes,
        elementId,
        "size",
        "x",
        atMs,
        drawn.width,
        undefined,
        bakeHz,
      ),
      elementId,
      "size",
      "y",
      atMs,
      drawn.height,
      undefined,
      bakeHz,
    );
  }
  if (Number.isFinite(atMs) && any.animation?.position?.isActivate === true) {
    // The position track's values live in parent space, which is the space
    // `drawn.location` is already in, so this stays an absolute setter rather
    // than an adjustment that could be applied twice.
    withKeyframes = addKeyframe(
      addKeyframe(
        withKeyframes,
        elementId,
        "position",
        "x",
        atMs,
        drawn.location.x,
        undefined,
        bakeHz,
      ),
      elementId,
      "position",
      "y",
      atMs,
      drawn.location.y,
      undefined,
      bakeHz,
    );
  }

  const staticLocation = {
    x: (any.location?.x ?? 0) + d.x,
    y: (any.location?.y ?? 0) + d.y,
  };

  const settled = withKeyframes.elements[elementId] as TimelineElement &
    Record<string, unknown>;

  let updated: Record<string, unknown> = {
    ...settled,
    width: drawn.width,
    height: drawn.height,
    location: staticLocation,
  };

  if (mask != null) {
    updated.mask = mask;
  }

  if (isCropped(to)) {
    updated.crop = to;
  } else {
    // Removed, not set to `undefined`: `JSON.stringify` drops an undefined value
    // and `structuredClone` keeps it, so a stored `undefined` makes the saved
    // project and the one in memory disagree.
    const { crop: _cleared, ...rest } = updated;
    updated = rest;
  }

  return {
    ...withKeyframes,
    elements: {
      ...withKeyframes.elements,
      [elementId]: updated as TimelineElement,
    },
  };
}

/** Put the whole frame back, deleting the key. */
export function resetClipCrop(
  doc: TimelineDocument,
  elementId: string,
  cursor: number,
  bakeHz?: number,
): TimelineDocument {
  return setClipCrop(doc, elementId, FULL_CROP, cursor, bakeHz);
}
