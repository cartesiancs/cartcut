/**
 * The viewfinder: what the person being recorded sees, and draws on.
 *
 * Two jobs. It shows the camera bubble where the finished file will put it —
 * the layout comes from the same `bubbleLayout.ts` the compositor uses, so
 * moving the bubble changes both together — and it is the drawing surface.
 *
 * The window it lives in is transparent, click-through and, critically,
 * `setContentProtection(true)`, so the compositor leaves it out of every screen
 * capture including ours. See `electron/lib/window.ts`.
 *
 * ## Drawing mode is a trap unless it carries its own exit
 *
 * Turning drawing on means `setIgnoreMouseEvents(false)` on a window that
 * covers the whole display, and from that moment **every click on the screen
 * lands here**. `pointer-events: none` does not help: it governs dispatch
 * inside the page, not whether the OS window receives the click at all. So
 * while drawing is on, the tray menu, the app being recorded, and everything
 * else are unreachable *through this window*.
 *
 * That is inherent — it is what a drawing surface is — so the exits have to be
 * inside it:
 *
 *  - a toolbar, drawn here, with a Done button;
 *  - the Escape key, which is why the window is made focusable and focused
 *    while drawing and neither before nor after;
 *  - and, in `lib/recorder.ts`, the window drops below the menu bar's level for
 *    the duration, so the tray stays clickable as a last resort.
 *
 * Any one of the three is enough. All three are cheap.
 */

import { LitElement, css, html } from "lit";
import { customElement, state } from "lit/decorators.js";
import { bubbleRect } from "@app/features/record/bubbleLayout";
import {
  simplifyStroke,
  type StrokePoint,
} from "@app/features/record/strokeRender";
import { paintStroke } from "../paintStroke";
import {
  DEFAULT_RECORD_SETTINGS,
  type BubbleCorner,
  type BubbleShape,
  type BubbleSize,
} from "@app/features/record/recordSettings";

type OverlayState = {
  drawing: boolean;
  recording: boolean;
  cameraDeviceId: string;
  bubbleSize: BubbleSize;
  bubbleCorner: BubbleCorner;
  bubbleShape: BubbleShape;
};

const INITIAL: OverlayState = {
  drawing: false,
  recording: false,
  cameraDeviceId: "",
  bubbleSize: DEFAULT_RECORD_SETTINGS.bubbleSize,
  bubbleCorner: DEFAULT_RECORD_SETTINGS.bubbleCorner,
  bubbleShape: DEFAULT_RECORD_SETTINGS.bubbleShape,
};

/** The pen colours, in the order the toolbar shows them. */
const COLORS = ["#ff2d55", "#ffd60a", "#30d158", "#0a84ff", "#ffffff"];

/** Line width as a fraction of the display's height. */
const WIDTH_N = 0.0035;

/**
 * How far a point may sit from the line through its neighbours and still be
 * dropped, normalised.
 *
 * A pointer stream is a hundred samples a second, most of them a pixel apart on
 * a straight run. Sending them all would put a few hundred points per stroke
 * through two IPC hops, thirty times a second, and the extra vertices make the
 * Catmull-Rom pass wobble — it interpolates *through* every point it is given,
 * so sampling noise becomes visible waviness.
 */
const SIMPLIFY_N = 0.0012;

type LocalStroke = {
  id: string;
  color: string;
  /** Normalised to the display, `0..1`, so the compositor can place them. */
  points: StrokePoint[];
};

@customElement("record-overlay")
export class RecordOverlay extends LitElement {
  @state() private overlay: OverlayState = INITIAL;
  @state() private color = COLORS[0];

  /** The camera this element has open, so a re-render is not a re-open. */
  private openedDeviceId = "";
  private stream: MediaStream | null = null;

  private strokes: LocalStroke[] = [];
  private active: LocalStroke | null = null;
  private paintHandle: number | null = null;
  /** Throttles the send while a stroke is being drawn. */
  private lastSent = 0;

  static styles = css`
    :host {
      display: block;
      position: fixed;
      inset: 0;
      pointer-events: none;
    }

    /* The drawing surface takes the pointer only while drawing is on. The rest
       of the time the window is click-through anyway, and this keeps the two
       from disagreeing. */
    canvas {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
    }

    :host([drawing]) canvas {
      pointer-events: auto;
      cursor: crosshair;
    }

    /* An unmistakable sign that the screen is not going to respond normally.
       Without it, drawing mode looks exactly like a frozen machine. */
    .edge {
      position: absolute;
      inset: 0;
      border: 3px solid rgba(255, 45, 85, 0.9);
      pointer-events: none;
    }

    .toolbar {
      position: absolute;
      bottom: 28px;
      left: 50%;
      transform: translateX(-50%);
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 14px;
      border-radius: 999px;
      background: rgba(22, 23, 26, 0.92);
      box-shadow: 0 10px 40px rgba(0, 0, 0, 0.45);
      pointer-events: auto;
      font: 13px/1 system-ui, -apple-system, sans-serif;
      color: #e8e9ec;
    }

    .swatch {
      width: 22px;
      height: 22px;
      border-radius: 50%;
      border: 2px solid transparent;
      cursor: pointer;
      padding: 0;
    }

    .swatch[aria-pressed="true"] {
      border-color: #ffffff;
      transform: scale(1.12);
    }

    .divider {
      width: 1px;
      height: 20px;
      background: rgba(255, 255, 255, 0.18);
    }

    button.action {
      background: rgba(255, 255, 255, 0.1);
      color: inherit;
      border: 0;
      border-radius: 999px;
      padding: 6px 12px;
      cursor: pointer;
      font: inherit;
    }

    button.action:hover {
      background: rgba(255, 255, 255, 0.2);
    }

    button.done {
      background: #ff2d55;
      color: #ffffff;
    }

    .bubble {
      position: absolute;
      overflow: hidden;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.35);
      border: 2px solid rgba(255, 255, 255, 0.85);
      box-sizing: border-box;
      pointer-events: none;
      transition:
        top 120ms ease,
        left 120ms ease,
        width 120ms ease,
        height 120ms ease;
    }

    video {
      width: 100%;
      height: 100%;
      object-fit: cover;
      /* Mirrored, matching composeWithBubble in the engine. The two have to
         agree or the take is spent looking at the wrong side of a face. */
      transform: scaleX(-1);
      display: block;
    }
  `;

  connectedCallback(): void {
    super.connectedCallback();

    (window as any).electronAPI?.res?.overlayRecord?.overlay(
      (_event: unknown, next: Partial<OverlayState>) => {
        const wasDrawing = this.overlay.drawing;
        this.overlay = { ...this.overlay, ...next };

        // Leaving drawing mode drops whatever is on screen. Keeping it would
        // leave lines the user can no longer erase, over an interface they can
        // now click again.
        if (wasDrawing && !this.overlay.drawing) {
          this.clear();
        }

        this.toggleAttribute("drawing", this.overlay.drawing);
        this.paint();
      },
    );

    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("resize", this.onResize);
  }

  disconnectedCallback(): void {
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("resize", this.onResize);
    this.stopPainting();
    this.releaseCamera();
    super.disconnectedCallback();
  }

  /** Escape leaves drawing mode. The keyboard exit; see the header. */
  private onKeyDown = (event: KeyboardEvent) => {
    if (!this.overlay.drawing) {
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      this.exitDrawing();
    } else if (event.key === "Backspace" || event.key === "Delete") {
      event.preventDefault();
      this.clear();
      this.send({ kind: "clear" });
    }
  };

  private onResize = () => this.paint();

  private send(message: unknown): void {
    void (window as any).electronAPI?.req?.overlayRecord?.stroke(message);
  }

  private exitDrawing(): void {
    this.clear();
    this.send({ kind: "clear" });
    // The engine owns the setting; asking it to turn drawing off is the same
    // path the tray checkbox takes, so the menu's tick stays truthful.
    void (window as any).electronAPI?.req?.overlayRecord?.setDrawing(false);
  }

  private clear(): void {
    this.strokes = [];
    this.active = null;
    this.paint();
  }

  // ---- drawing ------------------------------------------------------------

  private normalise(event: PointerEvent): StrokePoint {
    return {
      t: performance.now(),
      x: event.clientX / Math.max(1, window.innerWidth),
      y: event.clientY / Math.max(1, window.innerHeight),
    };
  }

  private onPointerDown = (event: PointerEvent) => {
    if (!this.overlay.drawing || event.button !== 0) {
      return;
    }

    (event.target as HTMLCanvasElement).setPointerCapture(event.pointerId);

    this.active = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      color: this.color,
      points: [this.normalise(event)],
    };
    this.strokes.push(this.active);
    this.lastSent = 0;
    this.paint();
  };

  private onPointerMove = (event: PointerEvent) => {
    if (this.active == null) {
      return;
    }

    this.active.points.push(this.normalise(event));
    this.paint();

    // ~30Hz. The stroke is re-sent whole and replaces its earlier self by id,
    // so the line grows in the recording as it is drawn — the alternative,
    // sending once on pointer-up, makes a finished line pop into the file a
    // second after it was made.
    const now = performance.now();
    if (now - this.lastSent > 33) {
      this.lastSent = now;
      this.flush(this.active);
    }
  };

  private onPointerUp = (event: PointerEvent) => {
    if (this.active == null) {
      return;
    }

    (event.target as HTMLCanvasElement).releasePointerCapture(event.pointerId);
    this.active.points = simplifyStroke(this.active.points, SIMPLIFY_N);
    this.flush(this.active);
    this.active = null;
    this.paint();
  };

  private flush(stroke: LocalStroke): void {
    this.send({
      kind: "stroke",
      stroke: {
        id: stroke.id,
        color: stroke.color,
        widthN: WIDTH_N,
        points: stroke.points.map((point) => ({ x: point.x, y: point.y })),
      },
    });
  }

  // ---- painting -----------------------------------------------------------

  private stopPainting(): void {
    if (this.paintHandle != null) {
      cancelAnimationFrame(this.paintHandle);
      this.paintHandle = null;
    }
  }

  /** Coalesced to one repaint per frame — pointermove fires far faster. */
  private paint(): void {
    if (this.paintHandle != null) {
      return;
    }

    this.paintHandle = requestAnimationFrame(() => {
      this.paintHandle = null;
      this.draw();
    });
  }

  private draw(): void {
    const canvas = this.shadowRoot?.querySelector("canvas");
    if (canvas == null) {
      return;
    }

    const dpr = window.devicePixelRatio || 1;
    const width = Math.round(window.innerWidth * dpr);
    const height = Math.round(window.innerHeight * dpr);

    // Assigning either dimension clears the canvas, so only do it when the
    // window actually changed size.
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    const ctx = canvas.getContext("2d");
    if (ctx == null) {
      return;
    }

    ctx.clearRect(0, 0, width, height);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    for (const stroke of this.strokes) {
      paintStroke(ctx, stroke.points, stroke.color, {
        width,
        height,
        widthN: WIDTH_N,
        alpha: 1,
      });
    }
  }

  // ---- camera -------------------------------------------------------------

  private releaseCamera(): void {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.openedDeviceId = "";
  }

  private async syncCamera(): Promise<void> {
    const wanted = this.overlay.cameraDeviceId;

    if (wanted === this.openedDeviceId) {
      return;
    }

    this.releaseCamera();

    if (wanted === "") {
      this.requestUpdate();
      return;
    }

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { deviceId: { exact: wanted } },
      });
      this.openedDeviceId = wanted;
    } catch (error) {
      console.warn("[record] overlay could not open the camera", error);
      this.openedDeviceId = "";
    }

    this.requestUpdate();
    await this.updateComplete;
    this.attachStream();
  }

  private attachStream(): void {
    const video = this.shadowRoot?.querySelector("video");
    if (video != null && video.srcObject !== this.stream) {
      video.srcObject = this.stream;
      void video.play().catch(() => {
        // Muted and inline, so autoplay is permitted; if a policy ever says
        // otherwise the bubble stays black rather than throwing.
      });
    }
  }

  updated(): void {
    void this.syncCamera();
    this.attachStream();
    this.paint();
  }

  private renderBubble() {
    if (this.stream == null) {
      return null;
    }

    // The overlay covers one whole display, so its own viewport *is* the frame
    // the compositor works in — which is what lets one layout function answer
    // for both, in two different pixel spaces.
    const frame = { width: window.innerWidth, height: window.innerHeight };
    const rect = bubbleRect(
      frame,
      { width: 1280, height: 720 },
      this.overlay.bubbleSize,
      this.overlay.bubbleCorner,
      this.overlay.bubbleShape,
    );

    const radius =
      this.overlay.bubbleShape === "circle"
        ? "50%"
        : `${Math.round(Math.min(rect.width, rect.height) * 0.14)}px`;

    return html`
      <div
        class="bubble"
        style="left: ${rect.x}px; top: ${rect.y}px; width: ${rect.width}px;
               height: ${rect.height}px; border-radius: ${radius};"
      >
        <video autoplay muted playsinline></video>
      </div>
    `;
  }

  private renderToolbar() {
    if (!this.overlay.drawing) {
      return null;
    }

    return html`
      <div class="edge"></div>
      <div class="toolbar">
        ${COLORS.map(
          (color) => html`
            <button
              class="swatch"
              style="background: ${color};"
              aria-pressed=${this.color === color}
              aria-label="Pen colour"
              @pointerdown=${(event: Event) => {
                event.stopPropagation();
                this.color = color;
              }}
            ></button>
          `,
        )}
        <span class="divider"></span>
        <button
          class="action"
          @pointerdown=${(event: Event) => {
            event.stopPropagation();
            this.clear();
            this.send({ kind: "clear" });
          }}
        >
          Erase
        </button>
        <button
          class="action done"
          @pointerdown=${(event: Event) => {
            event.stopPropagation();
            this.exitDrawing();
          }}
        >
          Done · Esc
        </button>
      </div>
    `;
  }

  render() {
    return html`
      <canvas
        @pointerdown=${this.onPointerDown}
        @pointermove=${this.onPointerMove}
        @pointerup=${this.onPointerUp}
        @pointercancel=${this.onPointerUp}
      ></canvas>
      ${this.renderToolbar()} ${this.renderBubble()}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "record-overlay": RecordOverlay;
  }
}
