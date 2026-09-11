/**
 * Mirror, flip and reverse, in the option panel's Media tab.
 *
 * One row of toggles, shared by the video and image panels, for the reason
 * `controlBlendMode.ts` gives for being one component. Self-gating like
 * `clip-speed`: a panel may mount it for any clip, and it shows what that clip
 * can take — nothing for a type that cannot be mirrored, no Reverse for an
 * image.
 *
 * Every button calls the same function as the timeline's context menu
 * (`actions.mirrorClips`, `reverseSession.reverseClips`/`unreverseClips`), so
 * the two surfaces cannot disagree about what a click does.
 *
 * The Reverse button has three states because the operation takes time:
 * "Reverse" to start, disabled with the percentage while the tray shows it
 * running, and pressed-in "Reversed" once it has landed — which un-reverses,
 * instantly, on the next click.
 */

import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { TimelineElement } from "../../@types/timeline";
import { useTimelineStore } from "../../states/timelineStore";
import { backgroundTaskStore, taskFor } from "../../states/backgroundTaskStore";
import { isMirrorable, mirrorOf } from "../timeline/mirrorOps";
import { isReversed, isReversible } from "../timeline/reverseOps";
import { mirrorClips } from "../editor/actions";
import {
  canReverseHere,
  reverseClips,
  unreverseClips,
} from "../reverse/reverseSession";

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

  render() {
    const element = this.element;
    if (!isMirrorable(element)) {
      return html``;
    }
    const { h, v } = mirrorOf(element);
    const id = this.elementId;

    return html`
      <label class="form-label text-light">Orientation</label>
      <div class="d-flex gap-2 mb-3">
        <button
          type="button"
          class="btn btn-sm ${h ? "btn-primary" : "btn-default"} text-light flex-fill"
          aria-pressed=${h ? "true" : "false"}
          aria-event="mirror_h"
          title="Mirror the picture left to right"
          @click=${() => mirrorClips([id], "h")}
        >
          ↔ Mirror
        </button>
        <button
          type="button"
          class="btn btn-sm ${v ? "btn-primary" : "btn-default"} text-light flex-fill"
          aria-pressed=${v ? "true" : "false"}
          aria-event="mirror_v"
          title="Flip the picture top to bottom"
          @click=${() => mirrorClips([id], "v")}
        >
          ↕ Flip
        </button>
        ${element.filetype === "video" && canReverseHere()
          ? this.reverseButton(element)
          : ""}
      </div>
    `;
  }

  private reverseButton(element: TimelineElement) {
    const id = this.elementId;
    const task = taskFor("reverse", id);

    if (task != null) {
      const label =
        task.stage === "queued"
          ? "Waiting…"
          : task.fraction == null
            ? "Reversing…"
            : `Reversing ${Math.floor(task.fraction * 100)}%`;
      return html`<button
        type="button"
        class="btn btn-sm btn-default text-light flex-fill"
        aria-event="reverse"
        disabled
      >
        ${label}
      </button>`;
    }

    if (isReversed(element)) {
      return html`<button
        type="button"
        class="btn btn-sm btn-primary text-light flex-fill"
        aria-pressed="true"
        aria-event="reverse"
        title="Play forwards again"
        @click=${() => unreverseClips([id])}
      >
        ⟲ Reversed
      </button>`;
    }

    if (!isReversible(element)) {
      return "";
    }

    return html`<button
      type="button"
      class="btn btn-sm btn-default text-light flex-fill"
      aria-pressed="false"
      aria-event="reverse"
      title="Play this clip backwards"
      @click=${() => reverseClips([id])}
    >
      ⟲ Reverse
    </button>`;
  }
}
