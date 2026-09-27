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
import { iconButton, section, textButton } from "./optionKit";

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

    // The two mirrors sit in the head, as the mask's invert and pen do: they
    // are instant acts on the whole clip rather than values to set. Reverse
    // does not join them, because it is the one here that takes minutes and has
    // to report progress in words.
    return section({
      title: "Orientation",
      actions: html`
        ${iconButton({
          icon: "swap_horiz",
          title: "Mirror the picture left to right",
          on: h,
          event: "mirror_h",
          onClick: () => mirrorClips([id], "h"),
        })}
        ${iconButton({
          icon: "swap_vert",
          title: "Flip the picture top to bottom",
          on: v,
          event: "mirror_v",
          onClick: () => mirrorClips([id], "v"),
        })}
      `,
      body:
        element.filetype === "video" && canReverseHere()
          ? this.reverseButton(element)
          : undefined,
    });
  }

  /**
   * Reverse, as the section's one body row.
   *
   * Four states in one button, which is why it is a word rather than a glyph:
   * queued, running with a percentage, already reversed, and offered. The
   * running one is the reason this is not an icon in the head beside the
   * mirrors, where there is no room for "Reversing 45%".
   */
  private reverseButton(element: TimelineElement) {
    const id = this.elementId;
    const task = taskFor("reverse", id);

    if (task != null) {
      const label =
        task.stage === "queued"
          ? "Waiting"
          : task.fraction == null
            ? "Reversing"
            : `Reversing ${Math.floor(task.fraction * 100)}%`;
      return html`<div class="opt-row">
        <span class="opt-label">${label}</span>
      </div>`;
    }

    if (isReversed(element)) {
      return html`<div class="opt-seg" role="group" aria-label="Playback direction">
        <button
          type="button"
          class="opt-seg-item is-on"
          aria-pressed="true"
          aria-event="reverse"
          title="Play forwards again"
          @click=${() => unreverseClips([id])}
        >
          <span class="material-symbols-outlined">fast_rewind</span>
          Reversed
        </button>
      </div>`;
    }

    if (!isReversible(element)) {
      return undefined;
    }

    return html`<div class="opt-row">
      ${textButton({
        label: "Reverse",
        title: "Play this clip backwards",
        event: "reverse",
        onClick: () => reverseClips([id]),
      })}
    </div>`;
  }
}
