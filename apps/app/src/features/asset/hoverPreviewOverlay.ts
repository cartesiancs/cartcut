/**
 * The large preview that follows the cursor, as one element for the whole app.
 *
 * **Singleton, and that is not tidiness.** Chromium caps `WebMediaPlayer` at 75
 * per frame and each playing element costs 30-80MB — the measurement
 * `asset/decoderWindow.ts` opens with, and the reason the timeline stopped
 * giving every clip its own `<video>`. A preview element per tile would put a
 * decoder behind every file in the folder, so a directory of a few hundred
 * recordings would exhaust the cap before anyone hovered anything. One element,
 * reused, and torn down on close.
 *
 * Plain DOM rather than a Lit component: there is no reactive state here to
 * render from. The tile drives this imperatively from the effects
 * `assetHover.ts` hands it, and following the cursor writes two inline
 * properties. A `@state` field would re-render the *tile* at pointer rate, and
 * `AssetFile.render` re-enters `captureVideoThumbnail` for any video whose
 * thumbnail is not cached yet — which fetches the whole file.
 *
 * `owner` is the tile that opened it. `move` and `close` are refused from
 * anyone else, so a tile being torn down late — the directory reloaded, and
 * `repeat` keys by name — cannot close a preview a different tile has since
 * opened.
 */

import { playbackPathFor } from "../../states/proxyStore";
import { toLocalPath } from "../element/mediaProbe";
import { thumbnailCache } from "./thumbnailCache";
import {
  applyPreviewPlacement,
  previewBoxSize,
  type PreviewSide,
  type Size,
} from "./hoverPreviewPlacement";

export type HoverPreviewKind = "video" | "image" | "gif";

export type HoverPreviewSource = {
  kind: HoverPreviewKind;
  /** The tile's own encoded file URL — the key both caches below are under. */
  url: string;
};

/**
 * The rendition to decode for `localpath`.
 *
 * `playbackPathFor` is the only place the proxy substitution is decided, but it
 * is asymmetric: it hands back the caller's own `localpath` — a `file://` URL —
 * when there is no proxy, and `entry.proxy`, a bare **OS path**, when there is.
 * `proxyBridge.ts` converts only `entry.source` on the way in, because the
 * source is what the table is keyed by.
 *
 * So the conversion is applied to the substituted case alone.
 * `loadedAssetStore.ts` wraps unconditionally instead, which on the web build
 * turns `/api/file?path=…` into `/api/file?path=/api/file?path=…` — latent
 * there only because the web build has no proxies, and not worth reproducing.
 * Handed a bare OS path, a `<video>` would resolve it against the page.
 */
export function previewSrcFor(localpath: string): string {
  const chosen = playbackPathFor(localpath);
  return chosen === localpath ? localpath : toLocalPath(chosen);
}

type Overlay = {
  root: HTMLDivElement;
  video: HTMLVideoElement;
  image: HTMLImageElement;
};

let overlay: Overlay | null = null;
let owner: object | null = null;
let cursor = { x: 0, y: 0 };
let box: Size = { w: 0, h: 0 };
/** The side last placed on, fed back so the preview does not strobe. */
let side: PreviewSide | undefined;
let frame = 0;

function viewport(): Size {
  return { w: window.innerWidth, h: window.innerHeight };
}

function ensureOverlay(): Overlay {
  if (overlay != null) {
    return overlay;
  }

  const root = document.createElement("div");
  root.className = "asset-hover-preview";
  root.hidden = true;

  const video = document.createElement("video");
  video.muted = true;
  video.loop = true;
  video.autoplay = true;
  video.playsInline = true;
  video.preload = "auto";
  // Belt and braces: `muted` as a property is what the autoplay policy reads,
  // and the attribute is what survives a `load()`.
  video.setAttribute("muted", "");
  video.hidden = true;

  const image = document.createElement("img");
  image.alt = "";
  image.hidden = true;

  root.append(video, image);
  document.body.append(root);

  overlay = { root, video, image };
  return overlay;
}

/** Stop decoding. Without this a 120fps 3600x2338 file keeps a decoder alive. */
function releaseVideo(video: HTMLVideoElement) {
  video.pause();
  video.removeAttribute("poster");
  video.removeAttribute("src");
  // `load()` is what actually releases the player; clearing `src` alone leaves
  // the previous resource loaded.
  video.load();
}

function paint() {
  frame = 0;
  if (overlay == null) {
    return;
  }
  side = applyPreviewPlacement(overlay.root, cursor, box, { prefer: side });
}

/**
 * Coalesce into one write per frame.
 *
 * `pointermove` fires far faster than the display refreshes, and each call here
 * writes a transform on an element with a decoding `<video>` inside it.
 */
function schedulePaint() {
  if (frame !== 0 || overlay == null) {
    return;
  }
  frame = requestAnimationFrame(paint);
}

function cancelPaint() {
  if (frame !== 0) {
    cancelAnimationFrame(frame);
    frame = 0;
  }
}

/** Re-fit to the media's real dimensions, once it has reported them. */
function resizeTo(natural: Size) {
  box = previewBoxSize(natural, viewport());
  // Straight to the DOM rather than through the scheduler: this runs once, off
  // a media event, and the box is wrong on screen until it does.
  paint();
}

export const hoverPreview = {
  open(by: object, source: HoverPreviewSource, x: number, y: number): void {
    const { root, video, image } = ensureOverlay();

    owner = by;
    cursor = { x, y };
    // A fresh open picks its own side; only a move inherits one.
    side = undefined;

    const known = thumbnailCache.get(source.url);
    // The tile's own thumbnail carries the source's dimensions, so for any
    // video whose tile has been drawn the preview opens at the right size.
    // Failing that, something of the usual shape — a collapsed sliver reads as
    // a broken feature, and it would visibly jump when metadata lands.
    box = previewBoxSize(
      known != undefined ? { w: known.w, h: known.h } : { w: 0, h: 0 },
      viewport(),
    );

    if (source.kind === "video") {
      image.hidden = true;
      image.removeAttribute("src");

      // Cleared unconditionally: the element is reused, so the previous file's
      // frame would otherwise sit under this one's until it decodes.
      video.removeAttribute("poster");
      if (known != undefined) {
        // The tile already has this frame decoded, so the preview is never an
        // empty box while the first one arrives.
        video.poster = known.url;
      }

      // The proxy where one exists. It matters here: the originals are
      // routinely 3600x2338 at 120fps.
      video.src = previewSrcFor(source.url);
      video.hidden = false;
      // Autoplay is allowed because the element is muted; a rejection is still
      // possible and costs a still frame, not an error.
      void video.play().catch(() => {});

      video.onloadedmetadata = () => {
        resizeTo({ w: video.videoWidth, h: video.videoHeight });
      };
    } else {
      releaseVideo(video);
      video.hidden = true;

      image.src = source.url;
      image.hidden = false;

      image.onload = () => {
        resizeTo({ w: image.naturalWidth, h: image.naturalHeight });
      };
    }

    root.hidden = false;
    paint();
  },

  move(by: object, x: number, y: number): void {
    if (owner !== by || overlay == null) {
      return;
    }
    cursor = { x, y };
    schedulePaint();
  },

  close(by: object): void {
    if (owner !== by || overlay == null) {
      return;
    }

    owner = null;
    cancelPaint();
    overlay.root.hidden = true;
    overlay.video.onloadedmetadata = null;
    overlay.image.onload = null;
    overlay.image.removeAttribute("src");
    overlay.image.hidden = true;
    releaseVideo(overlay.video);
    overlay.video.hidden = true;
  },
};
