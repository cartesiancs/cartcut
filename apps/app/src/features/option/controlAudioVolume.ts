/**
 * The level fader, shared by the audio and video option panels.
 *
 * One component rather than the same row inlined twice: the markup, the
 * clamping handler, the read-back and the store subscription are identical for
 * both panels, and the read-back is the fiddly half — the place two copies
 * would quietly drift apart. `default-transform` is the precedent for exactly
 * this shape.
 *
 * The note that used to be here said a level was not animatable and that this
 * control therefore needed no cursor. It is, and it does: the field shows the
 * level at the playhead through `volumeDbAt`, and a scrub with the stopwatch
 * armed writes a keyframe there rather than a static value. The rest of the
 * arrangement is unchanged.
 *
 * Still narrower than `default-transform` in one way: **no `timeline` /
 * `timelineState` props.** This reads the store directly.
 * `default-transform` reads a `timeline` its *parent* refreshes from a
 * separately-registered zustand subscriber, which works only because the parent
 * happens to have subscribed first; there is no reason to inherit that ordering
 * dependency for one number.
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
  volumeDbAt,
} from "../timeline/audio";
import { setVolumeDb } from "../timeline/audioOps";
import { addKeyframe } from "../animation/keyframeOps";
import { animatableProperties } from "../../@types/timeline";
import { projectBakeHz } from "../editor/frameRate";
import "./controlKeyframeNav";

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
        <div class="d-flex flex-row gap-2 justify-content-end">
          ${this.canAnimate()
            ? html`<control-keyframe-nav
                .elementId=${this.elementId}
                .property=${"volumeDb"}
                .label=${"level"}
              ></control-keyframe-nav>`
            : ""}
        </div>
      </div>
    `;
  }

  /**
   * Whether this clip has a level to keyframe at all.
   *
   * Asked of `animatableProperties`, which gates on audibility, so the
   * stopwatch is absent on a video whose audio has been detached at the same
   * moment the waveform and the rubber band are. Offering it there would arm a
   * track nothing reads and `normalizeAnimation` would collect on the next
   * ingress.
   */
  private canAnimate(): boolean {
    const element = useTimelineStore.getState().timeline[this.elementId];
    return element != null && animatableProperties(element).includes("volumeDb");
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
    // Read at the playhead, not off the field: with an envelope on the clip the
    // static value is only the fallback, and a field showing it while the line
    // says otherwise is a number that disagrees with what is playing.
    // `volumeDbAt` falls back to `volumeDbOf`, so a clip with no envelope shows
    // exactly what it always did, and a value clamped by the op still snaps the
    // display back on the next store change.
    dom.value = volumeDbAt(element, useTimelineStore.getState().cursor);
  }

  private handleVolume() {
    const dom: any = this.querySelector("number-input[aria-event='volume']");
    const raw = parseFloat(dom?.value);
    if (!Number.isFinite(raw)) {
      return;
    }

    const elementId = this.elementId;
    const db = clampVolumeDb(raw);
    const cursor = useTimelineStore.getState().cursor;
    // `projectBakeHz()`, not the op's 60Hz default: a baked lane is a cache
    // read by nearest sample, so one written coarser than the project's rate
    // hands consecutive frames the same value and the curve steps.
    const bakeHz = projectBakeHz();
    // One step per gesture, not per event: `number-input` dispatches `onChange`
    // on every mousemove of a scrub, and a checkpoint each would evict the
    // whole undo stack on a single drag.
    this.gesture.apply((doc) => {
      const element: any = doc.elements[elementId];
      if (element == null) {
        return doc;
      }
      // The keyframe is written **only where the track is already switched
      // on**, which is what makes this box usable as both a static control and
      // the envelope's authoring surface with no mode switch. Written before
      // the static field so `setVolumeDb` sees the document the keyframe left,
      // and the two cannot be undone apart.
      const next = element.animation?.volumeDb?.isActivate
        ? addKeyframe(
            doc,
            elementId,
            "volumeDb",
            "x",
            cursor - element.startTime,
            db,
            undefined,
            bakeHz,
          )
        : doc;
      return setVolumeDb(next, elementId, db);
    });
  }
}
