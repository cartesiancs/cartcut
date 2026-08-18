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
import { splitAt, trimEnd, trimStart } from "../timeline/clipEdit";
import { pxToMsSigned, spanLength } from "../timeline/geometry";
import {
  hitTest,
  layoutTimeline,
  type Hit,
  type TimelineLayout,
} from "../timeline/layout";
import { drawTimeline } from "../timeline/draw";
import { collectSnapPoints, snapSpan } from "../timeline/snapping";
import {
  normalizeDocument,
  type TimelineDocument,
} from "../timeline/tracks";

/** How close, in px, an edge must come before it snaps. */
const SNAP_TOLERANCE_PX = 10;

type DragKind = "move" | "trimStart" | "trimEnd";

type DragState = {
  kind: DragKind;
  originX: number;
  /** Primary target — the clip actually grabbed. */
  elementId: string;
  /** The elements as they were at mousedown, keyed by id. */
  snapshot: Record<string, TimelineElement>;
};

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

  private drag: DragState | null = null;
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
  }

  /** Bound so `this` survives the listener call. */
  private handleWindowResize = () => {
    this.drawCanvas();
  };

  private handleWindowMouseMove = (e: MouseEvent) => {
    if (!this.drag || !this.canvas) {
      return;
    }
    const rect = this.canvas.getBoundingClientRect();
    this.updateDrag(e.clientX - rect.left);
  };

  private handleWindowMouseUp = () => {
    if (this.drag) {
      this.endDrag();
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
    this.drawCanvas();
  }

  disconnectedCallback(): void {
    this.timelineResizeObserver?.disconnect();
    this.timelineResizeObserver = undefined;
    window.removeEventListener("resize", this.handleWindowResize);
    window.removeEventListener("mousemove", this.handleWindowMouseMove);
    window.removeEventListener("mouseup", this.handleWindowMouseUp);
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
  public timelineOptions: any = { canvasVerticalScroll: 0, panelOptions: [] };

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
    });
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
   * Cut the selected clip at the playhead.
   *
   * Both halves keep the original's `trackId`, so they land side by side on one
   * row. The old implementation handed the second half a fresh
   * `priority = max + 1`, and since a row *was* the priority-sorted index, that
   * put it on a brand-new row every time.
   */
  private splitSelected() {
    const at = this.timelineCursor;
    this.commit((doc) => {
      let next = doc;
      let changed = false;

      for (const elementId of this.targetId) {
        const element = next.elements[elementId];
        if (!element) {
          continue;
        }
        const parts = splitAt(element, at);
        if (parts == null) {
          continue;
        }

        changed = true;
        next = {
          ...next,
          elements: {
            ...next.elements,
            [elementId]: parts.left,
            [uuidv4()]: parts.right,
          },
        };
      }

      return changed ? normalizeDocument(next) : doc;
    });
  }

  private pasteClipboard() {
    const entries = Object.entries(this.clipboard);
    if (entries.length === 0) {
      return;
    }

    this.commit((doc) => {
      const elements = { ...doc.elements };
      for (const [, element] of entries) {
        elements[uuidv4()] = structuredClone(element);
      }
      return normalizeDocument({ ...doc, elements });
    });
  }

  private removeElements(ids: string[]) {
    if (ids.length === 0) {
      return;
    }
    this.commit((doc) => {
      const elements = { ...doc.elements };
      for (const id of ids) {
        delete elements[id];
      }
      return normalizeDocument({ ...doc, elements });
    });
  }

  public removeSeletedElements() {
    this.removeElements(this.targetIdDuringRightClick);
  }

  // ----------------------------------------------------------------- drag

  private beginDrag(hit: Extract<Hit, { kind: "clip" }>, x: number) {
    const doc = this.currentDoc();
    const snapshot: Record<string, TimelineElement> = {};
    for (const elementId of this.targetId) {
      const element = doc.elements[elementId];
      if (element) {
        snapshot[elementId] = element;
      }
    }

    this.drag = {
      kind: hit.zone === "body" ? "move" : hit.zone,
      originX: x,
      elementId: hit.elementId,
      snapshot,
    };
  }

  private updateDrag(x: number) {
    const drag = this.drag;
    if (!drag) {
      return;
    }

    const committed = useTimelineStore.getState().getDocument();
    const deltaMs = pxToMsSigned(x - drag.originX, this.timelineRange);
    const elements = { ...committed.elements };
    this.snapGuideMs = null;

    if (drag.kind === "move") {
      const primary = drag.snapshot[drag.elementId];
      let applied = deltaMs;

      if (primary) {
        // Snap the grabbed clip, then move the whole selection by the amount
        // that actually got applied, so a multi-clip drag keeps its shape.
        const desired = Math.max(0, primary.startTime + deltaMs);
        const snapped = snapSpan(
          desired,
          spanLength(primary),
          collectSnapPoints(committed, {
            excludeIds: Object.keys(drag.snapshot),
            playheadMs: this.timelineCursor,
          }),
          this.timelineRange,
          SNAP_TOLERANCE_PX,
          primary.trackId,
        );

        applied = snapped.startMs - primary.startTime;
        this.snapGuideMs = snapped.hit?.ms ?? null;
      }

      for (const [elementId, element] of Object.entries(drag.snapshot)) {
        elements[elementId] = {
          ...element,
          startTime: Math.max(0, element.startTime + applied),
        };
      }
    } else {
      // Trimming acts on the grabbed clip alone; dragging one edge of a
      // multi-selection has no obvious meaning for the rest.
      const element = drag.snapshot[drag.elementId];
      if (element) {
        elements[drag.elementId] =
          drag.kind === "trimStart"
            ? trimStart(element, deltaMs)
            : trimEnd(element, deltaMs);
      }
    }

    this.pendingDoc = normalizeDocument({ ...committed, elements });
    this.drawCanvas();
  }

  private endDrag() {
    const pending = this.pendingDoc;
    this.drag = null;
    this.pendingDoc = null;
    this.snapGuideMs = null;

    if (pending) {
      this.commit(() => pending);
    }
    this.drawCanvas();
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
    if (this.drag) {
      this.updateDrag(e.offsetX);
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

    if (hit.kind !== "clip") {
      this.targetId = [];
      this.drawCanvas();
      return;
    }

    if (e.shiftKey) {
      if (!this.targetId.includes(hit.elementId)) {
        this.targetId = [...this.targetId, hit.elementId];
      }
    } else if (!this.targetId.includes(hit.elementId)) {
      this.targetId = [hit.elementId];
    }

    this.showSideOption(hit.elementId);
    this.beginDrag(hit, e.offsetX);
    this.drawCanvas();
  }

  _handleMouseUp() {
    if (this.drag) {
      this.endDrag();
    }
  }

  _handleContextmenu(e) {
    this.targetIdDuringRightClick = [...this.targetId];
    if (e.which == 3 || e.button == 2) {
      this.showMenuDropdown({ x: e.clientX, y: e.clientY });
    }
  }

  _handleKeydown(event) {
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
    if (this.targetId.length === 0) {
      return;
    }

    this.commit((doc) => {
      const ordered = [...doc.tracks].sort((a, b) => a.index - b.index);
      const elements = { ...doc.elements };
      let changed = false;

      for (const elementId of this.targetId) {
        const element = elements[elementId];
        if (!element) {
          continue;
        }
        const from = ordered.findIndex((t) => t.id === element.trackId);
        const to = from + delta;
        if (from === -1 || to < 0 || to >= ordered.length) {
          continue;
        }
        // Kinds are kept apart: a caption dropping onto an audio row would be
        // invisible and unexportable.
        if (ordered[to].kind !== ordered[from].kind) {
          continue;
        }
        elements[elementId] = { ...element, trackId: ordered[to].id };
        changed = true;
      }

      return changed ? normalizeDocument({ ...doc, elements }) : doc;
    });
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
        @mousewheel=${this._handleMouseWheel}
        @mousemove=${this._handleMouseMove}
        @mousedown=${this._handleMouseDown}
        @mouseup=${this._handleMouseUp}
        @contextmenu=${this._handleContextmenu}
      ></canvas>
    `;
  }
}
