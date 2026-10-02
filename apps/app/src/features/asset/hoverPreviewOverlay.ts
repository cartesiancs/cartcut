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
 * properties. A `@state` field would re-render the *tile* at pointer rate, for
 * a preview that is not part of the tile's own template anyway.
 *
 * `owner` is the tile that opened it. `move` and `close` are refused from
 * anyone else, so a tile being torn down late — the directory reloaded, and
 * `repeat` keys by name — cannot close a preview a different tile has since
 * opened.
 */

import { playbackPathFor } from "../../states/proxyStore";
import { toLocalPath } from "../element/mediaProbe";
import { releaseVideo } from "./releaseVideo";
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
  /** The filename, shown in full under the picture. */
  name: string;
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
 * So the conversion is applied to the substituted case alone. Handed a bare OS
 * path, a `<video>` would resolve it against the page.
 *
 * `loadedAssetStore.ts` decodes every timeline video through this too. It used
 * to wrap unconditionally, which was not harmless outside Electron: the web
 * build's `/api/file?path=…` became `/api/file?path=/api/file?path=…`, and the
 * demo's bundled `/sample/x.mp4` became `/api/file?path=/sample/x.mp4`, which
 * the static host answers with `index.html`.
 */
export function previewSrcFor(localpath: string): string {
  const chosen = playbackPathFor(localpath);
  return chosen === localpath ? localpath : toLocalPath(chosen);
}

type Overlay = {
  root: HTMLDivElement;
  /** The picture's own box. The root is this plus the caption under it. */
  frame: HTMLDivElement;
  video: HTMLVideoElement;
  image: HTMLImageElement;
  caption: HTMLDivElement;
};

let overlay: Overlay | null = null;
let owner: object | null = null;
let cursor = { x: 0, y: 0 };
/** The picture's box, from the media's own dimensions. */
let box: Size = { w: 0, h: 0 };
/**
 * The whole card, caption included: what has to fit on screen.
 *
 * Measured rather than derived, because a filename wraps to however many lines
 * it wraps to and no arithmetic here knows the font's metrics. Held between
 * paints so that a `pointermove` stays a transform write: re-measuring per move
 * would force a layout per move, which is the cost `applyPreviewPlacement`'s
 * transform-only write exists to avoid.
 */
let card: Size = { w: 0, h: 0 };
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

  const frameEl = document.createElement("div");
  frameEl.className = "asset-hover-preview-frame";

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

  const caption = document.createElement("div");
  caption.className = "asset-hover-preview-name";

  frameEl.append(video, image);
  root.append(frameEl, caption);
  document.body.append(root);

  overlay = { root, frame: frameEl, video, image, caption };
  return overlay;
}

/** Give the picture its box, and measure what the card then comes to. */
function fit(size: Size): Size {
  const { root, frame: frameEl } = ensureOverlay();

  frameEl.style.width = `${size.w}px`;
  frameEl.style.height = `${size.h}px`;

  // The card is as wide as its picture, so the caption wraps *under* it rather
  // than setting the width itself. Without this a long filename lays out on one
  // line and drags the card out to its own length — measured at 726px against a
  // 355px picture. `.asset-hover-preview`'s `min-width` still raises it for a
  // picture too narrow to read a name in; that is why the width is measured
  // back rather than assumed to be what was just written.
  root.style.width = `${size.w}px`;

  // A hidden element measures 0x0, and every caller unhides the root before
  // this runs. Kept as one forced layout per open and per `loadedmetadata`,
  // never per pointer move.
  const rect = root.getBoundingClientRect();
  return { w: rect.width, h: rect.height };
}

function paint() {
  frame = 0;
  if (overlay == null) {
    return;
  }
  side = applyPreviewPlacement(overlay.root, cursor, card, { prefer: side });
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
  card = fit(box);
  // Straight to the DOM rather than through the scheduler: this runs once, off
  // a media event, and the box is wrong on screen until it does.
  paint();
}

export const hoverPreview = {
  open(by: object, source: HoverPreviewSource, x: number, y: number): void {
    const { root, video, image, caption } = ensureOverlay();

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

    // `textContent`, never `innerHTML`: a filename is not markup, and on this
    // platform it may legally contain any of it.
    caption.textContent = source.name;

    // Unhidden before the measure, because a hidden element has no box.
    root.hidden = false;
    card = fit(box);
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
