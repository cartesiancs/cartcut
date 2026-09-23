/**
 * Extension sections in the option column, under the app's own panels.
 *
 * Which sections show is decided by the **selected clip's type**, which is
 * the one thing the app knows and the extension does not: `option-group`
 * already resolves a panel by prefixing `option-` onto a filetype, and this
 * follows the same idea from the data rather than from a list somebody keeps.
 *
 * What a section *shows* is entirely the extension's business. It is handed no
 * element id and no selection. An extension that needs to know what is
 * selected subscribes to `selection.onDidChange` and tells its own page,
 * which it can already do; passing the id through the URL would reload the
 * page on every click in the timeline and lose whatever the user had typed
 * into it.
 *
 * Reads the stores itself so the seam in `Control.ts` is one tag with no
 * properties, and so a selection change does not have to re-render the whole
 * editor tree to reach here.
 */

import { LitElement, html } from "lit";
import { customElement, state } from "lit/decorators.js";

import { selectionStore } from "../../states/selectionStore";
import { useTimelineStore } from "../../states/timelineStore";
import { contributionStore, inspectorViews } from "./contributions";
import { viewContent } from "./views";

@customElement("ext-inspector-sections")
export class ExtInspectorSections extends LitElement {
  createRenderRoot() {
    contributionStore.subscribe(() => this.requestUpdate());

    selectionStore.subscribe((selection) => {
      const next = selection.ids.length === 1 ? selection.ids[0] : null;
      if (next !== this.elementId) {
        this.elementId = next;
      }
    });

    return this;
  }

  /**
   * The single selected clip, or null.
   *
   * Sections are offered for one clip at a time. With several selected there
   * is no one type to resolve, and an extension's section that appeared for a
   * mixed selection would be talking about something the user cannot see.
   */
  @state()
  private elementId: string | null =
    selectionStore.getState().ids.length === 1 ? selectionStore.getState().ids[0] : null;

  private filetype(): string | null {
    if (this.elementId == null) {
      return null;
    }
    const element = useTimelineStore.getState().timeline[this.elementId] as
      | { filetype?: string }
      | undefined;
    return typeof element?.filetype === "string" ? element.filetype : null;
  }

  render() {
    const type = this.filetype();
    if (type == null) {
      return html``;
    }

    const sections = inspectorViews(contributionStore.getState(), type);
    if (sections.length === 0) {
      // Nothing at all rather than an empty container. The column's empty
      // state is a sibling of this, and a zero-height box between them would
      // push it off centre.
      return html``;
    }

    return html`${sections.map(
      (view) => html`
        <div class="p-2 border-top border-secondary">
          <b class="text-light" style="font-size: 0.8rem">${view.title}</b>
          <div style="height: 14rem" class="mt-1">${viewContent(view)}</div>
        </div>
      `,
    )}`;
  }
}
