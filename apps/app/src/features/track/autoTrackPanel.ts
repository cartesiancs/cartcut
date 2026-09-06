/**
 * The Auto Track panel.
 *
 * Select a video clip on the timeline, draw a box around something in it, press
 * Track, and get a null object whose `position` follows what was in the box.
 * Anything parented to that null then follows it too, through the pick-whip
 * that already exists — which is why the output is a null and not a new kind of
 * element: the whole "make this label stick to that sign" feature is already
 * built, and it was missing only something that knows where the sign is.
 *
 * ## Why it draws the source rather than the composite
 *
 * The panel takes over the preview column, like every other utility panel, and
 * shows the clip's own decoded frame — not what the preview would draw. Three
 * reasons, in increasing order of how much trouble the alternative would be:
 * the tracker works in source pixels, so this is the picture whose coordinates
 * it will answer in; the clip may be scaled, rotated or half off-screen, and
 * asking someone to click a feature they can barely see is a worse tool; and
 * putting a drag on `previewCanvas` would mean sharing the hit test, the
 * element drag and the mask pen tool's key handling, which CLAUDE.md already
 * describes as the thing in this codebase that fights everything else.
 *
 * ## Why the canvas is drawn imperatively
 *
 * Tracking reports a frame every 16ms. Routing that through Lit's reactive
 * update would re-render the whole panel at frame rate to move one dot, so the
 * path is drawn straight onto the 2D context in the harvest callback and only
 * the progress number is throttled back into component state.
 */

import { LitElement, html } from "lit";
import { customElement, state } from "lit/decorators.js";
import { v4 as uuidv4 } from "uuid";
import type { TimelineElement } from "../../@types/timeline";
import { renderOptionStore } from "../../states/renderOptionStore";
import { selectionStore } from "../../states/selectionStore";
import { useTimelineStore } from "../../states/timelineStore";
import { bakeRateFor } from "../animation/keyframes";
import { frameDurationMs } from "../timeline/frames";
import { sourceTimeAt, spanOf, timelineTimeAt } from "../timeline/geometry";
import { openFrameSource, type FrameSource } from "./frameSource";
import { DEFAULT_TOLERANCE_PX, simplifyPath } from "./simplify";
import { toProjectPath } from "./trackToTimeline";
import { createTrackNull } from "./trackNullOp";
import {
  DEFAULT_TRACK_OPTIONS,
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

type Box = { cx: number; cy: number; radius: number };

type Phase = "idle" | "loading" | "ready" | "tracking" | "done" | "error";

@customElement("auto-track-panel")
export class AutoTrackPanel extends LitElement {
  @state() private clipId: string | null = null;
  @state() private phase: Phase = "idle";
  @state() private message = "";
  @state() private progress = 0;
  @state() private status: TrackerState["status"] | null = null;
  @state() private sampleCount = 0;
  @state() private searchRadius = DEFAULT_TRACK_OPTIONS.searchRadius;
  @state() private tolerance = DEFAULT_TOLERANCE_PX;
  @state() private adaptTemplate = DEFAULT_TRACK_OPTIONS.adaptTemplate;
  /**
   * Whether the user stopped this run.
   *
   * A panel fact rather than a tracker one: the tracker was not asked for more
   * frames, which is not a state it can distinguish from having been given them
   * all. Without it a cancelled run reports "Tracked 118 frames" in the same
   * words as one that reached the end of the clip, and the partial track that
   * "Create null" then writes looks like the whole thing.
   */
  @state() private cancelled = false;

  private source: FrameSource | null = null;
  private box: Box | null = null;
  private dragFrom: { x: number; y: number } | null = null;
  private seedMs = 0;
  private samples: TrackSample[] = [];
  private result: TrackerState | null = null;
  private abort: AbortController | null = null;
  private disposers: (() => void)[] = [];
  private lastProgressAt = 0;

  createRenderRoot() {
    return this;
  }

  connectedCallback(): void {
    super.connectedCallback();
    // The host is a plain custom element with no shadow root, so it is inline
    // by default and collapses to its content. Sizing it here is what lets the
    // column below give the frame the space left over and keep the controls on
    // screen. Done in `connectedCallback` rather than the constructor, which
    // may not touch attributes.
    this.style.display = "flex";
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
    this.cancel();
    this.closeSource();
    super.disconnectedCallback();
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
   * Follow the selection onto a video clip — and onto nothing else.
   *
   * A selection that names no video clip leaves the panel exactly as it is,
   * rather than resetting it. Otherwise "Create null" would wipe the thing it
   * had just been given: creating the null selects it, so that anything the
   * user parents to it is one click away in the option panel, and a panel that
   * reset on any non-video selection would throw away a track that took as
   * long to make as the clip is long. Clicking a title, or clicking empty
   * space, would do the same.
   *
   * The clip going away is the one case that does reset, and it is handled by
   * `clip()` answering null rather than here — a deleted clip is not a
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
    this.status = null;
    this.sampleCount = 0;
    this.message = "";
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

      this.seedMs = this.seedSourceMs(element);
      await source.grab(this.seedMs);
      if (this.clipId !== clipId) {
        return;
      }

      this.phase = "ready";
      this.message = "";
      await this.updateComplete;
      this.paint();
    } catch (error) {
      this.phase = "error";
      this.message = error instanceof Error ? error.message : String(error);
    }
  }

  /**
   * The source instant the panel opens on.
   *
   * The playhead when it is over the clip, and the clip's first frame when it
   * is not — rather than refusing, because "move the playhead onto the clip
   * first" is a rule the user has no way to have known about, and the first
   * frame is a defensible place to start a forward track from.
   */
  private seedSourceMs(element: TimelineElement): number {
    const span = spanOf(element);
    const cursor = useTimelineStore.getState().cursor ?? span.start;
    const inside = Math.min(Math.max(cursor, span.start), span.end - 1);
    return sourceTimeAt(element as any, inside);
  }

  // ------------------------------------------------------------- the canvas

  private canvas(): HTMLCanvasElement | null {
    return this.querySelector<HTMLCanvasElement>("#auto-track-canvas");
  }

  /** Redraw the frame, the box and whatever path has been found so far. */
  private paint(): void {
    const canvas = this.canvas();
    const source = this.source;
    if (canvas == null || source == null) {
      return;
    }

    if (
      canvas.width !== source.workingWidth ||
      canvas.height !== source.workingHeight
    ) {
      canvas.width = source.workingWidth;
      canvas.height = source.workingHeight;
    }

    const ctx = canvas.getContext("2d");
    if (ctx == null) {
      return;
    }

    ctx.drawImage(source.canvas, 0, 0);
    this.paintPath(ctx);
    this.paintBox(ctx);
  }

  private paintBox(ctx: CanvasRenderingContext2D): void {
    const box = this.box;
    if (box == null) {
      return;
    }

    // The search region first, so the feature box reads as sitting inside it.
    ctx.strokeStyle = "rgba(120, 110, 190, 0.9)";
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    const outer = box.radius + this.searchRadius;
    ctx.strokeRect(box.cx - outer, box.cy - outer, outer * 2, outer * 2);

    ctx.setLineDash([]);
    ctx.strokeStyle = "#ffd400";
    ctx.lineWidth = 2;
    ctx.strokeRect(
      box.cx - box.radius,
      box.cy - box.radius,
      box.radius * 2,
      box.radius * 2,
    );

    ctx.beginPath();
    ctx.moveTo(box.cx - 6, box.cy);
    ctx.lineTo(box.cx + 6, box.cy);
    ctx.moveTo(box.cx, box.cy - 6);
    ctx.lineTo(box.cx, box.cy + 6);
    ctx.stroke();
  }

  private paintPath(ctx: CanvasRenderingContext2D): void {
    if (this.samples.length < 2) {
      return;
    }
    ctx.strokeStyle = "#4ade80";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(this.samples[0].x, this.samples[0].y);
    for (let i = 1; i < this.samples.length; i++) {
      ctx.lineTo(this.samples[i].x, this.samples[i].y);
    }
    ctx.stroke();
  }

  /** Pointer client coordinates as a pixel in the decoded frame. */
  private toFramePoint(event: PointerEvent): { x: number; y: number } | null {
    const canvas = this.canvas();
    if (canvas == null) {
      return null;
    }
    const rect = canvas.getBoundingClientRect();
    if (!(rect.width > 0) || !(rect.height > 0)) {
      return null;
    }
    return {
      x: ((event.clientX - rect.left) / rect.width) * canvas.width,
      y: ((event.clientY - rect.top) / rect.height) * canvas.height,
    };
  }

  private onPointerDown(event: PointerEvent): void {
    if (this.phase !== "ready" && this.phase !== "done") {
      return;
    }
    const point = this.toFramePoint(event);
    if (point == null) {
      return;
    }
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    this.dragFrom = point;
    // Drawing a new box discards the previous run's path: it belongs to a
    // feature the user has just stopped pointing at.
    this.samples = [];
    this.result = null;
    this.status = null;
    this.sampleCount = 0;
    this.setBoxFromDrag(point);
  }

  private onPointerMove(event: PointerEvent): void {
    if (this.dragFrom == null) {
      return;
    }
    const point = this.toFramePoint(event);
    if (point != null) {
      this.setBoxFromDrag(point);
    }
  }

  private onPointerUp(event: PointerEvent): void {
    if (this.dragFrom == null) {
      return;
    }
    (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
    this.dragFrom = null;
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

    this.paint();
  }

  // -------------------------------------------------------------- the track

  private async track(): Promise<void> {
    const element = this.clip();
    const source = this.source;
    const box = this.box;
    if (element == null || source == null || box == null) {
      return;
    }

    const span = spanOf(element);
    const endSourceMs = sourceTimeAt(element as any, span.end);
    if (!(endSourceMs > this.seedMs)) {
      this.message = "There is nothing after this frame to track.";
      return;
    }

    const fps = renderOptionStore.getState().options.fps;
    const abort = new AbortController();
    this.abort = abort;
    this.phase = "tracking";
    this.message = "";
    this.progress = 0;
    this.samples = [];
    this.result = null;
    this.cancelled = false;

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
                  {
                    windowRadius: Math.round(box.radius),
                    searchRadius: this.searchRadius,
                    adaptTemplate: this.adaptTemplate,
                  },
                )
              : stepTracker(state, frame);

          this.samples = state.samples as TrackSample[];
          this.paint();

          // Throttled: the harvest reports at frame rate and this is the only
          // part of it that goes through a reactive update.
          const now = performance.now();
          if (now - this.lastProgressAt > 100) {
            this.lastProgressAt = now;
            this.progress = progress;
            this.sampleCount = this.samples.length;
          }

          if (state.status !== "tracking") {
            abort.abort();
          }
        },
      });
    } catch (error) {
      if ((error as Error)?.name !== "AbortError") {
        this.phase = "error";
        this.message =
          error instanceof Error ? error.message : String(error);
        this.abort = null;
        return;
      }
    }

    this.abort = null;
    this.result = state == null ? null : finishTracker(state);
    this.status = this.result?.status ?? null;
    this.sampleCount = this.result?.samples.length ?? 0;
    this.progress = 1;
    this.phase = "done";
    this.message = this.describe();
  }

  private describe(): string {
    const result = this.result;
    if (result == null) {
      return "No frames were decoded for this range.";
    }
    if (result.status === "no-texture") {
      return "There is not enough detail in that box to track. Try a corner or an edge with contrast.";
    }
    if (result.status === "lost" && result.lostAtMs != null) {
      const element = this.clip();
      const at =
        element == null
          ? result.lostAtMs
          : timelineMsOf(element, result.lostAtMs);
      return `Lost the feature at ${formatMs(at)}. The track up to there is kept.`;
    }
    if (this.cancelled) {
      const element = this.clip();
      const last = result.samples[result.samples.length - 1];
      const at =
        element == null || last == null
          ? null
          : timelineMsOf(element, last.sourceMs);
      return at == null
        ? `Stopped after ${result.samples.length} frames.`
        : `Stopped at ${formatMs(at)}, after ${result.samples.length} frames. What was tracked is kept.`;
    }
    return `Tracked ${result.samples.length} frames.`;
  }

  private cancel(): void {
    if (this.abort != null) {
      this.cancelled = true;
    }
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

    const simplified = simplifyPath(path, this.tolerance);
    const nullId = uuidv4();

    useTimelineStore.getState().withCheckpoint((doc) =>
      createTrackNull(doc, {
        samples: simplified,
        nullId,
        newTrackId: uuidv4(),
        // `renderOption.duration` is in seconds.
        durationMs: duration * 1000,
        bakeHz: bakeRateFor(fps),
      }),
    );

    if (useTimelineStore.getState().timeline[nullId] == null) {
      this.message = "There was nothing on the timeline to write.";
      return;
    }

    // Select it, so the option panel opens on the thing that was just made and
    // the pick-whip is one click away.
    selectionStore.getState().setIds([nullId]);
    toast(`Null created from ${simplified.length} keyframes.`);
  }

  // ---------------------------------------------------------------- render

  render() {
    const element = this.clip();

    // A column rather than a scrolling block. The frame takes whatever height
    // is left after the heading and the controls, so the Track button is on
    // screen for a 9:16 phone clip and a 21:9 anamorphic one alike — which a
    // full-width canvas is not, and which no fixed max-height gets right for
    // both.
    return html`
      <div
        class="p-4 w-100 h-100 d-flex flex-column overflow-auto"
        style="max-width: 52rem; min-height: 0;"
      >
        <h5 class="text-light flex-shrink-0">Auto Track</h5>
        <p class="text-secondary flex-shrink-0" style="font-size: 0.8rem;">
          Follow something in a clip and turn its path into a null object.
          Parent a title or a shape to that null and it sticks to what you
          tracked.
        </p>

        ${element == null ? this.renderEmpty() : this.renderTracker(element)}
      </div>
    `;
  }

  private renderEmpty() {
    return html`
      <div class="alert alert-dark" style="font-size: 0.85rem;">
        Select a video clip on the timeline to track something in it.
      </div>
    `;
  }

  private renderTracker(element: TimelineElement) {
    const busy = this.phase === "tracking";
    const ready = this.phase === "ready" || this.phase === "done";

    return html`
      <div class="mb-2 text-secondary flex-shrink-0" style="font-size: 0.8rem;">
        ${this.phase === "loading"
          ? "Opening the clip…"
          : this.box == null
            ? "Drag a box around what you want to follow — a corner, a logo, an eye. Something with contrast."
            : `Tracking forward from ${formatMs(
                timelineMsOf(element, this.seedMs),
              )} to the end of the clip.`}
      </div>

      <!--
        The canvas is capped in height rather than simply filling the width.
        A portrait clip is twice as tall as it is wide, and at 100% width it
        pushed the Track button and every setting below the fold, so the panel
        looked like it had no controls at all. A max-height in viewport units
        keeps them on screen whatever the aspect ratio, and the pointer mapping
        is unaffected because it measures the canvas rather than assuming it.
      -->
      <div
        class="position-relative mb-3 d-flex justify-content-center align-items-center flex-grow-1"
        style="background: #111; border-radius: 4px; overflow: hidden; min-height: 8rem;"
      >
        <canvas
          id="auto-track-canvas"
          style="display: block; max-width: 100%; max-height: 100%; width: auto; height: auto; cursor: crosshair; touch-action: none;"
          @pointerdown=${this.onPointerDown}
          @pointermove=${this.onPointerMove}
          @pointerup=${this.onPointerUp}
          @pointercancel=${this.onPointerUp}
        ></canvas>
      </div>

      <div class="d-flex align-items-center gap-2 mb-3 flex-wrap flex-shrink-0">
        <button
          class="btn btn-sm btn-primary"
          ?disabled=${!ready || this.box == null}
          @click=${() => void this.track()}
        >
          ${busy ? "Tracking…" : "Track"}
        </button>
        <button
          class="btn btn-sm btn-secondary"
          ?disabled=${!busy}
          @click=${() => this.cancel()}
        >
          Cancel
        </button>
        <button
          class="btn btn-sm btn-success"
          ?disabled=${this.result == null || this.sampleCount < 2}
          @click=${() => this.createNull()}
        >
          Create null
        </button>
        ${busy || this.sampleCount > 0
          ? html`<span class="text-secondary" style="font-size: 0.8rem;">
              ${this.sampleCount} frames
            </span>`
          : ""}
      </div>

      ${busy
        ? html`<div class="progress mb-3" style="height: 4px;">
            <div
              class="progress-bar"
              style="width: ${Math.round(this.progress * 100)}%"
            ></div>
          </div>`
        : ""}
      ${this.message
        ? html`<p
            class="${this.status === "lost" || this.phase === "error"
              ? "text-warning"
              : "text-secondary"}"
            style="font-size: 0.8rem;"
          >
            ${this.message}
          </p>`
        : ""}

      <div class="row g-3 flex-shrink-0" style="font-size: 0.8rem;">
        <div class="col-4">
          <label class="form-label text-secondary"
            >Search radius — ${this.searchRadius}px</label
          >
          <input
            type="range"
            class="form-range"
            min="2"
            max="48"
            .value=${String(this.searchRadius)}
            ?disabled=${busy}
            @input=${(e: Event) => {
              this.searchRadius = Number(
                (e.target as HTMLInputElement).value,
              );
              this.paint();
            }}
          />
          <div class="text-secondary">How far it may move per frame.</div>
        </div>

        <div class="col-4">
          <label class="form-label text-secondary"
            >Smoothing — ${this.tolerance.toFixed(1)}px</label
          >
          <input
            type="range"
            class="form-range"
            min="0"
            max="4"
            step="0.1"
            .value=${String(this.tolerance)}
            ?disabled=${busy}
            @input=${(e: Event) => {
              this.tolerance = Number((e.target as HTMLInputElement).value);
            }}
          />
          <div class="text-secondary">
            How far a keyframe may be dropped from the path. 0 keeps every frame.
          </div>
        </div>

        <div class="col-4">
          <div class="form-check mt-4">
            <input
              class="form-check-input"
              type="checkbox"
              id="auto-track-adapt"
              .checked=${this.adaptTemplate}
              ?disabled=${busy}
              @change=${(e: Event) => {
                this.adaptTemplate = (e.target as HTMLInputElement).checked;
              }}
            />
            <label class="form-check-label text-secondary" for="auto-track-adapt">
              Follow appearance changes
            </label>
          </div>
          <div class="text-secondary">
            For a subject that turns. Costs accuracy: it can drift.
          </div>
        </div>
      </div>
    `;
  }
}

/**
 * Source ms back onto the timeline, for anything shown to the user.
 *
 * Clamped to the clip's span, unlike `toProjectPath`, which drops an
 * out-of-span sample instead. The difference is deliberate: a keyframe outside
 * the clip is one that never plays and must not be written, but a *label*
 * saying where the track ended is better approximately right than absent.
 */
function timelineMsOf(element: TimelineElement, sourceMs: number): number {
  const span = spanOf(element);
  const raw = timelineTimeAt(element as any, sourceMs);
  return Math.min(Math.max(raw, span.start), span.end);
}

function formatMs(ms: number): string {
  const total = Math.max(0, Math.round(ms));
  const minutes = Math.floor(total / 60_000);
  const seconds = Math.floor((total % 60_000) / 1000);
  const hundredths = Math.floor((total % 1000) / 10);
  return `${minutes}:${String(seconds).padStart(2, "0")}.${String(
    hundredths,
  ).padStart(2, "0")}`;
}

function toast(message: string): void {
  (document.querySelector("toast-box") as any)?.showToast({
    message,
    delay: "3000",
  });
}
