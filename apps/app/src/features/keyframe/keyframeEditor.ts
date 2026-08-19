import { LitElement, PropertyValues, html } from "lit";
import { customElement, property, query } from "lit/decorators.js";
import { ITimelineStore, useTimelineStore } from "../../states/timelineStore";
import { millisecondsToPx, pxToMilliseconds } from "../../utils/time";
import { IUIStore, uiStore } from "../../states/uiStore";
import { ImageElementType } from "../../@types/timeline";
import { KeyframeController } from "../../controllers/keyframe";
import { applySurface, surfaceSpec } from "../timeline/canvasSurface";
import { moveKeyframe, setHandles } from "../animation/keyframeOps";
import { sameKeyframes } from "../animation/keyframes";
import type { TimelineDocument } from "../timeline/tracks";
import { isTypingEvent } from "../../utils/typingTarget";

@customElement("keyframe-editor")
export class KeyframeEditor extends LitElement {
  tension: number;
  divBody: any;
  svgBody: any;
  poly: {};
  path: {};
  hiddenPath: {};
  padding: { start: number; end: number };
  lineCount: number;
  points: number[][][];
  selectLine: number;
  keyframePointBody: any;
  prevElementId: any;
  isDrag: boolean;
  clickDot: string;
  clickIndex: number;
  verticalScroll: number;
  cursor: string;
  verticalRange: number;
  activePointIndex: number;

  /** The document as it stood when the current drag began. */
  private dragOriginDoc: TimelineDocument | null = null;
  /** Index of the grabbed keyframe in `dragOriginDoc`, which never re-sorts. */
  private dragOriginIndex = -1;
  /** The drag's preview document; committed once, on mouseup. */
  private pendingDoc: TimelineDocument | null = null;

  constructor() {
    super();

    this.tension = 1;
    this.divBody = undefined;
    this.svgBody = {};
    this.poly = {};
    this.path = {};
    this.hiddenPath = {};

    this.padding = {
      start: 0,
      end: 0,
    };

    this.lineCount = 1;
    this.points = [[[0, 0]], [[0, 0]]];

    this.prevElementId = "";

    this.selectLine = 0;

    this.clickIndex = -1;
    this.clickDot = "";
    this.isDrag = false;

    this.cursor = "default";

    this.verticalScroll = 0;
    this.verticalRange = 1;

    this.activePointIndex = -1;

    this.addEventListener("scroll", this.handleScroll.bind(this));
    // Bound once and kept, so `disconnectedCallback` can actually remove it.
    // The old `.bind(this)` inline created a function nobody held a
    // reference to, leaking one window listener per editor instance.
    window.addEventListener("keydown", this.boundKeydown);
    window.addEventListener("mouseup", this._handleMouseUp);
    window.addEventListener("blur", this.handleCancelDrag);

    // try {
    //   // position이면 2개 나머지는 1개
    //   this.lineCount = 2;

    //   this.clearLineEditorGroup();

    //   for (let line = 0; line < this.lineCount; line++) {
    //     this.addLineEditor(line);
    //   }

    //   this.changeLineEditor(0);
    // } catch (error) {}
  }

  private keyframeControl = new KeyframeController(this);

  /**
   * Whether the editor is open.
   *
   * An explicit converter because the host binds this as an attribute —
   * `isShow="${this.target.isShow}"` — and Lit's default converter is String,
   * so the closed state arrived as the string `"false"`, which is truthy. Every
   * `if (this.isShow)` in this file was therefore always taken: the editor
   * redrew on every store change while closed, and Backspace deleted a keyframe
   * from a panel the user could not see.
   *
   * Lit's own `Boolean` converter is presence-based and would be wrong here for
   * the same reason — the attribute is always present.
   */
  @property({ converter: { fromAttribute: (value) => value === "true" } })
  isShow = false;

  @property()
  elementId;

  @property()
  animationType;

  @query("#keyframeEditerCanvasRef") canvas!: HTMLCanvasElement;

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
  uiState: IUIStore = uiStore.getInitialState();

  @property()
  resize = this.uiState.resize;

  createRenderRoot() {
    useTimelineStore.subscribe((state) => {
      this.timeline = state.timeline;
      this.timelineRange = state.range;
      this.timelineScroll = state.scroll;
      this.timelineCursor = state.cursor;

      this.drawCanvas();
    });

    uiStore.subscribe((state) => {
      this.resize = state.resize;

      this.drawCanvas();
    });

    return this;
  }

  render() {
    if (!this.isShow) {
      return;
    }

    // Position is the only two-lane property; everything else edits one curve.
    this.lineCount = this.animationType == "position" ? 2 : 1;
    if (this.selectLine >= this.lineCount) {
      // A stale `selectLine` of 1 left the editor silently inert on a
      // single-lane property: every read and every edit addressed a `y` lane
      // that does not exist, so clicking added nothing and dragging grabbed
      // nothing, with no visible reason and no way back except the x button.
      this.selectLine = 0;
      this.activePointIndex = -1;
    }

    this.showKeyframeEditorButtonGroup();
    this.classList.add("h-100", "w-100", "position-absolute", "overflow-hidden");

    return html` <div style="display: flex;">
      <div
        class="d-flex row gap-2 p-2 ps-3"
        style="width: ${this.resize.timelineVertical.leftOption}px"
      >
        <span class="text-secondary">Line</span>
        <div class="btn-group p-2" role="group" id="timelineOptionLineEditor">
          <button
            line="0"
            @click=${() => this.changeLineEditor("0")}
            type="button"
            class="btn ${this.selectLine == 0
              ? "btn-primary"
              : "btn-secondary"} btn-sm"
          >
            x
          </button>

          <button
            line="1"
            @click=${() => this.changeLineEditor("1")}
            type="button"
            class="btn ${this.selectLine == 1
              ? "btn-primary"
              : "btn-secondary"} btn-sm ${this.lineCount == 1 ? "d-none" : ""}"
          >
            y
          </button>
        </div>

        <span class="text-secondary">Range</span>
        <input
          type="range"
          class="form-range p-2 ps-3"
          min="0.1"
          max="10"
          step="0.1"
          value="1"
          id="verticalRange"
          @change=${this.handleChangeVerticalRange}
          @input=${this.handleChangeVerticalRange}
        />
      </div>

      <canvas
        id="keyframeEditerCanvasRef"
        style="left: ${this.resize.timelineVertical
          .leftOption}px; position: absolute; cursor: ${this.cursor};"
        @mousewheel=${this._handleMouseWheel}
        @mousedown=${this._handleMouseDown}
        @mousemove=${this._handleMouseMove}
        @mouseup=${this._handleMouseUp}
      ></canvas>
    </div>`;
  }

  handleChangeVerticalRange(e) {
    this.verticalRange = parseFloat(e.target.value);
    this.requestUpdate();
  }

  drawRuler() {
    const ctx = this.canvas.getContext("2d") as any;

    const height = 1000;
    const width = 50;
    const step = 50;
    const iStep = step * 40;
    const center = this.verticalScroll;

    ctx.fillStyle = "#55585e";
    ctx.textAlign = "center";
    ctx.font = "9px Arial";

    for (let i = -iStep; i <= iStep; i += step) {
      const pos = center + i;
      ctx.fillText(i, width / 2, pos / this.verticalRange);
      ctx.fillRect(10, pos / this.verticalRange, 30, 0.5);
    }
  }

  private drawDots(ctx) {
    const points = this.timeline[this.elementId].animation[this.animationType];

    for (const key in points) {
      if (Object.prototype.hasOwnProperty.call(points, key)) {
        if (["x", "y"].includes(key)) {
          const point =
            this.timeline[this.elementId].animation[this.animationType][key];
          if (key == "x") {
            let color = this.selectLine == 0 ? "#403af0" : "#3d3e45";
            let subcolor = this.selectLine == 0 ? "#b7bcf7" : "#3d3e45";

            this.drawDotsLoop({
              ctx: ctx,
              dots: point,
              color: color,
              subColor: subcolor,
            });
          } else {
            let color = this.selectLine == 1 ? "#e83535" : "#3d3e45";
            let subcolor = this.selectLine == 1 ? "#ed7979" : "#3d3e45";

            this.drawDotsLoop({
              ctx: ctx,
              dots: point,
              color: color,
              subColor: subcolor,
            });
          }
        }
      }
    }
  }

  drawDotsLoop({ ctx, dots, color, subColor }) {
    for (let index = 0; index < dots.length; index++) {
      const element = dots[index];
      ctx.fillStyle = color;

      if (this.activePointIndex == index && this.activePointIndex != -1) {
        ctx.fillStyle = "#f7f414"; // yellow color
      }

      ctx.beginPath();

      const x =
        millisecondsToPx(
          element.p[0] + this.timeline[this.elementId].startTime,
          this.timelineRange,
        ) - this.timelineScroll;

      const y = element.p[1] + this.verticalScroll;
      ctx.arc(x, y / this.verticalRange, 4, 0, 2 * Math.PI);
      ctx.fill();

      ctx.fillStyle = subColor;

      ctx.beginPath();
      const sx =
        millisecondsToPx(
          element.cs[0] + this.timeline[this.elementId].startTime,
          this.timelineRange,
        ) - this.timelineScroll;
      const sy = element.cs[1] + this.verticalScroll;
      ctx.arc(sx, sy / this.verticalRange, 4, 0, 2 * Math.PI);
      ctx.fill();

      ctx.beginPath();
      const ex =
        millisecondsToPx(
          element.ce[0] + this.timeline[this.elementId].startTime,
          this.timelineRange,
        ) - this.timelineScroll;
      const ey = element.ce[1] + this.verticalScroll;
      ctx.arc(ex, ey / this.verticalRange, 4, 0, 2 * Math.PI);
      ctx.fill();

      ctx.strokeStyle = subColor;

      ctx.beginPath();
      ctx.moveTo(x, y / this.verticalRange);
      ctx.lineTo(sx, sy / this.verticalRange);
      ctx.stroke();

      ctx.strokeStyle = subColor;

      ctx.beginPath();
      ctx.moveTo(x, y / this.verticalRange);
      ctx.lineTo(ex, ey / this.verticalRange);
      ctx.stroke();
    }
  }

  private drawLines(ctx) {
    const points = this.timeline[this.elementId].animation[this.animationType];

    for (const key in points) {
      if (Object.prototype.hasOwnProperty.call(points, key)) {
        if (["ax", "ay"].includes(key)) {
          const point =
            this.timeline[this.elementId].animation[this.animationType][key];
          ctx.strokeStyle = this.selectLine == 0 ? "#403af0" : "#3d3e45";
          if (key == "ay") {
            ctx.strokeStyle = this.selectLine == 1 ? "#e83535" : "#3d3e45";
          }

          ctx.beginPath();
          for (let index = 0; index < point.length; index++) {
            const element = point[index];
            const x =
              millisecondsToPx(
                element[0] + this.timeline[this.elementId].startTime,
                this.timelineRange,
              ) - this.timelineScroll;
            ctx.lineTo(
              x,
              (element[1] + this.verticalScroll) / this.verticalRange,
            );
          }
          ctx.stroke();
        }
      }
    }
  }

  private drawCursor(ctx) {
    const now =
      millisecondsToPx(this.timelineCursor, this.timelineRange) -
      this.timelineScroll;

    ctx.fillStyle = "#dbdaf0";
    ctx.beginPath();
    ctx.rect(now, 0, 2, this.surface.height);
    ctx.fill();
  }

  private drawLeftPadding(ctx) {
    const targetTimeline: ImageElementType | any =
      this.timeline[this.elementId];

    const startPx =
      millisecondsToPx(targetTimeline.startTime, this.timelineRange) -
      this.timelineScroll;

    ctx.fillStyle = "#000000";
    ctx.beginPath();
    ctx.rect(0, 0, startPx, this.surface.height);
    ctx.fill();
  }

  private drawRightPadding(ctx) {
    const targetTimeline: ImageElementType | any =
      this.timeline[this.elementId];

    const startPx =
      millisecondsToPx(
        targetTimeline.startTime + targetTimeline.duration,
        this.timelineRange,
      ) - this.timelineScroll;

    ctx.fillStyle = "#000000";
    ctx.beginPath();
    ctx.rect(
      startPx,
      0,
      this.surface.width - startPx,
      this.surface.height,
    );
    ctx.fill();
  }

  /**
   * The canvas in CSS px — what every draw method below measures in.
   *
   * `this.canvas.width`/`.height` are the *device* pixel backing store, and
   * drawing happens through a `dpr` transform, so using them as rect extents
   * made every filled rect `dpr` times too large. The right-hand padding was
   * the visible one: it started in the right place and ran `dpr` times too far.
   */
  private surface = { width: 0, height: 0 };

  private drawCanvas() {
    if (!this.isShow || !this.canvas) {
      return false;
    }

    const ctx = this.canvas.getContext("2d");
    const timeline = document.querySelector("element-timeline");
    if (!ctx || !timeline || this.timeline?.[this.elementId] == null) {
      // The only condition the old blanket `try {}` around this was actually
      // swallowing: a draw scheduled before the target element exists.
      return false;
    }

    // The canvas is positioned at `left: leftOption`, so the space it has is
    // what remains of the window — not the whole window, which ran it off the
    // right edge by exactly the header width.
    const width = Math.max(
      0,
      window.innerWidth - this.resize.timelineVertical.leftOption,
    );
    const height = (timeline as HTMLElement).offsetHeight;
    this.surface = { width, height };

    applySurface(
      this.canvas,
      ctx,
      surfaceSpec(width, height, window.devicePixelRatio || 1),
    );

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#0f1012";
    ctx.beginPath();
    ctx.rect(0, 0, width, height);
    ctx.fill();

    this.drawLeftPadding(ctx);
    this.drawRightPadding(ctx);
    this.drawRuler();
    this.drawCursor(ctx);
    this.drawDots(ctx);
    this.drawLines(ctx);
  }

  updated() {
    this.drawCanvas();
  }

  showKeyframeEditorButtonGroup() {}

  /**
   * Collapse the bottom offcanvas.
   *
   * No longer calls `closeAnimationPanel`. It used to, and it used to be called
   * from `render()` — a render writing to the store that decides whether it
   * renders. That was harmless only because `isShow` was permanently truthy;
   * with the converter above making it a real boolean, it would recurse.
   * `Timeline._handleClickClosedKeyframe` owns the explicit close.
   */
  hideKeyframeEditorButtonGroup() {
    const offcanvas = document.getElementById("option_bottom");
    if (offcanvas == null) {
      return;
    }
    offcanvas.classList.remove("show");
    offcanvas.classList.add("hide");
  }

  addPadding({ px, type }) {
    let keyframePadding = this.divBody.querySelector("keyframe-padding");
    let keyframePoint = this.keyframePointBody;
    let svgBody: any = this.svgBody;

    const typeFunction = {
      start: () => {
        keyframePadding.style.width = `${px}px`;
        keyframePoint.style.left = `${px}px`;
        svgBody.style.left = `${px}px`;
      },
    };

    this.padding["start"] = px;
    typeFunction[type]();
  }

  highlightLineEditorButton(line) {
    for (let index = 0; index < this.lineCount; index++) {
      let button = document
        .querySelector("#timelineOptionLineEditor")
        .querySelector(`button[line='${index}']`);
      button.classList.remove("btn-primary");
      button.classList.add("btn-secondary");
    }

    let targeButton = document
      .querySelector("#timelineOptionLineEditor")
      .querySelector(`button[line='${line}']`);
    targeButton.classList.remove("btn-secondary");
    targeButton.classList.add("btn-primary");
  }

  changeLineEditor(line) {
    this.selectLine = Number(line);
    // The selected index belongs to the lane it was made in. Carrying it over
    // meant Backspace after switching deleted the keyframe at the same index in
    // the *other* lane — one the user never selected — and `drawDotsLoop`
    // painted both of them yellow, so both looked selected.
    this.activePointIndex = -1;
    this.requestUpdate();
  }

  addLineEditor(line) {
    document
      .querySelector("#timelineOptionLineEditor")
      .insertAdjacentHTML(
        "beforeend",
        `<button line="${line}" onclick="document.querySelector('keyframe-editor').changeLineEditor('${line}')" type="button" class="btn btn-secondary btn-sm">Line${line}</button>`,
      );
  }

  clearLineEditorGroup() {
    document.querySelector("#timelineOptionLineEditor").innerHTML = "";
  }

  getRemovedDuplicatePoint({ x, line }) {
    let tmp: any = [];
    this.points[line].forEach((element) => {
      if (element[0] != x) {
        tmp.push(element);
      }
    });
    return tmp;
  }

  removePoint() {
    if (this.activePointIndex == -1) {
      return false;
    }

    this.keyframeControl.removePoint({
      elementId: this.elementId,
      animationType: this.animationType,
      line: this.selectLine,
      index: this.activePointIndex,
    });

    // `= -1`, not `== -1`. The comparison this replaces had no effect, so the
    // index of a keyframe that no longer exists stayed live — and the next
    // Backspace deleted whatever had shifted into its place.
    this.activePointIndex = -1;

    this.requestUpdate();
  }

  checkBoundary(element, mouseX, mouseY) {
    const padding = 10;

    const csx =
      millisecondsToPx(
        element.cs[0] + this.timeline[this.elementId].startTime,
        this.timelineRange,
      ) - this.timelineScroll;

    const csy = (element.cs[1] + this.verticalScroll) / this.verticalRange;

    if (
      csx > mouseX - padding &&
      csx < mouseX + padding &&
      csy > mouseY - padding &&
      csy < mouseY + padding
    ) {
      return "cs";
    }

    const cex =
      millisecondsToPx(
        element.ce[0] + this.timeline[this.elementId].startTime,
        this.timelineRange,
      ) - this.timelineScroll;

    const cey = (element.ce[1] + this.verticalScroll) / this.verticalRange;

    if (
      cex > mouseX - padding &&
      cex < mouseX + padding &&
      cey > mouseY - padding &&
      cey < mouseY + padding
    ) {
      return "ce";
    }

    const dotx =
      millisecondsToPx(
        element.p[0] + this.timeline[this.elementId].startTime,
        this.timelineRange,
      ) - this.timelineScroll;

    const doty = (element.p[1] + this.verticalScroll) / this.verticalRange;

    if (
      dotx > mouseX - padding &&
      dotx < mouseX + padding &&
      doty > mouseY - padding &&
      doty < mouseY + padding
    ) {
      return "p";
    }

    return "n";
  }

  handleScroll(e) {
    let optionBottom = document.querySelector("#option_bottom");
    let isShowOptionBottom = optionBottom.classList.contains("show");
    if (isShowOptionBottom == false) {
      return 0;
    }
    let elementTimeline = document.querySelector("element-timeline");
    elementTimeline.scrollTo(this.scrollLeft, elementTimeline.scrollTop);
  }

  _handleMouseWheel(e) {
    const newScroll = this.timelineScroll + e.deltaX;
    this.verticalScroll -= e.deltaY * this.verticalRange;

    this.drawCanvas();

    // `= -1`, not `== -1`. Scrolling is meant to drop the selection — the
    // comparison it was written as did nothing, so a Backspace after a scroll
    // deleted a keyframe the user could no longer see highlighted.
    this.activePointIndex = -1;

    if (newScroll >= 0) {
      this.timelineState.setScroll(newScroll);
    }

    this.requestUpdate();
  }

  /** The authored keyframes for the lane currently being edited. */
  private currentLane(): any[] {
    const lane = this.selectLine == 0 ? "x" : "y";
    const list = this.timeline?.[this.elementId]?.animation?.[
      this.animationType
    ]?.[lane];
    return Array.isArray(list) ? list : [];
  }

  /** Pointer position as (element-relative ms, track value). */
  private pointerValue(e): { tMs: number; value: number } {
    return {
      tMs:
        pxToMilliseconds(e.offsetX, this.timelineRange) +
        pxToMilliseconds(this.timelineScroll, this.timelineRange) -
        this.timeline[this.elementId].startTime,
      value: e.offsetY * this.verticalRange - this.verticalScroll,
    };
  }

  _handleMouseMove(e) {
    if (this.timeline?.[this.elementId] == null) {
      return;
    }

    const list = this.currentLane();
    this.cursor = list.some((point) =>
      ["p", "ce", "cs"].includes(this.checkBoundary(point, e.offsetX, e.offsetY)),
    )
      ? "pointer"
      : "default";

    if (!this.isDrag || this.clickIndex < 0) {
      this.requestUpdate();
      return;
    }

    const { tMs, value } = this.pointerValue(e);

    // A drag previews through `previewDocument` — which neither normalises the
    // document nor records history, so it is cheap at pointer rate — and
    // commits exactly once on mouseup. Writing per mousemove is what made a
    // single drag either fill the undo stack or, as it actually did, mutate the
    // store snapshot in place and bypass history altogether.
    //
    // Every frame recomputes from `dragOriginDoc` rather than compounding, so
    // the point tracks the pointer exactly instead of drifting.
    if (this.clickDot == "p") {
      const moved = moveKeyframe(
        this.dragOriginDoc ?? useTimelineStore.getState().getDocument(),
        this.elementId,
        this.animationType,
        this.selectLine == 0 ? "x" : "y",
        this.dragOriginIndex,
        tMs,
        value,
      );
      this.clickIndex = moved.index;
      this.activePointIndex = moved.index;
      this.pendingDoc = moved.doc;
    } else {
      const origin = this.dragOriginDoc?.elements[this.elementId] as any;
      const anchor =
        origin?.animation?.[this.animationType]?.[
          this.selectLine == 0 ? "x" : "y"
        ]?.[this.dragOriginIndex];
      if (anchor == null) {
        return;
      }
      this.pendingDoc = setHandles(
        this.dragOriginDoc!,
        this.elementId,
        this.animationType,
        this.selectLine == 0 ? "x" : "y",
        this.dragOriginIndex,
        this.clickDot == "cs"
          ? { cs: [tMs, value] }
          : { ce: [tMs, value] },
      );
    }

    useTimelineStore.getState().previewDocument(this.pendingDoc);
    this.drawCanvas();
    this.requestUpdate();
  }

  _handleMouseDown(e) {
    if (this.timeline?.[this.elementId] == null) {
      return;
    }

    const list = this.currentLane();

    // Reverse order with an early exit, so the point drawn on top is the one
    // grabbed. The loop this replaces ran forwards without breaking, so the
    // *last* overlapping point won regardless of what the user was pointing at.
    this.isDrag = false;
    for (let index = list.length - 1; index >= 0; index--) {
      const check = this.checkBoundary(list[index], e.offsetX, e.offsetY);
      if (check == "n") {
        continue;
      }
      this.clickIndex = index;
      this.clickDot = check;
      this.isDrag = true;
      if (check == "p") {
        this.activePointIndex = index;
      }
      break;
    }

    if (this.isDrag) {
      // The document as it stood when the drag began. Every mousemove
      // recomputes from this rather than compounding, so the point tracks the
      // pointer exactly instead of drifting.
      this.dragOriginDoc = useTimelineStore.getState().getDocument();
      this.dragOriginIndex = this.clickIndex;
      this.pendingDoc = null;
      return;
    }

    const { tMs, value } = this.pointerValue(e);
    this.keyframeControl.addPoint({
      x: tMs,
      y: value,
      line: this.selectLine,
      elementId: this.elementId,
      animationType: this.animationType,
    });
    this.drawCanvas();
  }

  _handleMouseUp = () => {
    // One undo entry for the whole gesture. `withCheckpoint` compares by
    // identity, so a drag that never moved anything records nothing.
    const pending = this.pendingDoc;
    const origin = this.dragOriginDoc;
    this.isDrag = false;
    this.clickIndex = -1;
    this.pendingDoc = null;
    this.dragOriginDoc = null;

    // Compare the curve, not the object. `moveKeyframe` builds a fresh document
    // on every mousemove, so identity says "changed" about a drag that ended
    // exactly where it began — and `withCheckpoint` cannot tell either, because
    // the document it compares against is rebuilt on every call. Without this a
    // cancelled drag left an undo step that appears to do nothing.
    if (origin == null) {
      return;
    }
    useTimelineStore.getState().previewDocument(origin);
    if (pending != null && !this.sameCurve(origin, pending)) {
      useTimelineStore.getState().withCheckpoint(() => pending);
    }
  };

  /** Whether two documents hold the same curve for the lane being dragged. */
  private sameCurve(a: TimelineDocument, b: TimelineDocument): boolean {
    const lane = this.selectLine == 0 ? "x" : "y";
    const read = (doc: TimelineDocument) =>
      (doc.elements[this.elementId] as any)?.animation?.[this.animationType]?.[
        lane
      ] ?? [];
    return sameKeyframes(read(a), read(b));
  };

  /** Abandon a drag that ended somewhere this component never hears about. */
  private handleCancelDrag = () => {
    if (this.dragOriginDoc != null) {
      useTimelineStore.getState().previewDocument(this.dragOriginDoc);
    }
    this.isDrag = false;
    this.clickIndex = -1;
    this.pendingDoc = null;
    this.dragOriginDoc = null;
  };

  private boundKeydown = (event: KeyboardEvent) => this._handleKeydown(event);

  _handleKeydown(event) {
    // This is bound to `window`, so a Backspace aimed at any text field in the
    // app arrived here too — and deleted the selected keyframe. The timeline
    // canvas already guards its own shortcuts with this helper.
    if (isTypingEvent(event)) {
      return;
    }
    if (!this.isShow) {
      return;
    }

    // `event.code`, not `keyCode`: the latter is deprecated and, being
    // layout-dependent on some engines, is exactly the sort of thing that works
    // on one machine and not another.
    if (event.code === "Backspace" || event.code === "Delete") {
      if (this.activePointIndex != -1) {
        this.removePoint();
      }
      return;
    }

    if (event.code === "Escape") {
      this.handleCancelDrag();
    }
  }

  disconnectedCallback(): void {
    window.removeEventListener("keydown", this.boundKeydown);
    window.removeEventListener("mouseup", this._handleMouseUp);
    window.removeEventListener("blur", this.handleCancelDrag);
    super.disconnectedCallback();
  }
}
