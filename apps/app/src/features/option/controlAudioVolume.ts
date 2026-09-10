/**
 * The level fader, shared by the audio and video option panels.
 *
 * One component rather than the same row inlined twice: the markup, the
 * clamping handler, the read-back and the store subscription are identical for
 * both panels, and the read-back is the fiddly half — the place two copies
 * would quietly drift apart. `default-transform` is the precedent for exactly
 * this shape.
 *
 * Deliberately narrower than `default-transform`, in two ways:
 *
 *   - **No `timelineCursor`.** A level is not animatable — `canAnimate`
 *     excludes audio and `animatableProperties` returns `[]` for it — so there
 *     is no cursor-dependent sampling to do. Not taking the cursor is what
 *     keeps someone from reaching for `sampleTrack` here later.
 *   - **No `timeline` / `timelineState` props.** This reads the store directly.
 *     `default-transform` reads a `timeline` its *parent* refreshes from a
 *     separately-registered zustand subscriber, which works only because the
 *     parent happens to have subscribed first; there is no reason to inherit
 *     that ordering dependency for one number.
 */

import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { useTimelineStore } from "../../states/timelineStore";
import { LocaleController } from "../../controllers/locale";
import { GestureCommit } from "./gestureCommit";
import {
  MAX_VOLUME_DB,
  MIN_VOLUME_DB,
  clampVolumeDb,
  volumeDbOf,
} from "../timeline/audio";
import { setVolumeDb } from "../timeline/audioOps";

@customElement("audio-volume")
export class AudioVolume extends LitElement {
  private lc = new LocaleController(this);
  /** Coalesces a fader scrub into a single undo step. */
  private gesture = new GestureCommit();

  @property()
  elementId = "";

  @property()
  isShow = false;

  createRenderRoot() {
    // Light DOM. The Bootstrap classes below come from a global stylesheet,
    // which does not cross a shadow boundary — rendering into a shadow root
    // would upgrade `<number-input>` fine and leave the row unstyled, a bug
    // that looks like a CSS problem.
    useTimelineStore.subscribe(() => {
      if (this.isShow) {
        this.updateValue();
      }
    });

    // A fader drag abandoned with Escape. The bounds above are the same ones
    // `clampVolumeDb` enforces, bound from its own constants so the two cannot
    // drift: the field stops where the op would have stopped it, which is what
    // keeps the number from disagreeing with the store mid-drag.
    this.addEventListener("onCancel", () => this.gesture.cancel());

    return this;
  }

  render() {
    return html`
      <label class="form-label text-light">${this.lc.t("setting.volume")}</label>
      <div class="d-flex flex-row justify-content-between bd-highlight mb-2">
        <div
          class="d-flex flex-row gap-2 justify-content-start align-items-center"
        >
          <number-input
            aria-event="volume"
            @onChange=${this.handleVolume}
            value="0"
            .min=${MIN_VOLUME_DB}
            .max=${MAX_VOLUME_DB}
            sensitivity="0.15"
          ></number-input>
          <span class="text-secondary" style="font-size: 12px;">dB</span>
        </div>
        <div class="d-flex flex-row gap-2 justify-content-end"></div>
      </div>
    `;
  }

  /**
   * Seed the field when the panel opens or the selection changes.
   *
   * The store subscription above only fires on an *edit*, so without this a
   * freshly opened panel would show the `value="0"` attribute default rather
   * than the clip's own level — the gap `default-transform` has today, where
   * `optionImage.setElementId`'s `updateValue()` call sits commented out.
   */
  updated(changed: Map<string, unknown>) {
    if ((changed.has("elementId") || changed.has("isShow")) && this.isShow) {
      this.updateValue();
    }
  }

  updateValue() {
    const dom: any = this.querySelector("number-input[aria-event='volume']");
    if (dom == null) {
      return;
    }
    const element = useTimelineStore.getState().timeline[this.elementId];
    if (element == null) {
      return;
    }
    // Reading through the resolver, so a clip with no `volumeDb` shows 0.00
    // rather than NaN — and so a value clamped by the op snaps the display
    // back to the floor on the next store change.
    dom.value = volumeDbOf(element);
  }

  private handleVolume() {
    const dom: any = this.querySelector("number-input[aria-event='volume']");
    const raw = parseFloat(dom?.value);
    if (!Number.isFinite(raw)) {
      return;
    }

    const elementId = this.elementId;
    const db = clampVolumeDb(raw);
    // One step per gesture, not per event: `number-input` dispatches `onChange`
    // on every mousemove of a scrub, and a checkpoint each would evict the
    // whole undo stack on a single drag.
    this.gesture.apply((doc) => setVolumeDb(doc, elementId, db));
  }
}
