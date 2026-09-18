/**
 * Crop, in the option panel's Media tab.
 *
 * One row that opens the tool, a strip of aspect presets, and Apply/Cancel while
 * a session is live. Shared by the video and image panels for the reason
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
 * The icon is `crop_free` rather than `crop`, which the Mask tab already wears.
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

  private reset() {
    const id = this.elementId;
    if (refusesEdit()) {
      return;
    }
    const cursor = useTimelineStore.getState().cursor;
    const bakeHz = bakeRateFor(renderOptionStore.getState().options.fps);
    useTimelineStore
      .getState()
      .withCheckpoint((doc) => resetClipCrop(doc, id, cursor, bakeHz));
    this.requestUpdate();
  }

  render() {
    const element = this.element;
    if (!isCroppable(element)) {
      return html``;
    }

    const session = this.session;
    const cropped = isCropped(cropOf(element));

    return html`
      <label class="form-label text-light">Crop</label>
      <div class="d-flex gap-2 mb-2">
        <button
          type="button"
          class="btn btn-sm ${session != null
            ? "btn-primary"
            : "btn-default"} text-light flex-fill"
          aria-pressed=${session != null ? "true" : "false"}
          aria-event="crop"
          title="Reframe this clip to part of its source"
          @click=${() =>
            session == null ? this.start() : this.finish("Enter")}
        >
          <span class="material-symbols-outlined icon-xs">crop_free</span>
          ${session == null ? "Crop" : "Apply"}
        </button>
        ${session != null
          ? html`<button
              type="button"
              class="btn btn-sm btn-default text-light"
              aria-event="crop_cancel"
              title="Leave the crop unchanged"
              @click=${() => this.finish("Escape")}
            >
              Cancel
            </button>`
          : cropped
            ? html`<button
                type="button"
                class="btn btn-sm btn-default text-light"
                aria-event="crop_reset"
                title="Show the whole frame again"
                @click=${() => this.reset()}
              >
                Reset
              </button>`
            : ""}
      </div>
      ${session == null ? "" : this.aspectStrip(session)}
    `;
  }

  /**
   * The presets, each drawn as a box in its own proportions.
   *
   * The glyph idiom is `ui/control/ControlSetting.ts#renderResolutionPresets`'s:
   * a span scaled so its longest side is `RATIO_GLYPH_PX`, which reads as the
   * shape far faster than the label does. Free has no shape to draw, and
   * Original's is the clip's, so both fall back to their label alone.
   */
  private aspectStrip(session: any) {
    return html`
      <style>
        clip-crop .crop-aspects {
          display: flex;
          flex-wrap: wrap;
          gap: 4px;
        }
        clip-crop .crop-aspect {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: flex-end;
          gap: 3px;
          min-width: 40px;
          padding: 4px 2px;
          font-size: 10px;
          line-height: 1;
        }
        clip-crop .crop-aspect-glyph {
          display: block;
          border: 1px solid currentColor;
          border-radius: 1px;
        }
      </style>
      <div class="crop-aspects mb-3">
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
          return html`
            <button
              type="button"
              class="btn btn-xs crop-aspect ${session.aspectId === aspect.id
                ? "btn-primary"
                : "btn-default"} text-light"
              aria-pressed=${session.aspectId === aspect.id ? "true" : "false"}
              aria-event=${`crop_aspect_${aspect.id}`}
              title=${`Lock the crop to ${aspect.label}`}
              @click=${() => this.pickAspect(aspect.id)}
            >
              ${drawable
                ? html`<span
                    class="crop-aspect-glyph"
                    style=${`width:${width}px;height:${height}px;`}
                  ></span>`
                : html`<span
                    class="material-symbols-outlined"
                    style="font-size:15px;line-height:1;"
                    >${aspect.id === "free"
                      ? "open_in_full"
                      : "fit_screen"}</span
                  >`}
              <span>${aspect.label}</span>
            </button>
          `;
        })}
      </div>
      <div class="text-secondary mb-3" style="font-size: 11px;">
        ${cropChanged(session) ? "Enter to apply, Escape to cancel." : ""}
      </div>
    `;
  }
}
