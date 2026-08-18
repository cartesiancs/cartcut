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
  nowShapeId: string;
  isRotation: boolean;

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
    const ctx = canvas.getContext("2d");

    if (ctx == null) {
      return;
    }

    canvas.width = this.renderOption.previewSize.w;
    canvas.height = this.renderOption.previewSize.h;

    loadedAssetStore
      .getState()
      .loadAssetsNeededAtTime(this.timelineCursor, this.timeline);
    renderTimelineAtTime(
      ctx,
      this.timeline,
      this.timelineCursor,
      this.renderers,
      this.renderOption.backgroundColor,
      canvas.width,
      canvas.height,
      { controlOutlineEnabled: true, activeElementId: this.activeElementId },
      (elementId, element) => {
        if (this.activeElementId !== elementId) {
          return;
        }
        if (!this.isMove) {
          return;
        }

        const checkAlign = this.isAlign({
          x: element.location.x,
          y: element.location.y,
          w: element.width,
          h: element.height,
        });
        if (checkAlign) {
          this.drawAlign(ctx, checkAlign.direction);
        }
      },
    );
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
