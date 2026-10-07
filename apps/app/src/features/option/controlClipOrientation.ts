/**
 * Mirror, flip and reverse, in the option panel's Media tab.
 *
 * One section, shared by the video and image panels, for the reason
 * `controlBlendMode.ts` gives for being one component. Self-gating like
 * `clip-speed`: a panel may mount it for any clip, and it shows what that clip
 * can take: nothing for a type that cannot be mirrored, no Reverse for an
 * image.
 *
 * A `+` section, like Blend and Speed. A clip the right way round and playing
 * forwards shows the name and the `+`; the toggles appear once it is pressed,
 * or whenever one of them is on. `×` turns all three off as one undo
 * step (`timeline/orientationOps.ts`) and cancels a reversal still running, so
 * after it the clip is exactly as it was imported.
 *
 * The mirrors call the same function as the timeline's context menu
 * (`actions.mirrorClips`, `reverseSession.reverseClips`/`unreverseClips`), so
 * the two surfaces cannot disagree about what a click does.
 *
 * Two rows in the body. The mirrors share one segmented row, as Bold and
 * Italic do in the text panel: two independent switches, either or both on.
 * Reverse has a row to itself, for two reasons: it is about time rather than
 * the picture, and it takes minutes, so it has to report "Reversing 45%" in
 * words. A third tile beside the mirrors was tried and measured: at the stock
 * 148px column it wrapped to a row of its own anyway, half the width.
 *
 * The Reverse row has four states because the operation takes time: offered,
 * waiting in the queue, running with its percentage, and pressed in once it
 * has landed, which un-reverses, instantly, on the next click.
 */

import { LitElement, PropertyValues, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { TimelineElement } from "../../@types/timeline";
import { useTimelineStore } from "../../states/timelineStore";
import {
  backgroundTaskStore,
  taskFor,
  type BackgroundTask,
} from "../../states/backgroundTaskStore";
import { isMirrorable, mirrorOf } from "../timeline/mirrorOps";
import { isReversed, isReversible } from "../timeline/reverseOps";
import {
  isReoriented,
  resetClipOrientation,
} from "../timeline/orientationOps";
import { mirrorClips } from "../editor/actions";
import { refusesEdit } from "../editor/timelineLock";
import {
  canReverseHere,
  reverseClips,
  unreverseClips,
} from "../reverse/reverseSession";
import { addButton, removeButton, section } from "./optionKit";

@customElement("clip-orientation")
export class ClipOrientationControl extends LitElement {
  @property()
  elementId = "";

  @property()
  isShow = false;

  createRenderRoot() {
    // Light DOM: the Bootstrap classes below come from a global stylesheet.
    useTimelineStore.subscribe(() => {
      if (this.isShow) {
        this.requestUpdate();
      }
    });
    // The Reverse button's percentage and its return to enabled both come from
    // the tray's store, not the document.
    backgroundTaskStore.subscribe(() => {
      if (this.isShow) {
        this.requestUpdate();
      }
    });

    // The timeline canvas clears the selection on any mousedown outside itself,
    // which fires before the `click` this control acts on.
    this.setAttribute("data-keeps-selection", "");

    return this;
  }

  /** Read from the store on every render; see `optionVideo.ts` on caching. */
  private get element() {
    return useTimelineStore.getState().timeline[this.elementId];
  }

  /**
   * Whether `+` has opened the section on a clip with nothing set. Component
   * state, for the reason `controlBlendMode.ts` gives for its own.
   */
  private opened = false;

  willUpdate(changed: PropertyValues<this>) {
    if (changed.has("elementId")) {
      this.opened = false;
    }
  }

  /** The reversal running or queued for this clip, if any. */
  private get task(): BackgroundTask | undefined {
    return taskFor("reverse", this.elementId);
  }

  render() {
    const element = this.element;
    if (!isMirrorable(element)) {
      return html``;
    }

    // A reversal in flight counts as set: folding the section while the
    // percentage is still climbing would hide the one place it is reported.
    if (!isReoriented(element) && this.task == null && !this.opened) {
      return section({
        title: "Orientation",
        actions: addButton(
          "Mirror, flip or reverse this clip",
          this.handleOpen,
          "orientation_add",
        ),
      });
    }

    const { h, v } = mirrorOf(element);
    const id = this.elementId;

    return section({
      title: "Orientation",
      actions: removeButton(
        "Back to the original orientation",
        this.handleRemove,
        "orientation_reset",
      ),
      body: html`
        <div class="opt-field">
          <div class="opt-seg" role="group" aria-label="Mirror">
            <button
              type="button"
              class="opt-seg-item ${h ? "is-on" : ""}"
              aria-pressed=${h ? "true" : "false"}
              aria-event="mirror_h"
              title="Mirror the picture left to right"
              @click=${() => mirrorClips([id], "h")}
            >
              <span class="material-symbols-outlined">swap_horiz</span>
              Mirror
            </button>
            <button
              type="button"
              class="opt-seg-item ${v ? "is-on" : ""}"
              aria-pressed=${v ? "true" : "false"}
              aria-event="mirror_v"
              title="Flip the picture top to bottom"
              @click=${() => mirrorClips([id], "v")}
            >
              <span class="material-symbols-outlined">swap_vert</span>
              Flip
            </button>
          </div>
        </div>
        ${element.filetype === "video" && canReverseHere()
          ? this.reverseRow(element)
          : ""}
      `,
    });
  }

  /**
   * Reverse, as the body's second row: one full-width cell.
   *
   * While the file is being made the cell is disabled but drawn at full
   * strength, since the progress is the thing worth reading. A clip that cannot
   * be reversed (no valid trim) gets no row rather than one that does nothing.
   */
  private reverseRow(element: TimelineElement) {
    const id = this.elementId;
    const task = this.task;

    let cell;
    if (task != null) {
      const queued = task.stage === "queued";
      const label = queued
        ? "Waiting"
        : task.fraction == null
          ? "Reversing"
          : `Reversing ${Math.floor(task.fraction * 100)}%`;
      cell = html`<button
        type="button"
        class="opt-seg-item is-busy"
        aria-event="reverse"
        title=${label}
        disabled
      >
        <span class="material-symbols-outlined"
          >${queued ? "hourglass_empty" : "fast_rewind"}</span
        >
        ${label}
      </button>`;
    } else if (isReversed(element)) {
      cell = html`<button
        type="button"
        class="opt-seg-item is-on"
        aria-pressed="true"
        aria-event="reverse"
        title="Play forwards again"
        @click=${() => unreverseClips([id])}
      >
        <span class="material-symbols-outlined">fast_rewind</span>
        Reversed
      </button>`;
    } else if (isReversible(element)) {
      cell = html`<button
        type="button"
        class="opt-seg-item"
        aria-pressed="false"
        aria-event="reverse"
        title="Play this clip backwards"
        @click=${() => reverseClips([id])}
      >
        <span class="material-symbols-outlined">fast_rewind</span>
        Reverse
      </button>`;
    } else {
      return "";
    }

    return html`<div class="opt-field">
      <div class="opt-seg" role="group" aria-label="Playback direction">
        ${cell}
      </div>
    </div>`;
  }

  private handleOpen = () => {
    this.opened = true;
    this.requestUpdate();
  };

  /**
   * Everything off, and the section shut.
   *
   * A reversal still being made is cancelled first, or it would land a minute
   * later and turn the section back on by itself. The tray's own cancel is the
   * same call. Then one undo step for whatever was set, which
   * `resetClipOrientation` declines by identity when nothing was.
   */
  private handleRemove = () => {
    this.opened = false;
    const id = this.elementId;
    this.task?.cancel?.();
    if (!refusesEdit()) {
      useTimelineStore
        .getState()
        .withCheckpoint((doc) => resetClipOrientation(doc, id));
    }
    this.requestUpdate();
  };
}
