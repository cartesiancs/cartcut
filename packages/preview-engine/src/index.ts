/**
 * @nugget/preview-engine — the rendering engine the app is being consolidated onto.
 *
 * Target state: one compositing implementation shared by the live preview
 * (`<preview-canvas>`) and both export paths (in-app V2 export and the offscreen
 * render window). The migration is staged — see the plan's Step 3-5 — so during
 * the cut-over some call-sites still run their own copy. Nothing new should be
 * written against those copies.
 *
 * Everything here except `filters/glFilter` is DOM-free and unit-tested against a
 * headless canvas; glFilter needs a real WebGL context and is browser-only.
 */

// model
export * from "./model/timeline.types";
export { getElementType } from "./model/elementType";
export type { ElementKind } from "./model/elementType";

// animation sampling
export {
  findNearestY,
  zeroIfNegative,
  isBeforeElementStart,
  sampleScale,
  sampleRotation,
  samplePosition,
  sampleOpacityAlpha,
} from "./animation/sample";

// core frame model
export { resolveStartTime } from "./core/startTime";
export {
  isElementVisibleAtTime,
  getVisibleElementIds,
} from "./core/visibility";
export { sortIdsByPriority, sortTimelineByPriority } from "./core/priority";

// text layout
export { wrapTextLines } from "./text/wrap";
export type { MeasureText } from "./text/wrap";
export {
  alignedLineX,
  textBackgroundBox,
  TEXT_BACKGROUND_PADDING,
} from "./text/layout";
export type { TextAlign } from "./text/layout";

// assets
export { pickGifFrameIndex } from "./assets/gifFrame";

// export frame loop
export { runFrameLoop } from "./loop/frameLoop";
export type {
  FrameSink,
  FrameLoopDeps,
  FrameLoopSpec,
  FrameLoopHooks,
  FrameLoopProgress,
  FrameLoopResult,
} from "./loop/frameLoop";

// browser adapters (DOM-dependent, like glFilter)
export {
  createPreloadedResolver,
  createVideoSeeker,
  createCanvasEncoder,
} from "./adapters/preloadedAssets";
export type { LoadedMedia } from "./adapters/preloadedAssets";

// filters
export {
  parseRGBString,
  parseBlurString,
} from "./filters/parseFilter";
export type { ChromaKeyParams, BlurParams } from "./filters/parseFilter";
export { glFilter } from "./filters/glFilter";

// draw layer — the single compositing path
export { renderFrame, resolveFrameElementIds } from "./render/renderFrame";
export { resolveBoxTransform } from "./render/transform";
export type { BoxTransform, BoxTransformOptions } from "./render/transform";
export { resolveElementBox } from "./render/box";
export type { ElementBox } from "./render/box";
export { drawImage } from "./render/drawers/image";
export { drawGif } from "./render/drawers/gif";
export { drawVideo } from "./render/drawers/video";
export { drawText } from "./render/drawers/text";
export { drawShape } from "./render/drawers/shape";
export type {
  CanvasCtx,
  ImageSource,
  VideoHandle,
  AssetResolver,
  RenderDeps,
  RenderFrameOptions,
  RenderFrameResult,
} from "./render/types";
