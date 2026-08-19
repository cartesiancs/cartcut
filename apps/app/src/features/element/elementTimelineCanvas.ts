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
  animatableProperties,
  type TimelineElement,
} from "../../@types/timeline";
import {
  deleteClips,
  moveClips,
  pasteClips,
  rippleDelete,
  splitAtPlayhead,
  trimClipEnd,
  trimClipStart,
} from "../timeline/clipOps";
import { pxToMsSigned, spanLength } from "../timeline/geometry";
import {
  TRACK_PITCH,
  hitTest,
  layoutTimeline,
  timeAtX,
  trackAtY,
  type TimelineLayout,
} from "../timeline/layout";
import {
  DRAG,
  idleDrag,
  reduceDrag,
  trackDeltaFor,
  type DragState,
  type PointerEv,
} from "../timeline/dragMachine";
import { drawDropTarget, drawTimeline } from "../timeline/draw";
import {
  createVideoTileProvider,
  type VideoTileProvider,
} from "../timeline/strip/videoTiles";
import {
  createAudioPeakProvider,
  type AudioPeakProvider,
} from "../timeline/strip/audioPeaks";
import { collectSnapPoints, snapSpan } from "../timeline/snapping";
import { type TimelineDocument } from "../timeline/tracks";
import { AssetController } from "../../controllers/asset";
import { isTypingTarget } from "../../utils/typingTarget";

/** How close, in px, an edge must come before it snaps. */
const SNAP_TOLERANCE_PX = 10;

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
  targetId: string[] = [];
  targetIdDuringRightClick: string[] = [];

  private dragState: DragState = idleDrag;
  /** The document as it stood when the drag began. */
  private dragBase: TimelineDocument | null = null;
  /** The selection the drag is carrying. */
  private dragIds: string[] = [];
  private longPressTimer = 0;
  /** Row a freed clip is currently hovering over, for the drop highlight. */
  private dropTrackId: string | null = null;
  /**
   * The document as the drag has it so far.
   *
   * A drag draws from this and writes to the store exactly once, on mouseup.
   * Every mousemove used to call `patchTimeline`, which churned the store at
   * pointer rate and let a single drag eat the whole undo history.
   */
  private pendingDoc: TimelineDocument | null = null;
  private snapGuideMs: number | null = null;
  private layout: TimelineLayout = { rows: [], clips: [], totalHeight: 0 };
  private clipboard: Record<string, TimelineElement> = {};
  private canvasVerticalScroll = 0;

  /**
   * Decodes filmstrip frames in the background.
   *
   * Drawing only ever reads from it, so a frame that is not ready yet costs
   * nothing; when one lands it asks for a repaint.
   */
  private tiles: VideoTileProvider = createVideoTileProvider();
  private peaks: AudioPeakProvider = createAudioPeakProvider();
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
    this.peaks.dispose();
    this.timelineResizeObserver?.disconnect();
    this.timelineResizeObserver = undefined;
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

  drawCanvas() {
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

    this.canvas.style.width = `${width}px`;
    this.canvas.width = width * dpr;
    this.canvas.height = height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const doc = this.currentDoc();
    this.layout = layoutTimeline({
      doc,
      range: this.timelineRange,
      hScroll: this.timelineScroll,
      vScroll: this.canvasVerticalScroll,
      viewportW: width,
      viewportH: height,
    });

    drawTimeline(ctx, {
      layout: this.layout,
      doc,
      range: this.timelineRange,
      hScroll: this.timelineScroll,
      viewportW: width,
      viewportH: height,
      selection: this.targetId,
      playheadMs: this.timelineCursor,
      projectEndMs: this.renderOption.duration * 1000,
      snapGuideMs: this.snapGuideMs,
      provider: this.tiles,
      peaks: this.peaks,
    });

    if (this.dropTrackId != null) {
      drawDropTarget(ctx, this.layout, this.dropTrackId, width);
    }
  }

  // ---------------------------------------------------------------- editing

  /** Apply a document transform and record one undo step. */
  private commit(fn: (doc: TimelineDocument) => TimelineDocument) {
    useTimelineStore.getState().withCheckpoint(fn);
  }

  private copySelected() {
    const doc = this.currentDoc();
    const copied: Record<string, TimelineElement> = {};
    for (const elementId of this.targetId) {
      const element = doc.elements[elementId];
      if (element) {
        copied[elementId] = structuredClone(element);
      }
    }
    this.clipboard = copied;
  }

  /**
   * Cut the selected clips at the playhead.
   *
   * Both halves keep the original's `trackId`, so they land side by side on one
   * row. The old implementation handed the second half a fresh
   * `priority = max + 1`, and since a row *was* the priority-sorted index, that
   * put it on a brand-new row every time.
   */
  private splitSelected() {
    const at = this.timelineCursor;
    this.commit((doc) => splitAtPlayhead(doc, this.targetId, at, uuidv4));
  }

  /** Paste at the playhead, keeping the copied group's internal spacing. */
  private pasteClipboard() {
    const at = this.timelineCursor;
    this.commit((doc) => pasteClips(doc, this.clipboard, at, uuidv4));
  }

  private removeElements(ids: string[]) {
    this.commit((doc) => deleteClips(doc, ids));
  }

  /**
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

  public removeSeletedElements() {
    this.removeElements(this.targetIdDuringRightClick);
  }

  // ----------------------------------------------------------------- drag

  /**
   * Apply the drag machine's verdict to the document.
   *
   * The machine decides *what kind* of gesture is happening; this turns the
   * current offsets into a candidate document. Recomputed from `dragBase` every
   * frame rather than compounded, so the clip tracks the pointer exactly.
   */
  private applyDrag() {
    const base = this.dragBase;
    const drag = this.dragState;
    if (base == null || drag.hit.kind !== "clip") {
      return;
    }

    const deltaMs = pxToMsSigned(drag.dxPx, this.timelineRange);
    this.snapGuideMs = null;
    this.dropTrackId = null;

    let next: TimelineDocument;

    if (drag.phase === "trimStart" || drag.phase === "trimEnd") {
      // Trimming acts on the grabbed clip alone; dragging one edge of a
      // multi-selection has no obvious meaning for the rest. `clipOps` clamps
      // the edge at the neighbouring clip rather than letting it overlap.
      const trimMs = Math.round(deltaMs);
      next =
        drag.phase === "trimStart"
          ? trimClipStart(base, drag.hit.elementId, trimMs)
          : trimClipEnd(base, drag.hit.elementId, trimMs);
    } else {
      const primary = base.elements[drag.hit.elementId];
      if (!primary) {
        return;
      }

      // Snap the grabbed clip, then move the whole selection by however much
      // actually got applied, so a multi-clip drag keeps its shape.
      const desired = Math.max(0, primary.startTime + deltaMs);
      const snapped = snapSpan(
        desired,
        spanLength(primary),
        collectSnapPoints(base, {
          excludeIds: this.dragIds,
          playheadMs: this.timelineCursor,
        }),
        this.timelineRange,
        SNAP_TOLERANCE_PX,
        primary.trackId,
      );

      const trackDelta = drag.free
        ? trackDeltaFor(drag.dyPx, TRACK_PITCH)
        : 0;

      this.snapGuideMs = snapped.hit?.ms ?? null;

      // Round once, here, where pixels finally become a time. A fractional
      // delta leaves clips at 1988.888ms and, worse, a drag meant to be purely
      // vertical still nudges the clip along its track by a sub-pixel amount
      // — enough to break the exact adjacency a split just produced.
      const appliedMs = Math.round(snapped.startMs - primary.startTime);
      next = moveClips(base, this.dragIds, appliedMs, trackDelta);

      if (trackDelta !== 0 && next !== base) {
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
      this.drawCanvas();
      return;
    }

    if (!wasIdle || ev.type !== "down") {
      this.applyDrag();
    }
  }

  // --------------------------------------------------------------- events

  _handleDocumentClick(e) {
    if (e.target.id != "elementTimelineCanvasRef") {
      this.targetId = [];
      this.drawCanvas();
    }
  }

  _handleMouseWheel(e) {
    if (e.ctrlKey) {
      e.preventDefault();
      const dx = parseFloat(e.deltaY) * (this.timelineRange / 75);
      const next = this.timelineRange - dx;
      if (e.deltaY < 0 ? next < 5 : next > -8) {
        this.timelineState.setRange(next);
      }
      return;
    }

    const nextVertical = Math.max(0, this.canvasVerticalScroll + e.deltaY);
    if (nextVertical !== this.canvasVerticalScroll) {
      this.canvasVerticalScroll = nextVertical;
      this.timelineOptions.canvasVerticalScroll = nextVertical;
      this.drawCanvas();
    }

    this.timelineState.setScroll(Math.max(0, this.timelineScroll + e.deltaX));
  }

  _handleMouseMove(e) {
    // While a gesture is live the window listener owns tracking, so this only
    // has to keep the cursor honest about what is under the pointer.
    if (this.dragState.phase !== "idle") {
      return;
    }

    const hit = hitTest(this.layout, e.offsetX, e.offsetY);
    if (hit.kind === "clip") {
      this.style.cursor = hit.zone === "body" ? "pointer" : "ew-resize";
    } else {
      this.style.cursor = "default";
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

    this.dispatchPointer({
      type: "down",
      x: e.offsetX,
      y: e.offsetY,
      t: e.timeStamp,
      hit,
      shift: e.shiftKey,
      alt: e.altKey,
    });

    this.drawCanvas();
  }

  _handleMouseUp(e) {
    if (this.dragState.phase !== "idle") {
      this.dispatchPointer({ type: "up", t: e.timeStamp });
    }
  }

  /**
   * Accept an asset dragged from the browser.
   *
   * Assets could only ever be clicked before, which added them at time zero on
   * a brand-new row. Dropping says where and on which track, which is the whole
   * point of having tracks.
   */
  _handleDragOver(e: DragEvent) {
    if (!e.dataTransfer?.types.includes("application/x-nugget-asset")) {
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";

    this.dropTrackId = trackAtY(this.layout, (e as any).offsetY);
    this.drawCanvas();
  }

  _handleDragLeave() {
    if (this.dropTrackId != null) {
      this.dropTrackId = null;
      this.drawCanvas();
    }
  }

  _handleDrop(e: DragEvent) {
    const originPath = e.dataTransfer?.getData("application/x-nugget-asset");
    this.dropTrackId = null;
    if (!originPath) {
      return;
    }
    e.preventDefault();

    const atMs = Math.max(
      0,
      Math.round(
        timeAtX((e as any).offsetX, this.timelineRange, this.timelineScroll),
      ),
    );

    // Adding is asynchronous, so the position travels on the control rather
    // than as an argument; `commitNewElement` consumes it once.
    const control: any = document.querySelector("element-control");
    if (control) {
      control.dropHint = {
        startMs: atMs,
        trackId: trackAtY(this.layout, (e as any).offsetY),
      };
    }

    new AssetController().add(originPath);
    this.drawCanvas();
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
    if (isTypingTarget(event.target)) {
      return;
    }

    if (event.code === "Escape") {
      this.handleCancelGesture();
      return;
    }

    const mod = event.metaKey || event.ctrlKey;

    // `event.code` and `metaKey`: the old handler used `keyCode` with a
    // hard-coded `ctrlKey`, so none of these worked on macOS at all.
    switch (event.code) {
      case "ArrowUp":
        this.moveSelectionByTrack(-1);
        return;
      case "ArrowDown":
        this.moveSelectionByTrack(1);
        return;
      case "ArrowRight":
        if (this.control.cursorType === "pointer") {
          this.timelineState.increaseCursor(1000 / 60);
        }
        return;
      case "ArrowLeft":
        if (this.control.cursorType === "pointer") {
          this.timelineState.decreaseCursor(1000 / 60);
        }
        return;
      case "Backspace":
      case "Delete":
        this.removeElements(this.targetId);
        this.targetId = [];
        return;
    }

    if (!mod) {
      return;
    }

    switch (event.code) {
      case "KeyZ":
        this.timelineState.rollbackTimelineFromCheckPoint(
          event.shiftKey ? 1 : -1,
        );
        return;
      case "KeyC":
        this.copySelected();
        return;
      case "KeyV":
        this.pasteClipboard();
        return;
      case "KeyX":
        this.copySelected();
        this.removeElements(this.targetId);
        this.targetId = [];
        return;
      case "KeyD":
        this.splitSelected();
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
   */
  private moveSelectionByTrack(delta: number) {
    this.commit((doc) => moveClips(doc, this.targetId, 0, delta));
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

    return animatableProperties(element)
      .map(
        (type) =>
          `<menu-dropdown-item onclick="document.querySelector('element-timeline-canvas').openAnimationPanel('${elementId}', '${type}')" item-name="animate ${type}"></menu-dropdown-item>`,
      )
      .join("");
  }

  showMenuDropdown({ x, y }) {
    document.querySelector("#menuRightClick").innerHTML = `
        <menu-dropdown-body top="${y}" left="${x}">
          ${this.animationMenuTemplate()}
          <menu-dropdown-item onclick="document.querySelector('element-timeline-canvas').removeSeletedElements()" item-name="remove"> </menu-dropdown-item>
          <menu-dropdown-item onclick="document.querySelector('element-timeline-canvas').rippleDeleteSelected()" item-name="remove and close gap"> </menu-dropdown-item>
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

  protected render(): unknown {
    const canvasRef = document.querySelector("#elementTimelineCanvasRef");
    if (canvasRef) {
      this.timelineState.setCanvasWidth(canvasRef.clientWidth);
    }

    return html`
      <canvas
        id="elementTimelineCanvasRef"
        style="width: 1122px;left: ${this.resize.timelineVertical
          .leftOption}px;position: absolute;"
        @dragover=${this._handleDragOver}
        @dragleave=${this._handleDragLeave}
        @drop=${this._handleDrop}
        @mousewheel=${this._handleMouseWheel}
        @mousemove=${this._handleMouseMove}
        @mousedown=${this._handleMouseDown}
        @mouseup=${this._handleMouseUp}
        @contextmenu=${this._handleContextmenu}
      ></canvas>
    `;
  }
}
