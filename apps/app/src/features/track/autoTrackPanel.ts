/**
 * The Auto Track panel.
 *
 * Select a video clip on the timeline, click something in it, press Track, and
 * get a null object whose `position` follows what was clicked. Anything
 * parented to that null then follows it too, through the pick-whip that already
 * exists, which is why the output is a null and not a new kind of element: the
 * whole "make this label stick to that sign" feature is already built, and it
 * was missing only something that knows where the sign is.
 *
 * The panel is a stage and two buttons, Track (Cancel while it runs) and Create
 * Null, and it says nothing in sentences. A drag on the picture still sizes the
 * box for anyone who wants a bigger one; a click gets `CLICK_BOX_RADIUS`.
 *
 * ## Why it draws the source rather than the composite
 *
 * The panel takes over the preview column, like every other utility panel, and
 * shows the clip's own decoded frame, not what the preview would draw. Three
 * reasons, in increasing order of how much trouble the alternative would be:
 * the tracker works in source pixels, so this is the picture whose coordinates
 * it will answer in; the clip may be scaled, rotated or half off-screen, and
 * asking someone to click a feature they can barely see is a worse tool; and
 * putting a drag on `previewCanvas` would mean sharing the hit test, the
 * element drag and the mask pen tool's key handling, which CLAUDE.md already
 * describes as the thing in this codebase that fights everything else.
 *
 * ## The stage
 *
 * The canvas fills the panel and the frame is drawn into it through a viewport,
 * the preview's own arithmetic with fit as a floor (`stageView.ts`, where the
 * rules are and where they are tested). Pinch or ctrl+wheel zooms toward the
 * pointer; a swipe, a middle or alt drag, or a drag from the margin pans.
 *
 * ## Why the canvas is drawn imperatively
 *
 * Tracking reports a frame every 16ms. Routing that through Lit's reactive
 * update would re-render the whole panel at frame rate to move one dot, so the
 * path is drawn straight onto the 2D context in the harvest callback and only
 * the progress number is throttled back into component state.
 */

import { LitElement, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { v4 as uuidv4 } from "uuid";
import type { TimelineElement } from "../../@types/timeline";
import { renderOptionStore } from "../../states/renderOptionStore";
import { selectionStore } from "../../states/selectionStore";
import { useTimelineStore } from "../../states/timelineStore";
import { bakeRateFor } from "../animation/keyframes";
import { CANVAS_BG } from "../preview/playbackPreview";
import { fitViewport, type Viewport, type ViewportGeometry } from "../preview/viewport";
import { frameDurationMs } from "../timeline/frames";
import { sourceTimeAt, spanOf } from "../timeline/geometry";
import { openFrameSource, type FrameSource } from "./frameSource";
import { simplifyPath } from "./simplify";
import {
  containViewport,
  panViewport,
  pointerIntent,
  stageGeometry,
  stagePoint,
  wheelViewport,
  type StageSize,
} from "./stageView";
import { toProjectPath } from "./trackToTimeline";
import { createTrackNull } from "./trackNullOp";
import {
  finishTracker,
  startTracker,
  stepTracker,
  type TrackerState,
  type TrackSample,
} from "./tracker";

/** Half-side of the box a bare click produces, in working-frame pixels. */
const CLICK_BOX_RADIUS = 16;

/** Smallest box worth tracking. Below this a drag reads as a click. */
const MIN_BOX_RADIUS = 6;

/**
 * View px per working px past which the frame is drawn unsmoothed. Zooming in is
 * for placing the box precisely, and a smoothed blow-up hides the very pixels
 * the tracker is about to correlate.
 */
const PIXELATE_FROM_SCALE = 2;

const BOX_COLOR = "#ffd400";
const PATH_COLOR = "#4ade80";
const FAILED_COLOR = "#f87171";

type Box = { cx: number; cy: number; radius: number };

type Phase = "idle" | "loading" | "ready" | "tracking" | "done" | "error";

@customElement("auto-track-panel")
export class AutoTrackPanel extends LitElement {
  @state() private clipId: string | null = null;
  @state() private phase: Phase = "idle";
  /** Why the clip could not be opened, for the warning glyph's tooltip. */
  @state() private error = "";
  @state() private progress = 0;
  @state() private box: Box | null = null;
  @state() private result: TrackerState | null = null;

  private source: FrameSource | null = null;
  private viewport: Viewport = fitViewport(1, 1);
  /** The canvas's CSS size, as the resize observer last reported it. */
  private viewW = 0;
  private viewH = 0;
  private dragFrom: { x: number; y: number } | null = null;
  private pan: { x: number; y: number; from: Viewport } | null = null;
  private seedMs = 0;
  private samples: readonly TrackSample[] = [];
  private abort: AbortController | null = null;
  private disposers: (() => void)[] = [];
  private resizeObserver: ResizeObserver | null = null;
  private lastProgressAt = 0;

  createRenderRoot() {
    return this;
  }

  connectedCallback(): void {
    super.connectedCallback();
    // The host is a plain custom element with no shadow root, so it is inline
    // by default and collapses to its content. Sizing it here is what lets the
    // column below give the stage the space left over and keep the buttons on
    // screen. Done in `connectedCallback` rather than the constructor, which
    // may not touch attributes.
    this.style.display = "flex";
    this.style.flexDirection = "column";
    this.style.width = "100%";
    this.style.height = "100%";

    this.disposers.push(
      selectionStore.subscribe(() => this.adoptSelection()),
      // The clip can be trimmed or moved while the panel is open, which changes
      // the range a track may cover and which source frame the playhead names.
      useTimelineStore.subscribe(() => this.requestUpdate()),
    );
    this.adoptSelection();
  }

  disconnectedCallback(): void {
    for (const dispose of this.disposers) {
      dispose();
    }
    this.disposers = [];
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.cancel();
    this.closeSource();
    // Forget the clip with its decoder, or a reconnect would find the same
    // selection, take it as already adopted and show a stage with no source.
    this.clipId = null;
    this.phase = "idle";
    super.disconnectedCallback();
  }

  updated(): void {
    this.observeStage();
    this.paint();
  }

  // ------------------------------------------------------------- selection

  private clip(): TimelineElement | null {
    if (this.clipId == null) {
      return null;
    }
    return (useTimelineStore.getState().timeline[this.clipId] ??
      null) as TimelineElement | null;
  }

  /**
   * Follow the selection onto a video clip, and onto nothing else.
   *
   * A selection that names no video clip leaves the panel exactly as it is,
   * rather than resetting it. Otherwise "Create Null" would wipe the thing it
   * had just been given: creating the null selects it, so that anything the
   * user parents to it is one click away in the option panel, and a panel that
   * reset on any non-video selection would throw away a track that took as
   * long to make as the clip is long. Clicking a title, or clicking empty
   * space, would do the same.
   *
   * The clip going away is the one case that does reset, and it is handled by
   * `clip()` answering null rather than here: a deleted clip is not a
   * selection change.
   */
  private adoptSelection(): void {
    const timeline = useTimelineStore.getState().timeline as Record<
      string,
      TimelineElement
    >;
    const picked = selectionStore
      .getState()
      .ids.find((id) => timeline[id]?.filetype === "video");

    if (picked === undefined || picked === this.clipId) {
      return;
    }

    this.cancel();
    this.clipId = picked;
    this.box = null;
    this.samples = [];
    this.result = null;
    this.error = "";
    this.phase = "loading";
    this.closeSource();

    void this.openAndShow(picked);
  }

  private closeSource(): void {
    this.source?.close();
    this.source = null;
  }

  /** Open the clip's own decoder and show the frame under the playhead. */
  private async openAndShow(clipId: string): Promise<void> {
    const element = this.clip();
    if (element == null) {
      return;
    }

    try {
      const source = await openFrameSource({ localpath: element.localpath });
      // A second selection may have landed while the decoder was opening. The
      // late one wins, and this one closes rather than painting over it.
      if (this.clipId !== clipId) {
        source.close();
        return;
      }
      this.source = source;
      this.viewport = fitViewport(source.workingWidth, source.workingHeight);

      this.seedMs = this.seedSourceMs(element);
      await source.grab(this.seedMs);
      if (this.clipId !== clipId) {
        return;
      }

      this.phase = "ready";
    } catch (error) {
      if (this.clipId !== clipId) {
        return;
      }
      this.phase = "error";
      this.error = error instanceof Error ? error.message : String(error);
    }
  }

  /**
   * The source instant the panel opens on.
   *
   * The playhead when it is over the clip, and the clip's first frame when it
   * is not, rather than refusing: "move the playhead onto the clip first" is a
   * rule the user has no way to have known about, and the first frame is a
   * defensible place to start a forward track from.
   */
  private seedSourceMs(element: TimelineElement): number {
    const span = spanOf(element);
    const cursor = useTimelineStore.getState().cursor ?? span.start;
    const inside = Math.min(Math.max(cursor, span.start), span.end - 1);
    return sourceTimeAt(element as any, inside);
  }

  private endSourceMs(element: TimelineElement): number {
    return sourceTimeAt(element as any, spanOf(element).end);
  }

  // -------------------------------------------------------------- the stage

  private canvas(): HTMLCanvasElement | null {
    return this.querySelector<HTMLCanvasElement>(".auto-track-canvas");
  }

  /**
   * Watch the canvas's box, from the first render that has one.
   *
   * Here and not in `firstUpdated`, which runs once per element: a disconnect
   * drops the observer, and a reconnect has to find it missing and make another.
   * The panel's own column hides it with `d-none` when another tab is on show,
   * which reports 0x0 and stops `paint` until it comes back.
   */
  private observeStage(): void {
    const canvas = this.canvas();
    if (this.resizeObserver != null || canvas == null) {
      return;
    }
    this.resizeObserver = new ResizeObserver((entries) => {
      const rect = entries[entries.length - 1].contentRect;
      this.viewW = rect.width;
      this.viewH = rect.height;
      const size = this.stageSize();
      if (size != null) {
        this.viewport = containViewport(this.viewport, size);
      }
      this.paint();
    });
    this.resizeObserver.observe(canvas);
  }

  private stageSize(): StageSize | null {
    const source = this.source;
    if (source == null || !(this.viewW > 0) || !(this.viewH > 0)) {
      return null;
    }
    return {
      viewW: this.viewW,
      viewH: this.viewH,
      frameW: source.workingWidth,
      frameH: source.workingHeight,
    };
  }

  /** Pointer client coordinates as CSS px from the canvas's top left. */
  private toView(event: MouseEvent): { x: number; y: number } {
    const rect = (this.canvas() as HTMLCanvasElement).getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  private canPlace(): boolean {
    return this.phase === "ready" || this.phase === "done";
  }

  /** Redraw the frame, the box and whatever path has been found so far. */
  private paint(): void {
    const canvas = this.canvas();
    if (canvas == null || !(this.viewW > 0) || !(this.viewH > 0)) {
      return;
    }

    const dpr = window.devicePixelRatio || 1;
    const backingW = Math.round(this.viewW * dpr);
    const backingH = Math.round(this.viewH * dpr);
    if (canvas.width !== backingW || canvas.height !== backingH) {
      canvas.width = backingW;
      canvas.height = backingH;
    }

    const ctx = canvas.getContext("2d");
    if (ctx == null) {
      return;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = CANVAS_BG;
    ctx.fillRect(0, 0, backingW, backingH);

    const size = this.stageSize();
    if (size == null || this.clip() == null) {
      return;
    }

    const geometry = stageGeometry(this.viewport, size);
    ctx.setTransform(
      dpr * geometry.scale,
      0,
      0,
      dpr * geometry.scale,
      dpr * geometry.offsetX,
      dpr * geometry.offsetY,
    );
    ctx.imageSmoothingEnabled = geometry.scale < PIXELATE_FROM_SCALE;
    ctx.drawImage((this.source as FrameSource).canvas, 0, 0);

    // The marks in view px, so a line is two pixels wide at every zoom.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.paintPath(ctx, geometry);
    this.paintBox(ctx, geometry);
  }

  private paintBox(
    ctx: CanvasRenderingContext2D,
    geometry: ViewportGeometry,
  ): void {
    const box = this.box;
    if (box == null) {
      return;
    }

    // While it runs the box rides the newest sample, over the frame that sample
    // came from, so what is being followed is visible as it is followed.
    const head =
      this.phase === "tracking" && this.samples.length > 0
        ? this.samples[this.samples.length - 1]
        : null;
    const cx = (head?.x ?? box.cx) * geometry.scale + geometry.offsetX;
    const cy = (head?.y ?? box.cy) * geometry.scale + geometry.offsetY;
    const half = box.radius * geometry.scale;

    ctx.strokeStyle =
      this.result?.status === "no-texture" ? FAILED_COLOR : BOX_COLOR;
    ctx.lineWidth = 2;
    ctx.strokeRect(cx - half, cy - half, half * 2, half * 2);

    ctx.beginPath();
    ctx.moveTo(cx - 6, cy);
    ctx.lineTo(cx + 6, cy);
    ctx.moveTo(cx, cy - 6);
    ctx.lineTo(cx, cy + 6);
    ctx.stroke();
  }

  private paintPath(
    ctx: CanvasRenderingContext2D,
    geometry: ViewportGeometry,
  ): void {
    const samples = this.samples;
    if (samples.length < 2) {
      return;
    }
    const at = (sample: TrackSample) => ({
      x: sample.x * geometry.scale + geometry.offsetX,
      y: sample.y * geometry.scale + geometry.offsetY,
    });

    ctx.strokeStyle = PATH_COLOR;
    ctx.lineWidth = 2;
    ctx.beginPath();
    const first = at(samples[0]);
    ctx.moveTo(first.x, first.y);
    for (let i = 1; i < samples.length; i++) {
      const point = at(samples[i]);
      ctx.lineTo(point.x, point.y);
    }
    ctx.stroke();

    // Where the track ends, red when it ended by losing the feature, which is
    // the one thing the old message said that the path alone does not.
    if (this.result != null) {
      const end = at(samples[samples.length - 1]);
      ctx.fillStyle =
        this.result.status === "lost" ? FAILED_COLOR : PATH_COLOR;
      ctx.beginPath();
      ctx.arc(end.x, end.y, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private setCursor(cursor: string): void {
    const canvas = this.canvas();
    if (canvas != null && canvas.style.cursor !== cursor) {
      canvas.style.cursor = cursor;
    }
  }

  /** The cursor for a pointer hovering at `view`, with no button down. */
  private hoverCursor(event: MouseEvent, size: StageSize): string {
    const view = this.toView(event);
    const intent = pointerIntent(
      { button: 0, altKey: event.altKey },
      stagePoint(this.viewport, size, view.x, view.y),
      size,
      this.canPlace(),
    );
    return intent === "place" ? "crosshair" : "grab";
  }

  private onPointerDown(event: PointerEvent): void {
    const size = this.stageSize();
    if (size == null || this.clip() == null) {
      return;
    }
    const view = this.toView(event);
    const world = stagePoint(this.viewport, size, view.x, view.y);
    const intent = pointerIntent(event, world, size, this.canPlace());
    if (intent === "none") {
      return;
    }

    // Also what stops a middle press from starting the browser's autoscroll.
    event.preventDefault();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);

    if (intent === "pan") {
      this.pan = { x: view.x, y: view.y, from: this.viewport };
      this.setCursor("grabbing");
      return;
    }

    this.dragFrom = world;
    // A new box discards the previous run's path: it belongs to a feature the
    // user has just stopped pointing at.
    this.samples = [];
    this.result = null;
    this.setBoxFromDrag(world);
  }

  private onPointerMove(event: PointerEvent): void {
    const size = this.stageSize();
    if (size == null || this.clip() == null) {
      this.setCursor("");
      return;
    }
    const view = this.toView(event);

    if (this.pan != null) {
      // From where the drag began rather than by increments, so a clamp at the
      // edge gives the picture back as soon as the pointer turns round.
      this.viewport = panViewport(
        this.pan.from,
        view.x - this.pan.x,
        view.y - this.pan.y,
        size,
      );
      this.paint();
      return;
    }

    if (this.dragFrom != null) {
      this.setBoxFromDrag(stagePoint(this.viewport, size, view.x, view.y));
      return;
    }

    this.setCursor(this.hoverCursor(event, size));
  }

  private onPointerUp(event: PointerEvent): void {
    if (this.pan == null && this.dragFrom == null) {
      return;
    }
    const target = event.currentTarget as HTMLElement;
    if (target.hasPointerCapture(event.pointerId)) {
      target.releasePointerCapture(event.pointerId);
    }
    this.pan = null;
    this.dragFrom = null;

    const size = this.stageSize();
    if (size != null) {
      this.setCursor(this.hoverCursor(event, size));
    }
    this.paint();
  }

  private onWheel(event: WheelEvent): void {
    const size = this.stageSize();
    if (size == null || this.clip() == null) {
      return;
    }
    event.preventDefault();
    this.viewport = wheelViewport(
      this.viewport,
      event,
      this.toView(event),
      size,
    );
    this.paint();
  }

  /**
   * A square box from the drag, or a default one from a bare click.
   *
   * Square rather than free: the correlation window is `(2r+1)²` and a
   * rectangular drag would have to be reduced to one number anyway. Reducing it
   * here, visibly, beats accepting a shape the tracker then quietly ignores.
   */
  private setBoxFromDrag(to: { x: number; y: number }): void {
    const from = this.dragFrom ?? to;
    const radius = Math.max(
      Math.abs(to.x - from.x),
      Math.abs(to.y - from.y),
    ) / 2;

    this.box =
      radius < MIN_BOX_RADIUS
        ? { cx: from.x, cy: from.y, radius: CLICK_BOX_RADIUS }
        : {
            cx: (from.x + to.x) / 2,
            cy: (from.y + to.y) / 2,
            radius,
          };
  }

  // -------------------------------------------------------------- the track

  private async track(): Promise<void> {
    const element = this.clip();
    const source = this.source;
    const box = this.box;
    if (element == null || source == null || box == null) {
      return;
    }

    const endSourceMs = this.endSourceMs(element);
    if (!(endSourceMs > this.seedMs)) {
      return;
    }

    const fps = renderOptionStore.getState().options.fps;
    const abort = new AbortController();
    this.abort = abort;
    this.phase = "tracking";
    this.progress = 0;
    this.samples = [];
    this.result = null;

    let state: TrackerState | null = null;

    try {
      await source.harvest({
        startMs: this.seedMs,
        endMs: endSourceMs,
        // The project's own grid. A finer stride is work whose answer gets
        // snapped onto a keyframe time another sample already holds.
        strideMs: frameDurationMs(fps),
        signal: abort.signal,
        onFrame: (frame, progress) => {
          state =
            state == null
              ? startTracker(
                  frame,
                  { x: box.cx, y: box.cy },
                  { windowRadius: Math.round(box.radius) },
                )
              : stepTracker(state, frame);

          this.samples = state.samples;
          this.paint();

          // Throttled: the harvest reports at frame rate and this is the only
          // part of it that goes through a reactive update.
          const now = performance.now();
          if (now - this.lastProgressAt > 100) {
            this.lastProgressAt = now;
            this.progress = progress;
          }

          if (state.status !== "tracking") {
            abort.abort();
          }
        },
      });
    } catch (error) {
      // The clip changed under the run, and everything below would write this
      // clip's track into the next one's panel.
      if (this.source !== source) {
        return;
      }
      if ((error as Error)?.name !== "AbortError") {
        this.phase = "error";
        this.error = error instanceof Error ? error.message : String(error);
        this.abort = null;
        return;
      }
    }
    if (this.source !== source) {
      return;
    }

    this.abort = null;
    this.result = state == null ? null : finishTracker(state);
    this.samples = this.result?.samples ?? [];

    // Back to the seed frame. The harvest left the decoder on the last frame it
    // read, and a box clicked there would be seeded at `seedMs` on a picture
    // from somewhere else in the clip. `loading` until then, so the stage
    // takes no click on the wrong frame.
    this.phase = "loading";
    try {
      await source.grab(this.seedMs);
    } catch {
      // The path is already kept; failing to redraw the seed under it is not a
      // reason to throw it away.
    }
    if (this.source !== source) {
      return;
    }
    this.phase = "done";
  }

  private cancel(): void {
    this.abort?.abort();
    this.abort = null;
  }

  // --------------------------------------------------------------- the null

  private createNull(): void {
    const element = this.clip();
    const source = this.source;
    const result = this.result;
    if (element == null || source == null || result == null) {
      return;
    }

    const { fps, duration } = renderOptionStore.getState().options;
    const path = toProjectPath(result.samples, {
      elements: useTimelineStore.getState().timeline,
      clipId: this.clipId as string,
      frameWidth: source.workingWidth,
      frameHeight: source.workingHeight,
      fps,
    });

    const nullId = uuidv4();

    useTimelineStore.getState().withCheckpoint((doc) =>
      createTrackNull(doc, {
        samples: simplifyPath(path),
        nullId,
        newTrackId: uuidv4(),
        // `renderOption.duration` is in seconds.
        durationMs: duration * 1000,
        bakeHz: bakeRateFor(fps),
      }),
    );

    if (useTimelineStore.getState().timeline[nullId] == null) {
      return;
    }

    // Select it and open the inspector on it, so the pick-whip is one click
    // away. Both, because the inspector does not follow `selectionStore`: it is
    // shown by whoever made the selection (`elementTimelineCanvas#
    // showSideOption`), and the selection alone left it on whatever it showed
    // before. It is also the only confirmation, since the panel says nothing.
    selectionStore.getState().setIds([nullId]);
    (document.querySelector("option-group") as any)?.showOption({
      filetype: "group",
      elementId: nullId,
    });
  }

  // ---------------------------------------------------------------- render

  render() {
    const element = this.clip();
    const busy = this.phase === "tracking";
    const canTrack =
      element != null &&
      this.canPlace() &&
      this.box != null &&
      this.endSourceMs(element) > this.seedMs;
    const canCreate =
      element != null &&
      !busy &&
      this.result != null &&
      this.result.samples.length >= 2;

    return html`
      <div class="auto-track-stage">
        <canvas
          class="auto-track-canvas"
          @pointerdown=${this.onPointerDown}
          @pointermove=${this.onPointerMove}
          @pointerup=${this.onPointerUp}
          @pointercancel=${this.onPointerUp}
          @wheel=${{
            handleEvent: (event: WheelEvent) => this.onWheel(event),
            // A wheel listener has to be active to `preventDefault`, and a
            // pinch it did not prevent zooms the whole window.
            passive: false,
          }}
        ></canvas>
        ${this.renderOverlay(element)}
        ${busy
          ? html`<div
              class="auto-track-progress"
              style="width: ${Math.round(this.progress * 100)}%"
            ></div>`
          : nothing}
      </div>

      <div class="auto-track-bar">
        <button
          type="button"
          class="auto-track-btn is-primary ${busy ? "is-cancel" : ""}"
          ?disabled=${!busy && !canTrack}
          @click=${() => (busy ? this.cancel() : void this.track())}
        >
          <span class="material-symbols-outlined"
            >${busy ? "stop" : "my_location"}</span
          >${busy ? "Cancel" : "Track"}
        </button>
        <button
          type="button"
          class="auto-track-btn"
          ?disabled=${!canCreate}
          @click=${() => this.createNull()}
        >
          <span class="material-symbols-outlined">filter_center_focus</span
          >Create Null
        </button>
      </div>
    `;
  }

  private renderOverlay(element: TimelineElement | null) {
    if (element == null) {
      return html`<div class="auto-track-overlay">
        <span class="material-symbols-outlined">movie</span>Select a clip
      </div>`;
    }
    if (this.phase === "loading") {
      return html`<div class="auto-track-overlay is-loading">
        <span class="spinner-border spinner-border-sm"></span>
      </div>`;
    }
    if (this.phase === "error") {
      return html`<div class="auto-track-overlay is-error">
        <span class="material-symbols-outlined" title=${this.error}
          >error</span
        >
      </div>`;
    }
    return nothing;
  }
}
