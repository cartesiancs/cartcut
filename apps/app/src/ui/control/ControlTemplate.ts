import { LitElement, html } from "lit";
import { customElement } from "lit/decorators.js";
import "../../features/template/templateBrowser";

/**
 * The Templates tab.
 *
 * A rail slot of its own rather than a toggle inside `ControlFx`, because a
 * template is not an effect: it is content you place, like an asset, rather
 * than a treatment you apply to something already placed. Grouping it with
 * effects and LUTs would put the one panel that *adds a clip* behind a tab
 * whose other two panels change clips that are already there.
 *
 * A thin wrapper over `<template-browser>`, the shape `ControlFx` has: the
 * panel owns its own state and its own store subscriptions, and remounting it
 * would throw them away — so the pane stays mounted and hides with `d-none`,
 * which is what Bootstrap's `tab-pane` does anyway.
 */
@customElement("control-ui-template")
export class ControlUiTemplate extends LitElement {
  createRenderRoot() {
    this.setAttribute("data-keeps-selection", "");
    return this;
  }

  render() {
    return html`<template-browser></template-browser>`;
  }
}
