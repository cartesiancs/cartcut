import { html, LitElement } from "lit";
import { customElement, property, query } from "lit/decorators.js";
import { ITimelineStore, useTimelineStore } from "../../states/timelineStore";
import { IUIStore, uiStore } from "../../states/uiStore";
import {
  IRenderOptionStore,
  renderOptionStore,
} from "../../states/renderOptionStore";
import { KeyframeController } from "../../controllers/keyframe";
import { v4 as uuidv4 } from "uuid";
import { renderText } from "../renderer/text";
import { renderImage } from "../renderer/image";
import { renderShape } from "../renderer/shape";
import { renderGif } from "../renderer/gif";
import { renderVideoWithoutWait } from "../renderer/video";
import { loadedAssetStore } from "../asset/loadedAssetStore";
import {
  renderTimelineAtTime,
  type TimelineRenderers,
} from "../renderer/timeline";
import { isVisualTimelineElement } from "../../@types/timeline";
import { applyElementTransform } from "../renderer/element";
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

    this.nowShapeId = "";
  }

  @query("#elementPreviewCanvasRef") canvas!: HTMLCanvasElement;

  handleClickCanvas() {
    //document.querySelector("element-control").handleClickPreview();
  }

  private keyframeControl = new KeyframeController(this);

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

  findNearestY(pairs: number[][], a: number): number | null {
    let closestY: number | null = null;
    let closestDiff = Infinity;

    for (const [x, y] of pairs) {
      const diff = Math.abs(x - a);
      if (diff < closestDiff) {
        closestDiff = diff;
        closestY = y;
      }
    }

    return closestY;
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

    loadedAssetStore
      .getState()
      .loadAssetsNeededAtTime(this.timelineCursor, this.timeline);
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
    const element = this.timeline[this.activeElementId];
    if (element == undefined || !isVisualTimelineElement(element)) {
      return;
    }
    if (!isElementVisibleAtTime(this.timelineCursor, this.timeline, element)) {
      return;
    }

    ctx.save();
    applyElementTransform(ctx, element, this.timelineCursor);
    renderControlOutline(ctx, 0, 0, element.width, element.height);
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

    const checkAlign = this.isAlign({
      x: element.location.x,
      y: element.location.y,
      w: element.width,
      h: element.height,
    });
    this.alignDirection = checkAlign ? checkAlign.direction : [];
  }

  drawKeyframePath(ctx: CanvasRenderingContext2D, elementId: string) {
    const imageElement = this.timeline[elementId];
    if (imageElement.filetype != "image") {
      return false;
    }

    const animationType = "position";
    if (imageElement.animation[animationType].isActivate != true) return false;

    try {
      const xa = imageElement.animation[animationType].x;
      const ya = imageElement.animation[animationType].y;
      // ctx.strokeStyle = "#403af0";
      // ctx.beginPath();

      // ctx.stroke();

      // for (let index = 0; index < xa.length; index++) {
      //   const element = xa[index];
      //   ctx.lineTo(x, );

      // }
    } catch (error) {}
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
    const padding = 20;
    let isChange = false;
    let direction: string[] = [];
    let nx = x;
    let ny = y;

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

  collisionCheck({
    x,
    y,
    w,
    h,
    mx,
    my,
    padding,
    rotation = 0,
  }: {
    x: number;
    y: number;
    w: number;
    h: number;
    mx: number;
    my: number;
    padding: number;
    rotation: number;
  }) {
    const cx = x + w / 2;
    const cy = y + h / 2;

    const dx = mx - cx;
    const dy = my - cy;

    const cos = Math.cos(rotation * (Math.PI / 180));
    const sin = Math.sin(rotation * (Math.PI / 180));
    const localMouseX = dx * cos + dy * sin + cx;
    const localMouseY = -dx * sin + dy * cos + cy;

    if (
      localMouseX > x + padding / 2 &&
      localMouseX < x + w - padding / 2 &&
      localMouseY > y + padding / 2 &&
      localMouseY < y + h - padding / 2
    ) {
      return { type: "position" };
    } else if (
      localMouseX > x + w / 2 - 25 &&
      localMouseX < x + w / 2 + 25 &&
      localMouseY > y - 75 &&
      localMouseY < y
    ) {
      return { type: "rotation" };
    } else if (
      localMouseX > x + w &&
      localMouseX < x + w + padding &&
      localMouseY > y + padding &&
      localMouseY < y + h - padding
    ) {
      return { type: "stretchE" };
    } else if (
      localMouseX > x - padding &&
      localMouseX < x &&
      localMouseY > y + padding &&
      localMouseY < y + h - padding
    ) {
      return { type: "stretchW" };
    } else if (
      localMouseX > x + padding &&
      localMouseX < x + w - padding &&
      localMouseY > y - padding &&
      localMouseY < y
    ) {
      return { type: "stretchN" };
    } else if (
      localMouseX > x + padding &&
      localMouseX < x + w - padding &&
      localMouseY > y + h &&
      localMouseY < y + h + padding
    ) {
      return { type: "stretchS" };
    } else if (
      localMouseX > x - padding &&
      localMouseX < x + padding &&
      localMouseY > y - padding &&
      localMouseY < y + padding
    ) {
      return { type: "stretchNW" };
    } else if (
      localMouseX > x - padding &&
      localMouseX < x + padding &&
      localMouseY > y + h - padding &&
      localMouseY < y + h + padding
    ) {
      return { type: "stretchSW" };
    } else if (
      localMouseX > x + w - padding &&
      localMouseX < x + w + padding &&
      localMouseY > y - padding &&
      localMouseY < y + padding
    ) {
      return { type: "stretchNE" };
    } else if (
      localMouseX > x + w - padding &&
      localMouseX < x + w + padding &&
      localMouseY > y + h - padding &&
      localMouseY < y + h + padding
    ) {
      return { type: "stretchSE" };
    } else {
      return { type: "none" };
    }
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

  addAnimationPoint(x, y) {
    const activeElement = this.timeline[this.activeElementId];
    const startTime = activeElement.startTime;

    const animationType = "position";

    if (
      activeElement.filetype != "image" &&
      activeElement.filetype != "video" &&
      activeElement.filetype != "text"
    ) {
      return false;
    }

    if (activeElement.animation["position"].isActivate != true) {
      return false;
    }

    try {
      this.keyframeControl.addPoint({
        x: this.timelineCursor - startTime,
        y: x,
        line: 0,
        elementId: this.activeElementId,
        animationType: "position",
      });

      this.keyframeControl.addPoint({
        x: this.timelineCursor - startTime,
        y: y,
        line: 1,
        elementId: this.activeElementId,
        animationType: "position",
      });
    } catch (error) {
      console.log(error, "AAARR");
    }
  }

  public stopPlay() {
    loadedAssetStore.getState().stopPlay(this.timelineCursor);
    this.drawCanvas(this.canvas);
  }

  public startPlay() {
    loadedAssetStore.getState().startPlay(this.timelineCursor);
  }

  createShape(x: number, y: number) {
    const elementId = uuidv4();

    const width = this.renderOption.previewSize.w;
    const height = this.renderOption.previewSize.h;

    this.timeline[elementId] = {
      key: elementId,
      priority: 1,
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
      animation: {
        // position: {
        //   isActivate: false,
        //   x: [],
        //   y: [],
        //   ax: [[], []],
        //   ay: [[], []],
        // },
        opacity: {
          isActivate: false,
          x: [],
          ax: [[], []],
        },
        // scale: {
        //   isActivate: false,
        //   x: [],
        //   ax: [[], []],
        // },
        // rotation: {
        //   isActivate: false,
        //   x: [],
        //   ax: [[], []],
        // },
      },
      timelineOptions: {
        color: "rgb(59, 143, 179)",
      },
    };

    this.timelineState.patchTimeline(this.timeline);
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
    const padding = 20;
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
      const element = this.timeline[elementId];
      if (isVisualTimelineElement(element)) {
        const x = element.location.x;
        const y = element.location.y;
        const w = element.width;
        const h = element.height;
        const rotation = element.rotation;

        const fileType = element.filetype;
        const startTime = element.startTime;
        const duration = element.duration;

        if (
          !(
            this.timelineCursor >= startTime &&
            this.timelineCursor < startTime + duration
          )
        ) {
          continue;
        }

        if (fileType == "video") {
          if (
            !(
              this.timelineCursor >= startTime + element.trim.startTime &&
              this.timelineCursor < startTime + element.trim.endTime
            )
          ) {
            continue;
          }
        }

        const collide = this.collisionCheck({
          x: x,
          y: y,
          w: w,
          h: h,
          my: my,
          mx: mx,
          padding: padding,
          rotation: rotation,
        });

        if (collide.type == "position") {
          activeElementTemp = elementId;
          this.mouseOrigin = {
            x: mx,
            y: my,
          };
          this.elementOrigin = { x: x, y: y, w: w, h: h };
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
    const padding = 20;

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
        if (element.filetype != "audio") {
          let x = element.location.x;
          let y = element.location.y;

          const w = element.width;
          const h = element.height;
          const fileType = element.filetype;
          const startTime = element.startTime;
          const duration = element.duration;
          const rotation = element.rotation;

          const animationType = "position";

          if (
            fileType == "image" &&
            element.animation[animationType].isActivate == true
          ) {
            let index = Math.round(this.timelineCursor / 16);
            let indexToMs = index * 20;
            let startTime = Number(element.startTime);
            let indexPoint = Math.round((indexToMs - startTime) / 20);

            if (indexPoint < 0) {
              return false;
            }

            const possibleX = this.findNearestY(
              element.animation[animationType].ax,
              this.timelineCursor - element.startTime,
            );

            const possibleY = this.findNearestY(
              element.animation[animationType].ay,
              this.timelineCursor - element.startTime,
            );

            if (possibleX == null || possibleY == null) {
              return false;
            }

            x = possibleX;
            y = possibleY;
          }

          if (
            !(
              this.timelineCursor >= startTime &&
              this.timelineCursor < startTime + duration
            )
          ) {
            continue;
          }

          if (fileType == "video") {
            if (
              !(
                this.timelineCursor >= startTime + element.trim.startTime &&
                this.timelineCursor < startTime + element.trim.endTime
              )
            ) {
              continue;
            }
          }

          const collide = this.collisionCheck({
            x: x,
            y: y,
            w: w,
            h: h,
            my: my,
            mx: mx,
            padding: padding,
            rotation: rotation,
          });

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

    const activeElement = this.timeline[this.activeElementId];
    if (activeElement == undefined || !isVisualTimelineElement(activeElement)) {
      return;
    }

    if (this.isMove) {
      const dx = mx - this.mouseOrigin.x;
      const dy = my - this.mouseOrigin.y;
      const location = this.timeline[this.activeElementId].location;
      location.x = this.elementOrigin.x + dx;
      location.y = this.elementOrigin.y + dy;

      const alignLocation = this.isAlign({
        x: this.elementOrigin.x + dx,
        y: this.elementOrigin.y + dy,
        w: this.elementOrigin.w,
        h: this.elementOrigin.h,
      });

      if (alignLocation) {
        location.x = alignLocation?.x;
        location.y = alignLocation?.y;
      }

      this.updateAlignDirection();
      this.timelineState.patchTimeline(this.timeline);
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

      const r = this.calculateRotation(p2, p1);
      activeElement.rotation = r;
    }

    if (this.isStretch) {
      const minSize = 10;
      const dx = mx - this.mouseOrigin.x;
      const dy = my - this.mouseOrigin.y;

      const rotationDeg = activeElement.rotation || 0;
      const rotationRad = (rotationDeg * Math.PI) / 180;
      const cosTheta = Math.cos(rotationRad);
      const sinTheta = Math.sin(rotationRad);
      const localDx = dx * cosTheta + dy * sinTheta;
      const localDy = -dx * sinTheta + dy * cosTheta;

      const location = activeElement.location;
      const filetype = activeElement.filetype;

      const moveE = () => {
        if (this.elementOrigin.w + localDx <= minSize) return false;
        const width = this.elementOrigin.w + localDx;
        const ratio = activeElement.ratio;
        activeElement.width = width;

        if (filetype == "text") {
          return false;
        }
        activeElement.height = width / ratio;
        activeElement.location.y =
          this.elementOrigin.y - (width / ratio - this.elementOrigin.h) / 2;
      };

      const moveW = () => {
        if (this.elementOrigin.w - localDx <= minSize) return false;
        const width = this.elementOrigin.w - localDx;
        const ratio = activeElement.ratio;

        activeElement.width = width;
        activeElement.location.x = this.elementOrigin.x + localDx;

        if (filetype == "text") {
          return false;
        }
        activeElement.height = width / ratio;
        activeElement.location.y =
          this.elementOrigin.y - (width / ratio - this.elementOrigin.h) / 2;
      };

      const moveN = () => {
        if (this.elementOrigin.h - localDy <= minSize) return false;
        const height = this.elementOrigin.h - localDy;
        const ratio = activeElement.ratio;

        activeElement.height = height;
        activeElement.location.y = this.elementOrigin.y + localDy;

        if (filetype == "text") {
          return false;
        }
        activeElement.width = height * ratio;
        activeElement.location.x =
          this.elementOrigin.x - (height * ratio - this.elementOrigin.w) / 2;
      };

      const moveS = () => {
        if (this.elementOrigin.h + localDy <= minSize) return false;
        const height = this.elementOrigin.h + localDy;
        const ratio = activeElement.ratio;
        activeElement.height = height;

        if (filetype == "text") {
          return false;
        }
        activeElement.width = height * ratio;
        activeElement.location.x =
          this.elementOrigin.x - (height * ratio - this.elementOrigin.w) / 2;
      };

      const moveNW = () => {
        if (filetype == "text") {
          moveN();
          moveW();
        } else {
          const ratio = activeElement.ratio;
          const intr = this.getIntersection({
            m: 1,
            a1: this.elementOrigin.x,
            b1: this.elementOrigin.y,
            a2: this.elementOrigin.x + localDx,
            b2: this.elementOrigin.y + localDy,
          });

          activeElement.width =
            this.elementOrigin.w + (this.elementOrigin.x - intr.x);
          activeElement.height =
            (this.elementOrigin.w + (this.elementOrigin.x - intr.x)) / ratio;
          activeElement.location.y =
            this.elementOrigin.y +
            (this.elementOrigin.h - activeElement.height);

          activeElement.location.x = intr.x;
        }
      };

      const moveSW = () => {
        if (filetype == "text") {
          moveS();
          moveW();
        } else {
          const ratio = activeElement.ratio;
          const intr = this.getIntersection({
            m: -1,
            a1: this.elementOrigin.x,
            b1: this.elementOrigin.h,
            a2: this.elementOrigin.x + localDx,
            b2: this.elementOrigin.h + localDy,
          });

          activeElement.height = intr.y;
          activeElement.width = intr.y * ratio;
          activeElement.location.x =
            this.elementOrigin.x - (intr.y * ratio - this.elementOrigin.w);
        }
      };

      const moveSE = () => {
        if (filetype == "text") {
          moveS();
          moveE();
        } else {
          const ratio = activeElement.ratio;
          const intr = this.getIntersection({
            m: 1,
            a1: this.elementOrigin.w,
            b1: this.elementOrigin.h,
            a2: this.elementOrigin.w + localDx,
            b2: this.elementOrigin.h + localDy,
          });

          activeElement.height = intr.y;
          activeElement.width = intr.y * ratio;
        }
      };

      const moveNE = () => {
        if (filetype == "text") {
          moveN();
          moveE();
        } else {
          const ratio = activeElement.ratio;
          const intr = this.getIntersection({
            m: -1,
            a1: this.elementOrigin.w,
            b1: this.elementOrigin.y,
            a2: this.elementOrigin.w + localDx,
            b2: this.elementOrigin.y + localDy,
          });

          activeElement.width = intr.x;
          activeElement.height = intr.x / ratio;
          activeElement.location.y =
            this.elementOrigin.y - (intr.x / ratio - this.elementOrigin.h);
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
      this.addAnimationPoint(
        this.timeline[this.activeElementId].location.x,
        this.timeline[this.activeElementId].location.y,
      );
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
        const x = element.location.x;
        const y = element.location.y;
        const w = element.width;
        const h = element.height;
        const rotation = element.rotation;
        const fileType = element.filetype;

        if (fileType != "text") {
          continue;
        }

        const collide = this.collisionCheck({
          x: x,
          y: y,
          w: w,
          h: h,
          my: my,
          mx: mx,
          padding: padding,
          rotation: rotation,
        });

        if (collide.type == "position") {
          this.activeElementId = elementId;

          this.elementOrigin = { x: x, y: y, w: w, h: h };
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
      style="width: 100%; height: 100%; display: block; cursor: ${this
        .cursorType};"
      @mousedown=${this._handleMouseDown}
    ></canvas>`;
  }
}
