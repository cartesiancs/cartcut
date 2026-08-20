import { LitElement, PropertyValues, html } from "lit";
import { customElement, property, query } from "lit/decorators.js";
import { ITimelineStore, useTimelineStore } from "../../states/timelineStore";
import { millisecondsToPx } from "../../utils/time";
import { IUIStore, uiStore } from "../../states/uiStore";
import { ImageElementType } from "../../@types/timeline";
import { KeyframeController } from "../../controllers/keyframe";
import { applySurface, surfaceSpec } from "../timeline/canvasSurface";
import { isCollapsedHandle } from "../animation/handleBounds";
import type { Keyframe, Lane } from "../animation/keyframes";
import type { TimelineDocument } from "../timeline/tracks";
import { isTypingEvent } from "../../utils/typingTarget";
import {
  clampToClip,
  hitTest,
  toScreen,
  toTrack,
  type Hit,
  type Viewport,
} from "./editorGeometry";
import {
  beginDrag,
  curveChanged,
  updateDrag,
  type DragState,
  type DragTarget,
} from "./dragKeyframe";

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

  /** The drag in progress, or `null`. Owned by `dragKeyframe`. */
  private drag: DragState | null = null;
  /** The drag's preview document; committed once, on mouseup. */
  private pendingDoc: TimelineDocument | null = null;
  /** Whether the pointer is over something grabbable, for the cursor. */
  private hover: Hit | null = null;

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
    const track = this.timeline[this.elementId].animation[this.animationType];

    for (const lane of ["x", "y"] as const) {
      const dots = track[lane];
      if (!Array.isArray(dots)) {
        continue;
      }
      const selected = this.currentLaneName() === lane;
      this.drawDotsLoop({
        ctx,
        dots,
        // The lane being edited keeps its colour; the other greys out.
        color: selected ? (lane === "x" ? "#403af0" : "#e83535") : "#3d3e45",
        subColor: selected ? (lane === "x" ? "#b7bcf7" : "#ed7979") : "#3d3e45",
        selected,
      });
    }
  }

  drawDotsLoop({ ctx, dots, color, subColor, selected }) {
    const viewport = this.viewport();

    for (let index = 0; index < dots.length; index++) {
      const element = dots[index];

      // `selected` as well as the index. Without it, choosing keyframe 2 on the
      // x lane painted keyframe 2 on the y lane yellow too, so two points in
      // two different curves both looked like the selection.
      const isActive = selected && this.activePointIndex === index;

      const anchor = toScreen(viewport, element.p[0], element.p[1]);

      // Handles for the selected keyframe alone. Drawing all of them turned a
      // busy curve into a thicket of near-identical dots, and every one of them
      // was a grab target sitting on top of the anchors.
      if (isActive) {
        ctx.strokeStyle = subColor;
        ctx.fillStyle = subColor;

        for (const which of ["cs", "ce"] as const) {
          // The first keyframe's `cs` and the last one's `ce` sit exactly on
          // their anchors and the baker never reads them — see `handleBounds`.
          // Drawing them would offer a control that cannot affect the curve.
          if (isCollapsedHandle(element, which)) {
            continue;
          }
          const handle = toScreen(viewport, element[which][0], element[which][1]);

          ctx.beginPath();
          ctx.moveTo(anchor.x, anchor.y);
          ctx.lineTo(handle.x, handle.y);
          ctx.stroke();

          ctx.beginPath();
          ctx.arc(handle.x, handle.y, 4, 0, 2 * Math.PI);
          ctx.fill();
        }
      }

      // The anchor last, so it is never buried under its own handles.
      ctx.fillStyle = isActive ? "#f7f414" : color;
      ctx.beginPath();
      ctx.arc(anchor.x, anchor.y, isActive ? 5 : 4, 0, 2 * Math.PI);
      ctx.fill();
    }
  }

  private drawLines(ctx) {
    const track = this.timeline[this.elementId].animation[this.animationType];
    const viewport = this.viewport();

    for (const [lane, key] of [
      ["x", "ax"],
      ["y", "ay"],
    ] as const) {
      const baked = track[key];
      if (!Array.isArray(baked)) {
        continue;
      }
      const selected = this.currentLaneName() === lane;
      ctx.strokeStyle = selected
        ? lane === "x"
          ? "#403af0"
          : "#e83535"
        : "#3d3e45";

      // The same `toScreen` the dots go through. Drawing the curve and its
      // control points with two different mappings is how the handle you drew
      // and the curve it was supposed to shape came to disagree.
      ctx.beginPath();
      for (const [tMs, value] of baked) {
        const point = toScreen(viewport, tMs, value);
        ctx.lineTo(point.x, point.y);
      }
      ctx.stroke();
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

  /**
   * The mapping between track space and canvas px, as `editorGeometry` wants it.
   *
   * Built fresh per use rather than cached: every field is a live store value,
   * and a stale copy is exactly how the forward and inverse maps drifted apart
   * in the first place.
   */
  private viewport(): Viewport {
    const element = this.timeline[this.elementId];
    return {
      timelineRange: this.timelineRange,
      timelineScroll: this.timelineScroll,
      verticalScroll: this.verticalScroll,
      verticalRange: this.verticalRange,
      startTime: element?.startTime ?? 0,
      duration: element?.duration ?? 0,
    };
  }

  /** Which curve the x/y buttons currently address. */
  private dragTarget(): DragTarget {
    return {
      elementId: this.elementId,
      property: this.animationType,
      lane: this.currentLaneName(),
    };
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

  /** The lane name the x/y buttons currently select. */
  private currentLaneName(): Lane {
    return this.selectLine == 0 ? "x" : "y";
  }

  /** The authored keyframes for the lane currently being edited. */
  private currentLane(): Keyframe[] {
    const list = this.timeline?.[this.elementId]?.animation?.[
      this.animationType
    ]?.[this.currentLaneName()];
    return Array.isArray(list) ? list : [];
  }

  _handleMouseMove(e) {
    if (this.timeline?.[this.elementId] == null) {
      return;
    }

    if (this.drag == null) {
      this.hover = hitTest(
        this.currentLane(),
        this.viewport(),
        e.offsetX,
        e.offsetY,
        { activeIndex: this.activePointIndex },
      );
      this.cursor = this.hover == null ? "default" : "pointer";
      this.requestUpdate();
      return;
    }

    // A drag previews through `previewDocument` — which neither normalises the
    // document nor records history, so it is cheap at pointer rate — and
    // commits exactly once on mouseup. Writing per mousemove is what made a
    // single drag either fill the undo stack or, as it actually did, mutate the
    // store snapshot in place and bypass history altogether.
    //
    // `updateDrag` recomputes from the document as it stood when the drag
    // began rather than compounding, so the point tracks the pointer exactly
    // instead of drifting.
    const moved = updateDrag(
      this.drag,
      this.viewport(),
      e.offsetX,
      e.offsetY,
      {
        playheadMs: this.timelineCursor,
        // Alt is the escape hatch for placing a keyframe a few ms off the
        // playhead deliberately.
        enableSnap: !e.altKey,
      },
    );

    this.clickIndex = moved.index;
    if (this.drag.part == "p") {
      this.activePointIndex = moved.index;
    }
    this.pendingDoc = moved.doc;

    useTimelineStore.getState().previewDocument(moved.doc);
    this.drawCanvas();
    this.requestUpdate();
  }

  _handleMouseDown(e) {
    if (this.timeline?.[this.elementId] == null) {
      return;
    }

    const hit = hitTest(
      this.currentLane(),
      this.viewport(),
      e.offsetX,
      e.offsetY,
      { activeIndex: this.activePointIndex },
    );

    if (hit != null) {
      if (hit.part == "p") {
        this.activePointIndex = hit.index;
      }
      this.clickIndex = hit.index;
      this.clickDot = hit.part;
      this.isDrag = true;
      this.drag = beginDrag(
        useTimelineStore.getState().getDocument(),
        this.dragTarget(),
        hit,
      );
      this.pendingDoc = null;
      this.requestUpdate();
      return;
    }

    this.isDrag = false;
    const { tMs, value } = toTrack(this.viewport(), e.offsetX, e.offsetY);
    this.keyframeControl.addPoint({
      x: clampToClip(this.viewport(), tMs),
      y: value,
      line: this.selectLine,
      elementId: this.elementId,
      animationType: this.animationType,
    });
    this.drawCanvas();
  }

  _handleMouseUp = () => {
    // One undo entry for the whole gesture. A drag that never moved anything
    // records nothing — see `curveChanged`, which compares the curve rather
    // than the document, because the ops build a fresh document every frame.
    const pending = this.pendingDoc;
    const drag = this.drag;
    this.isDrag = false;
    this.clickIndex = -1;
    this.pendingDoc = null;
    this.drag = null;

    if (drag == null) {
      return;
    }

    // Put the store back to where the gesture started, so the checkpoint below
    // has an accurate baseline to diff against and a cancelled drag leaves no
    // trace at all.
    useTimelineStore.getState().previewDocument(drag.originDoc);
    if (pending != null && curveChanged(drag.originDoc, pending, drag.target)) {
      useTimelineStore.getState().withCheckpoint(() => pending);
    }
  };

  /** Abandon a drag that ended somewhere this component never hears about. */
  private handleCancelDrag = () => {
    if (this.drag != null) {
      useTimelineStore.getState().previewDocument(this.drag.originDoc);
    }
    this.isDrag = false;
    this.clickIndex = -1;
    this.pendingDoc = null;
    this.drag = null;
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
