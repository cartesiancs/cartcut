/**
 * The speed ramp's graph, in the video and audio option panels.
 *
 * A thin shell: every rule lives in `features/speed/curveGraph.ts`, which is
 * node-tested, and every write goes through `speedOps.ts#setClipSpeedCurve`.
 * What is left here is a canvas, four pointer handlers and the preset row.
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
 *
 * ## The toggle arms the section; it does not write a ramp
 *
 * A clip that carries a ramp reads as on, and on top of that the panel holds a
 * local flag the switch writes. Flipping it on shows the graph as the flat line
 * the clip is already playing and stores **nothing**: `coerceSpeedCurve` answers
 * `null` for a flat curve, so `setClipSpeedCurve` declines and the clip neither
 * resizes nor ripples its lane until a point actually moves. A toggle that
 * seeded a real ramp would change how the clip plays as the price of looking at
 * it.
 *
 * The flag is deliberately not a field on the element. It would be UI state in
 * the project file, and an armed-but-flat ramp would save a key for nothing,
 * against the rule that a feature nobody has used saves byte-identically. What
 * it costs is that arming does not survive selecting away and back, which is
 * the right trade: if there is a ramp, the document says so; if there is not,
 * there is nothing to remember. `timelineLockStore` is ephemeral on the same
 * argument.
 *
 * Switching it **off** removes the ramp and leaves `speed` at the mean it was
 * running, so the clip keeps its length and its neighbours do not move. No
 * confirm: the graph above it showed what was there, and undo is one keystroke.
 */

import { LitElement, PropertyValues, html } from "lit";
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
  isRampArmed,
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
 * Unique per instance, for the switch's `id` and its label's `for`.
 *
 * Keyed on the element id was the first try and is wrong: both option panels
 * mount this control, so two of them can hold the same clip id at once and the
 * label would point at whichever input the document happened to reach first.
 */
let nextControlId = 0;

@customElement("clip-speed-curve")
export class ClipSpeedCurveControl extends LitElement {
  private lc = new LocaleController(this);
  private gesture = new GestureCommit({ idleMs: null });
  /** Index of the point being dragged, or null. */
  private dragging: number | null = null;
  /**
   * Whether the panel is holding the section open for a clip with no ramp.
   *
   * Reset when the control is pointed at a different clip, or selecting a plain
   * clip after a ramped one would show it armed for no reason.
   */
  private locallyArmed = false;
  private readonly controlId = `speed-ramp-${++nextControlId}`;

  @property()
  elementId = "";

  @property()
  isShow = false;

  createRenderRoot() {
    // Light DOM: the Bootstrap classes below come from a global stylesheet,
    // which does not cross a shadow boundary.
    useTimelineStore.subscribe(() => {
      if (this.isShow) {
        this.requestUpdate();
      }
    });

    // The timeline canvas clears the selection on any mousedown outside itself,
    // and it fires before this one.
    this.setAttribute("data-keeps-selection", "");
    // A custom element with no styles is `display: inline`, where height does
    // nothing and `getBoundingClientRect` answers a zero-high box with no error
    // anywhere. The canvas inside would then be measured at 0 and draw nothing.
    this.style.display = "block";

    return this;
  }

  willUpdate(changed: PropertyValues<this>) {
    if (changed.has("elementId")) {
      this.locallyArmed = false;
    }
  }

  private get element() {
    return useTimelineStore.getState().timeline[this.elementId];
  }

  /** Whether the graph is showing. */
  private get armed(): boolean {
    return isRampArmed(speedCurveOf(this.element) != null, this.locallyArmed);
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
    const element = this.element;
    // Self-gating, like `option-lut-section`: a panel may mount this without
    // knowing whether the clip has a rate, and an image simply shows nothing.
    if (!isSpeedAdjustable(element)) {
      return html``;
    }

    const armed = this.armed;

    return html`
      <div class="form-check form-switch form-switch-row mb-2">
        <label class="form-check-label text-light" for=${this.controlId}>
          ${this.lc.t("setting.speed_ramp")}
        </label>

        <input
          class="form-check-input"
          type="checkbox"
          role="switch"
          id=${this.controlId}
          aria-event="speed_ramp_toggle"
          .checked=${armed}
          @change=${this.handleToggle}
        />
      </div>
      ${armed ? this.graph() : ``}
    `;
  }

  /** The graph and its presets, rendered only while the section is armed. */
  private graph() {
    return html`
      <canvas
        class="w-100 mb-1"
        style="height: ${PLOT_HEIGHT}px; border-radius: 4px; cursor: crosshair;"
        aria-label="speed ramp"
        aria-event="speed_curve"
        @pointerdown=${this.handlePointerDown}
        @pointermove=${this.handlePointerMove}
        @pointerup=${this.handlePointerUp}
        @dblclick=${this.handleDoubleClick}
        @contextmenu=${this.handleContextMenu}
      ></canvas>
      <!--
        A select rather than a row of buttons, measured rather than guessed:
        the option column is 148px wide, and seven small buttons wrap to seven
        rows and 257px of it, pushing every control below the ramp off the
        fold. One row, and the same argument the speed control makes directly
        above: a discrete pick is one change and one undo step.

        No backticks in here. A backtick inside an html comment ends the
        template literal, and the errors land on the lines after it.
      -->
      <select
        class="form-select bg-dark text-light form-select-sm mb-3"
        aria-label="speed ramp preset"
        aria-event="speed_curve_preset"
        @change=${this.handlePreset}
      >
        <option value="">${this.lc.t("setting.speed_ramp_preset")}</option>
        ${SPEED_CURVE_PRESETS.map(
          (preset) =>
            html`<option value=${preset.id}>
              ${this.lc.t(preset.label)}
            </option>`,
        )}
      </select>
    `;
  }

  /**
   * Arm the section, or take the ramp off.
   *
   * On writes nothing. Off removes the ramp through the same op the "Constant"
   * preset uses, which leaves `speed` at the mean the ramp was running so the
   * clip keeps its length and its neighbours stay put.
   */
  private handleToggle = (event: Event) => {
    const on = (event.currentTarget as HTMLInputElement).checked;
    if (!on) {
      this.commit(null);
    }
    // After the commit, not before: `commit` re-renders, and the handlers above
    // arm on every edit, so setting it first would have the section switch
    // itself straight back on.
    this.locallyArmed = on;
    this.requestUpdate();
  };

  updated() {
    // The switch, imperatively, for the reason `clip-speed` writes its own
    // `select.value` in `updated`. `?checked` was the first try and it is an
    // *attribute* binding: once a real click has set an input's dirty flag the
    // browser stops applying the attribute, so selecting a plain clip after a
    // ramped one left the switch reading on over a hidden graph. `.checked` is
    // a property binding and does not have that problem; this second write
    // covers a render where the bound value did not change but the DOM did.
    const toggle = this.querySelector<HTMLInputElement>(
      "input[aria-event='speed_ramp_toggle']",
    );
    if (toggle != null) {
      const armed = this.armed;
      if (toggle.checked !== armed) {
        toggle.checked = armed;
      }
    }

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

  // Every handler is an arrow property. `optionVideo.ts` renders this component
  // directly, but `<app-window>` renders the panel, and lit binds a listener's
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
    // Every edit arms locally, including one on a clip that already has a ramp.
    // Dragging a ramp back to flat deletes the curve, and without this the
    // section would be reading `armed` off the document alone and would close
    // under the pointer halfway through the gesture.
    this.locallyArmed = true;
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
    this.locallyArmed = true;
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
    this.locallyArmed = true;
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
    this.locallyArmed = true;
    const select = event.currentTarget as HTMLSelectElement;
    const preset = SPEED_CURVE_PRESETS.find(
      (entry) => entry.id === select.value,
    );
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
