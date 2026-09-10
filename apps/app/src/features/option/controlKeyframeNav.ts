/**
 * The keyframe diamond, as every other NLE draws one.
 *
 * What it replaces was a two-state boolean: lit when
 * `animation[property].isActivate` was true, dim otherwise, and a click toggled
 * the track. That is the *stopwatch's* question. A diamond answers a different
 * one — **is there a keyframe on the frame I am looking at** — and clicking it
 * puts one there or takes it away. The sidebar had no way to do either; the
 * only route was the curve editor behind a right-click.
 *
 * Nine hand-written copies of that button existed across three files (four
 * inlined in `controlDefaultTransform`, five in the mask section, one in the
 * reveal section), which is why this is a component rather than a fourth copy.
 *
 * ## CapCut's arrangement, deliberately
 *
 * There is no separate stopwatch. One control carries all three states, and
 * `toggleKeyframe` decides which is which:
 *
 *   not armed        hollow, dim     -> arm, and plant one here
 *   armed, no key    hollow, bright  -> plant one here
 *   armed, key here  FILLED, bright  -> remove it; the last one disarms
 *
 * The filled/hollow pair comes free from the icon font: `style.scss` sets
 * `FILL 1` on every Material Symbol globally, and Material Symbols is a
 * variable font, so restating the axes with `FILL 0` gives the outline. No new
 * glyph, no SVG, and nothing fetched — the font is already bundled for offline.
 *
 * ## It reads the store rather than taking props
 *
 * `controlDefaultTransform` has `timelineCursor` prop-drilled through six
 * panels. Subscribing here instead — the mask and reveal sections' newer
 * pattern, with real teardown — is what lets one element drop into all three
 * without each host learning to feed it.
 */

import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { AnimatableProperty, TimelineElement } from "../../@types/timeline";
import { KeyframeController } from "../../controllers/keyframe";
import { useTimelineStore } from "../../states/timelineStore";
import { keyframeNavAt, type KeyframeNavState } from "../animation/keyframeNav";
import { projectFps } from "../editor/frameRate";
import { snapMsToFrame } from "../timeline/frames";

@customElement("control-keyframe-nav")
export class ControlKeyframeNav extends LitElement {
  /** The clip this acts on. A multi-selection arms its first element only. */
  @property()
  elementId = "";

  @property()
  property: AnimatableProperty = "position";

  /** Shown in the tooltip; falls back to the property's own name. */
  @property()
  label = "";

  private keyframeControl = new KeyframeController(this);
  private teardown: Array<() => void> = [];

  createRenderRoot() {
    // Every store write, because the playhead is one — the diamond has to fill
    // and empty as the cursor crosses each keyframe.
    this.teardown.push(useTimelineStore.subscribe(() => this.requestUpdate()));
    // The timeline canvas's document-level mousedown clears the selection
    // *before* this button receives its own click, so without this the op would
    // run against nothing. `controlDefaultTransform` never set it, which is why
    // folding its four buttons in here fixes them too.
    this.setAttribute("data-keeps-selection", "");
    return this;
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    for (const off of this.teardown) {
      off();
    }
    this.teardown = [];
  }

  private get element(): TimelineElement | null {
    return useTimelineStore.getState().timeline[this.elementId] ?? null;
  }

  private get nav(): KeyframeNavState {
    return keyframeNavAt(
      this.element,
      this.property,
      useTimelineStore.getState().cursor,
      projectFps(),
    );
  }

  private toggle() {
    this.keyframeControl.togglePoint({
      elementId: this.elementId,
      animationType: this.property,
      cursorMs: useTimelineStore.getState().cursor,
    });
  }

  /** Put the playhead on a neighbouring keyframe. */
  private jump(tMs: number | null) {
    const element = this.element as any;
    if (tMs == null || element == null) {
      return;
    }
    // Keyframe times are element-local; the cursor is absolute. Snapped because
    // the playhead lives on the frame grid and a keyframe need not — landing
    // between two frames would show a frame no export corresponds to.
    useTimelineStore
      .getState()
      .setCursor(snapMsToFrame(element.startTime + tMs, projectFps()));
  }

  render() {
    const nav = this.nav;
    const name = this.label || this.property;
    // Outside the clip nothing can be keyed — a keyframe there never plays —
    // so the whole control declines rather than offering a click that would.
    const dead = !nav.inSpan;
    const lit = nav.mark === "off" || dead ? "text-secondary" : "text-light";

    const step = (
      way: "prev" | "next",
      to: number | null,
      icon: string,
      title: string,
    ) => html`
      <button
        class="btn btn-xxs text-light"
        aria-event="keyframe-${way}-${this.property}"
        title=${title}
        ?disabled=${dead || to == null}
        @click=${() => this.jump(to)}
      >
        <span
          class="material-symbols-outlined icon-xsm ${to == null || dead
            ? "text-secondary"
            : "text-light"}"
        >
          ${icon}
        </span>
      </button>
    `;

    return html`
      <div class="d-flex flex-row align-items-center">
        ${step("prev", nav.prevMs, "chevron_left", `Previous ${name} keyframe`)}
        <button
          class="btn btn-xxs text-light"
          aria-event="keyframe-toggle-${this.property}"
          title=${dead
            ? `Move the playhead over the clip to key ${name}`
            : nav.mark === "on"
              ? `Remove ${name} keyframe`
              : `Add ${name} keyframe`}
          ?disabled=${dead}
          @click=${() => this.toggle()}
        >
          <span
            class="material-symbols-outlined icon-xsm ${lit} ${nav.mark === "on"
              ? ""
              : "keyframe-hollow"}"
          >
            stat_0
          </span>
        </button>
        ${step("next", nav.nextMs, "chevron_right", `Next ${name} keyframe`)}
      </div>
    `;
  }
}
