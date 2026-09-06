import { path } from "../../functions/path";
import mime from "../../functions/mime";
import { LitElement, PropertyValues, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { getLocationEnv } from "../../functions/getLocationEnv";
import { AssetShowType } from "../../states/assetStore";
import { AssetEntry, joinPath } from "./directoryEntries";
import { thumbnailCache } from "./thumbnailCache";
import { ASSET_MIME } from "./dropIntent";
import { DRAG } from "../timeline/dragMachine";
import {
  idlePress,
  reducePress,
  type PressEv,
  type PressState,
} from "./assetPress";
import {
  HOVER,
  idleHover,
  reduceHover,
  type HoverEv,
  type HoverState,
} from "./assetHover";
import {
  hoverPreview,
  type HoverPreviewSource,
} from "./hoverPreviewOverlay";

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

  /**
   * Click or drag, decided by `assetPress.ts`.
   *
   * `draggable` stays off until the hold completes. Left on permanently — which
   * is how this started — the panel cannot be scrolled by dragging it, and
   * every slightly imprecise click becomes a drag.
   */
  private press: PressState = idlePress;
  private holdTimer = 0;

  /** Resting on the tile, decided by `assetHover.ts`. */
  private hover: HoverState = idleHover;
  private dwellTimer = 0;
  private watchingWindow = false;

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

    this.addEventListener("pointerdown", this.handlePointerDown);
    this.addEventListener("pointermove", this.handlePointerMove);
    this.addEventListener("pointerup", this.handlePointerUp);
    this.addEventListener("pointercancel", this.handleGestureEnd);
    this.addEventListener("dragstart", this.handleDragStart);
    this.addEventListener("dragend", this.handleGestureEnd);
    // Neither bubbles, so they go on the tile itself rather than on the grid.
    this.addEventListener("pointerenter", this.handlePointerEnter);
    this.addEventListener("pointerleave", this.handlePointerLeave);

    this.videoBlob = "";
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.clearHold();

    // `repeat` keys on `entry.name`, so reloading the directory replaces these
    // elements without any `pointerleave` reaching the one under the cursor.
    // This is the only thing that stops a preview outliving its tile.
    this.dispatchHover({ type: "cancel" });
    this.clearDwell();
    this.unwatchWindow();
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

    // `<asset-list>`'s `repeat` keys on `entry.name` alone, so navigating to a
    // folder holding a file of the same name *reuses this element* — new
    // `name`/`directory`, no `disconnectedCallback`. A preview open at that
    // moment would go on playing the previous folder's file.
    if (
      _changedProperties.has("name") ||
      _changedProperties.has("directory")
    ) {
      this.dispatchHover({ type: "cancel" });
    }
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
        this.videoBlob = cached.url;
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

  // ------------------------------------------------------------ press gesture

  private dispatch(ev: PressEv) {
    const { state, effects } = reducePress(this.press, ev);
    this.press = state;

    for (const effect of effects) {
      switch (effect.type) {
        case "arm":
          this.setAttribute("draggable", "true");
          break;
        case "disarm":
          this.clearHold();
          this.removeAttribute("draggable");
          break;
        case "open":
          this.clearHold();
          this.handleOpen();
          break;
      }
    }
  }

  private clearHold() {
    if (this.holdTimer !== 0) {
      window.clearTimeout(this.holdTimer);
      this.holdTimer = 0;
    }
  }

  private handlePointerDown = (e: PointerEvent) => {
    // Above the button guard on purpose. A right-click opens the context menu,
    // and a preview left standing would cover it.
    this.dispatchHover({ type: "press" });

    // Only the primary button picks things up; right-click is the context menu
    // and the middle button is a paste on some platforms.
    if (e.button !== 0) {
      return;
    }

    // A press that ended somewhere else — released off the tile, so no
    // `pointerup` ever arrived here — can leave the attribute set even though
    // the reducer is back to idle. `dragstart` still refuses the drag, but the
    // browser would begin one and visibly cancel it. Every press starts clean.
    this.removeAttribute("draggable");

    this.dispatch({ type: "down", x: e.clientX, y: e.clientY, t: e.timeStamp });

    // The hold has to be able to complete with the pointer perfectly still, so
    // it cannot wait on a move event.
    this.clearHold();
    this.holdTimer = window.setTimeout(() => {
      this.holdTimer = 0;
      this.dispatch({ type: "tick", t: e.timeStamp + DRAG.LONG_PRESS_MS });
    }, DRAG.LONG_PRESS_MS);
  };

  private handlePointerMove = (e: PointerEvent) => {
    this.dispatch({ type: "move", x: e.clientX, y: e.clientY, t: e.timeStamp });

    if (e.pointerType === "mouse" && this.previewKind != null) {
      this.dispatchHover({
        type: "move",
        x: e.clientX,
        y: e.clientY,
        t: e.timeStamp,
      });
    }
  };

  private handlePointerUp = (e: PointerEvent) => {
    this.dispatch({ type: "up", t: e.timeStamp });
  };

  private handleGestureEnd = () => {
    this.dispatch({ type: "cancel" });
    this.dispatchHover({ type: "cancel" });
  };

  private handleDragStart = (e: DragEvent) => {
    this.dispatchHover({ type: "cancel" });

    // The gate. `draggable` is only set once the hold completes, but Chromium
    // can still begin a drag on the same frame the attribute lands, so refusing
    // here is what actually guarantees a short press never drags.
    this.dispatch({ type: "dragstart" });

    if (this.press.phase !== "dragging" || !e.dataTransfer) {
      e.preventDefault();
      return;
    }

    // A custom type so the timeline can tell an asset from an OS file drop,
    // which `asset-upload-drop` handles differently.
    e.dataTransfer.setData(ASSET_MIME, this.fullPath);
    e.dataTransfer.effectAllowed = "copy";

    // The tile's own thumbnail as the ghost, rather than the whole grid cell
    // with its label and padding.
    const preview = this.querySelector("img");
    if (preview instanceof HTMLImageElement && preview.complete) {
      e.dataTransfer.setDragImage(
        preview,
        preview.width / 2,
        preview.height / 2,
      );
    }
  };

  private handleOpen() {
    this.dispatchEvent(
      new CustomEvent("asset-open", {
        detail: { path: this.fullPath },
        bubbles: true,
        composed: true,
      }),
    );
  }

  // ----------------------------------------------------------- hover preview

  /**
   * What this tile would show, or `null` if it would show nothing.
   *
   * Asked before any timer is armed, so an audio or unrecognised file costs
   * nothing at all. A waveform would be a real feature with its own scope, and
   * a muted `<video>` for an mp3 is a black rectangle.
   */
  private get previewKind(): HoverPreviewSource["kind"] | null {
    const type = mime.lookup(this.name).type;
    if (type == "video" || type == "image" || type == "gif") {
      return type;
    }
    return null;
  }

  private handlePointerEnter = (e: PointerEvent) => {
    // A tap is not a hover, and this is the whole reason these are pointer
    // events rather than mouse events: `mouseenter` is synthesised for touch.
    if (e.pointerType !== "mouse" || this.previewKind == null) {
      return;
    }

    this.dispatchHover({
      type: "enter",
      x: e.clientX,
      y: e.clientY,
      t: e.timeStamp,
    });
  };

  private handlePointerLeave = () => {
    this.dispatchHover({ type: "leave" });
  };

  private handleWindowCancel = () => {
    this.dispatchHover({ type: "cancel" });
  };

  private dispatchHover(ev: HoverEv) {
    const previous = this.hover;
    const { state, effects } = reduceHover(previous, ev);
    this.hover = state;

    for (const effect of effects) {
      switch (effect.type) {
        case "open":
          this.openPreview(effect.x, effect.y);
          break;
        case "move":
          hoverPreview.move(this, effect.x, effect.y);
          break;
        case "close":
          hoverPreview.close(this);
          break;
      }
    }

    this.armDwell(previous);

    if (state.phase === "idle") {
      this.unwatchWindow();
    } else {
      this.watchWindow();
    }
  }

  /**
   * Arm the clock whenever the dwell *starts over*, not whenever it is running.
   *
   * A fresh `enter` moves `enterT` forward, and a timer left from the previous
   * one would fire early — the reducer would refuse it on its own clock check
   * and nothing would be left to open the preview.
   */
  private armDwell(previous: HoverState) {
    if (this.hover.phase !== "dwelling") {
      this.clearDwell();
      return;
    }

    if (
      previous.phase === "dwelling" &&
      previous.enterT === this.hover.enterT
    ) {
      return;
    }

    this.clearDwell();
    const startedT = this.hover.enterT;
    // Same reason `holdTimer` exists: the dwell has to be able to complete with
    // the pointer perfectly still, so it cannot wait on a move event.
    this.dwellTimer = window.setTimeout(() => {
      this.dwellTimer = 0;
      this.dispatchHover({ type: "tick", t: startedT + HOVER.DWELL_MS });
    }, HOVER.DWELL_MS);
  }

  private clearDwell() {
    if (this.dwellTimer !== 0) {
      window.clearTimeout(this.dwellTimer);
      this.dwellTimer = 0;
    }
  }

  private openPreview(x: number, y: number) {
    const kind = this.previewKind;
    if (kind == null) {
      return;
    }

    hoverPreview.open(this, { kind, url: this.fileUrl }, x, y);
  }

  /**
   * Window-level ways a hover ends, attached only while one is in progress.
   *
   * At most one tile is hovered at a time, so this is at most one set of
   * listeners — where attaching them in the constructor would put a pair on
   * every tile in the folder. The handler is a field, created once, because
   * `removeEventListener(this.f.bind(this))` hands over a newly bound function
   * that was never registered and the listener outlives the app.
   */
  private watchWindow() {
    if (this.watchingWindow) {
      return;
    }
    this.watchingWindow = true;

    // `wheel`, not `scroll`: the asset panel's scroller is the `.tab-content`
    // container, and `scroll` does not bubble to `window`. Nothing here calls
    // `preventDefault`, so both are passive.
    window.addEventListener("wheel", this.handleWindowCancel, {
      passive: true,
    });
    window.addEventListener("blur", this.handleWindowCancel);
    window.addEventListener("keydown", this.handleWindowCancel);
  }

  private unwatchWindow() {
    if (!this.watchingWindow) {
      return;
    }
    this.watchingWindow = false;

    window.removeEventListener("wheel", this.handleWindowCancel);
    window.removeEventListener("blur", this.handleWindowCancel);
    window.removeEventListener("keydown", this.handleWindowCancel);
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
                    // `width`/`height` are the source's own, read above to size
                    // the canvas. The hover preview opens before its `<video>`
                    // has metadata and uses them to avoid a reflow.
                    thumbnailCache.set(fileUrl, { url, w: width, h: height });
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
