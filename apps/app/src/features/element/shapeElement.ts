/**
 * The shape of a shape element, in one place.
 *
 * `previewTopBar.createShape` used to be the only way to make one, and it both
 * built the element and committed it. Splitting construction from commitment is
 * the same move `textElement.ts` made, and for the same reason: a caller that
 * wants to place several in one undo step cannot use a function that checkpoints
 * on its way out.
 *
 * Points are authored in a 0-100 box and `width`/`height` scale them, which is
 * the space `previewTopBar` already worked in — `oWidth`/`oHeight` record the
 * authoring box so a resize can be expressed as a ratio against it.
 */

import { emptyAnimation } from "../animation/keyframes";
import type { ShapeElementType } from "../../@types/timeline";

export type ShapeKind = "rectangle" | "ellipse" | "triangle";

/** How many segments approximate an ellipse. Matches the preview's own value. */
const ELLIPSE_SEGMENTS = 50;

/**
 * The box points are authored in, and therefore what `oWidth`/`oHeight` hold.
 *
 * `renderShape` paints each point at `point * (width / oWidth)`. Recording the
 * *drawn* size here instead makes that ratio 1 for every shape, so the polygon
 * is painted at 100x100 whatever size was asked for — the width and height only
 * move the selection box. That went unnoticed because the one UI path calls
 * this with no size at all and lands on the 100 default by accident; `add_shape`
 * is the only caller that passes one, and its bar came out a small square.
 */
export const SHAPE_AUTHORING_BOX = 100;

/** Points in the 0..100 box, for one of the built-in kinds. */
export function shapePoints(
  kind: ShapeKind,
  segments: number = ELLIPSE_SEGMENTS,
): number[][] {
  switch (kind) {
    case "triangle":
      return [
        [50, 0],
        [0, 100],
        [100, 100],
      ];
    case "ellipse": {
      const points: number[][] = [];
      const radius = 50;
      for (let i = 0; i < segments; i++) {
        const angle = (2 * Math.PI * i) / segments;
        points.push([
          radius + radius * Math.cos(angle),
          radius + radius * Math.sin(angle),
        ]);
      }
      return points;
    }
    case "rectangle":
    default:
      return [
        [0, 0],
        [0, 100],
        [100, 100],
        [100, 0],
      ];
  }
}

export type ShapeElementOptions = {
  shape?: number[][];
  kind?: ShapeKind;
  startTime?: number;
  duration?: number;
  locationX?: number;
  locationY?: number;
  width?: number;
  height?: number;
  fillColor?: string;
  opacity?: number;
  rotation?: number;
};

export function createShapeElement({
  shape,
  kind = "rectangle",
  startTime = 0,
  duration = 1000,
  locationX = 0,
  locationY = 0,
  width = 100,
  height = 100,
  fillColor = "#ffffff",
  opacity = 100,
  rotation = 0,
}: ShapeElementOptions): ShapeElementType {
  const points = shape ?? shapePoints(kind);

  return {
    // Both are supplied by `placeNewElement`, which picks the track and derives
    // the paint rank from it.
    trackId: "",
    priority: 0,
    blob: "",
    startTime,
    duration,
    opacity,
    location: { x: locationX, y: locationY },
    rotation,
    width,
    height,
    oWidth: SHAPE_AUTHORING_BOX,
    oHeight: SHAPE_AUTHORING_BOX,
    ratio: width / height,
    filetype: "shape",
    localpath: "SHAPE",
    shape: points,
    option: {
      fillColor,
    },
    animation: emptyAnimation("shape"),
    timelineOptions: {
      color: "rgb(59, 143, 179)",
    },
  } as ShapeElementType;
}
