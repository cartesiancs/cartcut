import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";

@customElement("control-ui-extension")
export class ControlExtension extends LitElement {
  createRenderRoot() {
    return this;
  }

  /**
   * Open an extension folder.
   *
   * Reads the picked directory directly. It used to go via the `#projectFolder`
   * input in the settings panel — which has been removed, and which it was
   * misusing anyway: it read the input's `.value` into a string and then
   * assigned `.value` *on that string*, so `dir` was always `"undefined"` and
   * the picked folder was discarded.
   */
  extTest() {
    window.electronAPI.req.dialog.openDirectory().then((result) => {
      window.electronAPI.req.extension.openDir(String(result || "/"));
    });
  }

  ext() {
    window.electronAPI.req.dialog.openFile().then((result) => {
      window.electronAPI.req.extension.openFile(result);
    });
  }

  render() {
    return html` <button
        class="btn btn-sm btn-default text-light mt-1"
        @click=${this.extTest}
      >
        Load Ext Folder (dev)
        <span class="material-symbols-outlined icon-xs"> developer_mode </span>
      </button>

      <button class="btn btn-sm btn-default text-light mt-1" @click=${this.ext}>
        Load Ext
      </button>
      <br />

      <div id="extension_webview" class="mt-2">
        <!-- <webview src="https://nugget.studio/"></webview> -->
      </div>`;
  }
}
