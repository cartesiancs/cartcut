/**
 * The Blend section, shared by every option panel whose clip is painted as a
 * layer.
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
 *
 * A `+` section, like LUT and Filter: a clip at Normal shows the name and the
 * `+` and nothing else, because Normal is what almost every clip is and a
 * dropdown reading "Normal" on every one of them was a control nobody needed
 * to see. `+` opens the list and writes nothing; picking a mode is the edit.
 * `×` puts Normal back and folds the section shut.
 */

import { LitElement, PropertyValues, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { BlendMode } from "../../@types/timeline";
import { useTimelineStore } from "../../states/timelineStore";
import { blendOf, coerceBlend, DEFAULT_BLEND } from "../renderer/blend";
import { setClipBlend } from "../timeline/blendOps";
import { BLEND_GROUPS } from "./blendGroups";
import { addButton, removeButton, section } from "./optionKit";

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

  /**
   * Whether `+` has opened the section on a clip still at Normal.
   *
   * Component state and never the document, for the reason
   * `controlClipSpeed.ts` gives for its ramp flag: an open section with nothing
   * picked is where the user is looking, and saving it would put a key in the
   * project for nothing. Dropped when the panel moves to another clip, or the
   * next clip would show open for no reason.
   */
  private opened = false;

  willUpdate(changed: PropertyValues<this>) {
    if (changed.has("elementId")) {
      this.opened = false;
    }
  }

  render() {
    const blend = this.blend;
    if (blend === DEFAULT_BLEND && !this.opened) {
      return section({
        title: "Blend",
        actions: addButton(
          "Blend this clip into what is beneath it",
          this.handleOpen,
          "blend_add",
        ),
      });
    }

    // The list takes the body's whole width with no label beside it: the
    // section's name already says what it picks, and the longest mode name
    // clipped at the 60% a labelled row leaves.
    return section({
      title: "Blend",
      actions: removeButton("Back to Normal", this.handleRemove, "blend_reset"),
      body: html`
        <select
          class="opt-select"
          aria-label="blend mode"
          aria-event="blend_mode"
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
      `,
    });
  }

  /**
   * Point the `<select>` at the document's mode, after the options exist.
   *
   * Not a `.value` binding, for the reason `controlClipSpeed.ts#updated` gives:
   * lit commits the property before the child part that builds the options, and
   * the list is now created fresh every time the section opens, so a clip
   * already set to Multiply would have opened reading Normal.
   */
  updated() {
    const select = this.querySelector<HTMLSelectElement>(
      "select[aria-event='blend_mode']",
    );
    if (select != null) {
      select.value = this.blend;
    }
  }

  private handleOpen = () => {
    this.opened = true;
    this.requestUpdate();
  };

  /**
   * Normal again, as one undo step, and the section shut.
   *
   * `setClipBlend` declines by identity for a clip already at Normal, so `×` on
   * a section that was only opened records nothing.
   */
  private handleRemove = () => {
    this.opened = false;
    const elementId = this.elementId;
    useTimelineStore
      .getState()
      .withCheckpoint((doc) => setClipBlend(doc, elementId, DEFAULT_BLEND));
    this.requestUpdate();
  };

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
  private handleChange = (event: Event) => {
    const blend = coerceBlend((event.target as HTMLSelectElement).value);
    if (blend == null) {
      return;
    }

    const elementId = this.elementId;
    useTimelineStore
      .getState()
      .withCheckpoint((doc) => setClipBlend(doc, elementId, blend));

    this.requestUpdate();
  };
}
