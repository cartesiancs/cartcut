/**
 * Turning a text clip into the picture of itself — "render and replace".
 *
 * The document half of the operation, and only that half. Producing the PNG
 * needs a canvas and an IPC round trip, neither of which belongs in a pure op;
 * `features/element/rasterizeText.ts` does that, and hands the finished path
 * and box in here.
 *
 * Modelled on `timeline/audio.ts#audioTwinOf` + `audioOps.ts#detachAudio`, the
 * only other place in this repo where one element becomes another kind. The
 * difference is that detaching *adds* a clip while this one *replaces*: the
 * image stands exactly where the text stood, so it keeps the same element id
 * and the same `trackId` rather than being routed through `placeNewElement`.
 * Reusing the id is what makes the swap invisible to everything keyed on it —
 * selection, keyframes, group membership.
 *
 * Why replace rather than hide the text behind the image: the text element is
 * one `withCheckpoint` away, and Cmd+Z brings it back with every property
 * intact. Keeping a shadow copy in the document would mean two clips claiming
 * one slot, and every op in `clipOps` would have to learn about it.
 */

import type {
  ImageElementType,
  TextElementType,
  TimelineElement,
} from "../../@types/timeline";
import { cloneAnimation } from "../animation/keyframes";
import { normalizeDocument, type TimelineDocument } from "./tracks";

/** The colour `elementControl.addImage` gives an image clip on the timeline. */
const IMAGE_CLIP_COLOR = "rgb(134, 41, 143)";

/**
 * Where the baked picture sits, in the same space the text element used.
 *
 * Not simply the text's own box: shadow, glow and outline all paint outside it,
 * so the bitmap is grown by `styleBleed` on every side and its origin moves up
 * and left by the same amount. Getting this wrong crops exactly the effects
 * this feature exists to add.
 */
export type RasterBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/**
 * The image element that stands in for a text element.
 *
 * Carries across everything that describes *where and when* the clip is —
 * track, time, rotation, opacity, animation — and drops everything that
 * describes how to draw glyphs, because there are no glyphs any more.
 *
 * `parentId` **is** carried over, unlike `audioTwinOf`, which drops it: a group
 * is a spatial transform parent, and an image has a `location` for it to
 * transform. A rasterised title inside a group must keep moving with it.
 */
export function imageTwinOf(
  text: TextElementType,
  localpath: string,
  box: RasterBox,
): ImageElementType {
  const twin: ImageElementType = {
    filetype: "image",
    key: text.key,
    localpath,
    blob: "",
    trackId: text.trackId,
    priority: text.priority,
    startTime: text.startTime,
    duration: text.duration,
    location: { x: box.x, y: box.y },
    width: box.width,
    height: box.height,
    // The native proportions of the file just written, which for a generated
    // PNG are exactly the box it was drawn at.
    ratio: box.height === 0 ? 1 : box.width / box.height,
    opacity: text.opacity,
    rotation: text.rotation,
    // A deep copy: the animation block holds arrays, and sharing them with the
    // text element still sitting in the undo history would let a later
    // keyframe edit reach backwards into it.
    animation: cloneAnimation(text).animation,
    timelineOptions: { color: IMAGE_CLIP_COLOR },
  } as ImageElementType;

  if (text.parentId != null) {
    twin.parentId = text.parentId;
  }

  return twin;
}

/** Only a text clip can be rasterised. */
export function canRasterize(
  element: TimelineElement | undefined,
): element is TextElementType {
  return element != null && element.filetype === "text";
}

/**
 * Replace one text clip with its picture.
 *
 * Returns `doc` **by identity** when the id names something that is not text,
 * which is how `withCheckpoint` knows not to record an undo step — the
 * convention every op in `clipOps.ts` follows.
 */
export function rasterizeTextInDoc(
  doc: TimelineDocument,
  elementId: string,
  localpath: string,
  box: RasterBox,
): TimelineDocument {
  const text = doc.elements[elementId];
  if (!canRasterize(text)) {
    return doc;
  }

  return normalizeDocument({
    ...doc,
    elements: {
      ...doc.elements,
      [elementId]: imageTwinOf(text, localpath, box),
    },
  });
}
