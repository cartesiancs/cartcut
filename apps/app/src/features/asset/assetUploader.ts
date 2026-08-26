import { LitElement, html } from "lit";
import { customElement, state } from "lit/decorators.js";
import { dropIntent } from "./dropIntent";
import { idleOverlay, reduceOverlay, type OverlayState } from "./dropOverlay";
import { atPlayhead, importDroppedFiles } from "./importDrop";

/**
 * The "Drop File" curtain, and the fallback target for OS file drops.
 *
 * It used to raise itself on every `dragenter` without looking at what was
 * being dragged, which broke both halves of drag-and-drop at once: an asset
 * dragged out of the panel raised the curtain over the timeline canvas, the
 * canvas never saw the drop it was waiting for, and the curtain then tried to
 * read the asset as an OS file and threw. Now every handler asks `dropIntent`
 * first and an asset drag passes straight through, untouched and un-prevented.
 *
 * Every listener is on `document`. Split across `document` and `this` — which
 * is how it was — the curtain could be raised by an event the element itself
 * would never see the end of, so a drag that left the window without dropping
 * left it up over a dead UI with no way to dismiss it.
 */
@customElement("asset-upload-drop")
export class AssetDropUploader extends LitElement {
  private overlay: OverlayState = idleOverlay;

  @state()
  private visible = false;

  constructor() {
    super();

    document.addEventListener("dragenter", this.handleDragEnter);
    document.addEventListener("dragover", this.handleDragOver);
    document.addEventListener("dragleave", this.handleDragLeave);
    document.addEventListener("drop", this.handleDrop);
    document.addEventListener("dragend", this.handleDragEnd);
    // A drag that leaves the window entirely stops sending events; the blur is
    // the only signal that it is over.
    window.addEventListener("blur", this.handleDragEnd);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();

    document.removeEventListener("dragenter", this.handleDragEnter);
    document.removeEventListener("dragover", this.handleDragOver);
    document.removeEventListener("dragleave", this.handleDragLeave);
    document.removeEventListener("drop", this.handleDrop);
    document.removeEventListener("dragend", this.handleDragEnd);
    window.removeEventListener("blur", this.handleDragEnd);
  }

  createRenderRoot() {
    return this;
  }

  render() {
    // A plain template reading one piece of state. The old `render` reassigned
    // `innerHTML` and toggled classes by hand, so any re-render mid-drag tore
    // down the drop target underneath the pointer.
    return html`<div
      class="asset-drop-curtain ${this.visible ? "" : "d-none"}"
      aria-hidden=${this.visible ? "false" : "true"}
    >
      <b class="text-light">Drop File</b>
    </div>`;
  }

  private apply(next: OverlayState) {
    if (next === this.overlay) {
      return;
    }
    this.overlay = next;
    this.visible = next.visible;
  }

  private handleDragEnter = (e: DragEvent) => {
    this.apply(
      reduceOverlay(this.overlay, {
        type: "enter",
        intent: dropIntent(e.dataTransfer?.types),
      }),
    );
  };

  private handleDragOver = (e: DragEvent) => {
    const intent = dropIntent(e.dataTransfer?.types);

    // An asset drag belongs to the timeline canvas. Calling `preventDefault`
    // here would claim it, and the canvas would never get the drop.
    if (intent === "asset") {
      return;
    }

    // Everything else is prevented even when the curtain stays down: the
    // default action for a file dropped on a `file://` page is to navigate to
    // it, which would replace the editor with a video player.
    e.preventDefault();

    if (e.dataTransfer && intent === "os-files") {
      e.dataTransfer.dropEffect = "copy";
    }
  };

  private handleDragLeave = () => {
    this.apply(reduceOverlay(this.overlay, { type: "leave" }));
  };

  private handleDragEnd = () => {
    this.apply(reduceOverlay(this.overlay, { type: "end" }));
  };

  private handleDrop = (e: DragEvent) => {
    const intent = dropIntent(e.dataTransfer?.types);
    this.apply(reduceOverlay(this.overlay, { type: "drop" }));

    if (intent !== "os-files") {
      return;
    }

    // The canvas is a descendant, so its own handler has already run and
    // prevented the default if it claimed the drop. Handling it again here
    // would import the same files twice, at the wrong position.
    if (e.defaultPrevented) {
      return;
    }

    e.preventDefault();
    void importDroppedFiles(e.dataTransfer, atPlayhead());
  };
}
