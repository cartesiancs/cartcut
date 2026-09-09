import { v4 as uuidv4 } from "uuid";
import { LitElement, html } from "lit";
import { customElement, property, query } from "lit/decorators.js";
import { ITimelineStore, useTimelineStore } from "../../states/timelineStore";
import { consume } from "@lit/context";
import { timelineContext } from "../../context/timelineContext";
import { IUIStore, uiStore } from "../../states/uiStore";
import { IKeyframeStore, keyframeStore } from "../../states/keyframeStore";
import {
  IRenderOptionStore,
  renderOptionStore,
} from "../../states/renderOptionStore";
import {
  MASK_ANIMATABLE_PROPERTIES,
  animatableProperties,
  type AnimatableProperty,
  type TimelineElement,
} from "../../@types/timeline";
import {
  deleteClips,
  moveClips,
  rippleDelete,
  trimClipEnd,
  trimClipStart,
} from "../timeline/clipOps";
import {
  normalizeFps,
  shouldShowFrameGrid,
  stepCursorByFrames,
} from "../timeline/frames";
import { clampRange } from "../timeline/zoom";
import {
  resolveMove,
  resolveTransitionResize,
  resolveTrim,
} from "../timeline/dragResolve";
import {
  addTransition,
  cutPointsOn,
  setTransitionDuration,
} from "../timeline/transitionOps";
import { addEffect } from "../timeline/effectOps";
import { isGradable, setClipLut } from "../timeline/lutOps";
import { DEFAULT_EFFECT_MS } from "./effectElement";
import {
  DEFAULT_TRANSITION_MS,
  maxTransitionMs,
} from "../timeline/transitionGeometry";
import {
  defaultParamsFor,
  presetById,
  presetsOfKind,
  subscribePresets,
} from "../fx/presetRegistry";
import {
  TRACK_PITCH,
  clipsInRect,
  hitTest,
  layoutTimeline,
  rectBetween,
  trackAtY,
  type ScreenRect,
  type TimelineLayout,
} from "../timeline/layout";
import {
  DRAG,
  idleDrag,
  reduceDrag,
  type DragState,
  type PointerEv,
} from "../timeline/dragMachine";
import {
  clipLabel,
  drawDropTarget,
  drawMarquee,
  drawTimeline,
} from "../timeline/draw";
import { applySurface, surfaceSpec } from "../timeline/canvasSurface";
import {
  createVideoTileProvider,
  type VideoTileProvider,
} from "../timeline/strip/videoTiles";
import {
  sharedAudioPeakProvider,
  type AudioPeakProvider,
} from "../timeline/strip/audioPeaks";
import { type TimelineDocument } from "../timeline/tracks";
import { canBeGrouped, removeFromParent } from "../timeline/groupOps";
import { addTemplateToTimeline } from "../template/addTemplate";
import {
  clearReplaceable,
  isReplaceable,
  replaceableOf,
  setReplaceable,
} from "../timeline/templateOps";
import { parentOf, withDescendants } from "../timeline/hierarchy";
import { canDetachAudio } from "../timeline/audio";
import { detachAudioFrom } from "../timeline/audioOps";
import { rasterizeTextElements } from "./rasterizeText";
import {
  ASSET_MIME,
  FX_PRESET_MIME,
  LUT_PRESET_MIME,
  TEMPLATE_MIME,
  dropIntent,
} from "../asset/dropIntent";
import { dropTargetAt } from "../asset/dropTarget";
import { importDroppedFiles, importPathsAt } from "../asset/importDrop";
import { isTypingEvent } from "../../utils/typingTarget";
import { hasEditorModifier } from "../../utils/platform";
import { mergeIds, selectionStore } from "../../states/selectionStore";
import {
  copySelection,
  cutSelection,
  deleteSelection,
  groupClips,
  pasteFromClipboard,
  redo,
  splitSelection,
  undo,
  ungroupClips,
} from "../editor/actions";
import { penCapturesKey } from "../mask/penSession";
import { count as perfCount } from "../debug/frameStats";

/** What a click on a bare cut reaches for first. */
const DEFAULT_TRANSITION_PRESET = "com.cartcut.cross-dissolve";

/**
 * How each animatable property is named and drawn on the context menu.
 *
 * A lookup rather than a formatted string because the icon cannot be derived
 * from the property name. An unlisted property still gets an entry — its own
 * name, with no icon — so widening `animatableProperties` can never silently
 * drop a row from the menu.
 *
 * The labels are bare nouns because these rows live inside the "Animate" and
 * "Animate mask" submenus, which say the verb once. That is also why the two
 * `position` entries can read alike: they are never on the same panel.
 */
const ANIMATION_MENU: Record<string, { label: string; icon: string }> = {
  position: { label: "Position", icon: "open_with" },
  opacity: { label: "Opacity", icon: "opacity" },
  scale: { label: "Scale", icon: "aspect_ratio" },
  rotation: { label: "Rotation", icon: "rotate_90_degrees_cw" },
  // Not `aspect_ratio`, which `scale` above already wears: the two are next to
  // each other on this menu and are the pair most easily confused for one
  // another, so they must not also look alike.
  size: { label: "Size", icon: "open_in_full" },
  // The mask's five, which `animatableProperties` offers only on a clip that
  // has one. Listed because the fallback above would otherwise render them as
  // `maskPosition` — correct, and not English.
  maskPosition: { label: "Position", icon: "open_with" },
  maskSize: { label: "Size", icon: "aspect_ratio" },
  maskRotation: { label: "Rotation", icon: "rotate_90_degrees_cw" },
  maskFeather: { label: "Feather", icon: "blur_on" },
  maskRoundness: { label: "Roundness", icon: "rounded_corner" },
};

/** The mask's five, as a set, for splitting the menu in two. */
const MASK_ANIMATION_PROPERTIES = new Set<string>(MASK_ANIMATABLE_PROPERTIES);

/**
 * A clip's label, with an effect's preset name resolved.
 *
 * `draw.ts` derives labels from the element alone, which is right for every
 * other type — a clip is named after its file, a title after its words. An
 * effect's name lives in a preset manifest on disk, and the painter is DOM-free
 * and drawn against a Skia canvas in tests, so it cannot read one. This is the
 * hook it exposes for exactly that; the preset id is the fallback when the
 * preset is not installed, which is at least true.
 */
function labelForClip(element: TimelineElement): string {
  if (element.filetype === "effect") {
    return presetById(element.presetId)?.name ?? clipLabel(element);
  }
  return clipLabel(element);
}

/**
 * The timeline canvas.
 *
 * This used to be 1,500 lines that measured clips, hit-tested them, drew them,
 * and edited them — with the row geometry written out four separate times
 * across two files and, inevitably, disagreeing. All of that now lives in
 * DOM-free modules under `features/timeline/`, each with its own tests, and
 * what is left here is the part that genuinely needs a browser: a canvas, some
 * event listeners, and the store.
 */
@customElement("element-timeline-canvas")
export class elementTimelineCanvas extends LitElement {
  /**
   * The selection, kept in `selectionStore` and reached through here.
   *
   * An accessor rather than a field so every call site in this file — and the
   * agent's `select_clips`/`get_selection`, which reach for this property
   * through the DOM — reads and writes exactly as it did, while the value
   * itself lives somewhere the toolbar can subscribe to. A plain field notified
   * nobody, which is why writing it used to have to be followed by a manual
   * `drawCanvas()`.
   */
  get targetId(): string[] {
    return selectionStore.getState().ids;
  }

  set targetId(ids: string[]) {
    selectionStore.getState().setIds(ids);
  }

  /**
   * The selection as it stood when the context menu opened.
   *
   * Stays a plain field: this is a snapshot of one gesture, not the app's idea
   * of what is selected, and nothing outside this component should see it.
   */
  targetIdDuringRightClick: string[] = [];

  private dragState: DragState = idleDrag;
  /** The document as it stood when the drag began. */
  private dragBase: TimelineDocument | null = null;
  /**
   * The selection the drag is carrying.
   *
   * Also the band's starting point: `dispatchPointer` snapshots this on `down`
   * *before* the effects run, so for a shift-drag over empty space it holds
   * the selection as it stood when the button went down — the thing a band
   * extends, and the thing Escape puts back.
   */
  private dragIds: string[] = [];
  private longPressTimer = 0;
  /** Row a freed clip is currently hovering over, for the drop highlight. */
  private dropTrackId: string | null = null;
  /** The rubber-band currently being dragged, in canvas px, or null. */
  private marqueeRect: ScreenRect | null = null;
  /**
   * The document as the drag has it so far.
   *
   * A drag draws from this and writes to the store exactly once, on mouseup.
   * Every mousemove used to call `patchTimeline`, which churned the store at
   * pointer rate and let a single drag eat the whole undo history.
   */
  private pendingDoc: TimelineDocument | null = null;
  private snapGuideMs: number | null = null;
  /**
   * Whether the frame lattice is currently drawn.
   *
   * The only state the hysteresis needs: `shouldShowFrameGrid` stays a pure
   * function by being handed its own previous answer, so the grid cannot strobe
   * while the zoom slider crosses the threshold.
   */
  private frameGridOn = false;
  private layout: TimelineLayout = {
    rows: [],
    clips: [],
    transitions: [],
    cuts: [],
    totalHeight: 0,
  };
  private canvasVerticalScroll = 0;

  /**
   * The bare cut under the pointer, hinted while hovered.
   *
   * Display-only, like `snapGuideMs`: it takes no part in hit-testing, which
   * reads the cut rects out of `layout` directly.
   */
  private hoveredCut: { trackId: string; fromId: string } | null = null;

  /**
   * Decodes filmstrip frames in the background.
   *
   * Drawing only ever reads from it, so a frame that is not ready yet costs
   * nothing; when one lands it asks for a repaint.
   */
  private tiles: VideoTileProvider = createVideoTileProvider();
  /**
   * Shared, not owned: the preview's level meter reads the same decoded peaks.
   * See `sharedAudioPeakProvider`. This element unsubscribes from it on
   * disconnect but must never dispose it.
   */
  private peaks: AudioPeakProvider = sharedAudioPeakProvider();
  private disposeStrips: Array<() => void> = [];

  constructor() {
    super();
    window.addEventListener("resize", this.handleWindowResize);
    window.addEventListener("keydown", this._handleKeydown.bind(this));
    document.addEventListener("mousedown", this._handleDocumentClick.bind(this));

    // A drag has to keep tracking once the pointer leaves the canvas —
    // dragging a clip up to another row means moving well outside it — and it
    // must end even if the button is released somewhere else entirely,
    // otherwise the drag sticks to the cursor.
    window.addEventListener("mousemove", this.handleWindowMouseMove);
    window.addEventListener("mouseup", this.handleWindowMouseUp);
    window.addEventListener("blur", this.handleCancelGesture);
  }

  /** Bound so `this` survives the listener call. */
  private handleWindowResize = () => {
    this.drawCanvas();
  };

  private handleWindowMouseMove = (e: MouseEvent) => {
    if (this.dragState.phase === "idle" || !this.canvas) {
      return;
    }
    const rect = this.canvas.getBoundingClientRect();
    this.dispatchPointer({
      type: "move",
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
      t: e.timeStamp,
    });
  };

  private handleWindowMouseUp = (e: MouseEvent) => {
    if (this.dragState.phase !== "idle") {
      this.dispatchPointer({ type: "up", t: e.timeStamp });
    }
  };

  /** Escape abandons a drag; so does the window losing focus mid-gesture. */
  private handleCancelGesture = () => {
    if (this.dragState.phase !== "idle") {
      this.dispatchPointer({ type: "cancel" });
    }
  };

  private timelineResizeObserver?: ResizeObserver;

  /**
   * `element-timeline` sits in a resizable split pane and can measure 0 high at
   * first paint, so observing it covers both the first real layout and every
   * later resize.
   */
  protected firstUpdated(): void {
    const timeline = document.querySelector("element-timeline");
    if (timeline) {
      this.timelineResizeObserver = new ResizeObserver(() => this.drawCanvas());
      this.timelineResizeObserver.observe(timeline);
    }
    this.disposeStrips = [
      this.tiles.onReady(() => this.drawCanvas()),
      this.peaks.onReady(() => this.drawCanvas()),
    ];
    this.drawCanvas();
  }

  disconnectedCallback(): void {
    for (const dispose of this.disposeStrips) {
      dispose();
    }
    this.disposeStrips = [];
    this.tiles.dispose();
    // `peaks` is deliberately not disposed: it is the shared decode cache, and
    // the preview's level meter is still reading it.
    this.timelineResizeObserver?.disconnect();
    this.timelineResizeObserver = undefined;
    // A coalesced repaint outlives the element that asked for it otherwise, and
    // would run `paintCanvas` against a canvas that is no longer in the tree.
    if (this.drawRequest) {
      cancelAnimationFrame(this.drawRequest);
      this.drawRequest = 0;
    }
    window.removeEventListener("resize", this.handleWindowResize);
    window.removeEventListener("mousemove", this.handleWindowMouseMove);
    window.removeEventListener("mouseup", this.handleWindowMouseUp);
    window.removeEventListener("blur", this.handleCancelGesture);
    window.clearTimeout(this.longPressTimer);
    super.disconnectedCallback();
  }

  @query("#elementTimelineCanvasRef") canvas!: HTMLCanvasElement;

  @property({ attribute: false })
  timelineState: ITimelineStore = useTimelineStore.getInitialState();

  @property({ attribute: false })
  timeline: any = this.timelineState.timeline;

  @property({ attribute: false })
  tracks = this.timelineState.tracks;

  @property({ attribute: false })
  timelineRange = this.timelineState.range;

  @property({ attribute: false })
  timelineScroll = this.timelineState.scroll;

  @property({ attribute: false })
  timelineCursor = this.timelineState.cursor;

  @property({ attribute: false })
  timelineHistory = this.timelineState.history;

  @property({ attribute: false })
  control = this.timelineState.control;

  @property({ attribute: false })
  keyframeState: IKeyframeStore = keyframeStore.getInitialState();

  @property({ attribute: false })
  uiState: IUIStore = uiStore.getInitialState();

  @property({ attribute: false })
  resize = this.uiState.resize;

  @property({ attribute: false })
  renderOptionStore: IRenderOptionStore = renderOptionStore.getInitialState();

  @property({ attribute: false })
  renderOption = this.renderOptionStore.options;

  @consume({ context: timelineContext })
  @property({ attribute: false })
  public timelineOptions: any = { canvasVerticalScroll: 0 };

  createRenderRoot() {
    useTimelineStore.subscribe((state) => {
      this.timeline = state.timeline;
      this.tracks = state.tracks;
      this.timelineRange = state.range;
      this.timelineCursor = state.cursor;
      this.timelineScroll = state.scroll;
      this.timelineHistory = state.history;
      this.control = state.control;
      this.drawCanvas();
    });

    // The selection is drawn, so a change to it has to repaint — including one
    // made from somewhere else entirely, like the toolbar's merge narrowing the
    // selection or the agent's `select_clips`.
    selectionStore.subscribe(() => {
      this.drawCanvas();
    });

    // An effect clip is labelled with its preset's *name*, which lives in the
    // registry rather than in the document. The registry fills in
    // asynchronously at startup, well after this canvas has already painted —
    // so without this every effect on the timeline showed its raw preset id
    // until some unrelated edit happened to trigger a repaint.
    subscribePresets(() => {
      this.drawCanvas();
    });

    uiStore.subscribe((state) => {
      this.resize = state.resize;
      this.drawCanvas();
    });

    renderOptionStore.subscribe((state) => {
      this.renderOption = state.options;
      this.drawCanvas();
    });

    return this;
  }

  /** The document being displayed: mid-drag preview, or the committed one. */
  private currentDoc(): TimelineDocument {
    return this.pendingDoc ?? useTimelineStore.getState().getDocument();
  }

  /** A pending coalesced repaint, or 0. */
  private drawRequest = 0;

  /**
   * Ask for a repaint on the next frame.
   *
   * This is the entry point every caller gets — including the cross-component
   * ones that reach in through `querySelector` — because none of them needs the
   * pixels to exist before the call returns, and several of them fire far
   * faster than the display can show the result: a cursor tick on a 120Hz
   * panel, a mousemove from a high-rate pointer, a drag writing the document
   * once per event. Each of those used to be a synchronous relayout of every
   * clip plus a full-window paint.
   *
   * `previewCanvas.scheduleDraw` is the same thing, and was already doing it
   * for the viewport.
   *
   * Coalescing also keeps `this.layout` honest rather than compromising it.
   * Every hit test — `_handleMouseMove`, `_handleMouseDown`, the drop targets —
   * reads the layout `paintCanvas` last computed, so deferring the paint defers
   * the layout with it and the pointer goes on aiming at the frame actually on
   * screen. Painting eagerly would have let the layout run a frame *ahead* of
   * the picture, which is the `previewCanvas.collisionCheck` bug in a new
   * place: the picture in one spot and the pointer's idea of it in another.
   * The field is initialised to an empty layout, so a hit test before the first
   * paint misses rather than throwing.
   */
  drawCanvas() {
    if (this.drawRequest) {
      return;
    }
    this.drawRequest = requestAnimationFrame(() => {
      this.drawRequest = 0;
      this.paintCanvas();
    });
  }

  private paintCanvas() {
    perfCount("timeline.draw");
    const container = document.querySelector("element-timeline");
    if (!this.canvas || !container) {
      return;
    }

    const ctx = this.canvas.getContext("2d");
    if (!ctx) {
      return;
    }

    const dpr = window.devicePixelRatio || 1;
    // The canvas is absolutely positioned to the right of the track headers, so
    // its own width is what is left of the window. Using the full window width
    // ran it off the right edge by exactly the header width.
    const width = Math.max(
      0,
      window.innerWidth - this.resize.timelineVertical.leftOption,
    );
    const height = (container as HTMLElement).offsetHeight;

    // All four numbers, not three: `style.height` was missing and no
    // stylesheet supplies one, so the CSS box fell back to the `height`
    // attribute and every y coordinate was off by `dpr`. See `canvasSurface`.
    applySurface(this.canvas, ctx, surfaceSpec(width, height, dpr));

    const doc = this.currentDoc();
    this.layout = layoutTimeline({
      doc,
      range: this.timelineRange,
      hScroll: this.timelineScroll,
      vScroll: this.canvasVerticalScroll,
      viewportW: width,
      viewportH: height,
    });

    const fps = this.projectFps();
    // Recomputed each paint, carrying its own previous answer so the threshold
    // has hysteresis and the lattice cannot flicker mid zoom-drag.
    this.frameGridOn = shouldShowFrameGrid(
      this.timelineRange,
      fps,
      this.frameGridOn,
    );

    drawTimeline(ctx, {
      layout: this.layout,
      doc,
      range: this.timelineRange,
      hScroll: this.timelineScroll,
      viewportW: width,
      viewportH: height,
      fps,
      frameGrid: this.frameGridOn,
      // Selecting a group outlines its contents too. A group's bar sits on its
      // own row, often far from the clips it holds, so without this there is no
      // way to see what is in one — and the outline is drawn by the painter
      // already, so showing it costs nothing but the id list.
      //
      // Only the *drawn* selection is widened. `this.targetId` still holds what
      // the user picked, so a drag moves the group's bar alone and a delete
      // removes the group (taking its contents through `withDescendants`,
      // which is a decision `deleteClips` owns rather than the painter).
      selection: withDescendants(this.timeline, this.targetId),
      playheadMs: this.timelineCursor,
      projectEndMs: this.renderOption.duration * 1000,
      snapGuideMs: this.snapGuideMs,
      // Hinted only while hovered; a transcript-driven edit has hundreds of
      // cuts and marking them all would be noise.
      hoveredCut: this.hoveredCut,
      // `draw.ts` is DOM-free and cannot read a preset manifest off disk, so
      // an effect's display name is injected from here instead of derived.
      labelOf: labelForClip,
      provider: this.tiles,
      peaks: this.peaks,
    });

    if (this.dropTrackId != null) {
      drawDropTarget(ctx, this.layout, this.dropTrackId, width);
    }

    // Last, because it is the topmost transient. Outside `drawTimeline` for
    // the reason the drop target is: that function takes a document and a
    // layout and knows nothing about a gesture in flight.
    if (this.marqueeRect != null) {
      drawMarquee(ctx, this.marqueeRect);
    }
  }

  // ---------------------------------------------------------------- editing

  /** Apply a document transform and record one undo step. */
  private commit(fn: (doc: TimelineDocument) => TimelineDocument) {
    useTimelineStore.getState().withCheckpoint(fn);
  }

  /**
   * The project's frame rate.
   *
   * One source, `renderOptionStore.options.fps` — the same field
   * `features/export/renderTimeline.ts` samples the timeline with. The component
   * already subscribes to that store and repaints on any change, so making fps
   * editable later needs nothing here.
   */
  private projectFps(): number {
    return normalizeFps(this.renderOption?.fps);
  }

  /**
   * Move the playhead by whole frames, without accumulating error.
   *
   * Public because the Playback menu offers the same step. The modal-tool
   * guard stays inside rather than at the callers, so both surfaces decline
   * together while the mask pen is drawing.
   */
  public stepCursor(deltaFrames: number) {
    if (this.control.cursorType !== "pointer") {
      return;
    }
    this.timelineState.setCursor(
      stepCursorByFrames(this.timelineCursor, deltaFrames, this.projectFps()),
    );
  }

  /**
   * Delete and close the gap, pulling later clips on the same track backwards.
   * Delete and close the gap, pulling later clips on the same track backwards.
   *
   * Plain delete leaves the hole; this is the other half of the pair every
   * editor offers, and with one clip per row there was nothing for it to act on
   * before.
   */
  public rippleDeleteSelected() {
    const ids = [...this.targetIdDuringRightClick];
    this.commit((doc) => {
      let next = doc;
      for (const id of ids) {
        next = rippleDelete(next, id);
      }
      return next;
    });
  }

  /**
   * Remove the right-clicked clips.
   *
   * Acts on the context-menu snapshot rather than the live selection, so it
   * stays here instead of calling `deleteSelection` — the menu operates on what
   * was under the cursor when it opened.
   */
  public removeSeletedElements() {
    const ids = [...this.targetIdDuringRightClick];
    this.commit((doc) => deleteClips(doc, ids));
  }

  // ---------------------------------------------------------------- groups

  /**
   * Wrap the right-clicked selection in a new group.
   *
   * The work is `features/editor/actions#groupClips`, which the Clip menu also
   * calls; what stays here is the one thing the context menu means and the menu
   * bar does not — that it acts on the right-click snapshot rather than on the
   * live selection.
   */
  public groupSelected() {
    groupClips([...this.targetIdDuringRightClick]);
    this.drawCanvas();
  }

  /** Dissolve the right-clicked group, leaving its contents where they look. */
  public ungroupSelected() {
    ungroupClips([...this.targetIdDuringRightClick]);
    this.drawCanvas();
  }

  /** Detach the right-clicked clips from their group, keeping them in place. */
  public removeSelectedFromGroup() {
    const ids = [...this.targetIdDuringRightClick];
    const atMs = useTimelineStore.getState().cursor;
    this.commit((doc) => removeFromParent(doc, ids, atMs));
    this.drawCanvas();
  }

  /**
   * The group entries for the context menu, chosen from what is selected.
   *
   * "Ungroup" only when a group is in the selection; "remove from group" only
   * when something in it actually has a parent — offering an item that can only
   * decline is worse than not offering it.
   */
  private groupMenuTemplate(): string {
    const ids = this.targetIdDuringRightClick;
    if (ids.length === 0) {
      return "";
    }

    const doc = this.currentDoc();
    const call = (method: string, label: string, icon: string) =>
      `<menu-dropdown-item onclick="document.querySelector('element-timeline-canvas').${method}()" item-name="${label}" item-icon="${icon}"> </menu-dropdown-item>`;

    const rows: string[] = [];

    if (ids.every((id) => canBeGrouped(doc.elements[id]))) {
      rows.push(call("groupSelected", "Group selected", "layers"));
    }
    if (ids.some((id) => doc.elements[id]?.filetype === "group")) {
      rows.push(call("ungroupSelected", "Ungroup", "layers_clear"));
    }
    if (ids.some((id) => parentOf(doc.elements, id) != null)) {
      rows.push(call("removeSelectedFromGroup", "Remove from group", "link_off"));
    }

    return rows.join("\n          ");
  }

  // ----------------------------------------------------------- template slots

  /** Mark the right-clicked clips as slots in an exported template. */
  public markSelectedReplaceable() {
    const ids = [...this.targetIdDuringRightClick];
    this.commit((doc) => setReplaceable(doc, ids, uuidv4));
    this.drawCanvas();
  }

  /** Unmark them. */
  public unmarkSelectedReplaceable() {
    const ids = [...this.targetIdDuringRightClick];
    this.commit((doc) => clearReplaceable(doc, ids));
    this.drawCanvas();
  }

  /**
   * The replaceable entries, chosen from what is selected.
   *
   * Offered only when the op would do something — the rule this menu already
   * keeps for grouping and for detaching audio, and the reason is unchanged:
   * `menu-dropdown-item` has no disabled state, so an entry that could only
   * decline is worse than no entry.
   */
  private replaceableMenuTemplate(): string {
    const ids = this.targetIdDuringRightClick;
    if (ids.length === 0) {
      return "";
    }

    const doc = this.currentDoc();
    const call = (method: string, label: string, icon: string) =>
      `<menu-dropdown-item onclick="document.querySelector('element-timeline-canvas').${method}()" item-name="${label}" item-icon="${icon}"> </menu-dropdown-item>`;

    const rows: string[] = [];
    if (
      ids.some(
        (id) =>
          isReplaceable(doc.elements[id]) && replaceableOf(doc, id) == null,
      )
    ) {
      rows.push(
        call("markSelectedReplaceable", "Mark replaceable", "swap_horiz"),
      );
    }
    if (ids.some((id) => replaceableOf(doc, id) != null)) {
      rows.push(
        call("unmarkSelectedReplaceable", "Unmark replaceable", "block"),
      );
    }

    return rows.join("\n          ");
  }

  // ----------------------------------------------------------------- audio

  /**
   * Split the right-clicked clips' audio onto audio tracks of their own.
   *
   * One `withCheckpoint` for the whole selection, so Cmd+Z takes back the new
   * clips, the track they landed on and the silencing of their sources
   * together. Clips with nothing to detach are skipped inside the op, and a
   * selection where none of them can be detached returns the document by
   * identity — no undo step for a click that did nothing.
   */
  public detachAudioFromSelected() {
    const ids = [...this.targetIdDuringRightClick];
    this.commit((doc) => detachAudioFrom(doc, ids, uuidv4));
    this.drawCanvas();
  }

  /**
   * The "detach audio" entry, offered only when it would do something.
   *
   * `menu-dropdown-item` has no disabled state, so the choice is between
   * showing an item that can only decline and showing none — and the group
   * menu above already settled that question the same way.
   */
  private audioMenuTemplate(): string {
    const ids = this.targetIdDuringRightClick;
    if (ids.length === 0) {
      return "";
    }

    const doc = this.currentDoc();
    if (!ids.some((id) => canDetachAudio(doc.elements[id]))) {
      return "";
    }

    return `<menu-dropdown-item onclick="document.querySelector('element-timeline-canvas').detachAudioFromSelected()" item-name="Detach audio" item-icon="music_off"> </menu-dropdown-item>`;
  }

  /**
   * Bake the selected text clips into image clips.
   *
   * Async, unlike every other entry on this menu: the glyphs have to be drawn
   * and the PNG written before the document can change. The single checkpoint
   * happens inside `rasterizeTextElements` once all of that has landed, so the
   * whole selection is still one Cmd+Z.
   */
  public async rasterizeSelectedText() {
    const ids = [...this.targetIdDuringRightClick];
    const cursor = useTimelineStore.getState().cursor ?? 0;
    const results = await rasterizeTextElements(ids, cursor);

    const failed = results.filter((result) => !result.ok);
    if (failed.length > 0) {
      (document.querySelector("toast-box") as any)?.showToast({
        message: `Could not rasterize ${failed.length} clip(s)`,
        delay: "4000",
      });
    }

    this.drawCanvas();
  }

  /** The "rasterize text" entry, offered only when the selection has text. */
  private rasterizeMenuTemplate(): string {
    const ids = this.targetIdDuringRightClick;
    if (ids.length === 0) {
      return "";
    }

    const doc = this.currentDoc();
    if (!ids.some((id) => doc.elements[id]?.filetype === "text")) {
      return "";
    }

    return `<menu-dropdown-item onclick="document.querySelector('element-timeline-canvas').rasterizeSelectedText()" item-name="Rasterize text" item-icon="image"> </menu-dropdown-item>`;
  }

  // ----------------------------------------------------------------- drag

  /**
   * Apply the drag machine's verdict to the document.
   *
   * The machine decides *what kind* of gesture is happening, `dragResolve`
   * decides *where it lands*, and this turns that answer into a candidate
   * document. Recomputed from `dragBase` every frame rather than compounded, so
   * the clip tracks the pointer exactly.
   *
   * The arithmetic that used to live here — snapping, rounding, the no-op guard
   * — moved into `features/timeline/dragResolve.ts` so it could be tested. It
   * was the last real decision in the timeline that a suite could not reach,
   * and frame quantization is not something to add to untested code.
   */
  private applyDrag() {
    const base = this.dragBase;
    const drag = this.dragState;
    if (base == null) {
      return;
    }

    const fps = this.projectFps();

    if (
      drag.hit.kind === "transition" &&
      (drag.phase === "transitionStart" || drag.phase === "transitionEnd")
    ) {
      this.snapGuideMs = null;
      this.dropTrackId = null;

      const plan = resolveTransitionResize({
        base,
        transitionId: drag.hit.transitionId,
        edge: drag.phase === "transitionStart" ? "start" : "end",
        dxPx: drag.dxPx,
        range: this.timelineRange,
        fps,
      });
      if (plan.kind === "none") {
        this.drawCanvas();
        return;
      }

      // `setTransitionDuration` clamps to what the source handles can supply
      // and records the ask, so dragging past the available footage stops the
      // badge growing without losing what was asked for.
      this.pendingDoc = setTransitionDuration(
        base,
        drag.hit.transitionId,
        plan.durationMs,
      );
      this.drawCanvas();
      return;
    }

    if (drag.hit.kind !== "clip") {
      return;
    }

    this.snapGuideMs = null;
    this.dropTrackId = null;

    let next: TimelineDocument;

    if (drag.phase === "trimStart" || drag.phase === "trimEnd") {
      // Trimming acts on the grabbed clip alone; dragging one edge of a
      // multi-selection has no obvious meaning for the rest. `clipOps` clamps
      // the edge at the neighbouring clip rather than letting it overlap.
      const plan = resolveTrim({
        base,
        elementId: drag.hit.elementId,
        edge: drag.phase === "trimStart" ? "start" : "end",
        dxPx: drag.dxPx,
        range: this.timelineRange,
        fps,
      });
      if (plan.kind === "none") {
        this.drawCanvas();
        return;
      }
      next =
        drag.phase === "trimStart"
          ? trimClipStart(base, drag.hit.elementId, plan.trimMs)
          : trimClipEnd(base, drag.hit.elementId, plan.trimMs);
    } else {
      // The grabbed clip is resolved, and the whole selection then moves by
      // however much it actually travelled, so a multi-clip drag keeps its
      // shape.
      const plan = resolveMove({
        base,
        primaryId: drag.hit.elementId,
        dragIds: this.dragIds,
        dxPx: drag.dxPx,
        dyPx: drag.dyPx,
        free: drag.free,
        range: this.timelineRange,
        fps,
        playheadMs: this.timelineCursor,
        trackPitch: TRACK_PITCH,
      });

      // A gesture that moves nothing must produce nothing. `moveClips` builds a
      // fresh document even for a zero delta, so `next !== base` held and a
      // press-and-hold with a steady hand committed an undo step that appears
      // to do nothing — and, if a neighbour's edge happened to lie within the
      // snap tolerance, silently relocated the clip the user never dragged.
      if (plan.kind === "none") {
        this.drawCanvas();
        return;
      }

      this.snapGuideMs = plan.snapGuideMs;
      next = moveClips(base, this.dragIds, plan.appliedMs, plan.trackDelta);

      if (plan.trackDelta !== 0 && next !== base) {
        this.dropTrackId = next.elements[drag.hit.elementId]?.trackId ?? null;
      }
    }

    // A declined op returns its input. Holding the previous frame rather than
    // snapping back to the start makes a blocked drag come to rest against
    // whatever is in the way, instead of jumping home.
    if (next !== base) {
      this.pendingDoc = next;
    }
    this.drawCanvas();
  }

  /**
   * Recompute the band, and the selection it names.
   *
   * The screen-space twin of `applyDrag`: same moment in the gesture, same
   * per-move budget, but it produces a selection rather than a candidate
   * document. Separate because `applyDrag`'s entire job is turning the
   * machine's verdict into a `TimelineDocument`, and a band makes none — so a
   * marquee must not reach it, and the branch that keeps it out is stated in
   * `dispatchPointer` rather than left to `applyDrag`'s early return, which
   * only declines a band by coincidence of `hit.kind`.
   *
   * Selection is applied on every move, not once on release: watching clips
   * light up as the band sweeps them is the whole gesture. That costs nothing,
   * because `clipsInRect` answers in layout order — the same array whichever
   * way the band was dragged — so a move that swept nothing new is declined by
   * `setIds`' `sameIds` guard and wakes no subscriber. The repaint below is
   * unconditional anyway: the band itself has moved even when its contents
   * have not.
   */
  private applyMarquee() {
    const drag = this.dragState;
    const rect = rectBetween(drag.origin, {
      x: drag.origin.x + drag.dxPx,
      y: drag.origin.y + drag.dyPx,
    });
    this.marqueeRect = rect;

    // `this.layout` is the layout the last paint produced — the same one every
    // hit test in this file reads, and so the same pixels the user is aiming
    // at. See `drawCanvas`.
    const banded = clipsInRect(this.layout, rect);
    this.targetId = drag.shift ? mergeIds(this.dragIds, banded) : banded;

    this.drawCanvas();
  }

  /** Feed one pointer event to the machine and carry out what it asks for. */
  private dispatchPointer(ev: PointerEv) {
    const { state, effects } = reduceDrag(this.dragState, ev);
    const wasIdle = this.dragState.phase === "idle";
    this.dragState = state;

    if (ev.type === "down" && state.phase !== "idle") {
      this.dragBase = this.currentDoc();
      this.dragIds = [...this.targetId];
      // A hold has to be able to complete without the pointer moving.
      window.clearTimeout(this.longPressTimer);
      this.longPressTimer = window.setTimeout(
        () => this.dispatchPointer({ type: "tick", t: ev.t + DRAG.LONG_PRESS_MS }),
        DRAG.LONG_PRESS_MS,
      );
    }

    for (const effect of effects) {
      switch (effect.type) {
        case "cursor":
          this.style.cursor = effect.value;
          break;
        case "clearSelection":
          this.targetId = [];
          this.drawCanvas();
          break;
        case "restoreSelection":
          // A cancelled band. `dragIds` still holds the selection from before
          // the press — the idle branch below clears it, and that runs after
          // this loop.
          this.targetId = this.dragIds;
          this.drawCanvas();
          break;
        case "commit": {
          const pending = this.pendingDoc;
          this.pendingDoc = null;
          if (pending) {
            this.commit(() => pending);
          }
          break;
        }
        case "revert":
          this.pendingDoc = null;
          break;
        case "armed":
          // The clip is off its track now; showing that immediately is what
          // makes the gesture discoverable without a tooltip.
          this.drawCanvas();
          break;
        default:
          break;
      }
    }

    if (state.phase === "idle") {
      window.clearTimeout(this.longPressTimer);
      this.longPressTimer = 0;
      this.dragBase = null;
      this.dragIds = [];
      this.snapGuideMs = null;
      this.dropTrackId = null;
      // One place covers `up`, `cancel`, Escape and window blur.
      this.marqueeRect = null;
      // `commit` and `revert` clear this themselves, but a press that ends
      // without ever becoming a drag emits neither — and `applyDrag` has
      // already run for it, because a `pressed` state still tracks the pointer.
      // Left set, `currentDoc()` keeps returning that preview for good: the
      // canvas shows a clip position the store does not have, later store
      // changes are invisible, and the next real drag commits the stale
      // document on top of whatever happened in between. An ordinary imprecise
      // click — press, drift two pixels, release — was enough.
      this.pendingDoc = null;
      this.drawCanvas();
      return;
    }

    if (!wasIdle || ev.type !== "down") {
      if (state.phase === "marquee") {
        this.applyMarquee();
      } else {
        this.applyDrag();
      }
    }
  }

  // --------------------------------------------------------------- events

  /**
   * Clicking away from the timeline clears the selection.
   *
   * Bound to `mousedown`, which fires *before* the click a button acts on —
   * and that ordering made the toolbar inert the moment it shipped. Pressing
   * "split" cleared the selection on the way down, so by the time the button's
   * own handler ran there was nothing selected and the op declined.
   *
   * Chrome that exists to act on the selection therefore opts out with
   * `data-keeps-selection`. An allowlist rather than naming the toolbar here
   * because it will not be the last such surface: anything that operates on
   * what is selected has the same problem, and should not have to be known to
   * this file to avoid it.
   */
  _handleDocumentClick(e) {
    if (e.target?.id === "elementTimelineCanvasRef") {
      return;
    }

    if (
      e.target instanceof Element &&
      e.target.closest("[data-keeps-selection]") != null
    ) {
      return;
    }

    this.targetId = [];
    this.drawCanvas();
  }

  /**
   * Apply a wheel gesture to the timeline.
   *
   * Public because the track-header column forwards its own wheel events here
   * rather than working the scroll out for itself: the two columns are one
   * scrollable surface, and one implementation is what stops them drifting
   * apart. Vertical, horizontal and the Ctrl/pinch zoom therefore behave
   * identically wherever the pointer is.
   */
  applyWheel(e) {
    // Not `hasEditorModifier`. macOS synthesises `ctrlKey` on a trackpad pinch,
    // and Windows spells wheel-zoom Ctrl+wheel — so this one flag is the right
    // test on both platforms. Routing it through the editor modifier would make
    // pinch-to-zoom scroll the timeline on a Mac instead of magnifying it.
    if (e.ctrlKey) {
      e.preventDefault();
      // Proportional to the current range, so the wheel magnifies by a
      // constant ratio per notch — the same curve the slider now uses.
      const dx = parseFloat(e.deltaY) * (this.timelineRange / 75);
      const next = clampRange(this.timelineRange - dx, this.projectFps());
      if (next !== this.timelineRange) {
        this.timelineState.setRange(next);
      }
      return;
    }

    const nextVertical = Math.max(0, this.canvasVerticalScroll + e.deltaY);
    if (nextVertical !== this.canvasVerticalScroll) {
      this.canvasVerticalScroll = nextVertical;
      this.timelineOptions.canvasVerticalScroll = nextVertical;
      this.drawCanvas();
      this.syncTrackHeaders();
    }

    this.timelineState.setScroll(Math.max(0, this.timelineScroll + e.deltaX));
  }

  /**
   * Tell the track-header column to redraw at the new vertical scroll.
   *
   * Writing the offset into the shared context object is not enough on its own:
   * `@lit/context` publishes when the provider's property is *reassigned*, and
   * this is a mutation of the object it already holds. So the value is correct
   * the moment the column next renders, but nothing asks it to — until this
   * change that only happened when an unrelated store update happened to wake
   * it, which left the headers sitting a few notches behind the rows they name.
   */
  private syncTrackHeaders() {
    const headers: any = document.querySelector("element-timeline-left-option");
    headers?.requestUpdate();
  }

  _handleMouseMove(e) {
    // While a gesture is live the window listener owns tracking, so this only
    // has to keep the cursor honest about what is under the pointer.
    if (this.dragState.phase !== "idle") {
      return;
    }

    const hit = hitTest(this.layout, e.offsetX, e.offsetY);

    // The hovered cut, if any. Only one is ever hinted and only while the
    // pointer is on it — a transcript-driven edit has hundreds of cuts, and a
    // permanent marker on each would be noise.
    const nextHoveredCut =
      hit.kind === "cut"
        ? { trackId: hit.trackId, fromId: hit.fromId }
        : null;
    const hoverChanged =
      (this.hoveredCut?.fromId ?? null) !== (nextHoveredCut?.fromId ?? null) ||
      (this.hoveredCut?.trackId ?? null) !== (nextHoveredCut?.trackId ?? null);
    this.hoveredCut = nextHoveredCut;

    if (hit.kind === "clip") {
      this.style.cursor = hit.zone === "body" ? "pointer" : "ew-resize";
    } else if (hit.kind === "transition") {
      this.style.cursor = hit.zone === "body" ? "pointer" : "ew-resize";
    } else if (hit.kind === "cut") {
      this.style.cursor = "pointer";
    } else {
      this.style.cursor = "default";
    }

    // Repaint only when the hint actually appears or disappears — this runs at
    // pointer rate.
    if (hoverChanged) {
      this.drawCanvas();
    }
  }

  _handleMouseDown(e) {
    this.timelineState.setCursorType("pointer");

    const hit = hitTest(this.layout, e.offsetX, e.offsetY);

    // Selection is settled here, before the machine sees the press, because
    // what the drag carries depends on it.
    if (hit.kind === "clip") {
      if (e.shiftKey) {
        if (!this.targetId.includes(hit.elementId)) {
          this.targetId = [...this.targetId, hit.elementId];
        }
      } else if (!this.targetId.includes(hit.elementId)) {
        this.targetId = [hit.elementId];
      }
      this.showSideOption(hit.elementId);
    }

    if (hit.kind === "transition") {
      // Selecting it opens `<option-transition>`, which is the only way to
      // change its preset or alignment. Never additive: a transition has
      // nothing in common with a multi-clip selection, and the ops that act on
      // one take a single id.
      this.targetId = [hit.transitionId];
      this.showSideOption(hit.transitionId);
    }

    if (hit.kind === "cut") {
      this.addTransitionAtCut(hit.fromId, hit.toId);
    }

    // `mousedown` fires for the right button too, and that press still has to
    // reach the machine: it is what settles the selection `_handleContextmenu`
    // is about to snapshot. `primary` is what stops it *arming* anything — the
    // menu opens over the canvas, so a gesture tracking the pointer would sweep
    // a rubber-band underneath it as the hand moves to the menu.
    this.dispatchPointer({
      type: "down",
      x: e.offsetX,
      y: e.offsetY,
      t: e.timeStamp,
      hit,
      shift: e.shiftKey,
      alt: e.altKey,
      primary: e.button === 0,
    });

    this.drawCanvas();
  }

  _handleMouseUp(e) {
    if (this.dragState.phase !== "idle") {
      this.dispatchPointer({ type: "up", t: e.timeStamp });
    }
  }

  /**
   * Canvas-local coordinates for a drag event.
   *
   * `offsetX`/`offsetY` are not on the TS `DragEvent` type and needed an `any`
   * cast; measuring off the bounding rect matches what `handleWindowMouseMove`
   * already does for the mouse path, so both gestures read the same numbers.
   */
  private dragPoint(e: DragEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  /**
   * Accept a drop: an asset out of the panel, or files in from the OS.
   *
   * Assets could only ever be clicked before, which added them at the playhead
   * on whatever row the chooser picked. Dropping says where and on which track,
   * which is the whole point of having tracks — and OS files earn the same,
   * rather than always landing at the playhead the way they used to.
   */
  _handleDragOver(e: DragEvent) {
    const intent = dropIntent(e.dataTransfer?.types);

    if (intent === "ignore") {
      // Text or a link. Clear any highlight left from a previous drag rather
      // than leaving a row lit under something that will never drop.
      this._handleDragLeave();
      return;
    }

    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = "copy";
    }

    const { y } = this.dragPoint(e);
    const next = trackAtY(this.layout, y);
    if (next !== this.dropTrackId) {
      this.dropTrackId = next;
      this.drawCanvas();
    }
  }

  _handleDragLeave() {
    if (this.dropTrackId != null) {
      this.dropTrackId = null;
      this.drawCanvas();
    }
  }

  _handleDrop(e: DragEvent) {
    const intent = dropIntent(e.dataTransfer?.types);
    this._handleDragLeave();

    if (intent === "ignore") {
      return;
    }

    const { x, y } = this.dragPoint(e);
    const target = dropTargetAt(
      this.layout,
      x,
      y,
      this.timelineRange,
      this.timelineScroll,
      this.projectFps(),
    );

    if (intent === "template") {
      const templateId = e.dataTransfer?.getData(TEMPLATE_MIME);
      if (!templateId) {
        return;
      }
      e.preventDefault();
      void addTemplateToTimeline(templateId, {
        startMs: target.startMs,
        trackId: target.trackId,
      }).then((result) => {
        if (!result.ok) {
          (document.querySelector("toast-box") as any)?.showToast({
            message: result.message,
            delay: "3000",
          });
        }
        this.drawCanvas();
      });
      return;
    }

    if (intent === "lut-preset") {
      const presetId = e.dataTransfer?.getData(LUT_PRESET_MIME);
      if (!presetId) {
        return;
      }
      e.preventDefault();
      this.dropLutPreset(presetId, target.startMs, x, y);
      return;
    }

    if (intent === "fx-preset") {
      const presetId = e.dataTransfer?.getData(FX_PRESET_MIME);
      if (!presetId) {
        return;
      }
      e.preventDefault();
      this.dropFxPreset(presetId, target.startMs, x, y);
      return;
    }

    if (intent === "asset") {
      const originPath = e.dataTransfer?.getData(ASSET_MIME);
      if (!originPath) {
        return;
      }
      e.preventDefault();
      void importPathsAt([originPath], target);
      return;
    }

    // `preventDefault` here is also what tells the curtain's own `drop`
    // handler — which runs after this one, on `document` — that these files
    // are already spoken for.
    e.preventDefault();
    void importDroppedFiles(e.dataTransfer, target);
  }

  _handleContextmenu(e) {
    this.targetIdDuringRightClick = [...this.targetId];
    if (e.which == 3 || e.button == 2) {
      this.showMenuDropdown({ x: e.clientX, y: e.clientY });
    }
  }

  _handleKeydown(event) {
    // Bound to `window`, so a keystroke aimed at a text field arrives here too.
    // Without this, Backspace while typing deleted the selected clip.
    if (isTypingEvent(event)) {
      return;
    }

    // The mask pen owns Escape, Enter, Backspace and Delete while a stroke is
    // in progress, and this is where it takes them from: Backspace here would
    // delete the very clip being masked.
    //
    // `previewCanvas` also installs a capture-phase listener that calls
    // `stopPropagation`, and that is what handles a real keystroke — but it is
    // not sufficient on its own. Capture only beats a bubble listener when the
    // event's target is *below* `window` in the tree; for one dispatched at
    // `window` itself both fire in the AT_TARGET phase, in registration order,
    // and this listener is registered first because the timeline mounts before
    // the preview. So the ownership is stated here as well, where it cannot
    // depend on which element happened to have focus.
    if (
      this.control.cursorType === "pen" &&
      penCapturesKey(event.code)
    ) {
      return;
    }

    if (event.code === "Escape") {
      this.handleCancelGesture();
      return;
    }

    const mod = hasEditorModifier(event);

    // `event.code` and a platform-strict modifier: the old handler used
    // `keyCode` with a hard-coded `ctrlKey`, so none of these worked on macOS
    // at all. It then accepted `metaKey || ctrlKey`, which worked everywhere
    // but meant Ctrl+D on a Mac split a clip — a combination macOS spends on
    // its own text editing. `hasEditorModifier` takes Cmd there and Ctrl here,
    // and nothing else.
    switch (event.code) {
      case "ArrowUp":
        this.moveSelectionByTrack(-1);
        return;
      case "ArrowDown":
        this.moveSelectionByTrack(1);
        return;
      case "ArrowRight":
        this.stepCursor(1);
        return;
      case "ArrowLeft":
        this.stepCursor(-1);
        return;
      case "Backspace":
      case "Delete":
        deleteSelection();
        return;
    }

    if (!mod) {
      return;
    }

    // Every branch below delegates to `features/editor/actions`, which is also
    // what the timeline toolbar calls. The shortcut and the button are the same
    // code path by construction — there is no second implementation to drift.
    //
    // `preventDefault` matters here: the Electron app menu owns these same
    // accelerators through native `undo`/`redo`/`cut`/`copy`/`paste` roles, and
    // without this both fire. `isTypingEvent` above already let real text
    // editing through, so nothing that wants the native behaviour reaches this.
    switch (event.code) {
      case "KeyZ":
        event.preventDefault();
        if (event.shiftKey) {
          redo();
        } else {
          undo();
        }
        return;
      case "KeyC":
        event.preventDefault();
        copySelection();
        return;
      case "KeyV":
        event.preventDefault();
        pasteFromClipboard();
        return;
      case "KeyX":
        event.preventDefault();
        cutSelection();
        return;
      case "KeyD":
        event.preventDefault();
        splitSelection();
        return;
    }
  }

  /**
   * Move the selection one row up or down.
   *
   * Replaces `exchangePriority`, which swapped two elements' priorities to
   * reorder rows — and which was called with the selection *array* where a
   * single id was expected, so it never matched anything and silently did
   * nothing.
   *
   * Gated on the pointer tool, exactly as `stepCursor` is and for the same
   * reason: while a modal tool is active the arrow keys belong to it, or to
   * nothing. Without this, pressing Up while drawing a mask moved the clip
   * being masked to another track — one undo step per press, under a pointer
   * that was nowhere near the timeline.
   */
  public moveSelectionByTrack(delta: number) {
    if (this.control.cursorType !== "pointer") {
      return;
    }
    this.commit((doc) => moveClips(doc, this.targetId, 0, delta));
  }

  /** The app's toast, reached the way everything else in this file reaches it. */
  private toast(message: string) {
    (document.querySelector("toast-box") as any)?.showToast({
      message,
      delay: "4000",
    });
  }

  /**
   * A preset tile dropped onto the timeline.
   *
   * A transition goes to the nearest bare cut on the row under the pointer, and
   * an effect lands where it was dropped. Dropping a transition anywhere but on
   * a track with a cut has nothing to attach to, so it says so rather than
   * silently doing nothing — the failure mode a drop target most easily has.
   */
  /**
   * A filter dropped on the timeline.
   *
   * On a clip it becomes that clip's own grade; on empty track space it becomes
   * an adjustment layer over everything beneath. The two are the same decision
   * the Filter panel's click makes with and without a selection, and they have
   * to agree — a drag and a click that land in different places for the same
   * tile is the kind of thing nobody reports and everybody notices.
   */
  private dropLutPreset(
    presetId: string,
    startMs: number,
    x: number,
    y: number,
  ) {
    const preset = presetById(presetId);
    if (preset == null || preset.render.type !== "lut") {
      this.toast("That filter is no longer installed.");
      return;
    }

    const hit = hitTest(this.layout, x, y);
    if (hit.kind === "clip") {
      if (!isGradable(this.currentDoc().elements[hit.elementId])) {
        this.toast("A filter can only go on a picture clip.");
        return;
      }
      this.commit((doc) => setClipLut(doc, hit.elementId, presetId));
      selectionStore.getState().setIds([hit.elementId]);
      return;
    }

    const id = uuidv4();
    const trackId = uuidv4();
    this.commit((doc) =>
      addEffect(
        doc,
        id,
        presetId,
        Math.max(0, startMs),
        DEFAULT_EFFECT_MS,
        trackId,
        {},
      ),
    );
    selectionStore.getState().setIds([id]);
    this.toast(`${preset.name} added as an adjustment layer.`);
  }

  private dropFxPreset(
    presetId: string,
    startMs: number,
    _x: number,
    y: number,
  ) {
    const preset = presetById(presetId);
    if (preset == null) {
      this.toast("That preset is no longer installed.");
      return;
    }

    if (preset.kind === "transition") {
      const trackId = trackAtY(this.layout, y);
      if (trackId == null) {
        this.toast("Drop a transition on a track that has a cut.");
        return;
      }
      const bare = cutPointsOn(this.currentDoc(), trackId).filter(
        (cut) => cut.transitionId == null,
      );
      if (bare.length === 0) {
        this.toast("No cut on that track to put a transition on.");
        return;
      }
      const nearest = bare.reduce((best, cut) =>
        Math.abs(cut.atMs - startMs) < Math.abs(best.atMs - startMs)
          ? cut
          : best,
      );
      this.addTransitionAtCut(nearest.fromId, nearest.toId, presetId);
      return;
    }

    const id = uuidv4();
    const trackId = uuidv4();
    this.commit((doc) =>
      addEffect(
        doc,
        id,
        presetId,
        Math.max(0, startMs),
        DEFAULT_EFFECT_MS,
        trackId,
        defaultParamsFor(presetId),
        {
          blend:
            preset.render.type === "overlay"
              ? ((preset.render.blend as GlobalCompositeOperation) ?? "screen")
              : undefined,
        },
      ),
    );
    this.targetId = [id];
    this.showSideOption(id);
    this.drawCanvas();
  }

  // ------------------------------------------------------------ transitions

  /**
   * Put a transition on the cut the user clicked.
   *
   * The default is a cross-dissolve, centred, half a second — the same default
   * every NLE offers, and the one most likely to be what was wanted. Everything
   * else is changed in `<option-transition>` afterwards.
   *
   * `addTransition` declines by identity when the cut cannot take one — no
   * source handles on either side is the case that actually happens — so a
   * refusal costs no undo step. It is worth telling the user why, because a
   * click that appears to do nothing is otherwise indistinguishable from a
   * missed click.
   */
  private addTransitionAtCut(
    fromId: string,
    toId: string,
    wantPresetId?: string,
  ) {
    // The first installed transition preset, preferring the built-in
    // cross-dissolve. `presetsOfKind` lists built-ins first, so this is simply
    // the head of the list unless the user has removed them all.
    const preset =
      (wantPresetId != null ? presetById(wantPresetId) : null) ??
      presetById(DEFAULT_TRANSITION_PRESET) ??
      presetsOfKind("transition")[0];
    if (preset == null) {
      this.toast("No transition presets are installed.");
      return;
    }
    const presetId = preset.id;

    const before = this.currentDoc();
    const id = uuidv4();

    this.commit((doc) =>
      addTransition(
        doc,
        id,
        fromId,
        toId,
        presetId,
        DEFAULT_TRANSITION_MS,
        "center",
        defaultParamsFor(presetId),
      ),
    );

    const after = useTimelineStore.getState().getDocument();
    if (after.elements[id] == null) {
      // A refusal now means the *clips* are too short to hold one, which is a
      // real impossibility rather than a shortage of footage. Missing handles
      // no longer refuse: the transition holds a frozen frame instead, which
      // the badge marks and the panel explains.
      this.toast("These clips are too short to hold a transition.");
      return;
    }

    this.targetId = [id];
    this.showSideOption(id);
    this.drawCanvas();
  }

  // ------------------------------------------------------------ side panel

  showSideOption(elementId: string) {
    const optionGroup: any = document.querySelector("option-group");
    const element = this.currentDoc().elements[elementId];
    if (!optionGroup || !element) {
      return;
    }

    const allText = this.targetId.every(
      (id) => this.currentDoc().elements[id]?.filetype === "text",
    );

    if (element.filetype === "text" && allText) {
      optionGroup.showOptions({ filetype: "text", elementIds: this.targetId });
      return;
    }

    optionGroup.showOption({ filetype: element.filetype, elementId });
  }

  /**
   * Menu items for keyframe editing, when the selection can be animated.
   *
   * The left column used to carry these buttons, one set per element row. With
   * many clips per row there is no per-element row to hang them on, so they
   * moved to the clip's own context menu.
   */
  private animationMenuTemplate(): string {
    if (this.targetIdDuringRightClick.length !== 1) {
      return "";
    }

    const elementId = this.targetIdDuringRightClick[0];
    const element = this.currentDoc().elements[elementId];
    if (!element) {
      return "";
    }

    const properties = animatableProperties(element);

    return [
      this.animationSubmenuTemplate(
        "Animate",
        "animation",
        elementId,
        properties.filter((type) => !MASK_ANIMATION_PROPERTIES.has(type)),
      ),
      // `crop` is the icon the sidebar's Mask tab already wears
      // (`option/optionTabBar.ts`), so both name the same feature.
      this.animationSubmenuTemplate(
        "Animate mask",
        "crop",
        elementId,
        properties.filter((type) => MASK_ANIMATION_PROPERTIES.has(type)),
      ),
    ].join("");
  }

  /**
   * One `Animate …` row, and the panel it opens.
   *
   * Empty when the group is: `animatableProperties` offers the mask's five
   * only on a clip that has a mask, and a submenu with nothing behind it is
   * the affordance-that-can-only-decline the context menu already refuses to
   * draw elsewhere.
   */
  private animationSubmenuTemplate(
    label: string,
    icon: string,
    elementId: string,
    properties: AnimatableProperty[],
  ): string {
    if (properties.length === 0) {
      return "";
    }

    const items = properties
      .map((type) => {
        const entry = ANIMATION_MENU[type] ?? { label: type, icon: "" };
        return `<menu-dropdown-item onclick="document.querySelector('element-timeline-canvas').openAnimationPanel('${elementId}', '${type}')" item-name="${entry.label}" item-icon="${entry.icon}"></menu-dropdown-item>`;
      })
      .join("");

    return `<menu-dropdown-sub item-name="${label}" item-icon="${icon}">${items}</menu-dropdown-sub>`;
  }

  showMenuDropdown({ x, y }) {
    document.querySelector("#menuRightClick").innerHTML = `
        <menu-dropdown-body top="${y}" left="${x}">
          ${this.animationMenuTemplate()}
          ${this.audioMenuTemplate()}
          ${this.rasterizeMenuTemplate()}
          ${this.groupMenuTemplate()}
          ${this.replaceableMenuTemplate()}
          <menu-dropdown-item onclick="document.querySelector('element-timeline-canvas').removeSeletedElements()" item-name="Remove" item-icon="delete"> </menu-dropdown-item>
          <menu-dropdown-item onclick="document.querySelector('element-timeline-canvas').rippleDeleteSelected()" item-name="Remove and close gap" item-icon="delete_sweep"> </menu-dropdown-item>
        </menu-dropdown-body>`;
  }

  /**
   * Keyframe editing moved out of the timeline.
   *
   * An open animation panel used to consume four extra rows *inside* the
   * timeline — one each for position, opacity, scale and rotation. That only
   * worked while a row belonged to a single element; with many clips per track
   * there is no row to borrow. The bottom keyframe editor already does this
   * job, so these two just drive it.
   */
  public openAnimationPanel(targetId: string, animationType) {
    const offcanvas = new bootstrap.Offcanvas(
      document.getElementById("option_bottom"),
    );
    const target: any = document.querySelector("#timelineOptionTargetElement");

    this.keyframeState.update({
      elementId: targetId,
      animationType,
      isShow: true,
    });

    if (target) {
      target.value = targetId;
    }
    offcanvas.show();
  }

  public closeAnimationPanel(targetId: string) {
    this.keyframeState.update({
      elementId: targetId,
      animationType: "position",
      isShow: false,
    });
  }

  // ---------------------------------------------------------------- render

  /**
   * Re-apply the canvas sizing after every Lit render.
   *
   * The template writes the whole `style` attribute, so a re-render wipes the
   * `width`/`height` that `drawCanvas` set imperatively — and with them the
   * CSS box that `offsetY` is measured against. Redrawing here puts all four
   * numbers back. The template no longer carries a hardcoded `width: 1122px`
   * either; that was a fixed guess `drawCanvas` immediately overwrote.
   */
  protected updated(): void {
    this.drawCanvas();
  }

  protected render(): unknown {
    const canvasRef = document.querySelector("#elementTimelineCanvasRef");
    if (canvasRef) {
      this.timelineState.setCanvasWidth(canvasRef.clientWidth);
    }

    return html`
      <canvas
        id="elementTimelineCanvasRef"
        style="left: ${this.resize.timelineVertical
          .leftOption}px;position: absolute;"
        @dragover=${this._handleDragOver}
        @dragleave=${this._handleDragLeave}
        @drop=${this._handleDrop}
        @mousewheel=${this.applyWheel}
        @mousemove=${this._handleMouseMove}
        @mousedown=${this._handleMouseDown}
        @mouseup=${this._handleMouseUp}
        @contextmenu=${this._handleContextmenu}
      ></canvas>
    `;
  }
}
