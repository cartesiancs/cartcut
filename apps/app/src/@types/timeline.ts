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
  /**
   * The source file's native aspect, recorded once at import.
   *
   * **Not** the element's current proportions, and not what a constrained
   * resize holds: nothing recomputes this after `width` or `height` change, and
   * the sidebar's size fields write the two independently. A resize takes its
   * ratio from the box as it stood at mousedown — see `preview/resizeMath.ts`,
   * whose header covers what reading this field here used to do.
   */
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

/**
 * Clips that make a sound, and can be turned down.
 *
 * A mixin rather than a field repeated on `video` and `audio`, so the reasoning
 * below lives in one place — the same way `Visual` and `Animatable` do.
 */
type Leveled = {
  /**
   * Authored output level in **decibels**, -60 … 0. Attenuation only.
   *
   * Absent on every clip written before the feature and on every clip the user
   * has not touched, which is what lets old projects load unchanged — there is
   * no migration on load. `features/timeline/audio.ts#volumeDbOf` owns the
   * reading of it and supplies the 0 dB default.
   *
   * Decibels, not a linear multiplier, deliberately: this is the number the
   * user scrubbed, stored exactly, so re-scrubbing cannot drift and so -60 can
   * mean silence without the round trip through `-Infinity` that a stored `0`
   * would need. The linear value `HTMLMediaElement.volume` and the FFmpeg
   * `volume` filter want comes from `gainOf`. **Never assign this to
   * `handle.volume`** — that line typechecks and is wrong by 20 orders of dB.
   *
   * The ceiling is 0 dB because `HTMLMediaElement.volume` maxes at 1.0: any
   * boost would make the preview and the export disagree, silently.
   *
   * Not animatable. `canAnimate` excludes audio and `animatableProperties`
   * returns `[]` for it, so this is a static field with no keyframe track.
   */
  volumeDb?: number;
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
  Animatable &
  Leveled & {
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
    /**
     * Whether the *source file* carries an audio stream. A fact about the file,
     * probed once at import — not a mute switch. `renderMain` also reads it to
     * decide the input `-vcodec`, so writing it to silence a clip would change
     * how the file is decoded.
     */
    isExistAudio: boolean;
    /**
     * Whether this clip's sound has been split onto an `audio` element of its
     * own, and so must not be heard from here as well.
     *
     * Absent on every clip that has never been detached, which is what lets
     * projects written before the feature load unchanged — see
     * `features/timeline/audio.ts`, which owns the reading of this field, and
     * `electron/render/ffmpegArgs.ts#isAudible`, which mirrors it across the
     * IPC boundary.
     */
    audioDetached?: boolean;
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

/**
 * A drop shadow cast by the glyphs.
 *
 * `offsetX`/`offsetY`/`blur` are in **element space**, not device pixels. The
 * canvas API's own shadow properties are device-space and untouched by the
 * transform, so `renderer/shadow.ts` converts these through the current matrix
 * — which is what keeps a shadow identical in a zoomed preview and in the
 * export, and what makes it rotate and scale with the clip.
 */
export type TextShadow = {
  enable: boolean;
  offsetX: number;
  offsetY: number;
  blur: number;
  color: string;
  /** 0-100. Folded into the shadow colour rather than `globalAlpha`. */
  opacity: number;
};

/** A shadow with no offset — the same machinery, spread evenly. */
export type TextGlow = {
  enable: boolean;
  /** Blur radius in element space. */
  size: number;
  color: string;
  opacity: number;
};

/**
 * How the glyph interiors are painted.
 *
 * A union rather than a flat object with an `enable` flag, because the fields
 * a gradient needs are meaningless for a solid fill — flattening it produces
 * elements carrying a `from`/`to` pair that nothing reads and that drifts out
 * of sync with the colour actually shown.
 *
 * MCP tool schemas must **not** mirror this union — `mcp/tools/define.ts`
 * forbids `z.discriminatedUnion` in tool shapes. Tools take flat optional
 * fields and assemble the union in the handler.
 */
export type TextFill =
  | { type: "solid" }
  | { type: "gradient"; from: string; to: string; angle: number };

/**
 * Text.
 *
 * Everything from `options.shadow` down is **optional on purpose**. Projects
 * written before text effects existed have none of it, and `.ngt` load runs no
 * migration — `features/text/style.ts#resolveTextStyle` supplies the defaults,
 * and every default means "off", so an old project renders exactly as it did.
 * Read style through that resolver rather than reaching in with `?.` chains.
 */
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
        /** 0-100. Absent on elements written before text effects. */
        opacity?: number;
      };
      shadow?: TextShadow;
      glow?: TextGlow;
      textTransform?: "none" | "uppercase" | "lowercase";
    };
    background: {
      enable: boolean;
      color: string;
      opacity?: number;
      /** Box padding around each line. Was the hard-coded 12 in `text.ts`. */
      padding?: number;
      /** Corner radius of the box. */
      radius?: number;
    };
    fill?: TextFill;
    /**
     * 0-100, applied to the glyphs alone. Distinct from `Visual.opacity`, which
     * fades the whole element — background box, shadow and all.
     */
    textOpacity?: number;
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

export type AudioElementType = TimelinePlaced &
  Leveled & {
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
