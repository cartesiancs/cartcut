import { ParsedFrame } from "gifuct-js";

export type CubicKeyframeType = {
  type: "cubic" | "linear";
  p: number[];
  cs: number[];
  ce: number[];
};

export type VideoFilterType = {
  name: "chromakey" | "blur" | "radialblur";
  value: string; //  if chromakey => r=0:g=0:b=0. 구분자는 : 로 구분합니다.
};

type TimelineElementType =
  | "video"
  | "image"
  | "gif"
  | "shape"
  | "text"
  | "audio";

type TimelinePlaced = {
  filetype: TimelineElementType;
  key: string;
  localpath: string;
  /** Which track (row) this clip sits on. Many clips may share one. */
  trackId: string;
  /**
   * Paint rank, back to front.
   *
   * DERIVED — never authored. `features/timeline/tracks.ts#derivePriorities`
   * recomputes it from track order on every mutation; it survives only so the
   * compositor and both FFmpeg paths keep working while the UI migrates to
   * tracks.
   */
  priority: number;
  blob: string;
  startTime: number;
  duration: number;
  location: { x: number; y: number };
  timelineOptions: {
    color: string;
  };
};

type Visual = {
  width: number;
  height: number;
  ratio: number;
  opacity: number;
  rotation: number;
};

// Shape는 opacity만 애니메이팅 가능하므로 다른 속성을 지원할 때 까지 임시 타입을 사용한다
type OpacityAnimatable = {
  animation: {
    opacity: {
      isActivate: boolean;
      x: CubicKeyframeType[];
      ax: number[][];
    };
  };
};

type Animatable = OpacityAnimatable & {
  animation: {
    position: {
      isActivate: boolean;
      x: CubicKeyframeType[];
      y: CubicKeyframeType[];

      ax: number[][];
      ay: number[][];
    };
    scale: {
      isActivate: boolean;
      x: CubicKeyframeType[];
      ax: number[][];
    };
    rotation: {
      isActivate: boolean;
      x: CubicKeyframeType[];
      ax: number[][];
    };
  };
};

export type ImageElementType = TimelinePlaced &
  Visual &
  Animatable & {
    filetype: "image";
  };

export type GifElementType = TimelinePlaced &
  Visual & {
    filetype: "gif";
  };

export type ShapeElementType = TimelinePlaced &
  Visual &
  OpacityAnimatable & {
    filetype: "shape";
    oWidth: number; // 원래 shape 사이즈
    oHeight: number;
    shape: number[][]; // [[x, y]...]
    option: {
      fillColor: string;
    };
  };

export type VideoElementType = TimelinePlaced &
  Visual &
  Animatable & {
    filetype: "video";
    /**
     * Window into the *source file*, in source milliseconds — never a timeline
     * offset. The clip sits at `[startTime, startTime + duration/speed)`, and
     * `duration === trim.endTime - trim.startTime` is an invariant enforced by
     * `features/timeline/geometry.ts`.
     */
    trim: { startTime: number; endTime: number };
    /** Full untrimmed length of the source file, in source ms. */
    sourceDuration: number;
    isExistAudio: boolean;
    codec: { video: string; audio: string };
    speed: number;
    filter: {
      enable: boolean;
      list: VideoFilterType[];
    };
    origin: {
      width: number;
      height: number;
    };
  };

export type TextElementType = TimelinePlaced &
  Visual &
  Animatable & {
    filetype: "text";
    text: string;
    textcolor: string;
    fontsize: number;
    fontpath: string;
    fontname: string;
    fontweight: string;
    fonttype: string;
    letterSpacing: number;
    options: {
      isBold: boolean;
      isItalic: boolean;
      align: "left" | "center" | "right";
      outline: {
        enable: boolean;
        size: number;
        color: string;
      };
    };
    background: {
      enable: boolean;
      color: string;
    };
    widthInner: number;
  };

export type AudioElementType = TimelinePlaced & {
  filetype: "audio";
  /** Source-file window in source ms. See `VideoElementType.trim`. */
  trim: { startTime: number; endTime: number };
  /** Full untrimmed length of the source file, in source ms. */
  sourceDuration: number;
  speed: number;
};

export type TimelineElement =
  | VideoElementType
  | ImageElementType
  | GifElementType
  | ShapeElementType
  | TextElementType
  | AudioElementType;

export type VisualTimelineElement = Exclude<TimelineElement, AudioElementType>;

export function isVisualTimelineElement(
  element: TimelineElement,
): element is VisualTimelineElement {
  return element.filetype !== "audio";
}

/** Elements that carry an `animation` block at all. */
export type AnimatableTimelineElement =
  | ImageElementType
  | VideoElementType
  | TextElementType
  | ShapeElementType;

export function canAnimate(
  element: TimelineElement,
): element is AnimatableTimelineElement {
  // GIF and audio have no `animation` field, so offering a keyframe editor for
  // them opens a panel with nothing to edit. The old check gated on "static and
  // not text", which let GIF through and kept video out — backwards on both.
  return (
    element.filetype === "image" ||
    element.filetype === "video" ||
    element.filetype === "text" ||
    element.filetype === "shape"
  );
}

export type AnimatableProperty = "position" | "opacity" | "scale" | "rotation";

/**
 * Which properties an element can actually animate.
 *
 * Shape is `OpacityAnimatable` only — its type carries no position, scale or
 * rotation tracks, so those keyframes would have nowhere to live.
 */
export function animatableProperties(
  element: TimelineElement,
): AnimatableProperty[] {
  if (!canAnimate(element)) {
    return [];
  }
  if (element.filetype === "shape") {
    return ["opacity"];
  }
  return ["position", "opacity", "scale", "rotation"];
}

export interface Timeline {
  [elementId: string]: TimelineElement;
}
