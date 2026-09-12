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

/**
 * How a clip combines with everything painted beneath it.
 *
 * Stored in the **Canvas2D vocabulary** rather than the CSS one, for the same
 * reason `EffectElementType.blend` is: fifteen of these are spelled identically
 * in both, the compositor sets the string straight onto
 * `globalCompositeOperation`, and inventing a second name for "normal" would
 * mean a translation table that can only ever be wrong in one direction.
 *
 * A closed union rather than the built-in `GlobalCompositeOperation`, which
 * also contains `copy`, `xor` and the `destination-*` family — operations that
 * *erase* what is already on the canvas. Those are legitimate tools for a
 * compositor to use internally; they are not something a project file should be
 * able to say about a clip. Narrowing here is the same rule the frame rate
 * follows: make an unusable value unrepresentable at the point it is stored.
 *
 * Ordered as the panel groups them — darken, lighten, contrast, comparative,
 * component — so the dropdown can be built from this array without a second
 * ordering to keep in sync.
 */
export const BLEND_MODES = [
  "source-over",
  "darken",
  "multiply",
  "color-burn",
  "lighten",
  "screen",
  "color-dodge",
  "lighter",
  "overlay",
  "soft-light",
  "hard-light",
  "difference",
  "exclusion",
  "hue",
  "saturation",
  "color",
  "luminosity",
] as const;

export type BlendMode = (typeof BLEND_MODES)[number];

/**
 * A clip that can be composited with something other than plain stacking.
 *
 * A mixin rather than a field on `Visual`, because `GroupElementType` shares
 * `Visual` and a group paints nothing — it exists only to hold a transform for
 * its children. A blend mode on it would be a field the renderer is structurally
 * unable to honour, and the sidebar would offer a control that does nothing.
 *
 * Absent means `"source-over"`, answered by
 * `features/renderer/blend.ts#blendOf` on the read side. Optional is
 * load-bearing: `.ngt` load is a compatibility check and not a migrator, so a
 * new field must never move `SCHEMA_VERSION`.
 */
type Blendable = {
  blend?: BlendMode;
};

/**
 * A colour grade applied to one clip, by reference.
 *
 * `presetId` names a LUT in the preset registry — the same registry effects and
 * transitions come from, so a LUT is available both here, as a property of a
 * clip, and as an adjustment layer (`EffectElementType`) covering everything
 * beneath its track. That is the Premiere/Final Cut convention: grade the shot
 * you mean, or grade the stack.
 *
 * The **LUT data is deliberately not stored here**, only its id. A 17³ table is
 * 4,913 nodes, and putting one on the element would send it through
 * `normalizeDocument`, into every undo snapshot, into the agent serialiser's
 * output, and into `timeline.json` — where it would be duplicated once per
 * graded clip. It is the same rule `localpath` follows for media: the document
 * carries a reference, and the thing referred to is loaded once and shared.
 *
 * A LUT that is not installed grades nothing and reports nothing — exactly the
 * contract a missing effect preset has (`planFrame.ts`). A project that names a
 * LUT the recipient does not have opens and plays; it simply plays ungraded.
 */
export type LutRef = {
  presetId: string;
  /**
   * How much of the grade to apply, 0-100.
   *
   * A field rather than a preset parameter, for the reason
   * `EffectElementType.intensity` is one: trying a different LUT should not
   * silently reset how strongly the last one was dialled in.
   */
  intensity: number;
};

/**
 * A clip that can carry a LUT.
 *
 * A mixin over exactly the same five element types as `Blendable`, and for the
 * same reason — a group paints nothing, so a grade on one would be a field the
 * renderer is structurally unable to honour.
 *
 * Absent means ungraded, answered by `features/renderer/lut.ts#lutOf` on the
 * read side. Optional is load-bearing: `.ngt` load is a compatibility check and
 * not a migrator, so a new field must never move `SCHEMA_VERSION`, and a
 * project nobody has graded must save byte-identically to one written before
 * the feature existed.
 */
type Gradable = {
  lut?: LutRef;
};

/**
 * The manual colour controls, in the order the Adjust tab lists them.
 *
 * CapCut's Adjust panel, which is also Lightroom's and Lumetri's basic set:
 * three for colour, seven for lightness, five for finishing. Exported as a
 * runtime list so `electron/mcp/tools/define.ts`'s hand-copy can be pinned
 * against it, the arrangement `FILETYPES` and `BLEND_MODES` already have.
 *
 * What each one does, and over what range, is `features/adjust/spec.ts`.
 */
export const COLOR_ADJUSTMENT_KEYS = [
  "temperature",
  "tint",
  "saturation",
  "exposure",
  "contrast",
  "highlights",
  "shadows",
  "whites",
  "blacks",
  "brilliance",
  "sharpen",
  "clarity",
  "particles",
  "fade",
  "vignette",
] as const;

export type ColorAdjustmentKey = (typeof COLOR_ADJUSTMENT_KEYS)[number];

/**
 * A clip's manual colour adjustments, in slider units.
 *
 * **Sparse**, and that is the whole persistence contract: a slider at zero has
 * no key, and a clip with every slider at zero has no `adjust` field at all.
 * A project nobody has adjusted therefore saves byte-identically to one written
 * before the feature, and `SCHEMA_VERSION` did not move — the rule `blend` and
 * `lut` follow.
 */
export type ColorAdjustments = Partial<Record<ColorAdjustmentKey, number>>;

/**
 * A clip that can carry manual colour adjustments.
 *
 * The same five types as `Gradable`, for the same reason. Absent means
 * unadjusted, answered by `features/renderer/adjust.ts#adjustOf`.
 */
type Adjustable = {
  adjust?: ColorAdjustments;
};

/**
 * A clip whose picture can be mirrored inside its own box.
 *
 * Video and image only. A mirror flips the *media*, not the element: it is
 * applied by `features/renderer/mirror.ts` just before the per-type renderer
 * draws, underneath the transform, so the box, the hit test, the grips and a
 * mask all stay exactly where they were — the picture turns over beneath them.
 *
 * Stored as `true` or not at all. Clearing deletes the key, the rule `blend`
 * and `lut` follow, so a project nobody has mirrored saves byte-identically to
 * one written before the feature and `SCHEMA_VERSION` did not move. Read
 * through `features/timeline/mirrorOps.ts#mirrorOf`.
 */
type Mirrorable = {
  flipH?: true;
  flipV?: true;
};

/**
 * Where a reversed clip came from, so reversing it back is instant.
 *
 * A reversed clip's `localpath` points at a *new file*, the clip's trimmed
 * window played backwards — which is what makes the preview, the export's
 * audio, the filmstrip and the waveform all follow with no changes of their
 * own. This remembers the forward source and the window the new file covers.
 *
 * The mapping back is `to - r`: a source time `r` in the reversed file is
 * `to - r` in the original. It survives a split or an inner trim of the
 * reversed clip, because each half keeps the same `to`. See
 * `features/timeline/reverseOps.ts`.
 */
export type ReversedFrom = {
  /** The forward source, exactly as `localpath` held it. */
  localpath: string;
  /** The window of the original the reversed file covers, in source ms. */
  from: number;
  to: number;
  /** The original's `sourceDuration`. */
  sourceDuration: number;
  /** The original's `isExistAudio`. */
  isExistAudio: boolean;
};

/**
 * The mask shapes a clip can be cut to.
 *
 * Three of them are built in and one is drawn: `pen` means "the path in
 * `MaskType.path`", so the shape name stays a closed union while the geometry
 * behind it is open. Ordered as the panel shows them.
 */
export const MASK_SHAPES = ["rectangle", "star", "heart", "pen"] as const;

export type MaskShape = (typeof MASK_SHAPES)[number];

/**
 * One node of a closed cubic path, in the mask's own unit square.
 *
 * `p` / `cs` / `ce` deliberately echo `CubicKeyframeType` above, so the codebase
 * has one vocabulary for "an anchor and its two handles" rather than two.
 * Unlike that type these are *2D positions*, not time-value pairs, and the
 * handles are stored as **offsets from `p`** — which is what makes moving an
 * anchor carry its curve with it, and what lets a node with no handles mean
 * exactly one thing.
 *
 * **Both handles absent means a corner.** That is not a shorthand for
 * `{ cs: [0,0], ce: [0,0] }`; it is the fact `features/mask/round.ts` reads to
 * decide what round-corners applies to. A heart is all handles and never
 * rounds; a rectangle is all corners and rounds completely; a pen path rounds
 * exactly the vertices the user clicked rather than dragged.
 */
export type MaskNode = {
  /** Anchor. The mask box is the unit square [-0.5, 0.5]². */
  p: [number, number];
  /** Incoming handle, as an offset from `p`. */
  cs?: [number, number];
  /** Outgoing handle, as an offset from `p`. */
  ce?: [number, number];
};

/**
 * The shape a clip's picture is cut to.
 *
 * One mask per clip, which is the CapCut arrangement and not an accident of
 * this type: mask keyframes live in `element.animation` under `maskPosition`,
 * `maskSize`, `maskRotation`, `maskFeather` and `maskRoundness`, and that record
 * addresses a track by a single name. A second mask would have nowhere to put
 * its curves without making every consumer of `animation[property]` — the
 * curve editor, the diamond lane, `keyframeOps`, the agent commands — learn
 * about indices.
 *
 * **`location` and `size` are percentages of the element box**, not pixels.
 * Both are read straight into the curve editor as keyframe values, so they have
 * to be numbers a person can read there; and a mask expressed in element pixels
 * would stay the same size while the clip under it was resized, which is the one
 * behaviour no NLE has.
 *
 * `feather` is in element-local pixels instead, because it is a distance across
 * the picture rather than a fraction of the mask, and a feather that grew when
 * the mask grew could not be dialled in independently of it.
 *
 * Absent on the element means unmasked, answered by
 * `features/mask/maskShape.ts#maskOf` on the read side. Optional is
 * load-bearing: `.ngt` load is a compatibility check and not a migrator, so a
 * new field must never move `SCHEMA_VERSION`, and a project nobody has masked
 * must save byte-identically to one written before the feature existed.
 */
export type MaskType = {
  shape: MaskShape;
  /** Mask centre, as a percentage of the element box. 50/50 is centred. */
  location: { x: number; y: number };
  /** Mask box, as a percentage of the element box. 100/100 fills it. */
  size: { width: number; height: number };
  /** Degrees, clockwise, about the mask's own centre. */
  rotation: number;
  /** Edge softness in element-local pixels. 0 is a hard edge. */
  feather: number;
  /** Corner rounding, 0-100 as a percentage of half the shorter side. */
  roundness: number;
  /**
   * Keep the outside instead of the inside.
   *
   * Optional, and absent means "keep the inside" — the same
   * default-deletes-the-key rule the whole field follows, one level down.
   */
  invert?: boolean;
  /**
   * `shape === "pen"` only: the drawn path, closed, in the unit square.
   *
   * Authored data, so it belongs on the element — unlike `LutRef`, which stores
   * an id precisely because the table behind it is 4,913 nodes. A pen path is a
   * handful of points the user drew and nothing else can reproduce.
   */
  path?: MaskNode[];
};

/**
 * A clip whose picture can be cut to a shape.
 *
 * A mixin over exactly the same five element types as `Blendable` and
 * `Gradable`, and for the same reason: a group paints nothing, and an effect and
 * a transition are whole-frame operations rather than layers, so a mask on one
 * would be a field the renderer is structurally unable to honour.
 */
type Maskable = {
  mask?: MaskType;
};

/**
 * A clip the author has offered as a slot in an exported template.
 *
 * Authoring metadata and nothing else: it changes no pixel and no timing in the
 * project it is written in. It matters only inside a `.cttpl`, where
 * `features/template/slots.ts#slotsOf` walks the archive's document and turns
 * every marked clip into a slot the template's user can fill.
 *
 * Absent means "not a slot" and clearing **deletes the key**, so a project
 * nobody has marked up saves byte-identically to one written before the
 * feature and `SCHEMA_VERSION` did not move — the rule `blend`, `lut` and
 * `mask` all follow.
 *
 * Mixed into video, image, gif and text alone: those are the four things a
 * person can hand a replacement for. A shape's fill, an effect's parameters and
 * a transition's preset are all settings rather than sources, and a group holds
 * a transform rather than content.
 *
 * `slotId` is deliberately not the element's key. Two clips may share one id —
 * the same shot cut in twice, a title repeated in the outro — and then one
 * replacement fills both, which is what `slotsOf` grouping on this field buys.
 */
type Replaceable = {
  replaceable?: {
    slotId: string;
    /** Shown in `<option-template>`; the source's filename when absent. */
    label?: string;
  };
};

/**
 * Every filetype, as a value rather than only a type.
 *
 * A runtime list for the reason `OWN_ANIMATABLE_PROPERTIES` is one: `electron/`
 * cannot import this module — `rootDir` is pinned to `electron/` — so
 * `mcp/tools/define.ts` keeps a hand-copied `FILETYPES`, and a test can only
 * pin that copy against something it can actually import. Until this existed
 * the copy was checked by eye, and the note in `CLAUDE.md` records it having
 * been wrong twice in opposite directions.
 */
export const FILETYPES = [
  "video",
  "image",
  "gif",
  "shape",
  "text",
  "audio",
  "group",
  "effect",
  "transition",
  "template",
] as const;

type TimelineElementType = (typeof FILETYPES)[number];

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
    /**
     * The element's box, in **pixels** — the two numbers the sidebar's Size
     * row shows, animated.
     *
     * Two lanes, and they are a *width* and a *height* rather than an x and a
     * y — the same arrangement `maskSize` has, for the same reason: the
     * pairing is about which instants carry a keyframe, and a clip that was
     * 400 wide at one keyframe with no height keyframe there would animate
     * along one axis and jump along the other.
     *
     * **Not a second `scale`.** `scale` is uniform, stored in tenths, and
     * applied as a matrix factor about the centre; it never touches the box.
     * A sampled `size` *replaces* `width`/`height` on the way to the renderer,
     * so animating to 500 draws exactly what typing 500 into the sidebar
     * draws. That equivalence is the whole contract — see
     * `timeline/transform.ts#sampledBoxOf`.
     */
    size: {
      isActivate: boolean;
      x: CubicKeyframeType[];
      y: CubicKeyframeType[];

      ax: number[][];
      ay: number[][];
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
  Animatable &
  Blendable &
  Gradable &
  Adjustable &
  Mirrorable &
  Maskable &
  Replaceable & {
    filetype: "image";
  };

export type GifElementType = TimelinePlaced &
  Visual &
  Blendable &
  Gradable &
  Adjustable &
  Maskable &
  Replaceable & {
    filetype: "gif";
  };

export type ShapeElementType = TimelinePlaced &
  Visual &
  Animatable &
  Blendable &
  Gradable &
  Adjustable &
  Maskable & {
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
  Leveled &
  Blendable &
  Gradable &
  Adjustable &
  Mirrorable &
  Maskable &
  Replaceable & {
    filetype: "video";
    /**
     * Present while the clip plays a reversed copy of its source. Absent on
     * every forward clip, and deleted on the way back.
     */
    reversed?: ReversedFrom;
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
 * What one step of a reveal counts.
 *
 * A runtime list for the same reason `MASK_SHAPES` is one: the option panel
 * builds its picker from it, and a value that is not in it is refused rather
 * than stored.
 */
export const REVEAL_UNITS = ["character", "word", "line"] as const;

export type RevealUnit = (typeof REVEAL_UNITS)[number];

/**
 * Showing a text clip's lettering a piece at a time — the typewriter, and every
 * other cadence built out of the same scalar.
 *
 * **This field holds no time at all.** It says what a progress value *means*;
 * the progress itself is `animation.revealProgress`, an ordinary keyframe track
 * over the static `progress` below. That split is the whole design:
 *
 * - Timing lives in the animation block, so `rebaseAnimation`, `sliceAnimation`
 *   and `rebakeElement` carry it through split, trim, duplicate, paste and a
 *   project frame-rate change without knowing this feature exists. A
 *   `startMs`/`durationMs` pair stored here would need every one of those
 *   reimplemented in `clipOps`.
 * - Meaning lives here, so changing the wording of the text does not invalidate
 *   the timing — which is exactly what keyframing the string itself, the way
 *   Premiere's Source Text does, cannot offer.
 *
 * Not a mixin over the other visual types on purpose: a reveal counts units of
 * *text*, and a picture has none. Wiping an image on is what a mask is for.
 */
export type TextReveal = {
  unit: RevealUnit;
  /**
   * 0-100, how much of the text is shown. **100 is the inert state** — turning
   * a reveal on without keyframing it changes nothing on screen.
   *
   * This is the static field `animation.revealProgress` keyframes, and it obeys
   * the usual contract: a keyframed reveal shows exactly what typing the same
   * number here shows.
   */
  progress: number;
  /**
   * 0-1. How much of one unit's turn it spends fading in; 0 is a hard cut.
   *
   * Bounded at one unit deliberately, so at most one unit is ever partially
   * drawn and the renderer costs one extra pass rather than one per unit in
   * flight.
   */
  fade?: number;
};

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
  Animatable &
  Blendable &
  Gradable &
  Adjustable &
  Maskable &
  Replaceable & {
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
      /**
       * Leading, as a multiple of the font size. Absent means
       * `text/metrics.ts#DEFAULT_LINE_HEIGHT`.
       *
       * This is where line spacing lives. It used to be `height`, which meant
       * the box and the leading were one number — resizing the box pushed the
       * lines apart. `height` is now a consequence of the text, written back by
       * `element/textFit.ts`, and never read by the layout.
       */
      lineHeight?: number;
    };
    background: {
      enable: boolean;
      color: string;
      opacity?: number;
      /** Box padding around each line. Was the hard-coded 12 in `text.ts`. */
      padding?: number;
      /** Corner radius of the box. */
      radius?: number;
      /**
       * **Backdrop** blur: how much to blur what is *behind* the band, in
       * element pixels. Frosted glass, and CSS's `backdrop-filter` exactly.
       * Absent or 0 means the band is drawn straight over a sharp picture, which
       * is the byte-identical path it always took.
       *
       * The band's own edge stays crisp, and `color` with `opacity` is the tint
       * on the glass — a frosted caption is a blurred backdrop plus a
       * translucent wash, which is what makes it readable rather than merely
       * blurry. `renderer/backdrop.ts` holds the mechanism and the one thing it
       * cannot do: a transition has no backdrop to read, so the tint draws and
       * the frost does not.
       */
      blur?: number;
    };
    fill?: TextFill;
    /**
     * 0-100, applied to the glyphs alone. Distinct from `Visual.opacity`, which
     * fades the whole element — background box, shadow and all.
     */
    textOpacity?: number;
    /**
     * Absent means the whole text is shown, and clearing a reveal deletes the
     * key — so a project nobody has revealed saves byte-identically to one
     * written before the feature, and `SCHEMA_VERSION` did not move. The rule
     * `blend`, `lut` and `mask` all follow.
     */
    reveal?: TextReveal;
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
 * What the user has dropped into one of a template's slots.
 *
 * `offsetMs` is an in-point in the **source file**, not a timeline offset: a
 * slot's span is fixed by the template, so a longer source is used head-first
 * and this is which head. `features/template/compose.ts` turns it into the
 * placeholder's `trim` window, clamped so a short source cannot be scrolled off
 * its own end.
 */
export type TemplateFill =
  | {
      kind: "media";
      localpath: string;
      offsetMs: number;
      /** The replacement's full length, probed once when it was chosen. */
      sourceDurationMs: number;
    }
  | { kind: "text"; text: string };

/**
 * An installed template, placed once: a whole edit standing in for one clip.
 *
 * The nested-composition element, and the only one whose picture is not drawn
 * by a renderer reading this element's own fields. `renderer/template.ts`
 * resolves `templateId` through `features/template/templateRegistry.ts`,
 * composites that document into a layer of the template's native size, and
 * blits the layer through this element's transform — so the template scales,
 * rotates, fades and keyframes exactly like an image, with no special case in
 * `drawDirect`, `sampledBoxOf`, the hit test or the preview's grips.
 *
 * **It stores a reference, not a copy**, which is the decision the whole
 * feature turns on. `HistoryEntry` keeps fifty snapshots of the element map and
 * a baked animation lane runs to 36,000 samples; an inner document inlined here
 * would ride in every one of them, would force `normalizeDocument` to recurse,
 * and would have to be whitelisted past `agent/serialize.ts`'s output cap. The
 * cost is the contract a LUT already has and is stated the same way: a template
 * that is not installed **draws nothing and reports nothing**. `name` is on the
 * element rather than looked up, so the bar still says what is missing.
 *
 * Deliberately not `Blendable`, `Gradable` or `Maskable`. A template's contents
 * are the author's; what the user may control is where it sits and how solid it
 * is, and nothing else. Leaving the three off also keeps `BLENDABLE_FILETYPES`,
 * `GRADABLE_FILETYPES` and `MASKABLE_FILETYPES` the same five they have always
 * been.
 *
 * `duration` is fixed at the template's own length —
 * `features/timeline/templateOps.ts#isDurationLocked` is the single predicate
 * every trim, split and speed op declines on, and `layout.ts#hitTest` reads it
 * so the trim handles are never offered in the first place.
 */
export type TemplateElementType = TimelinePlaced &
  Visual &
  Animatable & {
    filetype: "template";
    /** Which installed template this is. Resolved through the registry. */
    templateId: string;
    /** Shown on the bar, as a group's is. Survives the template going missing. */
    name: string;
    /** slotId -> the user's replacement. A slot with no entry keeps its placeholder. */
    fills: Record<string, TemplateFill>;
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
  | TransitionElementType
  | TemplateElementType;

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
  //
  // `template` is the one filetype that has taken that default on purpose. It
  // does paint itself onto whatever is there — `renderer/template.ts` composites
  // the referenced document into a layer of its own and blits it once — so it
  // fits `ElementRenderFunction` exactly, and being visual is what gives it the
  // transform, opacity, mask-free blit and control outline every other element
  // gets from `renderElement` without asking.
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

export function isTemplateElement(
  element: TimelineElement | undefined | null,
): element is TemplateElementType {
  return element?.filetype === "template";
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
  | EffectElementType
  | TemplateElementType;

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
    element.filetype === "effect" ||
    // A template's five tracks are the whole of what a user may control on it:
    // its length, its contents and its timing all belong to the author, so
    // where it sits and how solid it is are what is left.
    element.filetype === "template"
  );
}

/**
 * The mask's own keyframe tracks, which live in `element.animation` beside the
 * clip's.
 *
 * Same record, new names — deliberately, and it is the whole reason masks
 * animate at all without a second keyframe subsystem. `normalizeAnimation`,
 * `cloneAnimation`, `rebaseAnimation`, `sliceAnimation` and `rebakeElement` all
 * walk `Object.keys(animation)` or `animatableProperties(element)`, so split,
 * trim, duplicate, paste and a project frame-rate change carry mask curves for
 * free. A parallel `mask.animation` block would have needed all five
 * reimplemented, and the fifth one anyone forgot would fail silently on one
 * axis of one property.
 *
 * These exist on an element **only while it carries a mask**, and
 * `keyframes.ts#normalizeAnimation` collects them when it does not — see
 * `animatableProperties` below.
 *
 * Units are the ones `MaskType` stores: percentages of the element box for
 * position and size, degrees for rotation, element-local pixels for feather,
 * 0-100 for roundness. That is what makes them readable in the curve editor,
 * which draws raw track values.
 */
export const MASK_ANIMATABLE_PROPERTIES = [
  "maskPosition",
  "maskSize",
  "maskRotation",
  "maskFeather",
  "maskRoundness",
] as const;

export type MaskAnimatableProperty =
  (typeof MASK_ANIMATABLE_PROPERTIES)[number];

/**
 * The tracks a text clip carries only while it has a `reveal`.
 *
 * One track, holding the 0-100 progress. It sits in `element.animation` beside
 * the clip's own five for the reason the mask's five do: everything that
 * rewrites keyframes walks `Object.keys(animation)`, so split, trim, duplicate,
 * paste and a frame-rate change carry a typewriter's timing for free.
 *
 * Kept out of `emptyAnimation` and gated in `animatableProperties` below, so a
 * clip with no reveal has no such track to save — and
 * `keyframes.ts#normalizeAnimation` collects the orphans if one is left behind.
 */
export const TEXT_ANIMATABLE_PROPERTIES = ["revealProgress"] as const;

export type TextAnimatableProperty =
  (typeof TEXT_ANIMATABLE_PROPERTIES)[number];

/**
 * The tracks a clip carries on its own account, as a value rather than a type.
 *
 * A runtime list because `electron/` cannot import this module — `rootDir` is
 * pinned to `electron/`, which is why `mcp/tools/define.ts` keeps a copy of
 * this array — and `tools.test.ts` can only compare the copy against something
 * it can actually import. It used to compare it against these four names typed
 * out a third time in the test itself, which meant the guard was exactly as
 * stale as the copy it was guarding: adding a property left all three lists
 * disagreeing and every test passing.
 */
export const OWN_ANIMATABLE_PROPERTIES = [
  "position",
  "opacity",
  "scale",
  "rotation",
  "size",
] as const;

export type AnimatableProperty =
  | (typeof OWN_ANIMATABLE_PROPERTIES)[number]
  | MaskAnimatableProperty
  | TextAnimatableProperty;

/**
 * Every property that can carry a track — the conditional families included.
 *
 * Assembled here rather than at the one place that needs it, which is
 * `mcp/tools/define.ts`'s hand copy and the test that pins it. Spelling the
 * families out in that test made the guard go stale *at the same moment* as the
 * copy it exists to guard: `size` was added to the union, to
 * `animatableProperties` and to every consumer, and the test went on passing
 * against a list that named four of the five. A guard that can only be wrong
 * when this line is wrong cannot repeat that.
 *
 * Membership here says a property is animatable *somewhere*, not on every clip
 * — `animatableProperties(element)` is the only answer to that question.
 */
export const ALL_ANIMATABLE_PROPERTIES: readonly AnimatableProperty[] = [
  ...OWN_ANIMATABLE_PROPERTIES,
  ...MASK_ANIMATABLE_PROPERTIES,
  ...TEXT_ANIMATABLE_PROPERTIES,
];

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
 * lane all switch on, so a new animatable property is a change to the keyframe
 * subsystem rather than a line added to this list — `size` cost a lane
 * registration in `lanesOf`, a `staticValueOf` case, a seeded track in
 * `emptyAnimation` and a sampled box in `transform.ts`. `intensity` stays
 * static until someone does that work for it.
 *
 * **The mask made this a function of the element's state, not just its
 * filetype**, and that is the one surprising thing about it. A clip's mask
 * tracks exist only while it has a mask: applying one seeds them, clearing one
 * removes them, and this gate is what makes both true everywhere at once —
 * `keyframeOps.resolve` refuses a mask keyframe on an unmasked clip with no
 * guard of its own, `rebakeElement` skips tracks that should not be there, and
 * the curve editor and the diamond lane offer nothing to animate until there is
 * something to animate. The cost is that an *orphan* track — mask curves with
 * no mask, from a hand-edited file or a partial write — would be invisible to
 * every one of them while still riding along in the saved project, which is why
 * `keyframes.ts#normalizeAnimation` deletes those on ingress.
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
  // `size` is offered to a group as well, and that is deliberate rather than
  // an oversight: a group's box is its rotate/scale pivot, so animating it
  // moves the pivot and leaves the children exactly where they are. Excluding
  // it would put a filetype exception here that the context menu, the diamond
  // lane and the MCP schema would each have to re-derive.
  const own: AnimatableProperty[] = [...OWN_ANIMATABLE_PROPERTIES];
  if ((element as { mask?: unknown }).mask != null) {
    own.push(...MASK_ANIMATABLE_PROPERTIES);
  }
  // Text's `revealProgress` is gated the same way and for the same reason: a
  // clip with no reveal has nothing to progress through, and offering the
  // stopwatch would seed a track that `withReveal` would then have to strip.
  if (
    element.filetype === "text" &&
    (element as { reveal?: unknown }).reveal != null
  ) {
    own.push(...TEXT_ANIMATABLE_PROPERTIES);
  }
  return own;
}

export interface Timeline {
  [elementId: string]: TimelineElement;
}
