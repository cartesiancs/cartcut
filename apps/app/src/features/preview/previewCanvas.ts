import { html, LitElement } from "lit";
import { customElement, property, query } from "lit/decorators.js";
import { ITimelineStore, useTimelineStore } from "../../states/timelineStore";
import { keyframeStore } from "../../states/keyframeStore";
import { IUIStore, uiStore } from "../../states/uiStore";
import {
  IRenderOptionStore,
  renderOptionStore,
} from "../../states/renderOptionStore";
import { ImageElementType } from "../../@types/timeline";
import { KeyframeController } from "../../controllers/keyframe";
import { parseGIF, decompressFrames, ParsedFrame } from "gifuct-js";
import { v4 as uuidv4 } from "uuid";
import { millisecondsToPx } from "../../utils/time";
import {
  renderFrame,
  resolveElementBox,
  pickGifFrameIndex,
  samplePosition,
} from "@nugget/preview-engine";
import type {
  AssetResolver,
  ImageSource,
  VideoHandle,
} from "@nugget/preview-engine";
import { getLocationEnv } from "../../functions/getLocationEnv";

type ImageTempType = {
  elementId: string;
  object: any;
};

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
    | "grabbing"
    | "ew-resize"
    | "ns-resize"
    | "nesw-resize"
    | "nwse-resize"
    | "crosshair";
  isStretch: boolean;
  isEditText: boolean;
  gifFrames: { key: string; frames: ParsedFrame[] }[];
  nowShapeId: string;
  loadedVideos: any[];
  isChangeFilter: boolean;
  isRotation: boolean;

  /** One scratch canvas per GIF, so two GIFs of different sizes cannot
   * overwrite each other's frame the way a single shared canvas did. */
  private gifScratch = new Map<
    string,
    { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D }
  >();
  /** Assets whose load is already in flight, so a redraw does not start it
   * again — the old drawers kicked off a fresh request on every frame. */
  private pendingLoads = new Set<string>();

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

    this.gifFrames = [];

    this.loadedVideos = [];

    this.nowShapeId = "";

    this.isChangeFilter = true;
  }

  @query("#elementPreviewCanvasRef") canvas!: HTMLCanvasElement;

  handleClickCanvas() {
    //document.querySelector("element-control").handleClickPreview();
  }

  private keyframeControl = new KeyframeController(this);

  @property()
  timelineState: ITimelineStore = useTimelineStore.getInitialState();

  @property()
  timeline: any = this.timelineState.timeline;

  @property()
  timelineRange = this.timelineState.range;

  @property()
  timelineScroll = this.timelineState.scroll;

  @property()
  timelineCursor = this.timelineState.cursor;

  @property()
  timelineControl = this.timelineState.control;

  @property()
  loadedObjects: ImageTempType[] = [];

  @property()
  canvasMaxHeight = "100%";

  @property()
  uiState: IUIStore = uiStore.getInitialState();

  @property()
  resize = this.uiState.resize;

  @property()
  renderOptionStore: IRenderOptionStore = renderOptionStore.getInitialState();

  @property()
  renderOption = this.renderOptionStore.options;

  createRenderRoot() {
    useTimelineStore.subscribe((state) => {
      this.timeline = state.timeline;
      this.timelineRange = state.range;
      this.timelineCursor = state.cursor;
      this.timelineScroll = state.scroll;
      this.timelineControl = state.control;

      // this.setTimelineColor();
      this.setPreviewRatio();
      this.drawCanvas(this.canvas);
    });

    uiStore.subscribe((state) => {
      this.resize = state.resize;
      this.canvasMaxHeight =
        document.querySelector("#split_col_2").clientHeight;

      this.setPreviewRatio();
      this.drawCanvas(this.canvas);
    });

    renderOptionStore.subscribe((state) => {
      this.renderOption = state.options;
      this.canvasMaxHeight =
        document.querySelector("#split_col_2").clientHeight;
      this.setPreviewRatio();
      this.drawCanvas(this.canvas);
    });

    return this;
  }

  setPreviewRatio() {
    const width = this.canvas.offsetWidth;

    this.previewRatio = this.renderOption.previewSize.w / width;

    const controlDom = document.querySelector("element-control");
    controlDom.previewRatio = this.previewRatio;
  }

  updateCursor() {
    this.canvas.style.cursor = this.cursorType;
  }

  /**
   * Supplies pixels to the engine, loading lazily.
   *
   * The editor has to stay responsive while assets are still arriving, so a
   * miss returns `null` — the engine skips that element for this frame — and
   * kicks off the load, which redraws when it lands. The export paths take the
   * opposite approach and preload everything before the first frame.
   */
  private assetResolver: AssetResolver = {
    getImage: (elementId, element): ImageSource | null => {
      const loaded = this.loadedObjects.find(
        (item: ImageTempType) => item.elementId == elementId,
      );
      if (loaded) return loaded.object;

      this.loadOnce(elementId, () => {
        const img = new Image();
        img.onload = () => {
          this.loadedObjects.push({ elementId, object: img });
          this.pendingLoads.delete(elementId);
          this.drawCanvas(this.canvas);
        };
        img.onerror = () => this.pendingLoads.delete(elementId);
        img.src = this.getPath(element.localpath);
      });
      return null;
    },

    getVideo: (elementId, element): VideoHandle | null => {
      // The entry itself is the handle: glFilter caches its WebGL objects on it
      // between frames, so it has to be the same object every time.
      const loaded = this.loadedVideos.find(
        (item) => item.elementId == elementId,
      );
      // The entry is pushed as soon as the <video> exists so playback controls
      // can reach it, but it is not drawable until the first frame decodes.
      if (loaded) return loaded.isReady ? loaded : null;

      this.loadOnce(elementId, () => {
        const video = document.createElement("video");
        video.playbackRate = element.speed as number;

        const entry = {
          elementId,
          path: this.getPath(element.localpath),
          canvas: document.createElement("canvas"),
          object: video,
          isPlay: false,
          isReady: false,
        };
        this.loadedVideos.push(entry);

        video.addEventListener("loadeddata", () => {
          video.currentTime = 0;
          entry.isReady = true;
          this.pendingLoads.delete(elementId);
          this.drawCanvas(this.canvas);
        });
        video.src = entry.path;
      });
      return null;
    },

    getGifFrame: (elementId, element, timeMs): ImageSource | null => {
      const entry = this.gifFrames.find((item) => item.key == elementId);
      if (!entry) {
        this.loadOnce(elementId, () => {
          fetch(this.getPath(element.localpath))
            .then((resp) => resp.arrayBuffer())
            .then((buff) => {
              this.gifFrames.push({
                key: elementId,
                frames: decompressFrames(parseGIF(buff), true),
              });
              this.pendingLoads.delete(elementId);
              this.drawCanvas(this.canvas);
            })
            .catch(() => this.pendingLoads.delete(elementId));
        });
        return null;
      }

      const { frames } = entry;
      if (frames.length === 0) return null;

      const index = pickGifFrameIndex(frames.length, frames[0]?.delay, timeMs);
      const frame = frames[index];
      if (!frame?.dims) return null;

      const { width, height } = frame.dims;
      let scratch = this.gifScratch.get(elementId);
      if (!scratch) {
        const canvas = document.createElement("canvas");
        scratch = {
          canvas,
          ctx: canvas.getContext("2d") as CanvasRenderingContext2D,
        };
        this.gifScratch.set(elementId, scratch);
      }
      if (scratch.canvas.width !== width || scratch.canvas.height !== height) {
        scratch.canvas.width = width;
        scratch.canvas.height = height;
      }

      const imageData = scratch.ctx.createImageData(width, height);
      imageData.data.set(frame.patch);
      scratch.ctx.putImageData(imageData, 0, 0);
      return scratch.canvas;
    },
  };

  private loadOnce(elementId: string, start: () => void) {
    if (this.pendingLoads.has(elementId)) return;
    this.pendingLoads.add(elementId);
    start();
  }

  /**
   * Paint the frame, then the editor chrome on top of it.
   *
   * The picture itself comes from the same `renderFrame` both export paths use,
   * so what is on screen here is what gets exported. Everything the engine does
   * not know about — the selection outline, resize and rotation handles, the
   * align guides, shape vertex handles — is drawn afterwards, over the finished
   * frame, and never reaches an exported video.
   */
  drawCanvas(canvas) {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    canvas.width = this.renderOption.previewSize.w;
    canvas.height = this.renderOption.previewSize.h;

    const { drawn } = renderFrame(
      ctx,
      this.timeline,
      {
        width: this.renderOption.previewSize.w,
        height: this.renderOption.previewSize.h,
        backgroundColor: this.renderOption.backgroundColor,
      },
      this.timelineCursor,
      {
        assets: this.assetResolver,
        isChangeFilter: this.isChangeFilter,
        ignorePositionIds: this.draggedIds(),
      },
      { skipIds: this.hiddenIds() },
    );

    this.syncVideoAudio(drawn);
    this.drawEditorChrome(ctx, drawn);
  }

  /** While a text element is being edited inline, no text is composited. */
  private hiddenIds(): Set<string> | undefined {
    if (!this.isEditText) return undefined;
    const ids = new Set<string>();
    for (const id in this.timeline) {
      if (this.timeline[id]?.filetype === "text") ids.add(id);
    }
    return ids;
  }

  /** A dragged element follows the cursor rather than its position keyframes. */
  private draggedIds(): Set<string> | undefined {
    if (!this.isMove || !this.activeElementId) return undefined;
    return new Set([this.activeElementId]);
  }

  /**
   * Only clips that are on screen right now should be audible. This is playback,
   * not rendering, which is why the engine has no say in it.
   */
  private syncVideoAudio(visibleIds: string[]) {
    const visible = new Set(visibleIds);
    for (const item of this.loadedVideos) {
      if (item?.object) item.object.muted = !visible.has(item.elementId);
    }
  }

  private drawEditorChrome(ctx, drawnIds: string[]) {
    for (const elementId of drawnIds) {
      const element = this.timeline[elementId];
      const isActive = this.activeElementId === elementId;
      const isEditedShape = this.nowShapeId === elementId;
      if (!isActive && !isEditedShape) continue;

      const box = resolveElementBox(element, this.timelineCursor, {
        ignorePosition: this.isMove && isActive,
      });
      if (!box) continue;

      const centerX = box.x + box.w / 2;
      const centerY = box.y + box.h / 2;

      ctx.save();
      ctx.translate(centerX, centerY);
      ctx.rotate(box.rotation);

      if (isEditedShape) {
        this.drawShapeHandles(ctx, element, centerX, centerY);
      }
      if (isActive) {
        this.drawOutline(
          ctx,
          elementId,
          -box.w / 2,
          -box.h / 2,
          box.w,
          box.h,
          box.rotation,
        );
      }

      ctx.restore();

      if (isActive && this.isMove) {
        const checkAlign = this.isAlign({
          x: box.x,
          y: box.y,
          w: box.w,
          h: box.h,
        });
        if (checkAlign) {
          this.drawAlign(ctx, checkAlign.direction);
        }
      }
    }
  }

  /**
   * Vertex grips for the shape being edited. The old code appended these arcs to
   * the polygon's own path, so they were filled along with it and dragged the
   * outline out of shape; drawn here they are ordinary chrome, in the same white
   * as the selection handles.
   */
  private drawShapeHandles(ctx, element, centerX: number, centerY: number) {
    const points = element?.shape;
    if (!points || points.length === 0) return;

    const width = Number(element.width) || 0;
    const ratio = (Number(element.oWidth) || width) / (width || 1);
    const originX = element.location?.x ?? 0;
    const originY = element.location?.y ?? 0;

    ctx.fillStyle = "#ffffff";
    for (const point of points) {
      const px = point[0] / ratio + originX;
      const py = point[1] / ratio + originY;
      ctx.beginPath();
      ctx.arc(px - centerX, py - centerY, 8, 0, 2 * Math.PI);
      ctx.fill();
    }
  }

  drawOutline(ctx, elementId, x, y, w, h, a) {
    if (this.activeElementId == elementId) {
      const padding = 10;
      ctx.lineWidth = 3;
      ctx.strokeStyle = "#ffffff";
      ctx.strokeRect(x, y, w, h);
      ctx.fillStyle = "#ffffff";

      ctx.beginPath();
      ctx.rect(x - padding, y - padding, padding * 2, padding * 2);
      ctx.fill();

      ctx.beginPath();
      ctx.rect(x + w - padding, y - padding, padding * 2, padding * 2);
      ctx.fill();

      ctx.beginPath();
      ctx.rect(x + w - padding, y + h - padding, padding * 2, padding * 2);
      ctx.fill();

      ctx.beginPath();
      ctx.rect(x - padding, y + h - padding, padding * 2, padding * 2);
      ctx.fill();

      //draw control rotation

      ctx.beginPath();
      ctx.arc(x + w / 2, y - 50, 15, 0, 2 * Math.PI);
      ctx.fill();
    }
  }

  public preloadImage(elementId) {
    let img = new Image();

    img.onload = () => {
      if (
        this.loadedObjects.findIndex((item: ImageTempType) => {
          return item.elementId == elementId;
        }) != -1
      ) {
        const index = this.loadedObjects.findIndex((item: ImageTempType) => {
          return item.elementId == elementId;
        });

        this.loadedObjects[index].object = img;
      } else {
        this.loadedObjects.push({
          elementId: elementId,
          object: img,
        });
      }

      this.drawCanvas(this.canvas);
    };

    img.src = this.getPath(this.timeline[elementId].localpath);
  }

  getPath(path) {
    const nowEnv = getLocationEnv();
    let filepath = path;
    if (nowEnv == "electron") {
      filepath = path;
    } else if (nowEnv == "web") {
      filepath = `/api/file?path=${path}`;
    } else {
      filepath = path;
    }

    return filepath;
  }

  drawKeyframePath(ctx, elementId) {
    const imageElement = this.timeline[elementId] as any;
    const fileType = this.timeline[elementId].filetype;
    const animationType = "position";
    if (fileType != "image") return false;
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

  drawAlign(ctx, direction) {
    ctx.lineWidth = 3;
    ctx.strokeStyle = "#ffffff";
    if (direction.includes("top")) {
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(this.renderOption.previewSize.w, 0);
      ctx.stroke();
    }

    if (direction.includes("left")) {
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(0, this.renderOption.previewSize.h);
      ctx.stroke();
    }

    if (direction.includes("right")) {
      ctx.beginPath();
      ctx.moveTo(this.renderOption.previewSize.w, 0);
      ctx.lineTo(
        this.renderOption.previewSize.w,
        this.renderOption.previewSize.h,
      );
      ctx.stroke();
    }

    if (direction.includes("bottom")) {
      ctx.beginPath();
      ctx.moveTo(0, this.renderOption.previewSize.h);
      ctx.lineTo(
        this.renderOption.previewSize.w,
        this.renderOption.previewSize.h,
      );
      ctx.stroke();
    }

    if (direction.includes("horizontal")) {
      ctx.beginPath();
      ctx.moveTo(0, this.renderOption.previewSize.h / 2);
      ctx.lineTo(
        this.renderOption.previewSize.w,
        this.renderOption.previewSize.h / 2,
      );
      ctx.stroke();
    }
    if (direction.includes("vertical")) {
      ctx.beginPath();
      ctx.moveTo(this.renderOption.previewSize.w / 2, 0);
      ctx.lineTo(
        this.renderOption.previewSize.w / 2,
        this.renderOption.previewSize.h,
      );
      ctx.stroke();
    }
  }

  setChangeFilter() {
    this.isChangeFilter = true;
    this.drawCanvas(this.canvas);
  }

  isAlign({ x, y, w, h }) {
    const padding = 20;
    let isChange = false;
    let direction: string[] = [];
    let nx = x;
    let ny = y;

    const cw = this.renderOption.previewSize.w;
    const ch = this.renderOption.previewSize.h;

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

  collisionCheck({ x, y, w, h, mx, my, padding, rotation = 0 }) {
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
    const fileType = this.timeline[this.activeElementId].filetype;
    const startTime = this.timeline[this.activeElementId].startTime;

    const animationType = "position";
    if (!["image", "video", "text"].includes(fileType)) return false;

    if (
      this.timeline[this.activeElementId].animation["position"].isActivate !=
      true
    ) {
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
    for (let index = 0; index < this.loadedVideos.length; index++) {
      try {
        const element = this.loadedVideos[index];
        element.isPlay = false;
        element.object.pause();
        element.object.currentTime =
          (-(this.timeline[element.elementId].startTime - this.timelineCursor) *
            this.timeline[element.elementId].speed) /
          1000;

        this.drawCanvas(this.canvas);
      } catch (error) {}
    }
  }

  public startPlay() {
    for (let index = 0; index < this.loadedVideos.length; index++) {
      try {
        const element = this.loadedVideos[index];
        element.isPlay = true;
        element.object.currentTime =
          (-(this.timeline[element.elementId].startTime - this.timelineCursor) *
            this.timeline[element.elementId].speed) /
          1000;

        element.object.playbackRate = this.timeline[element.elementId].speed;
        element.object.muted = true;
        console.log(this.timeline[element.elementId].speed);

        element.object.play();
      } catch (error) {}
    }
  }

  createShape(x, y) {
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
      trim: { startTime: 0, endTime: 1000 },
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
        position: {
          isActivate: false,
          x: [],
          y: [],
          ax: [[], []],
          ay: [[], []],
        },
        opacity: {
          isActivate: false,
          x: [],
          ax: [[], []],
        },
        scale: {
          isActivate: false,
          x: [],
          ax: [[], []],
        },
        rotation: {
          isActivate: false,
          x: [],
          ax: [[], []],
        },
      },
      timelineOptions: {
        color: "rgb(59, 143, 179)",
      },
    };

    this.timelineState.patchTimeline(this.timeline);
    return elementId;
  }

  addShapePoint(x, y) {
    const ctx = this.canvas.getContext("2d") as CanvasRenderingContext2D;

    if (this.nowShapeId == "") {
      const createdElementId = this.createShape(x, y);
      this.nowShapeId = createdElementId;

      return false;
    }

    this.timeline[this.nowShapeId].shape.push([x, y]);
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

  _handleMouseDown(e) {
    const mx = e.offsetX * this.previewRatio;
    const my = e.offsetY * this.previewRatio;
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
        ([, valueA]: any, [, valueB]: any) => valueA.priority - valueB.priority,
      ),
    );

    for (const elementId in sortedTimeline) {
      if (Object.prototype.hasOwnProperty.call(sortedTimeline, elementId)) {
        const x = this.timeline[elementId].location?.x as number;
        const y = this.timeline[elementId].location?.y as number;
        const w = this.timeline[elementId].width as number;
        const h = this.timeline[elementId].height as number;
        const rotation = this.timeline[elementId].rotation as number;

        const fileType = this.timeline[elementId].filetype;
        const startTime = this.timeline[elementId].startTime as number;
        const duration = this.timeline[elementId].duration as number;

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
              this.timelineCursor >=
                startTime + this.timeline[elementId].trim.startTime &&
              this.timelineCursor <
                startTime + this.timeline[elementId].trim.endTime
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
      this.activeElementId = "";
    }

    this.drawCanvas(this.canvas);
  }

  _handleMouseMove(e) {
    const mx = e.offsetX * this.previewRatio;
    const my = e.offsetY * this.previewRatio;
    const padding = 20;

    let isCollide = false;

    if (this.timelineControl.cursorType == "shape") {
      this.cursorType = "crosshair";
      this.updateCursor();
      return false;
    }

    const sortedTimeline = Object.fromEntries(
      Object.entries(this.timeline).sort(
        ([, valueA]: any, [, valueB]: any) => valueA.priority - valueB.priority,
      ),
    );

    if (!this.isMove || !this.isStretch) {
      for (const elementId in sortedTimeline) {
        if (Object.prototype.hasOwnProperty.call(sortedTimeline, elementId)) {
          let x = this.timeline[elementId].location?.x;
          let y = this.timeline[elementId].location?.y;

          const w = this.timeline[elementId].width;
          const h = this.timeline[elementId].height;
          const fileType = this.timeline[elementId].filetype;
          const startTime = this.timeline[elementId].startTime as number;
          const duration = this.timeline[elementId].duration as number;
          const rotation = this.timeline[elementId].rotation as number;

          const animationType = "position";

          if (
            fileType == "image" &&
            this.timeline[elementId].animation[animationType].isActivate == true
          ) {
            // Hit-test against where the element was actually composited, using
            // the same sampler the engine drew it with.
            const sampled = samplePosition(
              this.timeline[elementId],
              this.timelineCursor,
            );
            if (sampled === false) {
              return false;
            }
            if (sampled) {
              x = sampled.ax as any;
              y = sampled.ay as any;
            }
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
                this.timelineCursor >=
                  startTime + this.timeline[elementId].trim.startTime &&
                this.timelineCursor <
                  startTime + this.timeline[elementId].trim.endTime
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

    if (this.isMove) {
      const dx = mx - this.mouseOrigin.x;
      const dy = my - this.mouseOrigin.y;
      const location = this.timeline[this.activeElementId].location as { x; y };
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
      this.timeline[this.activeElementId].rotation = r;
    }

    if (this.isStretch) {
      const minSize = 10;
      const dx = mx - this.mouseOrigin.x;
      const dy = my - this.mouseOrigin.y;

      const rotationDeg = this.timeline[this.activeElementId].rotation || 0;
      const rotationRad = (rotationDeg * Math.PI) / 180;
      const cosTheta = Math.cos(rotationRad);
      const sinTheta = Math.sin(rotationRad);
      const localDx = dx * cosTheta + dy * sinTheta;
      const localDy = -dx * sinTheta + dy * cosTheta;

      const location = this.timeline[this.activeElementId].location;
      const filetype = this.timeline[this.activeElementId].filetype;

      const moveE = () => {
        if (this.elementOrigin.w + localDx <= minSize) return false;
        const width = this.elementOrigin.w + localDx;
        const ratio = this.timeline[this.activeElementId].ratio;
        this.timeline[this.activeElementId].width = width;

        if (filetype == "text") {
          return false;
        }
        this.timeline[this.activeElementId].height = width / ratio;
        this.timeline[this.activeElementId].location.y =
          this.elementOrigin.y - (width / ratio - this.elementOrigin.h) / 2;
      };

      const moveW = () => {
        if (this.elementOrigin.w - localDx <= minSize) return false;
        const width = this.elementOrigin.w - localDx;
        const ratio = this.timeline[this.activeElementId].ratio;

        this.timeline[this.activeElementId].width = width;
        this.timeline[this.activeElementId].location.x =
          this.elementOrigin.x + localDx;

        if (filetype == "text") {
          return false;
        }
        this.timeline[this.activeElementId].height = width / ratio;
        this.timeline[this.activeElementId].location.y =
          this.elementOrigin.y - (width / ratio - this.elementOrigin.h) / 2;
      };

      const moveN = () => {
        if (this.elementOrigin.h - localDy <= minSize) return false;
        const height = this.elementOrigin.h - localDy;
        const ratio = this.timeline[this.activeElementId].ratio;

        this.timeline[this.activeElementId].height = height;
        this.timeline[this.activeElementId].location.y =
          this.elementOrigin.y + localDy;

        if (filetype == "text") {
          return false;
        }
        this.timeline[this.activeElementId].width = height * ratio;
        this.timeline[this.activeElementId].location.x =
          this.elementOrigin.x - (height * ratio - this.elementOrigin.w) / 2;
      };

      const moveS = () => {
        if (this.elementOrigin.h + localDy <= minSize) return false;
        const height = this.elementOrigin.h + localDy;
        const ratio = this.timeline[this.activeElementId].ratio;
        this.timeline[this.activeElementId].height = height;

        if (filetype == "text") {
          return false;
        }
        this.timeline[this.activeElementId].width = height * ratio;
        this.timeline[this.activeElementId].location.x =
          this.elementOrigin.x - (height * ratio - this.elementOrigin.w) / 2;
      };

      const moveNW = () => {
        if (filetype == "text") {
          moveN();
          moveW();
        } else {
          const ratio = this.timeline[this.activeElementId].ratio;
          const intr = this.getIntersection({
            m: 1,
            a1: this.elementOrigin.x,
            b1: this.elementOrigin.y,
            a2: this.elementOrigin.x + localDx,
            b2: this.elementOrigin.y + localDy,
          });

          this.timeline[this.activeElementId].width =
            this.elementOrigin.w + (this.elementOrigin.x - intr.x);
          this.timeline[this.activeElementId].height =
            (this.elementOrigin.w + (this.elementOrigin.x - intr.x)) / ratio;
          this.timeline[this.activeElementId].location.y =
            this.elementOrigin.y +
            (this.elementOrigin.h - this.timeline[this.activeElementId].height);

          this.timeline[this.activeElementId].location.x = intr.x;
        }
      };

      const moveSW = () => {
        if (filetype == "text") {
          moveS();
          moveW();
        } else {
          const ratio = this.timeline[this.activeElementId].ratio;
          const intr = this.getIntersection({
            m: -1,
            a1: this.elementOrigin.x,
            b1: this.elementOrigin.h,
            a2: this.elementOrigin.x + localDx,
            b2: this.elementOrigin.h + localDy,
          });

          this.timeline[this.activeElementId].height = intr.y;
          this.timeline[this.activeElementId].width = intr.y * ratio;
          this.timeline[this.activeElementId].location.x =
            this.elementOrigin.x - (intr.y * ratio - this.elementOrigin.w);
        }
      };

      const moveSE = () => {
        if (filetype == "text") {
          moveS();
          moveE();
        } else {
          const ratio = this.timeline[this.activeElementId].ratio;
          const intr = this.getIntersection({
            m: 1,
            a1: this.elementOrigin.w,
            b1: this.elementOrigin.h,
            a2: this.elementOrigin.w + localDx,
            b2: this.elementOrigin.h + localDy,
          });

          this.timeline[this.activeElementId].height = intr.y;
          this.timeline[this.activeElementId].width = intr.y * ratio;
        }
      };

      const moveNE = () => {
        if (filetype == "text") {
          moveN();
          moveE();
        } else {
          const ratio = this.timeline[this.activeElementId].ratio;
          const intr = this.getIntersection({
            m: -1,
            a1: this.elementOrigin.w,
            b1: this.elementOrigin.y,
            a2: this.elementOrigin.w + localDx,
            b2: this.elementOrigin.y + localDy,
          });

          this.timeline[this.activeElementId].width = intr.x;
          this.timeline[this.activeElementId].height = intr.x / ratio;
          this.timeline[this.activeElementId].location.y =
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
    try {
      this.addAnimationPoint(
        this.timeline[this.activeElementId].location.x,
        this.timeline[this.activeElementId].location.y,
      );
      this.isMove = false;
      this.isStretch = false;
      this.isRotation = false;

      this.drawCanvas(this.canvas);
    } catch (error) {}
  }

  _handleDblClick(e) {
    const mx = e.offsetX * this.previewRatio;
    const my = e.offsetY * this.previewRatio;
    const padding = 40;

    for (const elementId in this.timeline) {
      if (Object.prototype.hasOwnProperty.call(this.timeline, elementId)) {
        const x = this.timeline[elementId].location?.x as number;
        const y = this.timeline[elementId].location?.y as number;
        const w = this.timeline[elementId].width as number;
        const h = this.timeline[elementId].height as number;
        const rotation = this.timeline[elementId].rotation as number;
        const fileType = this.timeline[elementId].filetype;

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
    this.style.margin = "10px";
    return html` <canvas
      id="elementPreviewCanvasRef"
      class="preview"
      style="width: 100%; max-height: calc(${this
        .canvasMaxHeight}px - 40px); cursor: ${this.cursorType};"
      width="1920"
      height="1080"
      onclick="${this.handleClickCanvas()}"
      @mousedown=${this._handleMouseDown}
      @mousemove=${this._handleMouseMove}
      @mouseup=${this._handleMouseUp}
    ></canvas>`;
  }
}
