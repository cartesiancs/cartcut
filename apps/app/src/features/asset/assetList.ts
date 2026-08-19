import { path } from "../../functions/path";
import mime from "../../functions/mime";
import { LitElement, PropertyValues, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { getLocationEnv } from "../../functions/getLocationEnv";
import { AssetShowType } from "../../states/assetStore";
import { AssetEntry, joinPath } from "./directoryEntries";
import { thumbnailCache } from "./thumbnailCache";

/**
 * The grid. Presentation only — `<asset-browser>` owns the directory and hands
 * the entries down, so nothing here fetches, sorts, or reaches into the DOM.
 */
@customElement("asset-list")
export class AssetList extends LitElement {
  @property({ attribute: false })
  entries: AssetEntry[] = [];

  @property()
  directory = "";

  @property()
  showType: AssetShowType = "grid";

  createRenderRoot() {
    return this;
  }

  render() {
    return html`<div class="row px-2">
      ${repeat(
        this.entries,
        (entry) => entry.name,
        (entry) =>
          entry.isDirectory
            ? html`<asset-folder
                .name=${entry.name}
                .directory=${this.directory}
                .showType=${this.showType}
              ></asset-folder>`
            : html`<asset-file
                .name=${entry.name}
                .directory=${this.directory}
                .showType=${this.showType}
              ></asset-file>`,
      )}
    </div> `;
  }
}

/**
 * Layout for one item. Both `asset-file` and `asset-folder` swap between a
 * three-across grid cell and a full-width row.
 */
function applyShowType(element: HTMLElement, showType: AssetShowType) {
  if (showType == "grid") {
    element.classList.remove("col-12", "flex-row");
    element.classList.add("col-4", "flex-column");
  } else {
    element.classList.remove("col-4", "flex-column");
    element.classList.add("col-12", "flex-row");
  }
}

@customElement("asset-file")
export class AssetFile extends LitElement {
  videoBlob: string;

  constructor() {
    super();

    this.classList.add(
      "col-4",
      "d-flex",
      "flex-column",
      "bd-highlight",
      "overflow-hidden",
      "mt-1",
      "asset",
    );

    this.addEventListener("click", this.handleClick.bind(this));

    // Dragging an asset onto the timeline lets the user choose the track and
    // the moment. Clicking still works and drops it at the playhead.
    this.setAttribute("draggable", "true");
    this.addEventListener("dragstart", this.handleDragStart.bind(this));

    this.videoBlob = "";
  }

  @property()
  name = "";

  @property()
  directory = "";

  @property()
  showType: AssetShowType = "grid";

  createRenderRoot() {
    return this;
  }

  protected updated(_changedProperties: PropertyValues): void {
    applyShowType(this, this.showType);
  }

  private get fullPath(): string {
    return joinPath(this.directory, this.name);
  }

  private get fileUrl(): string {
    const filepath =
      getLocationEnv() == "electron"
        ? `file://${this.fullPath}`
        : `/api/file?path=${this.fullPath}`;

    return path.encode(filepath);
  }

  render() {
    const fileType = mime.lookup(this.name).type;
    const fileUrl = this.fileUrl;

    if (fileType == "image" || fileType == "gif") {
      return this.templateImage(fileUrl);
    }

    if (fileType == "video") {
      const cached = thumbnailCache.get(fileUrl);
      if (cached != undefined) {
        this.videoBlob = cached;
      } else {
        this.captureVideoThumbnail(fileUrl);
      }
      return this.templateVideoThumbnail();
    }

    return this.template(fileType);
  }

  template(filetype = "unknown") {
    const fileIcon = {
      video: "video_file",
      audio: "audio_file",
      unknown: "draft",
    };
    return html`<span
        class="material-symbols-outlined icon-lg align-self-center"
      >
        ${fileIcon[filetype] ?? fileIcon.unknown}
      </span>
      <b class="align-self-center text-ellipsis-scroll text-light text-center"
        >${this.name}</b
      >`;
  }

  templateImage(url) {
    return html`<img
        src="${url}"
        alt=""
        class="align-self-center asset-preview"
      />
      <b class="align-self-center text-ellipsis-scroll text-light text-center"
        >${this.name}</b
      >`;
  }

  templateVideoThumbnail() {
    return html` <div class="position-relative align-self-center">
        <img
          src="${this.videoBlob}"
          alt=""
          class="align-self-center asset-preview w-100"
        />
        <span class="material-symbols-outlined position-absolute icon-center ">
          play_arrow
        </span>
      </div>

      <b class="align-self-center text-ellipsis-scroll text-light text-center"
        >${this.name}</b
      >`;
  }

  handleDragStart(e: DragEvent) {
    if (!e.dataTransfer) {
      return;
    }
    // A custom type so the timeline can tell an asset from an OS file drop,
    // which `asset-upload-drop` already handles differently.
    e.dataTransfer.setData("application/x-cartcut-asset", this.fullPath);
    e.dataTransfer.effectAllowed = "copy";
  }

  handleClick() {
    this.dispatchEvent(
      new CustomEvent("asset-open", {
        detail: { path: this.fullPath },
        bubbles: true,
        composed: true,
      }),
    );
  }

  async captureVideoThumbnail(url) {
    const fileUrl = this.fileUrl;

    try {
      const thumbnailUrl = await new Promise((resolve, reject) => {
        fetch(`${url}`)
          .then((res) => {
            return res.blob();
          })
          .then((blob) => {
            const blobUrl = URL.createObjectURL(blob);
            const videoElement = document.createElement("video");

            videoElement.src = blobUrl;
            videoElement.preload = "metadata";

            videoElement.onloadedmetadata = async () => {
              const thumbnailCanvas = document.createElement("canvas");

              videoElement.addEventListener("seeked", () => {
                let width = videoElement.videoWidth;
                let height = videoElement.videoHeight;
                thumbnailCanvas.width = width;
                thumbnailCanvas.height = height;

                let ctx = thumbnailCanvas.getContext("2d");
                if (!ctx) return false;
                ctx.drawImage(
                  videoElement,
                  0,
                  0,
                  thumbnailCanvas.width,
                  thumbnailCanvas.height,
                );

                thumbnailCanvas.toBlob((blob: any) => {
                  try {
                    const newImg = document.createElement("img");
                    const url = URL.createObjectURL(blob);

                    newImg.onload = () => {
                      URL.revokeObjectURL(url);
                    };

                    this.videoBlob = url;
                    this.requestUpdate();
                    thumbnailCache.set(fileUrl, url);
                    resolve(url);
                  } catch (error) {}
                });
              });

              videoElement.currentTime = 1;
            };
          });
      });

      return thumbnailUrl;
    } catch (error) {}
  }
}

@customElement("asset-folder")
export class AssetFolder extends LitElement {
  constructor() {
    super();

    this.classList.add(
      "col-4",
      "d-flex",
      "flex-column",
      "bd-highlight",
      "overflow-hidden",
      "mt-1",
      "asset",
    );

    this.addEventListener("click", this.handleClick.bind(this));
  }

  @property()
  name = "";

  @property()
  directory = "";

  @property()
  showType: AssetShowType = "grid";

  createRenderRoot() {
    return this;
  }

  protected updated(_changedProperties: PropertyValues): void {
    applyShowType(this, this.showType);
  }

  render() {
    return html`<span
        class="material-symbols-outlined icon-lg align-self-center"
      >
        folder
      </span>
      <b class="align-self-center text-ellipsis text-light text-center"
        >${this.name}</b
      >`;
  }

  handleClick() {
    this.dispatchEvent(
      new CustomEvent("asset-navigate", {
        detail: { name: this.name },
        bubbles: true,
        composed: true,
      }),
    );
  }
}
