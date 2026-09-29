import { path } from "../../functions/path";
import mime from "../../functions/mime";
import { LitElement, PropertyValues, TemplateResult, html, nothing } from "lit";
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
import { cancelThumbnail, requestThumbnail } from "./thumbnails";
import { observeVisibility, unobserveVisibility } from "./tileVisibility";
import { showAssetMenu } from "../mediaInfo/assetMenu";
import { canShowMediaInfo } from "../mediaInfo/mediaInfoSession";
import { targetForAsset } from "../mediaInfo/mediaInfoView";

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
    // Bootstrap's `.row` is gone from here on purpose. It is a flex line with
    // negative side margins, so a fixed `col-*` was the only way to say how
    // many tiles fit; `_asset.scss`'s grid decides that from the panel's real
    // width instead.
    return html`<div
      class=${this.showType == "grid" ? "asset-grid" : "asset-rows"}
    >
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

/** Every tile carries these for its whole life, whichever mode it is in. */
const TILE_CLASSES = ["overflow-hidden", "asset"] as const;

/**
 * Layout for one item. Both `asset-file` and `asset-folder` swap between a grid
 * cell and a full-width row, and the two classes are mutually exclusive: the
 * grid parent is a CSS grid and the list parent a flex column, so the tile only
 * has to say which shape it takes, not how wide it is.
 */
function applyShowType(element: HTMLElement, showType: AssetShowType) {
  const grid = showType == "grid";

  element.classList.toggle("asset-tile", grid);
  element.classList.toggle("asset-row", !grid);
}

/**
 * One tile: a well of a fixed shape, then one line of name.
 *
 * Shared by `asset-file` and `asset-folder`, and by every branch inside the
 * file's own `render`, so a folder, a still, a video and an unrecognised file
 * all put their name in the same element in the same place. That is what lets
 * `_asset.scss` pin its height, and a pinned height is what keeps the caption
 * of a 9:16 clip level with the caption of a 16:9 one beside it.
 *
 * A `<span>`, not the `<b>` this used to be: `devent-designsystem.css` pins `b`
 * to `font-weight: 400 !important`.
 *
 * Every tile clips its name. A name too long for its tile used to be
 * *marquee'd* on hover: `.text-ellipsis-scroll` widened it to 750% and animated
 * a translate across it, which spent most of its five-second cycle showing the
 * gap between two passes, so resting on a tile read as the name disappearing.
 * The whole name is on the hover preview's own caption now, where there is room
 * for it.
 */
function templateTile(
  name: string,
  well: TemplateResult,
  wellClass = "",
): TemplateResult {
  return html`<div class="asset-thumb ${wellClass}">${well}</div>
    <span class="asset-name">${name}</span>`;
}

/** The glyph a file with no picture of its own gets. */
function templateIcon(glyph: string): TemplateResult {
  return html`<span class="material-symbols-outlined asset-thumb-icon"
    >${glyph}</span
  >`;
}

@customElement("asset-file")
export class AssetFile extends LitElement {
  /** Whether this tile is on screen, per `tileVisibility.ts`. */
  private visible = false;
  /** The file URL a thumbnail is currently on order for, or "" for none. */
  private requestedUrl = "";

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

    // `asset-tile` rather than nothing: `applyShowType` runs from `updated`,
    // which is after the first paint, so the grid has to be what a tile starts
    // as. It is also `assetStore`'s default.
    this.classList.add(...TILE_CLASSES, "asset-tile");

    this.addEventListener("pointerdown", this.handlePointerDown);
    this.addEventListener("pointermove", this.handlePointerMove);
    this.addEventListener("pointerup", this.handlePointerUp);
    this.addEventListener("pointercancel", this.handleGestureEnd);
    this.addEventListener("dragstart", this.handleDragStart);
    this.addEventListener("dragend", this.handleGestureEnd);
    // Neither bubbles, so they go on the tile itself rather than on the grid.
    this.addEventListener("pointerenter", this.handlePointerEnter);
    this.addEventListener("pointerleave", this.handlePointerLeave);
    this.addEventListener("contextmenu", this.handleContextMenu);
  }

  connectedCallback(): void {
    super.connectedCallback();
    observeVisibility(this, this.handleVisibility);
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

    unobserveVisibility(this);
    this.dropThumbnailRequest();
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
      // The same reuse, from the thumbnail's side: the capture still on order
      // is for the file this tile used to be, so it is no longer ours to wait
      // for.
      this.dropThumbnailRequest();
    }

    this.ensureThumbnail();
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
      // A read, and nothing else. Kicking the capture off from here is what
      // made merely painting the grid start one decode per video in the
      // folder; `ensureThumbnail` is asked from `updated`, and only for a tile
      // that is actually on screen.
      return this.templateVideoThumbnail(thumbnailCache.get(fileUrl)?.url ?? "");
    }

    return this.template(fileType);
  }

  template(filetype = "unknown") {
    const fileIcon = {
      video: "video_file",
      audio: "audio_file",
      unknown: "draft",
    };

    return templateTile(
      this.name,
      templateIcon(fileIcon[filetype] ?? fileIcon.unknown),
    );
  }

  templateImage(url) {
    return templateTile(
      this.name,
      html`<img
        src="${url}"
        alt=""
        loading="lazy"
        decoding="async"
        class="asset-thumb-img"
      />`,
    );
  }

  /**
   * `url` is "" until the capture lands, and that case renders no `<img>` at
   * all: an empty `src` resolves against the document and paints a broken-image
   * glyph, and the well behind it is already the right size and the right
   * colour, so there is nothing for a placeholder element to do.
   *
   * The play badge is drawn either way. It is the only thing that tells a video
   * from a still while the frame is still being captured.
   */
  templateVideoThumbnail(url: string) {
    return templateTile(
      this.name,
      html`${url == ""
        ? nothing
        : html`<img
            src="${url}"
            alt=""
            decoding="async"
            class="asset-thumb-img"
          />`}<span class="material-symbols-outlined asset-thumb-badge"
        >play_arrow</span
      >`,
    );
  }

  // -------------------------------------------------------------- thumbnail

  /**
   * Ask for this tile's thumbnail, if it wants one and does not have it.
   *
   * Idempotent, and called from `updated` on every render: a cache hit, a
   * request already outstanding and a tile off screen all cost one lookup.
   * That is what lets the kick-off live outside `render` without anything
   * having to track whether it has run.
   */
  private ensureThumbnail() {
    if (!this.visible || mime.lookup(this.name).type != "video") {
      return;
    }

    const fileUrl = this.fileUrl;
    if (this.requestedUrl == fileUrl || thumbnailCache.has(fileUrl)) {
      return;
    }

    this.dropThumbnailRequest();
    this.requestedUrl = fileUrl;
    requestThumbnail(fileUrl, this.handleThumbnail);
  }

  private dropThumbnailRequest() {
    if (this.requestedUrl == "") {
      return;
    }

    cancelThumbnail(this.requestedUrl, this.handleThumbnail);
    this.requestedUrl = "";
  }

  /** A field, not a method: `cancelThumbnail` has to be handed back the same
   * reference `requestThumbnail` was given, and `this.f.bind(this)` is a new
   * function every time. */
  private handleThumbnail = () => {
    this.requestedUrl = "";
    this.requestUpdate();
  };

  private handleVisibility = (visible: boolean) => {
    this.visible = visible;

    if (visible) {
      this.ensureThumbnail();
      return;
    }

    // Scrolled away with the capture still waiting for a slot. Giving the slot
    // back is the whole point of observing: what is on screen goes first.
    this.dropThumbnailRequest();
  };

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

  /**
   * Show Info, for a file it can describe. Anything else (a subtitle, a
   * project file) gets no menu at all rather than one with nothing in it.
   */
  private handleContextMenu = (e: MouseEvent) => {
    const target = targetForAsset(
      this.fullPath,
      this.fileUrl,
      this.name,
      mime.lookup(this.name).type,
    );
    if (target == null || !canShowMediaInfo()) {
      return;
    }
    e.preventDefault();
    showAssetMenu(e.clientX, e.clientY, target);
  };

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

    hoverPreview.open(this, { kind, url: this.fileUrl, name: this.name }, x, y);
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
}

@customElement("asset-folder")
export class AssetFolder extends LitElement {
  constructor() {
    super();

    this.classList.add(...TILE_CLASSES, "asset-tile");

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
    // The one tile with no picture of its own, so its well is marked and the
    // glyph inside it carries: `_asset.scss` draws `asset-thumb-folder` a step
    // brighter and a step larger than a file's fallback icon.
    return templateTile(
      this.name,
      templateIcon("folder"),
      "asset-thumb-folder",
    );
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
