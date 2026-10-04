/**
 * The shape of a graphic element, in one place.
 *
 * Construction split from commitment, as for every other element, so a caller
 * placing several in one undo step can build them first.
 *
 * `localpath: "GRAPHIC"` is a sentinel like `"SHAPE"`: a graphic has no source
 * file. `project/assetsFile.ts` lists it so the asset layer never tries to
 * resolve it as a path.
 */

import { emptyAnimation } from "../animation/keyframes";
import type {
  FxParams,
  GraphicElementType,
  InlineProgram,
} from "../../@types/timeline";
import { inlinePresetId } from "../fx/programHash";

/** How long a graphic lands as when nothing says otherwise. */
export const DEFAULT_GRAPHIC_MS = 4000;

/** The bar colour, matching `clipColor.ts`'s palette entry. */
export const GRAPHIC_CLIP_COLOR = "#ca8a04";

export type GraphicElementOptions = {
  /** An installed preset's id. Ignored when `program` is given. */
  presetId?: string;
  program?: InlineProgram;
  params?: FxParams;
  name: string;
  startTime?: number;
  duration?: number;
  x?: number;
  y?: number;
  width: number;
  height: number;
};

export function createGraphicElement(
  options: GraphicElementOptions,
): GraphicElementType {
  const {
    program,
    params = {},
    name,
    startTime = 0,
    duration = DEFAULT_GRAPHIC_MS,
    x = 0,
    y = 0,
    width,
    height,
  } = options;
  return {
    trackId: "",
    priority: 0,
    blob: "",
    startTime,
    duration,
    opacity: 100,
    location: { x, y },
    rotation: 0,
    width,
    height,
    ratio: height > 0 ? width / height : 1,
    filetype: "graphic",
    localpath: "GRAPHIC",
    name,
    presetId: program != null ? inlinePresetId(program.hash) : (options.presetId ?? ""),
    params,
    ...(program != null ? { program } : {}),
    animation: emptyAnimation("graphic"),
    timelineOptions: { color: GRAPHIC_CLIP_COLOR },
  } as unknown as GraphicElementType;
}
