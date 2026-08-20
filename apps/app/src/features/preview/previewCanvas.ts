import { emptyAnimation, sampleTrackXY } from "../animation/keyframes";
import { addKeyframePaired } from "../animation/keyframeOps";
import { displayPosition, isPositionAnimated } from "./elementPosition";
import type { TimelineDocument } from "../timeline/tracks";
import { html, LitElement } from "lit";
import { customElement, property, query } from "lit/decorators.js";
import { ITimelineStore, useTimelineStore } from "../../states/timelineStore";
import { IUIStore, uiStore } from "../../states/uiStore";
import {
  IRenderOptionStore,
  renderOptionStore,
} from "../../states/renderOptionStore";
import { v4 as uuidv4 } from "uuid";
import { renderText } from "../renderer/text";
import { renderImage } from "../renderer/image";
import { renderShape } from "../renderer/shape";
import { renderGif } from "../renderer/gif";
import { renderVideoWithoutWait } from "../renderer/video";
import { loadedAssetStore } from "../asset/loadedAssetStore";
import { placeNewElement } from "../timeline/placement";
import {
  renderTimelineAtTime,
  type TimelineRenderers,
} from "../renderer/timeline";
import { isVisualTimelineElement } from "../../@types/timeline";
import { applyElementTransform } from "../renderer/element";
import { hitZoneOf, type HitZone } from "./hitTest";
import {
  applyPoint,
  applyVector,
  invert,
  parentMatrixOf,
  rotationOf,
  scaleOf,
  worldMatrixOf,
  worldToParentLocal,
  worldVectorToParentLocal,
} from "../timeline/transform";
import { isElementVisibleAtTime } from "../element/time";
import { renderControlOutline } from "../renderer/controlOutline";
import {
  IPreviewViewportStore,
  previewViewportStore,
} from "../../states/previewViewportStore";
import {
  computeGeometry,
  fitViewport,
  screenToWorld,
  worldToScreen,
  zoomAround,
  clampZoom,
  ZOOM_STEP,
  type Viewport,
  type ViewportGeometry,
} from "./viewport";

/** The infinite plane the frame floats on. */
const CANVAS_BG = "#101112";
/** How much of an out-of-frame pixel survives. */
const OUTSIDE_ALPHA = 0.28;
const FRAME_GUIDE_COLOR = "rgba(255, 255, 255, 0.35)";

@customElement("preview-canvas")
export class PreviewCanvas extends LitElement {
  previewRatio: number;
  isMove: boolean;
  activeElementId: string;
  mouseOrigin: { x: number; y: number };
  elementOrigin: { x: number; y: number; w: number; h: number };
  /**
   * The same rect in the element's *parent* space, captured at drag start.
   *
   * `elementOrigin` is where the element is on the canvas, which is what a
   * pointer gesture is measured against. `width`, `height` and `location`
   * are not canvas quantities though — they are read inside the parent's
   * frame — so the resize math needs this one, or a clip inside a moved
   * group jumps to the group's offset the moment a handle is touched.
   */
  elementOriginLocal: { x: number; y: number; w: number; h: number };
  moveType:
    | "none"
    | "position"
    | "rotation"
    | "stretchN"
    | "stretchW"
    | "stretchE"
    | "stretchS"
    | "stretchNE"
    | "stretchNW"
    | "stretchSW"
    | "stretchSE";
  cursorType:
    | "default"
    | "grab"
    | "grabbing"
    | "ew-resize"
    | "ns-resize"
    | "nesw-resize"
    | "nwse-resize"
    | "crosshair";
  isStretch: boolean;
  isEditText: boolean;
  nowShapeId: string;
  isRotation: boolean;

  /** Viewport panning (middle-drag, alt-drag, or a drag off empty space). */
  isPanning = false;
  /** View-space (CSS px) position where the current pan started. */
  panOrigin = { x: 0, y: 0 };
  /** Viewport as it was when the pan started. */
  panViewportOrigin: Viewport = fitViewport(1920, 1080);

  /** Alignment guides to draw this frame, computed while dragging. */
  alignDirection: string[] = [];

  /** World -> view mapping for the current frame. Kept in sync by updateGeometry(). */
  geometry: ViewportGeometry = { scale: 1, offsetX: 0, offsetY: 0 };
  /** Canvas size in CSS px. */
  viewW = 0;
  viewH = 0;

  /**
   * The scene is rendered once here, then composited onto the visible canvas
   * twice — dimmed everywhere, then at full opacity clipped to the frame.
   */
  private offscreen: HTMLCanvasElement | null = null;
  private drawRequest = 0;
  private resizeObserver: ResizeObserver | null = null;
  private boundMouseMove = (e: MouseEvent) => this._handleWindowMouseMove(e);
  private boundMouseUp = (e: MouseEvent) => this._handleMouseUp(e);
  private boundKeydown = (e: KeyboardEvent) => this._handleKeydown(e);
  private boundWheel = (e: WheelEvent) => this._handleWheel(e);

  renderers: TimelineRenderers = {
    image: renderImage,
    video: renderVideoWithoutWait,
    gif: renderGif,
    text: renderText,
    shape: renderShape,
  };

  constructor() {
    super();

    this.previewRatio = 1920 / 1920;
    this.isMove = false;
    this.isStretch = false;
    this.isEditText = false;
    this.isRotation = false;

    this.moveType = "none";
    this.cursorType = "default";

    this.activeElementId = "";
    this.mouseOrigin = { x: 0, y: 0 };
    this.elementOrigin = { x: 0, y: 0, w: 0, h: 0 };
    this.elementOriginLocal = { x: 0, y: 0, w: 0, h: 0 };

    this.nowShapeId = "";
  }

  @query("#elementPreviewCanvasRef") canvas!: HTMLCanvasElement;

  handleClickCanvas() {
    //document.querySelector("element-control").handleClickPreview();
  }

  @property()
  timelineState: ITimelineStore = useTimelineStore.getInitialState();

  @property()
  timeline = this.timelineState.timeline;

  @property()
  timelineRange = this.timelineState.range;

  @property()
  timelineScroll = this.timelineState.scroll;

  @property()
  timelineCursor = this.timelineState.cursor;

  @property()
  timelineControl = this.timelineState.control;

  @property()
  uiState: IUIStore = uiStore.getInitialState();

  @property()
  resize = this.uiState.resize;

  @property()
  renderOptionStore: IRenderOptionStore = renderOptionStore.getInitialState();

  @property()
  renderOption = this.renderOptionStore.options;

  @property()
  viewportStore: IPreviewViewportStore = previewViewportStore.getInitialState();

  @property()
  viewport = this.viewportStore.viewport;

  createRenderRoot() {
    useTimelineStore.subscribe((state) => {
      this.timeline = state.timeline;
      this.timelineRange = state.range;
      this.timelineCursor = state.cursor;
      this.timelineScroll = state.scroll;
      this.timelineControl = state.control;

      // this.setTimelineColor();
      this.drawCanvas(this.canvas);
    });

    uiStore.subscribe((state) => {
      this.resize = state.resize;
      this.drawCanvas(this.canvas);
    });

    renderOptionStore.subscribe((state) => {
      this.renderOption = state.options;
      this.drawCanvas(this.canvas);
    });

    previewViewportStore.subscribe((state) => {
      this.viewport = state.viewport;
      this.scheduleDraw();
      this.requestUpdate();
    });

    return this;
  }

  connectedCallback() {
    super.connectedCallback();

    // Drag and pan listeners live on `window`, not on the canvas: the whole
    // point of the infinite canvas is dragging an element past the edge of the
    // preview, and a canvas-bound listener drops the drag the moment the
    // pointer leaves. One permanent window listener also avoids the double
    // dispatch two listeners would cause while the pointer is over the canvas.
    window.addEventListener("mousemove", this.boundMouseMove);
    window.addEventListener("mouseup", this.boundMouseUp);
    window.addEventListener("keydown", this.boundKeydown);
  }

  disconnectedCallback() {
    window.removeEventListener("mousemove", this.boundMouseMove);
    window.removeEventListener("mouseup", this.boundMouseUp);
    window.removeEventListener("keydown", this.boundKeydown);
    this.canvas?.removeEventListener("wheel", this.boundWheel);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (this.drawRequest) {
      cancelAnimationFrame(this.drawRequest);
      this.drawRequest = 0;
    }

    super.disconnectedCallback();
  }

  protected firstUpdated() {
    // `passive: false` so pinch-zoom can preventDefault the page zoom.
    this.canvas.addEventListener("wheel", this.boundWheel, { passive: false });

    this.resizeObserver = new ResizeObserver(() => {
      this.scheduleDraw();
    });
    this.resizeObserver.observe(this.canvas);

    this.viewport = previewViewportStore.getState().viewport;
    this.drawCanvas(this.canvas);
  }

  /** Project resolution, coerced — the settings inputs can hand us strings. */
  private get frameSize() {
    const w = Number(this.renderOption.previewSize.w);
    const h = Number(this.renderOption.previewSize.h);
    return {
      w: w > 0 ? w : 1,
      h: h > 0 ? h : 1,
    };
  }

  /** Re-derive the world -> view mapping from the live canvas size. */
  private updateGeometry(): ViewportGeometry {
    this.viewW = this.canvas?.clientWidth ?? 0;
    this.viewH = this.canvas?.clientHeight ?? 0;

    const { w, h } = this.frameSize;
    this.geometry = computeGeometry(
      this.viewport,
      this.viewW,
      this.viewH,
      w,
      h,
    );
    this.setPreviewRatio();

    return this.geometry;
  }

  /**
   * Kept for the legacy DOM overlay in `element-control`, which still sizes its
   * assets in CSS px. Same meaning as before: world (project) px per CSS px.
   */
  setPreviewRatio() {
    this.previewRatio = 1 / this.geometry.scale;

    const controlDom = document.querySelector("element-control");
    if (controlDom) {
      controlDom.previewRatio = this.previewRatio;
    }
  }

  /** Coalesce a burst of wheel/pan/resize events into one repaint per frame. */
  private scheduleDraw() {
    if (this.drawRequest) {
      return;
    }
    this.drawRequest = requestAnimationFrame(() => {
      this.drawRequest = 0;
      this.drawCanvas(this.canvas);
    });
  }

  /** Match the backing store to the laid-out size at the current DPR. */
  private syncCanvasSize(canvas: HTMLCanvasElement) {
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const height = Math.max(1, Math.round(canvas.clientHeight * dpr));

    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;

    return dpr;
  }

  private getOffscreen(width: number, height: number) {
    if (this.offscreen == null) {
      this.offscreen = document.createElement("canvas");
    }
    if (this.offscreen.width !== width) this.offscreen.width = width;
    if (this.offscreen.height !== height) this.offscreen.height = height;

    return this.offscreen;
  }

  /** View (CSS px, canvas-local) coordinates of a mouse event. */
  private toView(e: MouseEvent) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  /**
   * World (project px) coordinates of a mouse event.
   *
   * Uses `clientX` + `getBoundingClientRect` rather than `offsetX`, which is
   * relative to whatever element the pointer happens to be over — meaningless
   * once the listener lives on `window`.
   */
  private toWorld(e: MouseEvent) {
    const view = this.toView(e);
    return screenToWorld(this.geometry, view.x, view.y);
  }

  private isInsideCanvas(e: MouseEvent) {
    const rect = this.canvas.getBoundingClientRect();
    return (
      e.clientX >= rect.left &&
      e.clientX <= rect.right &&
      e.clientY >= rect.top &&
      e.clientY <= rect.bottom
    );
  }

  updateCursor() {
    this.canvas.style.cursor = this.cursorType;
  }

  drawCanvas(canvas: HTMLCanvasElement) {
    if (canvas == null) {
      return;
    }

    const ctx = canvas.getContext("2d");
    if (ctx == null) {
      return;
    }

    const dpr = this.syncCanvasSize(canvas);
    const g = this.updateGeometry();
    const frame = this.frameSize;

    // world -> device
    const toDevice: [number, number, number, number, number, number] = [
      g.scale * dpr,
      0,
      0,
      g.scale * dpr,
      g.offsetX * dpr,
      g.offsetY * dpr,
    ];

    // 1. The infinite plane the frame floats on.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = CANVAS_BG;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // 2. Render the scene exactly once, off screen. The control outline is
    //    deliberately left out — it is drawn later, unclipped and undimmed, so
    //    handles stay grabbable on elements parked outside the frame.
    const offscreen = this.getOffscreen(canvas.width, canvas.height);
    const octx = offscreen.getContext("2d");
    if (octx == null) {
      return;
    }
    octx.setTransform(1, 0, 0, 1, 0, 0);
    octx.clearRect(0, 0, offscreen.width, offscreen.height);
    octx.setTransform(...toDevice);

    // A newly decoded handle has missed this frame's sync, so ask for another
    // one as soon as it lands. Without this a clip stays parked at zero until
    // something unrelated triggers a repaint.
    void loadedAssetStore
      .getState()
      .loadAssetsNeededAtTime(this.timelineCursor, this.timeline)
      .then((loadedSomething) => {
        if (loadedSomething) {
          this.scheduleDraw();
        }
      })
      // A batch that rejects must not also cost us the repaint — some of its
      // assets did load.
      .catch(() => this.scheduleDraw());

    // Every media handle is reconciled here, on every repaint — which includes
    // every cursor tick during playback. This is what mutes a clip the moment
    // the playhead leaves it; the compositor below skips clips outside their
    // window, so it can never do that job.
    //
    // Any seek it issues lands later, so we ask to be called back and repaint
    // then: decoding finishing and the *frame* arriving are two events, and
    // painting on only the first shows the frame from before the seek.
    loadedAssetStore
      .getState()
      .syncPlayback(
        this.timeline,
        this.timelineCursor,
        this.timelineControl.isPlay,
        () => this.scheduleDraw(),
      );

    renderTimelineAtTime(
      octx,
      this.timeline,
      this.timelineCursor,
      this.renderers,
      this.renderOption.backgroundColor,
      frame.w,
      frame.h,
      { controlOutlineEnabled: false, activeElementId: "" },
    );

    // 3. Everything, dimmed — this is what an overflowing element looks like.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = OUTSIDE_ALPHA;
    ctx.drawImage(offscreen, 0, 0);
    ctx.globalAlpha = 1;

    // 4. The same pixels again at full opacity, clipped to the frame, giving a
    //    hard cut exactly where the rendered video ends.
    ctx.save();
    ctx.setTransform(...toDevice);
    ctx.beginPath();
    ctx.rect(0, 0, frame.w, frame.h);
    ctx.clip();
    // clip() bakes the region into device space, so resetting the transform
    // here keeps the clip but lets us blit the offscreen 1:1.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(offscreen, 0, 0);
    ctx.restore();

    this.drawFrameGuide(ctx, dpr, frame);

    // 5. Selection chrome and snap guides: always full opacity, never clipped.
    ctx.save();
    ctx.setTransform(...toDevice);
    this.drawActiveOutline(ctx);
    if (this.alignDirection.length > 0) {
      this.drawAlign(ctx, this.alignDirection);
    }
    ctx.restore();
  }

  /** The rendered resolution, marked out on the infinite plane. */
  private drawFrameGuide(
    ctx: CanvasRenderingContext2D,
    dpr: number,
    frame: { w: number; h: number },
  ) {
    const topLeft = worldToScreen(this.geometry, 0, 0);
    const bottomRight = worldToScreen(this.geometry, frame.w, frame.h);

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.lineWidth = dpr;
    ctx.strokeStyle = FRAME_GUIDE_COLOR;
    ctx.strokeRect(
      topLeft.x * dpr,
      topLeft.y * dpr,
      (bottomRight.x - topLeft.x) * dpr,
      (bottomRight.y - topLeft.y) * dpr,
    );
    ctx.restore();
  }

  /** Assumes `ctx` is already in world space. */
  private drawActiveOutline(ctx: CanvasRenderingContext2D) {
    const element: any = this.timeline[this.activeElementId];
    if (element == undefined) {
      return;
    }

    // A group draws nothing, so it cannot be picked in the preview — it is
    // selected from its bar on the timeline. Once it is, its handles have to
    // appear, or there is no way to move a group with the mouse at all. Its own
    // span is not a reason to hide them either: parenting is spatial, so a
    // group is "there" whenever it is selected.
    const isGroup = element.filetype === "group";
    if (!isGroup) {
      if (!isVisualTimelineElement(element)) {
        return;
      }
      if (!isElementVisibleAtTime(this.timelineCursor, this.timeline, element)) {
        return;
      }
    }

    ctx.save();
    // The parent chain first, then the element's own transform — the same two
    // steps `renderElement` takes, so the box lands exactly on the pixels.
    const parent = parentMatrixOf(
      this.timeline,
      this.activeElementId,
      this.timelineCursor,
    );
    ctx.transform(parent.a, parent.b, parent.c, parent.d, parent.e, parent.f);
    applyElementTransform(ctx, element, this.timelineCursor);
    renderControlOutline(ctx, 0, 0, element.width, element.height, {
      dashed: isGroup,
    });
    ctx.restore();
  }

  /** Snap guides for the element being dragged, refreshed every mouse move. */
  private updateAlignDirection() {
    const element = this.timeline[this.activeElementId];
    if (!this.isMove || element == undefined) {
      this.alignDirection = [];
      return;
    }
    if (!isVisualTimelineElement(element)) {
      this.alignDirection = [];
      return;
    }

    // Guides line up with the frame, so the element's position has to be the
    // one on the canvas. Reading the raw `location` showed guides for where the
    // clip would be with no animation and no group above it — which is nowhere
    // the user can see.
    const world = this.worldTopLeft(this.activeElementId);
    const checkAlign = this.isAlign({
      x: world.x,
      y: world.y,
      w: element.width,
      h: element.height,
    });
    this.alignDirection = checkAlign ? checkAlign.direction : [];
  }

  drawAlign(ctx: CanvasRenderingContext2D, direction: string[]) {
    const frame = this.frameSize;
    ctx.lineWidth = 3;
    ctx.strokeStyle = "#ffffff";
    if (direction.includes("top")) {
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(frame.w, 0);
      ctx.stroke();
    }

    if (direction.includes("left")) {
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(0, frame.h);
      ctx.stroke();
    }

    if (direction.includes("right")) {
      ctx.beginPath();
      ctx.moveTo(frame.w, 0);
      ctx.lineTo(frame.w, frame.h);
      ctx.stroke();
    }

    if (direction.includes("bottom")) {
      ctx.beginPath();
      ctx.moveTo(0, frame.h);
      ctx.lineTo(frame.w, frame.h);
      ctx.stroke();
    }

    if (direction.includes("horizontal")) {
      ctx.beginPath();
      ctx.moveTo(0, frame.h / 2);
      ctx.lineTo(frame.w, frame.h / 2);
      ctx.stroke();
    }
    if (direction.includes("vertical")) {
      ctx.beginPath();
      ctx.moveTo(frame.w / 2, 0);
      ctx.lineTo(frame.w / 2, frame.h);
      ctx.stroke();
    }
  }

  isAlign({ x, y, w, h }) {
    let isChange = false;
    let direction: string[] = [];
    let nx = x;
    let ny = y;

    // How near an edge counts as "snapped", in canvas units. Its own constant
    // rather than one shared with hit-testing: this is a distance between two
    // things being drawn, so it does not follow the pointer's screen scale the
    // way a grab band does.
    const padding = 20;

    const cw = this.frameSize.w;
    const ch = this.frameSize.h;

    // top
    if (y < 0 + padding && y > 0 - padding) {
      ny = 0;
      direction.push("top");
      isChange = true;
    }

    if (x < 0 + padding && x > 0 - padding) {
      nx = 0;
      direction.push("left");
      isChange = true;
    }

    if (x + w < cw + padding && x + w > cw - padding) {
      nx = cw - w;
      direction.push("right");
      isChange = true;
    }

    if (y + h < ch + padding && y + h > ch - padding) {
      ny = ch - h;
      direction.push("bottom");
      isChange = true;
    }

    if (x + w / 2 < cw / 2 + padding && x + w / 2 > cw / 2 - padding) {
      nx = cw / 2 - w / 2;
      direction.push("vertical");
      isChange = true;
    }

    if (y + h / 2 < ch / 2 + padding && y + h / 2 > ch / 2 - padding) {
      ny = ch / 2 - h / 2;
      direction.push("horizontal");
      isChange = true;
    }

    if (isChange) {
      return {
        x: nx,
        y: ny,
        direction: direction,
      };
    } else {
      return undefined;
    }
  }

  /**
   * Which handle, if any, the canvas-space point `(mx, my)` is over.
   *
   * Replaces the hand-rolled un-rotation `collisionCheck` did. That version was
   * a second, independent answer to "where is this element", and it knew about
   * rotation only — which was survivable while nothing but the element's own
   * `rotation` could turn it, and is not survivable now that an ancestor group
   * can rotate *and* scale it.
   *
   * The pointer goes through the inverse of the same world matrix the renderer
   * draws with, so drawing and hit-testing cannot disagree. `worldScale` keeps
   * the grips a fixed size on screen rather than in artwork pixels.
   */
  hitZoneAt(elementId: string, mx: number, my: number): HitZone {
    const element: any = this.timeline[elementId];
    if (element == null) {
      return "none";
    }
    const m = worldMatrixOf(this.timeline, elementId, this.timelineCursor);
    return hitZoneOf(
      applyPoint(invert(m), { x: mx, y: my }),
      element.width ?? 0,
      element.height ?? 0,
      { worldScale: scaleOf(m) },
    );
  }

  /**
   * The element's top-left on the canvas.
   *
   * A drag works in canvas space — that is where the pointer is — so this is
   * what `elementOrigin` holds, and `toParentLocal` is what turns the result
   * back into the parent-space value that belongs in `location`.
   */
  worldTopLeft(elementId: string): { x: number; y: number } {
    return applyPoint(
      worldMatrixOf(this.timeline, elementId, this.timelineCursor),
      { x: 0, y: 0 },
    );
  }

  /**
   * Whether the pointer may interact with this element at all.
   *
   * Everything drawable is always a target. A **group** is the exception, and
   * needs one: its frame is invisible and, by construction, encloses its own
   * children — so a group that answered the pointer all the time would be an
   * invisible rectangle swallowing every click aimed at what is inside it.
   *
   * It goes live only once it is the active element, which happens by selecting
   * its bar on the timeline. That is what makes an invisible, resizable box on
   * the canvas safe to have: until you ask for it, it is not there.
   */
  private isPointerTarget(elementId: string, element: any): boolean {
    if (element == null) {
      return false;
    }
    if (element.filetype === "group") {
      return elementId === this.activeElementId;
    }
    return isVisualTimelineElement(element);
  }

  /**
   * The element's rect as its own fields describe it — parent space, animation
   * resolved.
   *
   * `location` is where the top-left sits inside the parent, so this is what
   * the resize math has to start from; `worldTopLeft` answers the different
   * question the pointer asks.
   */
  localRectOf(elementId: string): { x: number; y: number; w: number; h: number } {
    const element: any = this.timeline[elementId];
    const { x, y } = displayPosition(element, this.timelineCursor);
    return { x, y, w: element?.width ?? 0, h: element?.height ?? 0 };
  }

  /** A canvas-space point as the value to write into the element's `location`. */
  toParentLocal(elementId: string, point: { x: number; y: number }) {
    return worldToParentLocal(
      this.timeline,
      elementId,
      this.timelineCursor,
      point,
    );
  }

  /** A canvas-space drag delta as a delta in the element's own parent space. */
  toParentLocalDelta(elementId: string, delta: { x: number; y: number }) {
    return worldVectorToParentLocal(
      this.timeline,
      elementId,
      this.timelineCursor,
      delta,
    );
  }

  /** How much the parent chain rotates this element, in degrees. */
  parentRotationOf(elementId: string): number {
    return rotationOf(
      parentMatrixOf(this.timeline, elementId, this.timelineCursor),
    );
  }

  showSideOption(elementId) {
    const optionGroup = document.querySelector("option-group");
    const fileType = this.timeline[elementId].filetype;

    optionGroup.showOption({
      filetype: fileType,
      elementId: elementId,
    });
  }

  getVectorMagnitude(x, y) {
    const magnitude = Math.sqrt(x * x + y * y);
    return x < 0 || y < 0 ? -magnitude : magnitude;
  }

  getIntersection({ m, a1, b1, a2, b2 }) {
    const m1 = m;
    const m2 = -m;
    const rx = (m1 * a1 - m2 * a2 + b2 - b1) / (m1 - m2);
    const ry = m1 * (rx - a1) + b1;

    return {
      x: rx,
      y: ry,
    };
  }

  /** The document a position keyframe at the cursor would produce, or `null`. */
  private withPositionKeyframe(
    x: number,
    y: number,
  ): ((doc: TimelineDocument) => TimelineDocument) | null {
    const activeElement = this.timeline[this.activeElementId];
    if (activeElement == null) {
      return null;
    }

    // The filetypes carrying a two-lane `position` track. A group is one of
    // them — dragging it with position animation on has to lay down keyframes
    // like any other element, and that animation is the whole reason a group
    // exists.
    if (
      activeElement.filetype != "image" &&
      activeElement.filetype != "video" &&
      activeElement.filetype != "text" &&
      activeElement.filetype != "group"
    ) {
      return null;
    }

    if (!isPositionAnimated(activeElement)) {
      return null;
    }

    const elementId = this.activeElementId;
    const atMs = this.timelineCursor - activeElement.startTime;

    // Both lanes in one transform. As two, a single undo left an x keyframe
    // with no y to match it — the element jumping to a position it was never
    // dragged to. `addKeyframePaired` is that guarantee made structural.
    return (doc) => {
      const withX = addKeyframePaired(doc, elementId, "position", "x", atMs, x);
      return addKeyframePaired(withX, elementId, "position", "y", atMs, y);
    };
  }

  addAnimationPoint(x, y) {
    const write = this.withPositionKeyframe(x, y);
    if (write == null) {
      return false;
    }
    useTimelineStore.getState().withCheckpoint(write);
  }

  /**
   * Play and stop no longer seed the videos themselves.
   *
   * `syncPlayback` runs from the draw path on every store change, so it starts
   * and stops each handle as the playhead enters and leaves its clip. Seeding
   * once at play time is exactly what left a clip wrong for the whole session
   * when its window began after the cursor.
   */
  public stopPlay() {
    loadedAssetStore
      .getState()
      .syncPlayback(this.timeline, this.timelineCursor, false, () =>
        this.scheduleDraw(),
      );
    this.drawCanvas(this.canvas);
  }

  public startPlay() {
    loadedAssetStore
      .getState()
      .syncPlayback(this.timeline, this.timelineCursor, true);
  }

  createShape(x: number, y: number) {
    const elementId = uuidv4();

    const width = this.renderOption.previewSize.w;
    const height = this.renderOption.previewSize.h;

    this.timeline[elementId] = {
      key: elementId,
      // Both are supplied by `placeNewElement` below, which picks the track and
      // derives the paint rank from it.
      trackId: "",
      priority: 0,
      blob: "",
      startTime: 0,
      duration: 1000,
      opacity: 100,
      location: { x: 0, y: 0 },
      // trim: { startTime: 0, endTime: 1000 },
      rotation: 0,
      width: width,
      height: height,
      oWidth: width,
      oHeight: height,
      ratio: width / height,
      filetype: "shape",
      localpath: "SHAPE",
      shape: [[x, y]],
      option: {
        fillColor: "#ffffff",
      },
      animation: emptyAnimation("shape"),
      timelineOptions: {
        color: "rgb(59, 143, 179)",
      },
    };

    const element = this.timeline[elementId];
    delete this.timeline[elementId];
    this.timelineState.withCheckpoint((doc) =>
      placeNewElement(doc, elementId, element, this.timelineCursor, uuidv4()),
    );
    this.timeline = useTimelineStore.getState().timeline;

    return elementId;
  }

  addShapePoint(x: number, y: number) {
    if (this.nowShapeId == "") {
      const createdElementId = this.createShape(x, y);
      this.nowShapeId = createdElementId;

      return false;
    }

    const shapeElement = this.timeline[this.nowShapeId];
    if (shapeElement.filetype != "shape") {
      return false;
    }

    shapeElement.shape.push([x, y]);
    this.timelineState.patchTimeline(this.timeline);
  }

  calculateRotation(point1, point2) {
    const dx = point2.x - point1.x;
    const dy = point2.y - point1.y;
    let degrees = Math.atan2(dy, dx) * (180 / Math.PI);

    degrees -= 90;
    if (degrees < 0) degrees += 360;

    return degrees;
  }

  /** Begin a viewport pan from the current pointer position. */
  private startPan(e: MouseEvent) {
    this.isPanning = true;
    this.panOrigin = this.toView(e);
    this.panViewportOrigin = this.viewport;
    this.cursorType = "grabbing";
    this.updateCursor();
  }

  _handleMouseDown(e) {
    this.updateGeometry();

    // Middle-drag and alt-drag always pan, whatever is under the pointer.
    // (Space is not used here: it is already bound to play/pause globally.)
    if (e.button === 1 || e.altKey) {
      e.preventDefault();
      this.startPan(e);
      return false;
    }

    if (e.button !== 0) {
      return false;
    }

    const world = this.toWorld(e);
    const mx = world.x;
    const my = world.y;
    let isMoveTemp = false;
    let isStretchTemp = false;
    let isRotationTemp = false;
    let activeElementTemp = "";
    let isClicked = false;

    const clearTempStatus = () => {
      isMoveTemp = false;
      isStretchTemp = false;
      isClicked = false;
      isRotationTemp = false;
    };

    if (this.timelineControl.cursorType == "shape") {
      this.addShapePoint(mx, my);
      return false;
    }

    this.nowShapeId = "";

    const sortedTimeline = Object.fromEntries(
      Object.entries(this.timeline).sort(
        ([, valueA], [, valueB]) => valueA.priority - valueB.priority,
      ),
    );

    for (const elementId of Object.keys(sortedTimeline)) {
      const element: any = this.timeline[elementId];
      if (this.isPointerTarget(elementId, element)) {
        // Where the element is *drawn*, not where `location` says it would be
        // with no animation, and not where it would be with no parent either.
        // Those diverge the moment a position track is active or a group sits
        // above the clip, and taking the wrong one is what made grabbing an
        // animated element miss its rectangle and then jump by the difference.
        // `drawCanvas` and `_handleMouseMove` resolve through the same matrix.
        const { x, y } = this.worldTopLeft(elementId);
        const w = element.width;
        const h = element.height;

        const fileType = element.filetype;
        const startTime = element.startTime;
        const duration = element.duration;

        // A group's frame is live whenever it is selected, whatever the
        // playhead is doing: its transform applies to its children at every
        // instant, so hiding its handles outside its own bar would be arbitrary.
        if (
          fileType != "group" &&
          !(
            this.timelineCursor >= startTime &&
            this.timelineCursor < startTime + duration
          )
        ) {
          continue;
        }

        if (fileType == "video") {
          if (!(
            this.timelineCursor >= startTime + element.trim.startTime &&
            this.timelineCursor < startTime + element.trim.endTime
          )) {
            continue;
          }
        }

        const collide = { type: this.hitZoneAt(elementId, mx, my) };

        if (collide.type == "position") {
          activeElementTemp = elementId;
          this.mouseOrigin = {
            x: mx,
            y: my,
          };
          this.elementOrigin = { x: x, y: y, w: w, h: h };
          this.elementOriginLocal = this.localRectOf(elementId);
          this.moveType = "position";
          this.cursorType = "grabbing";
          clearTempStatus();
          isMoveTemp = true;
          isStretchTemp = false;
          isClicked = true;
          this.showSideOption(elementId);
        } else if (collide.type == "rotation") {
          activeElementTemp = elementId;
          this.mouseOrigin = {
            x: mx,
            y: my,
          };
          this.elementOrigin = { x: x, y: y, w: w, h: h };
          this.elementOriginLocal = this.localRectOf(elementId);
          clearTempStatus();
          isStretchTemp = true;
          isMoveTemp = false;
          isRotationTemp = true;
          isClicked = true;
          this.moveType = collide.type;
          this.cursorType = "crosshair";
          this.showSideOption(elementId);
        } else if (collide.type == "stretchW") {
          activeElementTemp = elementId;
          this.mouseOrigin = {
            x: mx,
            y: my,
          };
          this.elementOrigin = { x: x, y: y, w: w, h: h };
          this.elementOriginLocal = this.localRectOf(elementId);
          clearTempStatus();
          isStretchTemp = true;
          isMoveTemp = false;
          isClicked = true;
          this.moveType = collide.type;
          this.cursorType = "ew-resize";
          this.showSideOption(elementId);
        } else if (collide.type == "stretchE") {
          activeElementTemp = elementId;
          this.mouseOrigin = {
            x: mx,
            y: my,
          };
          this.elementOrigin = { x: x, y: y, w: w, h: h };
          this.elementOriginLocal = this.localRectOf(elementId);
          clearTempStatus();
          isStretchTemp = true;
          isMoveTemp = false;
          isClicked = true;
          this.moveType = collide.type;
          this.cursorType = "ew-resize";
          this.showSideOption(elementId);
        } else if (collide.type == "stretchN") {
          activeElementTemp = elementId;
          this.mouseOrigin = {
            x: mx,
            y: my,
          };
          this.elementOrigin = { x: x, y: y, w: w, h: h };
          this.elementOriginLocal = this.localRectOf(elementId);
          clearTempStatus();
          isStretchTemp = true;
          isMoveTemp = false;
          isClicked = true;
          this.moveType = collide.type;
          this.cursorType = "ns-resize";
          this.showSideOption(elementId);
        } else if (collide.type == "stretchS") {
          activeElementTemp = elementId;
          this.mouseOrigin = {
            x: mx,
            y: my,
          };
          this.elementOrigin = { x: x, y: y, w: w, h: h };
          this.elementOriginLocal = this.localRectOf(elementId);
          clearTempStatus();
          isStretchTemp = true;
          isMoveTemp = false;
          isClicked = true;
          this.moveType = collide.type;
          this.cursorType = "ns-resize";
          this.showSideOption(elementId);
        } else if (collide.type == "stretchNW") {
          activeElementTemp = elementId;
          this.mouseOrigin = {
            x: mx,
            y: my,
          };
          this.elementOrigin = { x: x, y: y, w: w, h: h };
          this.elementOriginLocal = this.localRectOf(elementId);
          clearTempStatus();
          isStretchTemp = true;
          isMoveTemp = false;
          isClicked = true;
          this.moveType = collide.type;
          this.cursorType = "nwse-resize";
          this.showSideOption(elementId);
        } else if (collide.type == "stretchSE") {
          activeElementTemp = elementId;
          this.mouseOrigin = {
            x: mx,
            y: my,
          };
          this.elementOrigin = { x: x, y: y, w: w, h: h };
          this.elementOriginLocal = this.localRectOf(elementId);
          clearTempStatus();
          isStretchTemp = true;
          isMoveTemp = false;
          isClicked = true;
          this.moveType = collide.type;
          this.cursorType = "nwse-resize";
          this.showSideOption(elementId);
        } else if (collide.type == "stretchNE") {
          activeElementTemp = elementId;
          this.mouseOrigin = {
            x: mx,
            y: my,
          };
          this.elementOrigin = { x: x, y: y, w: w, h: h };
          this.elementOriginLocal = this.localRectOf(elementId);
          clearTempStatus();
          isStretchTemp = true;
          isMoveTemp = false;
          isClicked = true;
          this.moveType = collide.type;
          this.cursorType = "nesw-resize";
          this.showSideOption(elementId);
        } else if (collide.type == "stretchSW") {
          activeElementTemp = elementId;
          this.mouseOrigin = {
            x: mx,
            y: my,
          };
          this.elementOrigin = { x: x, y: y, w: w, h: h };
          this.elementOriginLocal = this.localRectOf(elementId);
          clearTempStatus();
          isStretchTemp = true;
          isMoveTemp = false;
          isClicked = true;
          this.moveType = collide.type;
          this.cursorType = "nesw-resize";
          this.showSideOption(elementId);
        } else {
          this.isEditText = false;
          this.cursorType = "default";
        }
        this.updateCursor();
      }
    }

    if (activeElementTemp != "") {
      this.activeElementId = activeElementTemp;
      this.isMove = isMoveTemp;
      this.isStretch = isStretchTemp;
      this.isRotation = isRotationTemp;
    }

    if (isClicked == false) {
      // Nothing under the pointer: clear the selection and let the drag pan the
      // view instead.
      this.activeElementId = "";
      this.startPan(e);
    }

    this.alignDirection = [];
    this.drawCanvas(this.canvas);
  }

  /**
   * Single `window`-level move handler. Panning and element drags are applied
   * wherever the pointer is; hover feedback only runs while it is over the
   * canvas.
   */
  _handleWindowMouseMove(e: MouseEvent) {
    if (this.isPanning) {
      const view = this.toView(e);
      const scale = this.geometry.scale;
      previewViewportStore.getState().setViewport({
        zoom: this.panViewportOrigin.zoom,
        center: {
          x:
            this.panViewportOrigin.center.x -
            (view.x - this.panOrigin.x) / scale,
          y:
            this.panViewportOrigin.center.y -
            (view.y - this.panOrigin.y) / scale,
        },
      });
      return;
    }

    const isDragging = this.isMove || this.isStretch || this.isRotation;
    if (!isDragging && !this.isInsideCanvas(e)) {
      return;
    }

    this._handleMouseMove(e);
  }

  _handleMouseMove(e) {
    const world = this.toWorld(e);
    const mx = world.x;
    const my = world.y;

    let isCollide = false;

    if (this.timelineControl.cursorType == "shape") {
      this.cursorType = "crosshair";
      this.updateCursor();
      return false;
    }

    const sortedTimeline = Object.fromEntries(
      Object.entries(this.timeline).sort(
        ([, valueA], [, valueB]) => valueA.priority - valueB.priority,
      ),
    );

    if (!this.isMove || !this.isStretch) {
      for (const elementId of Object.keys(sortedTimeline)) {
        const element = this.timeline[elementId];
        if (this.isPointerTarget(elementId, element)) {
          const fileType = element.filetype;
          const startTime = element.startTime;
          const duration = element.duration;

          // Where the selection box and its drag handles sit, which has to be
          // wherever the element is actually being drawn.
          //
          // Three bugs lived in the block this replaces. It ran only for
          // `filetype == "image"`, so a video's or a caption's handles stayed
          // at the static location while the element animated away from them.
          // It carried a copy of the renderer's dead 16ms-to-20ms guard. And
          // both of its bail-outs were `return false` inside a `for` loop —
          // which exits the whole method, so one element whose animation had
          // not started yet stopped every later element from being drawn at
          // all.
          //
          // A fourth is gone now: it sampled the position track by hand, so it
          // saw the clip's own animation but not the transform of any group
          // above it. `hitZoneAt` resolves the whole chain through the matrix
          // the renderer draws with.

          // As in `_handleMouseDown`: a selected group's frame is live at
          // every instant, so its handles do not blink out with its bar.
          if (
            fileType != "group" &&
            !(
              this.timelineCursor >= startTime &&
              this.timelineCursor < startTime + duration
            )
          ) {
            continue;
          }

          if (fileType == "video") {
            if (!(
              this.timelineCursor >= startTime + element.trim.startTime &&
              this.timelineCursor < startTime + element.trim.endTime
            )) {
              continue;
            }
          }

          const collide = { type: this.hitZoneAt(elementId, mx, my) };

          if (collide.type == "position") {
            //this.activeElementId = elementId;
            this.cursorType = "grabbing";
            isCollide = true;
          } else if (collide.type == "rotation") {
            this.cursorType = "crosshair";
            isCollide = true;
          } else if (collide.type == "stretchW") {
            this.cursorType = "ew-resize";
            isCollide = true;
          } else if (collide.type == "stretchE") {
            this.cursorType = "ew-resize";
            isCollide = true;
          } else if (collide.type == "stretchN") {
            this.cursorType = "ns-resize";
            isCollide = true;
          } else if (collide.type == "stretchS") {
            this.cursorType = "ns-resize";
            isCollide = true;
          } else if (collide.type == "stretchNW") {
            this.cursorType = "nwse-resize";
            isCollide = true;
          } else if (collide.type == "stretchSW") {
            this.cursorType = "nesw-resize";
            isCollide = true;
          } else if (collide.type == "stretchNE") {
            this.cursorType = "nesw-resize";
            isCollide = true;
          } else if (collide.type == "stretchSE") {
            this.cursorType = "nwse-resize";
            isCollide = true;
          }
        }
      }
    }

    if (!isCollide) {
      this.cursorType = "default";
    }
    this.updateCursor();

    // Deliberately `any`, not narrowed to `VisualTimelineElement`: a group is
    // excluded from that union — it draws nothing — yet it is exactly what the
    // move, rotate and resize branches below have to be able to act on. The
    // narrowing guard that used to be here returned early for every group, so
    // its handles drew and then refused to do anything.
    const activeElement: any = this.timeline[this.activeElementId];
    if (activeElement == undefined || activeElement.filetype === "audio") {
      return;
    }

    if (this.isMove) {
      const dx = mx - this.mouseOrigin.x;
      const dy = my - this.mouseOrigin.y;

      // `elementOrigin` is where the element was *drawn* when the drag began,
      // so this is the position it is drawn at now — animated or not.
      const alignLocation = this.isAlign({
        x: this.elementOrigin.x + dx,
        y: this.elementOrigin.y + dy,
        w: this.elementOrigin.w,
        h: this.elementOrigin.h,
      });
      // Snapping is a canvas-space question — guides line up with the frame
      // and with other clips as the user sees them — so it happens here, in
      // world coordinates, before the result is taken back into the element's
      // own space.
      const world = {
        x: alignLocation?.x ?? this.elementOrigin.x + dx,
        y: alignLocation?.y ?? this.elementOrigin.y + dy,
      };

      // `location` and the position track are read in the *parent's* space, so
      // a pointer position has to come back through the parent chain before it
      // is written. For a clip with no group above it this is the identity and
      // `next` is `world`; inside a group scaled to 2x, a 100px drag on screen
      // becomes the 50 that belongs in the field.
      const next = this.toParentLocal(this.activeElementId, world);

      this.updateAlignDirection();

      const write = this.withPositionKeyframe(next.x, next.y);
      if (write != null) {
        // An animated element is not at `location`; it is wherever its track
        // says. Writing `location` during the drag therefore moved nothing on
        // screen — the element sat still until mouseup committed a keyframe,
        // and then jumped. Previewing the keyframe instead makes it follow the
        // pointer, and `previewDocument` records no history, so the gesture is
        // still one undo step once `_handleMouseUp` commits it.
        const store = useTimelineStore.getState();
        store.previewDocument(write(store.getDocument()));
      } else {
        // Not animated: `location` is the position. Written immutably —
        // mutating the store's own object in place is the aliasing hazard the
        // keyframe subsystem was rewritten to remove, and history entries share
        // these objects. See the header of `controllers/keyframe.ts`.
        this.timelineState.patchTimeline({
          ...this.timeline,
          [this.activeElementId]: {
            ...this.timeline[this.activeElementId],
            location: next,
          },
        });
      }
    }

    if (this.isRotation) {
      const dx = mx - this.mouseOrigin.x;
      const dy = my - this.mouseOrigin.y;

      const p1 = {
        x: this.elementOrigin.x + this.elementOrigin.w / 2,
        y: this.elementOrigin.y + this.elementOrigin.h / 2,
      };
      const p2 = {
        x: mx,
        y: my,
      };

      // `calculateRotation` gives the angle on the canvas, but `rotation` is
      // read inside the parent's frame — so a child of a group already turned
      // 30° must store 30° less than the pointer says, or it snaps by the
      // group's rotation the moment the drag begins.
      const r =
        this.calculateRotation(p2, p1) -
        this.parentRotationOf(this.activeElementId);
      activeElement.rotation = r;
    }

    if (this.isStretch) {
      const minSize = 10;
      const dx = mx - this.mouseOrigin.x;
      const dy = my - this.mouseOrigin.y;

      // The pointer moved `dx, dy` across the canvas; `width` and `height` are
      // measured along the element's own axes. Inverting the world matrix takes
      // the delta into those axes in one step — it removes the element's own
      // rotation, as the hand-rolled cos/sin here used to, and also every
      // rotation and scale contributed by groups above it, which nothing did.
      //
      // For an unparented, unscaled clip this reduces to exactly the old
      // formula, so its drag behaviour is unchanged to the bit.
      const localDelta = applyVector(
        invert(worldMatrixOf(this.timeline, this.activeElementId, this.timelineCursor)),
        { x: dx, y: dy },
      );
      const localDx = localDelta.x;
      const localDy = localDelta.y;

      // Everything below is in the parent's frame, where `location` lives.
      const origin = this.elementOriginLocal;
      const location = activeElement.location;
      const filetype = activeElement.filetype;

      // Which kinds resize freely instead of holding their aspect ratio.
      //
      // Text always has: a caption's box is a text-wrapping width, not a
      // picture. A group is the other one, and for the same reason — its
      // `width`/`height` are not a size to draw but an invisible frame, and the
      // frame's job is to sit where the user wants the pivot. Locking it to the
      // proportions of whatever happened to be selected when it was made would
      // stop it doing that job.
      const freeAspect = filetype == "text" || filetype == "group";

      const moveE = () => {
        if (origin.w + localDx <= minSize) return false;
        const width = origin.w + localDx;
        const ratio = activeElement.ratio;
        activeElement.width = width;

        if (freeAspect) {
          return false;
        }
        activeElement.height = width / ratio;
        activeElement.location.y =
          origin.y - (width / ratio - origin.h) / 2;
      };

      const moveW = () => {
        if (origin.w - localDx <= minSize) return false;
        const width = origin.w - localDx;
        const ratio = activeElement.ratio;

        activeElement.width = width;
        activeElement.location.x = origin.x + localDx;

        if (freeAspect) {
          return false;
        }
        activeElement.height = width / ratio;
        activeElement.location.y =
          origin.y - (width / ratio - origin.h) / 2;
      };

      const moveN = () => {
        if (origin.h - localDy <= minSize) return false;
        const height = origin.h - localDy;
        const ratio = activeElement.ratio;

        activeElement.height = height;
        activeElement.location.y = origin.y + localDy;

        if (freeAspect) {
          return false;
        }
        activeElement.width = height * ratio;
        activeElement.location.x =
          origin.x - (height * ratio - origin.w) / 2;
      };

      const moveS = () => {
        if (origin.h + localDy <= minSize) return false;
        const height = origin.h + localDy;
        const ratio = activeElement.ratio;
        activeElement.height = height;

        if (freeAspect) {
          return false;
        }
        activeElement.width = height * ratio;
        activeElement.location.x =
          origin.x - (height * ratio - origin.w) / 2;
      };

      const moveNW = () => {
        if (freeAspect) {
          moveN();
          moveW();
        } else {
          const ratio = activeElement.ratio;
          const intr = this.getIntersection({
            m: 1,
            a1: origin.x,
            b1: origin.y,
            a2: origin.x + localDx,
            b2: origin.y + localDy,
          });

          activeElement.width =
            origin.w + (origin.x - intr.x);
          activeElement.height =
            (origin.w + (origin.x - intr.x)) / ratio;
          activeElement.location.y =
            origin.y +
            (origin.h - activeElement.height);

          activeElement.location.x = intr.x;
        }
      };

      const moveSW = () => {
        if (freeAspect) {
          moveS();
          moveW();
        } else {
          const ratio = activeElement.ratio;
          const intr = this.getIntersection({
            m: -1,
            a1: origin.x,
            b1: origin.h,
            a2: origin.x + localDx,
            b2: origin.h + localDy,
          });

          activeElement.height = intr.y;
          activeElement.width = intr.y * ratio;
          activeElement.location.x =
            origin.x - (intr.y * ratio - origin.w);
        }
      };

      const moveSE = () => {
        if (freeAspect) {
          moveS();
          moveE();
        } else {
          const ratio = activeElement.ratio;
          const intr = this.getIntersection({
            m: 1,
            a1: origin.w,
            b1: origin.h,
            a2: origin.w + localDx,
            b2: origin.h + localDy,
          });

          activeElement.height = intr.y;
          activeElement.width = intr.y * ratio;
        }
      };

      const moveNE = () => {
        if (freeAspect) {
          moveN();
          moveE();
        } else {
          const ratio = activeElement.ratio;
          const intr = this.getIntersection({
            m: -1,
            a1: origin.w,
            b1: origin.y,
            a2: origin.w + localDx,
            b2: origin.y + localDy,
          });

          activeElement.width = intr.x;
          activeElement.height = intr.x / ratio;
          activeElement.location.y =
            origin.y - (intr.x / ratio - origin.h);
        }
      };

      if (this.moveType == "stretchE") {
        moveE();
      } else if (this.moveType == "stretchW") {
        moveW();
      } else if (this.moveType == "stretchN") {
        moveN();
      } else if (this.moveType == "stretchS") {
        moveS();
      } else if (this.moveType == "stretchNW") {
        moveNW();
      } else if (this.moveType == "stretchSW") {
        moveSW();
      } else if (this.moveType == "stretchSE") {
        moveSE();
      } else if (this.moveType == "stretchNE") {
        moveNE();
      }

      this.timelineState.patchTimeline(this.timeline);
    }
  }

  _handleMouseUp(e) {
    if (this.isPanning) {
      this.isPanning = false;
      this.cursorType = "default";
      this.updateCursor();
      return;
    }

    const wasDragging = this.isMove || this.isStretch || this.isRotation;
    if (!wasDragging) {
      // This listener sees every mouseup in the app; without this guard a click
      // anywhere would record a keyframe for the selected element.
      return;
    }

    try {
      // Where the element ended up on screen, which for an animated element is
      // its previewed keyframe rather than `location`. Reading `location` here
      // is what wrote the un-animated position into the keyframe and made the
      // element jump by `animated − static` the moment the drag finished.
      const settled = displayPosition(
        this.timeline[this.activeElementId],
        this.timelineCursor,
      );
      this.addAnimationPoint(settled.x, settled.y);
    } catch (error) {}

    this.isMove = false;
    this.isStretch = false;
    this.isRotation = false;
    this.alignDirection = [];

    this.drawCanvas(this.canvas);
  }

  /**
   * macOS trackpad: a pinch arrives as a wheel event with `ctrlKey`, a
   * two-finger swipe as a plain wheel event.
   */
  _handleWheel(e: WheelEvent) {
    e.preventDefault();

    this.updateGeometry();
    const frame = this.frameSize;

    if (e.ctrlKey) {
      const view = this.toView(e);
      const nextZoom = this.viewport.zoom * Math.exp(-e.deltaY * 0.01);

      previewViewportStore
        .getState()
        .setViewport(
          zoomAround(
            this.viewport,
            nextZoom,
            view.x,
            view.y,
            this.viewW,
            this.viewH,
            frame.w,
            frame.h,
          ),
        );
      return;
    }

    previewViewportStore
      .getState()
      .panByWorld(
        e.deltaX / this.geometry.scale,
        e.deltaY / this.geometry.scale,
      );
  }

  private zoomByStep(factor: number) {
    previewViewportStore
      .getState()
      .setZoom(clampZoom(this.viewport.zoom * factor));
  }

  /** Fit / zoom shortcuts. Ignored while the user is typing. */
  _handleKeydown(e: KeyboardEvent) {
    if (!(e.metaKey || e.ctrlKey)) {
      return;
    }

    const target = e.target as HTMLElement | null;
    const tag = target?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable) {
      return;
    }

    if (e.key === "0") {
      e.preventDefault();
      const frame = this.frameSize;
      previewViewportStore.getState().fit(frame.w, frame.h);
    } else if (e.key === "=" || e.key === "+") {
      e.preventDefault();
      this.zoomByStep(ZOOM_STEP);
    } else if (e.key === "-" || e.key === "_") {
      e.preventDefault();
      this.zoomByStep(1 / ZOOM_STEP);
    }
  }

  _handleDblClick(e) {
    const world = this.toWorld(e);
    const mx = world.x;
    const my = world.y;
    const padding = 40;

    for (const elementId of Object.keys(this.timeline)) {
      const element = this.timeline[elementId];
      if (isVisualTimelineElement(element)) {
        if (element.filetype != "text") {
          continue;
        }

        // Was reading the raw `location`, so double-clicking an animated
        // caption to edit it missed wherever the animation had put it. Now the
        // same world resolve every other pointer path uses, which also makes a
        // caption inside a group double-clickable where it is drawn.
        const { x, y } = this.worldTopLeft(elementId);
        const w = element.width;
        const h = element.height;

        const collide = { type: this.hitZoneAt(elementId, mx, my) };

        if (collide.type == "position") {
          this.activeElementId = elementId;

          this.elementOrigin = { x: x, y: y, w: w, h: h };
          this.elementOriginLocal = this.localRectOf(elementId);
          this.isEditText = true;
          this.drawCanvas(this.canvas);
        } else {
          this.cursorType = "default";
        }
        this.updateCursor();
      }
    }
  }

  protected render() {
    // The canvas is a viewport now, not the frame: it always fills its column
    // and keeps its shape, whatever the project resolution is.
    return html` <canvas
      id="elementPreviewCanvasRef"
      class="preview"
      style="width: 100%; height: 100%; display: block; cursor: ${
        this.cursorType
      };"
      @mousedown=${this._handleMouseDown}
    ></canvas>`;
  }
}
