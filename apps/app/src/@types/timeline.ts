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
  | "group"
  | "effect"
  | "transition";

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

/**
 * The opacity track on its own, for an element that has nothing else to move.
 *
 * `effect` is the only such element: it covers the whole frame by definition,
 * so it has no position, scale or rotation to animate in the first place. A
 * shape used to share this mixin as a placeholder — its other properties were
 * merely unimplemented rather than meaningless — and now carries the full
 * `Animatable` like every other visual element.
 */
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
  Animatable & {
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

/**
 * The value of one parameter a preset declared, keyed by the manifest's
 * `param.key`.
 *
 * Deliberately loose. The manifest owns the schema — which keys exist, their
 * types, their ranges — and `features/fx/presetValidate.ts` enforces it on the
 * way in. Mirroring that structure in the type system here would mean this file
 * knowing about presets, and would still not be checkable at compile time
 * because the presets arrive from disk at runtime.
 */
export type FxParams = Record<
  string,
  number | string | boolean | number[]
>;

/**
 * A full-frame effect: an adjustment layer.
 *
 * Applies to every pixel drawn *beneath* it — that is, to every element with a
 * lower `priority` — so moving its track up or down is how the user chooses
 * what it touches. This is the Premiere/After Effects convention and it is what
 * makes "grade everything except the captions" expressible.
 *
 * `Visual` is deliberately NOT mixed in. An effect has no `width`, `height`,
 * `location` or `rotation`: it always covers the project frame exactly, so
 * those fields would have no value to hold — and if they existed the preview's
 * resize handles and `hitTest` would grab them, offering the user a box to drag
 * that means nothing.
 *
 * `OpacityAnimatable` is mixed in because fading an effect in and out is the
 * one thing everybody wants, and the keyframe subsystem is keyed on
 * `doc.elements[id]` throughout — so the curve editor, the timeline's diamond
 * lane and the context menu all work on it for free.
 */
export type EffectElementType = TimelinePlaced &
  OpacityAnimatable & {
    filetype: "effect";
    /**
     * Which installed preset this is. A preset that is not installed renders as
     * a pass-through rather than an error: the element and its `params` survive
     * the round trip, so opening a project on a machine without the preset and
     * saving it again loses nothing.
     */
    presetId: string;
    params: FxParams;
    /**
     * 0-100. The effect's overall strength.
     *
     * A field rather than a `params` entry because it is the one parameter
     * every effect has regardless of preset — the panel can offer it before it
     * knows which preset is selected, and switching presets must not reset it.
     */
    intensity: number;
    /**
     * How an overlay preset's frames combine with what is beneath.
     *
     * Absent on shader presets, which do their own combining in GLSL. Named
     * with the Canvas2D vocabulary because the built-in modes take the
     * `globalCompositeOperation` fast path — see `renderer/fx/compositor.ts`.
     */
    blend?: GlobalCompositeOperation;
  };

/** Which end of the cut a transition is anchored to. */
export type TransitionAlignment = "center" | "start" | "end";

/**
 * A transition between two adjacent clips on one track.
 *
 * The important thing this type does NOT do: it does not move, trim, or
 * otherwise touch the two clips. `fromId` and `toId` keep their own
 * `startTime` and `trim` exactly as they were, and this element is a window
 * laid over the cut between them. Removing it restores the edit precisely, and
 * undo needs no special case.
 *
 * That is also why it does not occupy the track — see
 * `features/timeline/overlap.ts#occupiesTrack`. A transition straddles the cut
 * by definition, so it overlaps both neighbours; counted as an occupant it
 * would report a collision with the very clips it belongs to and every trim,
 * drag and paste on that track would be refused.
 *
 * `fromId`/`toId` are stored rather than derived from track adjacency because
 * the compositor and both export paths receive a bare element map with no
 * tracks to look along — the same reason `priority` exists.
 */
export type TransitionElementType = TimelinePlaced & {
  filetype: "transition";
  presetId: string;
  params: FxParams;
  /** The outgoing clip. */
  fromId: string;
  /** The incoming clip. */
  toId: string;
  alignment: TransitionAlignment;
  /**
   * What the user asked for, when source handles forced a shorter window.
   *
   * Kept so the panel can say "2.0s requested, 0.8s available" instead of
   * silently lying about the number, and so that trimming a neighbour back to
   * free up handles can restore the original length rather than leaving the
   * transition permanently shortened by a since-undone edit.
   */
  requestedDuration?: number;
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
  | GroupElementType
  | EffectElementType
  | TransitionElementType;

/** Elements the compositor draws. Audio has no picture; a group draws nothing. */
export type VisualTimelineElement = Exclude<
  TimelineElement,
  | AudioElementType
  | GroupElementType
  | EffectElementType
  | TransitionElementType
>;

export function isVisualTimelineElement(
  element: TimelineElement,
): element is VisualTimelineElement {
  // A group is excluded here and nowhere else: `renderTimelineAtTime` already
  // filters on this guard, so groups leave the paint loop without the loop
  // learning they exist. Their transform still reaches their children, because
  // that is resolved by following `parentId` into the element map rather than
  // by anything the draw pass does.
  //
  // Effects and transitions are excluded for a different reason, and it matters
  // that they are excluded HERE rather than given renderers. Both are whole-
  // frame compositing operations: an effect reads the pixels already drawn
  // beneath it, and a transition needs its two clips rendered to *separate*
  // buffers before they can be mixed. Neither fits `ElementRenderFunction`,
  // whose whole signature — `(ctx, id, element, t)`, drawing at the origin in
  // element-local space — assumes an element paints itself onto whatever is
  // there. `renderTimelineAtTime` handles them in dedicated passes instead.
  //
  // The practical payoff: `TimelineRenderers` is a mapped type over
  // `VisualTimelineElement["filetype"]`, so leaving them out means the three
  // renderer tables (preview, export, offscreen export) need no new entries and
  // cannot be forgotten.
  //
  // This list is negative, so a filetype added later is visual by default and
  // will fail at `renderers[element.filetype]` with an undefined call. Add the
  // exclusion here at the same time as the type.
  return (
    element.filetype !== "audio" &&
    element.filetype !== "group" &&
    element.filetype !== "effect" &&
    element.filetype !== "transition"
  );
}

export function isGroupElement(
  element: TimelineElement,
): element is GroupElementType {
  return element.filetype === "group";
}

export function isEffectElement(
  element: TimelineElement,
): element is EffectElementType {
  return element.filetype === "effect";
}

export function isTransitionElement(
  element: TimelineElement,
): element is TransitionElementType {
  return element.filetype === "transition";
}

/**
 * Whether this element claims a slot on its track.
 *
 * The one exception to "a track never holds overlapping clips", and it is
 * defined once, here, so that it is a property of the element rather than a
 * condition every op has to remember.
 *
 * A transition straddles the cut between two clips — that is what it is — so it
 * necessarily overlaps both of them. Counted as an occupant it would report a
 * collision with the very clips it belongs to, and every trim, drag, paste and
 * placement on that track would be refused. It carries `startTime` and
 * `duration` all the same, because the timeline has to lay its badge out and
 * the repair pass has to find it.
 *
 * `features/timeline/overlap.ts` is the only consumer that matters:
 * `clipsOnTrack` deliberately does NOT filter on this, because layout and
 * repair both need to see transitions. Only occupancy arithmetic does.
 *
 * It lives in this module rather than in `overlap.ts` so that
 * `transitionRepair.ts` can use it from inside `normalizeDocument` without
 * closing a runtime cycle through `tracks.ts`.
 */
export function occupiesTrack(element: TimelineElement): boolean {
  return element.filetype !== "transition";
}

/** Elements that carry an `animation` block at all. */
export type AnimatableTimelineElement =
  | ImageElementType
  | VideoElementType
  | TextElementType
  | ShapeElementType
  | GroupElementType
  | EffectElementType;

export function canAnimate(
  element: TimelineElement,
): element is AnimatableTimelineElement {
  // GIF and audio have no `animation` field, so offering a keyframe editor for
  // them opens a panel with nothing to edit. The old check gated on "static and
  // not text", which let GIF through and kept video out — backwards on both.
  //
  // A transition is absent on purpose and permanently: its progress is driven
  // by the shader's `progress` uniform, derived from the playhead. Giving it
  // keyframes would put a second, competing clock on the same value.
  return (
    element.filetype === "image" ||
    element.filetype === "video" ||
    element.filetype === "text" ||
    element.filetype === "shape" ||
    // A group exists to be animated — it has no other purpose. Including it
    // here is what gives it the curve editor, the timeline's keyframe lane and
    // the context menu, with no group-specific code in any of them.
    element.filetype === "group" ||
    // Opacity only — see `animatableProperties`.
    element.filetype === "effect"
  );
}

export type AnimatableProperty = "position" | "opacity" | "scale" | "rotation";

/**
 * Which properties an element can actually animate.
 *
 * An effect is `OpacityAnimatable` only — it always covers the whole frame, so
 * it has no position, scale or rotation to move, and those keyframes would have
 * nowhere to live. A shape used to be listed here beside it, but for a weaker
 * reason: its other properties were simply unimplemented. It now carries the
 * full `Animatable` block, so it animates like any other visual element.
 *
 * An effect's `intensity` is deliberately not here. `AnimatableProperty` is a
 * closed union that `keyframeOps`, the curve editor and the timeline's diamond
 * lane all switch on, and the `animation` block is a fixed record of four
 * named tracks — so a fifth animatable property is a change to the keyframe
 * subsystem, not to this list. `intensity` stays static until that happens.
 */
export function animatableProperties(
  element: TimelineElement,
): AnimatableProperty[] {
  if (!canAnimate(element)) {
    return [];
  }
  if (element.filetype === "effect") {
    return ["opacity"];
  }
  return ["position", "opacity", "scale", "rotation"];
}

export interface Timeline {
  [elementId: string]: TimelineElement;
}
