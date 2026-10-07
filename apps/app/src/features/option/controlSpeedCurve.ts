/**
 * The speed ramp's graph, inside the Speed section.
 *
 * A thin shell: every rule lives in `features/speed/curveGraph.ts`, which is
 * node-tested, and every write goes through `speedOps.ts#setClipSpeedCurve`.
 * What is left here is a canvas, four pointer handlers and the preset row.
 *
 * **Mounted by `clip-speed`, never by a panel.** It used to be a section of its
 * own under Speed, with an eye that armed it. The two edit one property and
 * picking a rate above flattened whatever was drawn below, so they are now one
 * section: `controlClipSpeed.ts` owns the Constant/Ramp switch and the arming
 * rule, and renders this element only while Ramp is chosen. So there is no
 * section, no toggle and no armed flag in here any more; being mounted is being
 * armed.
 *
 * **The x axis is source time**, which is what makes direct manipulation
 * possible at all. Editing a ramp changes how long the clip is, so a graph
 * drawn against timeline time would resize under the pointer on the frame the
 * drag committed and the position being dragged would name a different instant
 * each repaint. `curveGraph.ts` says the same at more length.
 *
 * The ramp is also drawn over the clip in the timeline (`speedBand.ts`), and
 * that copy is **draw-only** for the same reason: `layout.ts#hitTest` never
 * offers it, so no press can land on a band whose clip is about to resize.
 */

import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { useTimelineStore } from "../../states/timelineStore";
import { LocaleController } from "../../controllers/locale";
import { applySurface, surfaceSpec } from "../timeline/canvasSurface";
import { GestureCommit } from "./gestureCommit";
import { isSpeedAdjustable, setClipSpeedCurve } from "../timeline/speedOps";
import {
  speedAtSource,
  speedCurveOf,
  type SpeedPoint,
} from "../timeline/speedCurve";
import {
  SPEED_CURVE_PRESETS,
  hitTest,
  insertPoint,
  movePoint,
  removePoint,
  seedCurveFor,
  speedToFraction,
  toCurve,
  toScreen,
  viewportFor,
  type GraphViewport,
} from "../speed/curveGraph";

/** Plot height in CSS px. Tall enough that a doubling is a visible distance. */
const PLOT_HEIGHT = 120;
/** Room for the rate labels down the left. */
const PAD_LEFT = 26;
const PAD = 8;

const COLORS = {
  background: "#0b0c0e",
  gridline: "rgba(255, 255, 255, 0.07)",
  unity: "rgba(255, 255, 255, 0.18)",
  outsideWindow: "rgba(0, 0, 0, 0.45)",
  curve: "#4ea1ff",
  point: "#ffffff",
  label: "rgba(255, 255, 255, 0.45)",
};

/** The rates that get a gridline and a label. */
const TICKS = [0.25, 0.5, 1, 2, 4];

/**
 * The presets the list offers. Constant is left out: it is the other half of
 * the section's own switch, one row up, and a second "Constant" in this list
 * would be the same word doing the same thing in two places.
 */
const RAMP_PRESETS = SPEED_CURVE_PRESETS.filter(
  (preset) => preset.id !== "constant",
);

@customElement("clip-speed-curve")
export class ClipSpeedCurveControl extends LitElement {
  private lc = new LocaleController(this);
  private gesture = new GestureCommit({ idleMs: null });
  /** Index of the point being dragged, or null. */
  private dragging: number | null = null;
  private teardown: Array<() => void> = [];

  @property()
  elementId = "";

  @property()
  isShow = false;

  createRenderRoot() {
    // Light DOM: the Bootstrap classes below come from a global stylesheet,
    // which does not cross a shadow boundary.
    this.teardown.push(
      useTimelineStore.subscribe(() => {
        if (this.isShow) {
          this.requestUpdate();
        }
      }),
    );

    // The timeline canvas clears the selection on any mousedown outside itself,
    // and it fires before this one.
    this.setAttribute("data-keeps-selection", "");
    // A custom element with no styles is `display: inline`, where height does
    // nothing and `getBoundingClientRect` answers a zero-high box with no error
    // anywhere. The canvas inside would then be measured at 0 and draw nothing.
    this.style.display = "block";

    return this;
  }

  /**
   * Unsubscribed on the way out, which the panel-mounted version never needed:
   * this element now comes and goes every time the Speed section switches
   * between Constant and Ramp, and each one left behind would keep repainting
   * a canvas nobody can see.
   */
  disconnectedCallback() {
    super.disconnectedCallback();
    for (const off of this.teardown) {
      off();
    }
    this.teardown = [];
  }

  private get element() {
    return useTimelineStore.getState().timeline[this.elementId];
  }

  /** The ramp as stored, or the flat pair a first edit starts from. */
  private get points(): SpeedPoint[] {
    const element = this.element as any;
    const stored = element?.speedCurve as SpeedPoint[] | undefined;
    if (stored != null && stored.length >= 2) {
      return stored.map((point) => ({ t: point.t, v: point.v }));
    }
    return (
      seedCurveFor(
        element?.trim?.startTime ?? 0,
        element?.trim?.endTime ?? 0,
        element?.speed,
      ) ?? []
    );
  }

  private viewportOf(canvas: HTMLCanvasElement): GraphViewport | null {
    const element = this.element as any;
    const rect = canvas.getBoundingClientRect();
    return viewportFor(
      element?.trim?.startTime ?? 0,
      element?.trim?.endTime ?? 0,
      {
        x: PAD_LEFT,
        y: PAD,
        w: Math.max(1, rect.width - PAD_LEFT - PAD),
        h: Math.max(1, rect.height - PAD * 2),
      },
    );
  }

  render() {
    // Self-gating, like `option-lut-section`, though `clip-speed` only mounts
    // it for a clip that has a rate.
    if (!isSpeedAdjustable(this.element)) {
      return html``;
    }
    return html`
      <canvas
        class="w-100"
        style="height: ${PLOT_HEIGHT}px; border-radius: 7px; cursor: crosshair;
               display: block; margin-bottom: 8px;"
        aria-label="speed ramp"
        aria-event="speed_curve"
        @pointerdown=${this.handlePointerDown}
        @pointermove=${this.handlePointerMove}
        @pointerup=${this.handlePointerUp}
        @dblclick=${this.handleDoubleClick}
        @contextmenu=${this.handleContextMenu}
      ></canvas>
      <div class="opt-hint" style="margin-bottom: 12px;">
        <span class="material-symbols-outlined opt-hint-icon">mouse</span>
        ${this.lc.t("setting.speed_ramp_add")}
      </div>
      <!--
        A select rather than a row of buttons, measured rather than guessed:
        the option column is 148px wide, and seven small buttons wrap to seven
        rows and 257px of it, pushing every control below the ramp off the
        fold. One row, and the same argument the speed control makes for its
        rates: a discrete pick is one change and one undo step.

        No backticks in here. A backtick inside an html comment ends the
        template literal, and the errors land on the lines after it.
      -->
      <select
        class="opt-select"
        aria-label="speed ramp preset"
        aria-event="speed_curve_preset"
        @change=${this.handlePreset}
      >
        <option value="">${this.lc.t("setting.speed_ramp_preset")}</option>
        ${RAMP_PRESETS.map(
          (preset) =>
            html`<option value=${preset.id}>
              ${this.lc.t(preset.label)}
            </option>`,
        )}
      </select>
    `;
  }

  updated() {
    // The preset select is a verb and holds no state, so it is re-pointed at
    // its own label on every render rather than at anything in the document.
    const select = this.querySelector<HTMLSelectElement>(
      "select[aria-event='speed_curve_preset']",
    );
    if (select != null) {
      select.value = "";
    }
    this.draw();
  }

  // Every handler is an arrow property. `clip-speed` renders this component,
  // `<app-window>` renders the panel around both, and lit binds a listener's
  // `this` to the host that rendered the template rather than to the component
  // the method is written on. A method here would silently be somebody else's.
  private handlePointerDown = (event: PointerEvent) => {
    const canvas = event.currentTarget as HTMLCanvasElement;
    const view = this.viewportOf(canvas);
    if (view == null) {
      return;
    }
    const { x, y } = this.local(canvas, event);
    const index = hitTest(view, this.points, x, y);
    if (index == null) {
      return;
    }
    this.dragging = index;
    canvas.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  private handlePointerMove = (event: PointerEvent) => {
    if (this.dragging == null) {
      return;
    }
    const canvas = event.currentTarget as HTMLCanvasElement;
    const view = this.viewportOf(canvas);
    if (view == null) {
      return;
    }
    const { x, y } = this.local(canvas, event);
    // Absolute, never a delta: re-applying the same list moves nothing, which
    // is what lets `GestureCommit` fold the whole drag into one undo step and
    // makes the ripple's increments telescope to the right total.
    const next = movePoint(this.points, this.dragging, toCurve(view, x, y));
    this.write(next);
  };

  private handlePointerUp = (event: PointerEvent) => {
    if (this.dragging == null) {
      return;
    }
    this.dragging = null;
    (event.currentTarget as HTMLCanvasElement).releasePointerCapture(
      event.pointerId,
    );
    this.gesture.flush();
  };

  private handleDoubleClick = (event: MouseEvent) => {
    const canvas = event.currentTarget as HTMLCanvasElement;
    const view = this.viewportOf(canvas);
    if (view == null) {
      return;
    }
    const { x, y } = this.local(canvas, event);
    const added = insertPoint(this.points, toCurve(view, x, y));
    if (added == null) {
      return;
    }
    this.commit(added);
  };

  private handleContextMenu = (event: MouseEvent) => {
    event.preventDefault();
    const canvas = event.currentTarget as HTMLCanvasElement;
    const view = this.viewportOf(canvas);
    if (view == null) {
      return;
    }
    const { x, y } = this.local(canvas, event);
    const index = hitTest(view, this.points, x, y);
    if (index == null) {
      return;
    }
    this.commit(removePoint(this.points, index));
  };

  private handlePreset = (event: Event) => {
    const select = event.currentTarget as HTMLSelectElement;
    const preset = RAMP_PRESETS.find((entry) => entry.id === select.value);
    // Snapped back to the label immediately: this is a verb, not a setting, and
    // a select left showing "Slow middle" would claim the ramp is still that
    // shape after the user had dragged a point.
    select.value = "";
    const element = this.element as any;
    if (preset == null || element?.trim == null) {
      return;
    }
    this.commit(preset.build(element.trim.startTime, element.trim.endTime));
  };

  private local(canvas: HTMLCanvasElement, event: MouseEvent) {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  /** One step of a drag: previews, records nothing. */
  private write(points: SpeedPoint[] | null): void {
    const elementId = this.elementId;
    this.gesture.apply((doc) =>
      setClipSpeedCurve(doc, elementId, points, { ripple: true }),
    );
  }

  /** A discrete edit: one undo step, no gesture. */
  private commit(points: SpeedPoint[] | null): void {
    const elementId = this.elementId;
    useTimelineStore
      .getState()
      .withCheckpoint((doc) =>
        setClipSpeedCurve(doc, elementId, points, { ripple: true }),
      );
    this.requestUpdate();
  }

  private draw(): void {
    const canvas = this.querySelector<HTMLCanvasElement>(
      "canvas[aria-event='speed_curve']",
    );
    const element = this.element as any;
    if (canvas == null || !isSpeedAdjustable(element)) {
      return;
    }
    const ctx = canvas.getContext("2d");
    const view = this.viewportOf(canvas);
    if (ctx == null || view == null) {
      return;
    }

    const rect = canvas.getBoundingClientRect();
    applySurface(
      canvas,
      ctx,
      surfaceSpec(rect.width, rect.height, window.devicePixelRatio),
    );

    ctx.fillStyle = COLORS.background;
    ctx.fillRect(0, 0, rect.width, rect.height);

    ctx.font = "9px sans-serif";
    ctx.textBaseline = "middle";
    for (const rate of TICKS) {
      const y = view.y + speedToFraction(rate) * view.h;
      ctx.strokeStyle = rate === 1 ? COLORS.unity : COLORS.gridline;
      ctx.beginPath();
      ctx.moveTo(view.x, y);
      ctx.lineTo(view.x + view.w, y);
      ctx.stroke();
      ctx.fillStyle = COLORS.label;
      ctx.fillText(`${rate}x`, 2, y);
    }

    // The margin either side is dimmed, so "outside this clip" reads without a
    // second axis: a point out there still belongs to the ramp and is still
    // draggable, it is simply not being played.
    const left = toScreen(view, { t: element.trim.startTime, v: 1 }).x;
    const right = toScreen(view, { t: element.trim.endTime, v: 1 }).x;
    ctx.fillStyle = COLORS.outsideWindow;
    ctx.fillRect(view.x, view.y, Math.max(0, left - view.x), view.h);
    ctx.fillRect(right, view.y, Math.max(0, view.x + view.w - right), view.h);

    // Sampled through `speedAtSource`, the same function the renderer reaches
    // for through `speedAt`, rather than drawn as a polyline between the
    // points. The two agree while the curve is piecewise linear, and the moment
    // an authored shape stops being a straight line between two points this is
    // the copy that is right.
    const points = this.points;
    const curve = speedCurveOf(element);
    const flat = element.speed > 0 ? element.speed : 1;
    ctx.strokeStyle = COLORS.curve;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    const columns = Math.max(2, Math.round(view.w));
    for (let i = 0; i <= columns; i++) {
      const x = view.x + (i / columns) * view.w;
      const sourceMs = view.fromMs + (i / columns) * (view.toMs - view.fromMs);
      const rate = curve == null ? flat : speedAtSource(curve, sourceMs);
      const y = view.y + speedToFraction(rate) * view.h;
      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();

    ctx.fillStyle = COLORS.point;
    for (const point of points) {
      const at = toScreen(view, point);
      ctx.beginPath();
      ctx.arc(at.x, at.y, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}
