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
import { iconButton, section, textButton } from "./optionKit";

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

    // Entering the crop is a mode, so the head carries what to do about that
    // mode and nothing else: start it, or finish it two ways. The aspect
    // presets are the body, and only exist while the mode is running.
    return section({
      title: "Crop",
      actions:
        session != null
          ? html`
              ${textButton({
                label: "Apply",
                title: "Keep this crop",
                event: "crop",
                onClick: () => this.finish("Enter"),
              })}
              ${textButton({
                label: "Cancel",
                title: "Leave the crop unchanged",
                event: "crop_cancel",
                onClick: () => this.finish("Escape"),
              })}
            `
          : html`
              ${cropped
                ? textButton({
                    label: "Reset",
                    title: "Show the whole frame again",
                    event: "crop_reset",
                    onClick: () => this.reset(),
                  })
                : ""}
              ${iconButton({
                icon: "crop_free",
                title: "Reframe this clip to part of its source",
                on: cropped,
                event: "crop",
                onClick: () => this.start(),
              })}
            `,
      body: session == null ? undefined : this.aspectStrip(session),
    });
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
        /*
          A cell of its own shape rather than a segmented-control cell: the
          glyph is a box in the aspect's own proportions, so the row cannot be
          the equal shares .opt-seg divides itself into.

          No backticks in here. This sits inside a lit html template literal,
          and one would end the template.
        */
        clip-crop .crop-aspect {
          appearance: none;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: flex-end;
          gap: 3px;
          min-width: 40px;
          padding: 5px 4px;
          border: 1px solid rgba(255, 255, 255, 0.07);
          border-radius: 7px;
          background-color: #16191c;
          color: #7f878f;
          font-size: 10px;
          line-height: 1;
          cursor: pointer;
          transition:
            background-color 140ms ease-out,
            color 140ms ease-out;
        }
        clip-crop .crop-aspect:hover {
          background-color: #1f2327;
          color: #c3c9cf;
        }
        clip-crop .crop-aspect.is-on {
          background-color: #2a3036;
          color: #f1f3f5;
        }
        clip-crop .crop-aspect-glyph {
          display: block;
          border: 1px solid currentColor;
          border-radius: 1px;
        }
      </style>
      <div class="crop-aspects">
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
              class="crop-aspect ${session.aspectId === aspect.id
                ? "is-on"
                : ""}"
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
      ${cropChanged(session)
        ? html`<div class="opt-hint" style="margin-top: 12px;">
            <span class="material-symbols-outlined opt-hint-icon">keyboard</span>
            Enter to apply, Escape to cancel.
          </div>`
        : ""}
    `;
  }
}
