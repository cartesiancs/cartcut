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
import type {
  ShapeElementType,
  ShapeGeometry,
  ShapeGeometryKind,
} from "../../@types/timeline";
import { normalizeShapeGeometry } from "../shape/shapeGeometry";
import { flattenOutline } from "../shape/shapeOutline";

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

/**
 * The recipe a legacy kind name means.
 *
 * `"triangle"` is not a kind of its own: it is a polygon with three points,
 * which is Figma's arrangement and the reason the vertex count is reachable at
 * all. The name survives here and in `add_shape`'s schema because it is what
 * the create menu and every agent call already say.
 */
export function geometryForKind(
  kind: ShapeKind | ShapeGeometryKind,
): ShapeGeometry {
  if (kind === "triangle") {
    return normalizeShapeGeometry("polygon", { count: 3 });
  }
  return normalizeShapeGeometry(kind as ShapeGeometryKind, {});
}

export type ShapeElementOptions = {
  shape?: number[][];
  kind?: ShapeKind;
  /**
   * The recipe. When present the outline is generated from it and `shape` is
   * filled with its flattened outer boundary, so the pair is consistent from
   * the moment the element exists rather than from its first edit.
   */
  geometry?: ShapeGeometry;
  startTime?: number;
  duration?: number;
  locationX?: number;
  locationY?: number;
  width?: number;
  height?: number;
  /**
   * The box the points are authored in. 100 unless a caller says otherwise, and
   * the polygon tool is the caller that does: it appends vertices in preview
   * coordinates, so its authoring box is the frame rather than the unit hundred.
   */
  oWidth?: number;
  oHeight?: number;
  fillColor?: string;
  opacity?: number;
  rotation?: number;
};

export function createShapeElement({
  shape,
  kind = "rectangle",
  geometry,
  startTime = 0,
  duration = 1000,
  locationX = 0,
  locationY = 0,
  width = 100,
  height = 100,
  oWidth = SHAPE_AUTHORING_BOX,
  oHeight = SHAPE_AUTHORING_BOX,
  fillColor = "#ffffff",
  opacity = 100,
  rotation = 0,
}: ShapeElementOptions): ShapeElementType {
  // A recipe outranks both, and mints the mirror rather than taking one: the
  // two must agree, and the only way to guarantee that is for one of them never
  // to be supplied by a caller.
  const points =
    geometry != null
      ? flattenOutline(geometry, { width: oWidth, height: oHeight })
      : (shape ?? shapePoints(kind));

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
    oWidth,
    oHeight,
    ratio: width / height,
    filetype: "shape",
    localpath: "SHAPE",
    shape: points,
    ...(geometry != null ? { geometry } : {}),
    option: {
      fillColor,
    },
    animation: emptyAnimation("shape"),
    timelineOptions: {
      color: "rgb(59, 143, 179)",
    },
  } as ShapeElementType;
}
