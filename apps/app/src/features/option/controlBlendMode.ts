/**
 * The blend-mode dropdown, shared by every option panel whose clip is painted
 * as a layer.
 *
 * One component rather than the same `<select>` inlined into four panels, for
 * the reason `controlAudioVolume.ts` gives: the markup, the grouped option list
 * and the read-back are identical, and the read-back is the half two copies
 * would drift on.
 *
 * **Not** folded into `default-transform`, which would have been fewer edits.
 * That control is also embedded by `optionGroupElement.ts`, and a group paints
 * nothing — it exists only to hold a transform for its children. Offering a
 * blend mode there would be a control that does nothing, on the one element
 * type whose type does not even carry the field.
 */

import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { BlendMode } from "../../@types/timeline";
import { useTimelineStore } from "../../states/timelineStore";
import { blendOf, coerceBlend } from "../renderer/blend";
import { setClipBlend } from "../timeline/blendOps";
import { BLEND_GROUPS } from "./blendGroups";

@customElement("blend-mode")
export class BlendModeControl extends LitElement {
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

    return this;
  }

  /**
   * The mode this clip carries, read from the store on every render.
   *
   * Never cached in a field. `optionVideo.ts` documents what caching cost there:
   * the field held the store's own object and the handlers wrote into it in
   * place, on an object every undo entry shares. Deriving it here also means the
   * dropdown follows an undo, or an edit the agent made, without being told to.
   */
  private get blend(): BlendMode {
    return blendOf(useTimelineStore.getState().timeline[this.elementId]);
  }

  render() {
    return html`
      <label class="form-label text-light">Blend</label>
      <select
        class="form-select bg-dark text-light form-select-sm mb-3"
        aria-label="blend mode"
        aria-event="blend_mode"
        .value=${this.blend}
        @change=${this.handleChange}
      >
        ${BLEND_GROUPS.map((group) =>
          group.label === ""
            ? group.modes.map(
                (mode) =>
                  html`<option value=${mode.value}>${mode.label}</option>`,
              )
            : html`<optgroup label=${group.label}>
                ${group.modes.map(
                  (mode) =>
                    html`<option value=${mode.value}>${mode.label}</option>`,
                )}
              </optgroup>`,
        )}
      </select>
    `;
  }

  /**
   * Apply the pick as one undo step.
   *
   * No repaint call, and none should be added: `preview-canvas` subscribes to
   * the store and redraws on every change, and the compositor reads the field
   * per frame — so writing to the store *is* the repaint.
   *
   * A value the coercer rejects is dropped rather than stored. It can only come
   * from a `<select>` built out of `BLEND_GROUPS`, so it means this list and
   * `BLEND_MODES` have gone out of step, and storing it would put a mode in the
   * project file that the renderer silently ignores.
   */
  private handleChange(event: Event) {
    const blend = coerceBlend((event.target as HTMLSelectElement).value);
    if (blend == null) {
      return;
    }

    const elementId = this.elementId;
    useTimelineStore
      .getState()
      .withCheckpoint((doc) => setClipBlend(doc, elementId, blend));

    this.requestUpdate();
  }
}
