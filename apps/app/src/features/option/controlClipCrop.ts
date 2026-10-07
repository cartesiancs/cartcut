/**
 * Crop, in the option panel's Media tab.
 *
 * A `+` section, like Blend, Speed and Orientation, with one difference: `+`
 * starts the crop tool itself rather than opening an empty card, because a crop
 * is aimed on the canvas and there is nothing to pick here first. While the
 * tool is running the body holds the aspect presets and Apply/Cancel; on a clip
 * that is already cropped it holds Edit. `×` cancels a running crop and puts
 * the whole frame back, so after it the clip is uncropped and the section is
 * shut, whichever state it was in.
 *
 * Whether the section is open is read entirely from the clip and the canvas
 * (cropped, or a session on this clip), with no flag of its own: Cancel on a
 * clip that was never cropped therefore folds it shut again, which is what
 * nothing having been added should look like.
 *
 * Shared by the video and image panels for the reason
 * `controlClipOrientation.ts` gives for being one component, and self-gating the
 * same way: a panel may mount it for any clip and it renders nothing for a type
 * that cannot be cropped.
 *
 * **The canvas owns the session, this only asks.** `beginCrop` returns false for
 * a clip it will not open on, and the store's `cursorType` is only set once it
 * has said yes, so the two cannot disagree about whether a crop is in progress.
 * That is `optionMaskSection.ts#startPen`'s arrangement, and it is here for its
 * reason: the flag and the session are two pieces of state, and the one that can
 * refuse has to move first.
 *
 * Edit's icon is `crop_free` rather than `crop`, which the Mask tab already
 * wears.
 */

import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { useTimelineStore } from "../../states/timelineStore";
import { renderOptionStore } from "../../states/renderOptionStore";
import { bakeRateFor } from "../animation/keyframes";
import { refusesEdit } from "../editor/timelineLock";
import {
  cropOf,
  isCropped,
  isCroppable,
  resetClipCrop,
} from "../timeline/cropOps";
import { CROP_ASPECTS, ratioOf } from "../crop/aspects";
import { cropChanged, cropKey, cropSetAspect } from "../crop/cropSession";
import { addButton, removeButton, section, textButton } from "./optionKit";

/** The longest side of a preset's glyph, in CSS pixels. */
const RATIO_GLYPH_PX = 16;

@customElement("clip-crop")
export class ClipCropControl extends LitElement {
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
    // The timeline canvas clears the selection on any mousedown outside itself,
    // which fires before the `click` this control acts on.
    this.setAttribute("data-keeps-selection", "");
    return this;
  }

  /** Read from the store on every render; see `optionVideo.ts` on caching. */
  private get element() {
    return useTimelineStore.getState().timeline[this.elementId];
  }

  private get canvas(): any {
    return document.querySelector("preview-canvas");
  }

  /** The live session, but only when it belongs to the clip this panel shows. */
  private get session() {
    const session = this.canvas?.activeCropSession ?? null;
    return session != null && session.elementId === this.elementId
      ? session
      : null;
  }

  private start() {
    if (this.canvas?.beginCrop?.(this.elementId) === true) {
      useTimelineStore.getState().setCursorType("crop");
    }
    this.requestUpdate();
  }

  private finish(code: "Enter" | "Escape") {
    const session = this.session;
    if (session == null) {
      return;
    }
    this.canvas?.applyCrop?.(cropKey(session, code));
    this.requestUpdate();
  }

  private pickAspect(id: string) {
    const session = this.session;
    if (session == null) {
      return;
    }
    this.canvas?.applyCrop?.(cropSetAspect(session, id));
    this.requestUpdate();
  }

  /**
   * No crop, whatever state the section was in: a running session is
   * cancelled, then the whole frame is put back as one undo step.
   * `resetClipCrop` declines by identity on a clip that was never cropped, so
   * `×` pressed to abandon a first crop records nothing.
   */
  private handleRemove = () => {
    if (this.session != null) {
      this.canvas?.applyCrop?.({ kind: "cancel" });
    }
    const id = this.elementId;
    if (refusesEdit()) {
      this.requestUpdate();
      return;
    }
    const cursor = useTimelineStore.getState().cursor;
    const bakeHz = bakeRateFor(renderOptionStore.getState().options.fps);
    useTimelineStore
      .getState()
      .withCheckpoint((doc) => resetClipCrop(doc, id, cursor, bakeHz));
    this.requestUpdate();
  };

  render() {
    const element = this.element;
    if (!isCroppable(element)) {
      return html``;
    }

    const session = this.session;
    const cropped = isCropped(cropOf(element));

    if (session == null && !cropped) {
      return section({
        title: "Crop",
        actions: addButton(
          "Reframe this clip to part of its source",
          () => this.start(),
          "crop",
        ),
      });
    }

    return section({
      title: "Crop",
      actions: removeButton(
        "Show the whole frame again",
        this.handleRemove,
        "crop_reset",
      ),
      body:
        session != null
          ? this.editing(session)
          : html`<div class="opt-actions">
              ${textButton({
                icon: "crop_free",
                label: "Edit",
                title: "Change which part of the source this clip shows",
                event: "crop_edit",
                onClick: () => this.start(),
              })}
            </div>`,
    });
  }

  /** The body while the tool is running: the presets, then how to finish. */
  private editing(session: any) {
    return html`
      <div class="opt-field">${this.aspectGrid(session)}</div>
      <div class="opt-field">
        <div class="opt-actions">
          ${textButton({
            label: "Cancel",
            title: "Leave the crop unchanged",
            event: "crop_cancel",
            onClick: () => this.finish("Escape"),
          })}
          ${textButton({
            label: "Apply",
            title: "Keep this crop",
            primary: true,
            event: "crop_apply",
            onClick: () => this.finish("Enter"),
          })}
        </div>
      </div>
      ${cropChanged(session)
        ? html`<div class="opt-hint" style="margin-top: 8px;">
            <span class="material-symbols-outlined opt-hint-icon">keyboard</span>
            Enter to apply, Escape to cancel.
          </div>`
        : ""}
    `;
  }

  /**
   * The presets, each drawn as a box in its own proportions.
   *
   * The glyph idiom is `ui/control/ControlSetting.ts#renderResolutionPresets`'s:
   * a span scaled so its longest side is `RATIO_GLYPH_PX`, which reads as the
   * shape far faster than the label does. Free has no shape to draw, and
   * Original's is the clip's, so both take a glyph instead.
   *
   * Tiles from the option kit. A label longer than a ratio's four characters
   * takes two cells, so "Original" reads whole in the stock column and fills
   * the first row beside Free.
   */
  private aspectGrid(session: any) {
    return html`
      <div class="opt-tiles" role="group" aria-label="Crop aspect">
        ${CROP_ASPECTS.map((aspect) => {
          const ratio = ratioOf(aspect, session.frame);
          const drawable = aspect.ratio !== null && aspect.ratio !== "frame";
          const width =
            !drawable || ratio == null || ratio < 1
              ? RATIO_GLYPH_PX * (ratio ?? 1)
              : RATIO_GLYPH_PX;
          const height =
            !drawable || ratio == null || ratio < 1
              ? RATIO_GLYPH_PX
              : RATIO_GLYPH_PX / ratio;
          const on = session.aspectId === aspect.id;
          return html`
            <button
              type="button"
              class="opt-tile ${on ? "is-on" : ""} ${aspect.label.length > 4
                ? "opt-tile-wide"
                : ""}"
              aria-pressed=${on ? "true" : "false"}
              aria-event=${`crop_aspect_${aspect.id}`}
              title=${`Lock the crop to ${aspect.label}`}
              @click=${() => this.pickAspect(aspect.id)}
            >
              ${drawable
                ? html`<span
                    class="opt-tile-shape"
                    style=${`width:${width}px;height:${height}px;`}
                  ></span>`
                : html`<span class="material-symbols-outlined"
                    >${aspect.id === "free" ? "open_in_full" : "fit_screen"}</span
                  >`}
              <span class="opt-tile-label">${aspect.label}</span>
            </button>
          `;
        })}
      </div>
    `;
  }
}
