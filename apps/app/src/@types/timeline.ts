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
  | "audio"
  | "group";

type TimelinePlaced = {
  filetype: TimelineElementType;
  key: string;
  localpath: string;
  /** Which track (row) this clip sits on. Many clips may share one. */
  trackId: string;
  /**
   * Transform parent: the `group` element whose coordinate space this clip's
   * `location` and `position` keyframes are expressed in. Absent for a clip
   * that sits directly on the canvas.
   *
   * Spatial only. It does **not** move the clip in time, gate its visibility,
   * or change its z-order — a group is not a nested sequence. Which is why it
   * is not the `parentKey` this codebase removed: that one was a *time* parent
   * and meant a clip could not answer for its own position on the timeline.
   *
   * The invariant, held by `features/timeline/hierarchy.ts#repairHierarchy`
   * from inside `normalizeDocument`: in a normalised document this either is
   * absent or names a live `group` element, with no cycle and no chain longer
   * than `MAX_GROUP_DEPTH`. Consumers may therefore follow it without guards.
   */
  parentId?: string | null;
  /**
   * Paint rank, back to front — 1 is furthest away.
   *
   * DERIVED, never authored: `features/timeline/tracks.ts#derivePriorities`
   * recomputes it from track order on every mutation, and
   * `tracks.test.ts` pins that sorting on it reproduces `paintOrder` exactly.
   *
   * It survives rather than being replaced by a track lookup because the
   * compositor, the WebCodecs export and the FFmpeg export all receive a bare
   * element map across an IPC boundary, with no tracks to sort by. This is the
   * serialised form of that ordering.
   *
   * What made the old field dangerous was not its existence but that it was
   * authored by hand and meant two things at once — z-order *and*, through the
   * enumeration index, which row a clip occupied. It now means one thing.
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

/**
 * A transform parent that draws nothing — After Effects' null object.
 *
 * It is a full `TimelinePlaced & Visual & Animatable` element rather than an
 * entry in some separate registry, and that is the whole trick. The `Timeline`
 * map already crosses every IPC boundary, lands in the `.ngt` file and sits in
 * every undo entry, so a group needs no new plumbing to reach any of them. More
 * importantly the keyframe subsystem is keyed on `doc.elements[id]` throughout
 * — `keyframeOps`, the curve editor, the timeline's diamond markers, the
 * "animate position" context menu — so all of it works on a group for free.
 *
 * `width`/`height` are not a size to draw; they are the **pivot**, since
 * `localMatrixOf` rotates and scales about `w/2, h/2`. `createGroup` sets them
 * from the bounding box of the clips being grouped, which puts the pivot at the
 * visual centre of the selection.
 *
 * Excluded from `VisualTimelineElement`, so every render path already skips it
 * through the `isVisualTimelineElement` guard it already has.
 */
export type GroupElementType = TimelinePlaced &
  Visual &
  Animatable & {
    filetype: "group";
    /** Shown on the group's bar. Every other clip is named by its source file. */
    name: string;
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
  | AudioElementType
  | GroupElementType;

/** Elements the compositor draws. Audio has no picture; a group draws nothing. */
export type VisualTimelineElement = Exclude<
  TimelineElement,
  AudioElementType | GroupElementType
>;

export function isVisualTimelineElement(
  element: TimelineElement,
): element is VisualTimelineElement {
  // A group is excluded here and nowhere else: `renderTimelineAtTime` already
  // filters on this guard, so groups leave the paint loop without the loop
  // learning they exist. Their transform still reaches their children, because
  // that is resolved by following `parentId` into the element map rather than
  // by anything the draw pass does.
  return element.filetype !== "audio" && element.filetype !== "group";
}

export function isGroupElement(
  element: TimelineElement,
): element is GroupElementType {
  return element.filetype === "group";
}

/** Elements that carry an `animation` block at all. */
export type AnimatableTimelineElement =
  | ImageElementType
  | VideoElementType
  | TextElementType
  | ShapeElementType
  | GroupElementType;

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
    element.filetype === "shape" ||
    // A group exists to be animated — it has no other purpose. Including it
    // here is what gives it the curve editor, the timeline's keyframe lane and
    // the context menu, with no group-specific code in any of them.
    element.filetype === "group"
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
