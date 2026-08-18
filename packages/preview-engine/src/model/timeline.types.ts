/**
 * Rendering-domain timeline types for the unified preview/export engine.
 *
 * These are the single source of truth for the shape the renderer consumes.
 * `apps/app/src/@types/timeline.ts` re-exports from here so the editor and the
 * engine never drift. The engine itself is DOM-free and framework-agnostic; the
 * only DOM types referenced are the injected canvas image sources.
 */

export type CubicKeyframeType = {
  type: "cubic" | "linear";
  p: number[];
  cs: number[];
  ce: number[];
};

/** A single animatable track. `ax`/`ay` are the *baked* [ms, value] point pairs
 * the renderer samples with `findNearestY`; `x`/`y` are the authoring form. */
export type AnimationTrack = {
  isActivate?: boolean;
  x?: CubicKeyframeType[];
  y?: CubicKeyframeType[];
  ax?: number[][];
  ay?: number[][];
};

export type ElementAnimation = {
  position?: AnimationTrack;
  opacity?: AnimationTrack;
  scale?: AnimationTrack;
  rotation?: AnimationTrack;
};

export type VideoFilterType = {
  name: "chromakey" | "blur" | "radialblur";
  value: string; // e.g. chromakey => "r=0:g=0:b=0:f=0.5" (":" separated)
};

export type ElementFileType =
  | "image"
  | "gif"
  | "video"
  | "text"
  | "shape"
  | "audio";

/**
 * The renderer treats the timeline as a flat map of elements, each an
 * intersection of every element variant (mirrors the app's `Timeline` type).
 * Every field is optional and co-present at the type level; `filetype` selects
 * which drawer/behaviour applies at runtime.
 */
export type RenderElement = {
  key?: string;
  filetype?: ElementFileType | string;
  priority?: number;

  startTime?: number;
  duration?: number;
  speed?: number;
  trim?: { startTime: number; endTime: number };

  location?: { x: number; y: number };
  rotation?: number;
  opacity?: number;
  width?: number;
  height?: number;
  oWidth?: number;
  oHeight?: number;

  localpath?: string;
  ratio?: number;

  animation?: ElementAnimation;

  // text
  parentKey?: string | "standalone";
  text?: string;
  textcolor?: string;
  fontsize?: number;
  fontname?: string;
  fontpath?: string;
  letterSpacing?: number;
  widthInner?: number;
  options?: {
    isBold?: boolean;
    isItalic?: boolean;
    align?: "left" | "center" | "right";
    outline?: { enable?: boolean; size?: number | string; color?: string };
  };
  background?: { enable?: boolean; color?: string };

  // shape
  shape?: number[][];
  option?: { fillColor?: string };

  // video
  filter?: { enable?: boolean; list?: VideoFilterType[] };
  isExistAudio?: boolean;
  codec?: { video: string; audio: string };

  timelineOptions?: { color?: string };
};

/** Flat, id-keyed map of elements — the renderer's scene graph. */
export type RenderTimeline = Record<string, RenderElement>;

export type RenderOptions = {
  /** Project canvas width in px (export = real size, preview = same, scaled by CSS). */
  width: number;
  height: number;
  /** Preview downscale ratio; export uses 1. Currently informational to the core. */
  previewRatio?: number;
  backgroundColor?: string;
};
