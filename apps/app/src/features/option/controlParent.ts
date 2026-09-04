/**
 * The parent picker — After Effects' pick-whip, as a dropdown.
 *
 * The gesture the null object was missing. `groupOps.ts#setParent` has always
 * been able to attach a clip to an existing group, but nothing in the app could
 * ask for it: the timeline's context menu offers only "Group selected" (which
 * makes a *new* group around a selection) and "Remove from group". So a null
 * created empty had no way of ever acquiring a child.
 *
 * **Folded into `default-transform`** rather than added to each panel
 * separately, which is the opposite of the call `controlBlendMode.ts` made and
 * for the opposite reason: a blend mode is meaningless on a group, so it had to
 * stay out of the control a group embeds. A parent is meaningful on *every*
 * element that has a transform at all — including a group, since nulls nest —
 * so the shared control is exactly the right place and the five panels pick it
 * up with no edit of their own.
 *
 * Single-element only, because `default-transform` is. `parentOptions.ts`
 * already answers for a whole selection (`"mixed"` and all), so a future
 * multi-select panel needs nothing new here.
 */

import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { useTimelineStore } from "../../states/timelineStore";
import { setParent } from "../timeline/groupOps";
import {
  canPickParent,
  parentChoicesFor,
  sharedParentOf,
  type ParentChoice,
  type ParentRefusal,
} from "../timeline/parentOptions";

/** Why a row is greyed out, in words, as its `title`. */
const REFUSAL_TITLE: Record<ParentRefusal, string> = {
  self: "A clip cannot be its own parent.",
  cycle: "That group is already inside this one.",
  depth: "Groups cannot nest more than 8 deep.",
};

/** The value the `<option>` for "no parent" carries. */
const NONE = "";

/**
 * One level of indent for a nested group.
 *
 * Non-breaking spaces, because HTML collapses a run of ordinary ones and an
 * `<option>` takes no markup — so plain spaces here would compute a `depth`
 * that nothing on screen ever showed.
 */
const INDENT = "  ";

@customElement("parent-select")
export class ParentSelectControl extends LitElement {
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
   * Read from the store on every render, never cached in a field.
   *
   * `controlBlendMode.ts` gives the reason and the bug that taught it. Deriving
   * here also means the picker follows an undo, a drag that re-parented
   * something, or an edit the agent made through `set_clip_parent`, without any
   * of them knowing this control exists.
   */
  private get elements() {
    return useTimelineStore.getState().timeline;
  }

  private get choices(): ParentChoice[] {
    return parentChoicesFor(this.elements, [this.elementId]);
  }

  private get held(): string {
    const shared = sharedParentOf(this.elements, [this.elementId]);
    // `"mixed"` cannot arise for one element, but a blank is the right answer
    // if it ever does — see the module header on multi-selection.
    return typeof shared === "string" && shared !== "mixed" ? shared : NONE;
  }

  render() {
    // Nothing to offer: no group exists yet, or the clip is audio, which has no
    // picture for a transform to move. Rendering an empty dropdown would be a
    // control that can only disappoint.
    if (
      this.elementId === "" ||
      !canPickParent(this.elements, [this.elementId])
    ) {
      return html``;
    }

    const choices = this.choices;
    if (choices.length === 0) {
      return html``;
    }

    return html`
      <label class="form-label text-light">Parent</label>
      <select
        class="form-select bg-dark text-light form-select-sm mb-2"
        aria-label="parent"
        aria-event="parent"
        .value=${this.held}
        @change=${this.handleChange}
      >
        <option value=${NONE}>None</option>
        ${choices.map(
          (choice) => html`<option
            value=${choice.id}
            ?disabled=${choice.disabled}
            title=${choice.reason != null ? REFUSAL_TITLE[choice.reason] : ""}
          >
            ${INDENT.repeat(choice.depth)}${choice.name}
          </option>`,
        )}
      </select>
    `;
  }

  /**
   * Apply the pick as one undo step.
   *
   * `setParent` keeps the clip where it appears at the playhead by rewriting
   * its own transform, so nothing moves on screen — which is why the cursor is
   * part of the call and not an afterthought. A pick it refuses returns the
   * document by identity and `withCheckpoint` records nothing, so a disabled
   * row that somehow got through costs the user no history entry.
   *
   * No `GestureCommit`: this is one discrete choice, not a spinner scrub.
   */
  private handleChange(event: Event) {
    const value = (event.target as HTMLSelectElement).value;
    const elementId = this.elementId;
    const cursor = useTimelineStore.getState().cursor;

    useTimelineStore
      .getState()
      .withCheckpoint((doc) =>
        setParent(doc, [elementId], value === NONE ? null : value, cursor),
      );

    this.requestUpdate();
  }
}
