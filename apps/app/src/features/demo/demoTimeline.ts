import { LitElement } from "lit";
import { customElement } from "lit/decorators.js";
import { getLocationEnv } from "../../functions/getLocationEnv";
import {
  linkedTemplateSlug,
  openLinkedTemplate,
} from "../template/templateLinkBrowser";

/**
 * Opens the example template the page address names
 * (`template/templateLink.ts`) in either browser build: `/?template=<slug>`.
 * Without one the timeline starts empty. Draws nothing.
 */
@customElement("demo-timeline")
export class DemoTimeline extends LitElement {
  createRenderRoot() {
    return this;
  }

  firstUpdated() {
    if (getLocationEnv() === "electron") return;
    const slug = linkedTemplateSlug();
    if (slug != null) {
      void this.openTemplate(slug);
    }
  }

  private async openTemplate(slug: string) {
    const result = await openLinkedTemplate(slug);
    if (!result.ok) {
      (document.querySelector("toast-box") as any)?.showToast({
        message: result.message,
        delay: "6000",
      });
    }
  }
}
