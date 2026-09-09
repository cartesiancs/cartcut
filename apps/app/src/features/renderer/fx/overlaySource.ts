/**
 * The looping `<video>` handles behind overlay effects.
 *
 * A small store of its own rather than an addition to `loadedAssetStore`, for
 * two reasons. Its keying is different — an overlay's media comes from the
 * preset folder, not from the element's `localpath`, which for an effect is the
 * placeholder `"EFFECT"` — and so is its time model: overlays loop, so their
 * position is `overlayTime.ts`'s modulo rather than `sourceTimeAt`'s offset.
 * Folding both into the asset store would mean a `filetype === "effect"` branch
 * in every one of its paths.
 *
 * The contract matches the rest of the render path: **never block, never
 * throw.** A handle that has not decoded yet returns `null`, the effect draws
 * nothing this frame, and the next repaint has it — exactly what
 * `renderer/video.ts` does for a clip whose handle is still loading.
 */

import type { EffectElementType } from "../../../@types/timeline";
import type { FxPreset } from "../../fx/presetTypes";
import { overlayDriftMs, overlaySourceTimeAt } from "./overlayTime";

/**
 * How far a rolling overlay may drift before it is corrected, in seconds.
 *
 * The same reasoning as `playback.ts#PLAYING_DRIFT_TOLERANCE_SEC`: a healthy
 * media element runs a constant few frames behind the wall clock, and treating
 * that offset as drift makes every correction starve the decoder into needing
 * another one. An overlay is decorative, so it can be even more relaxed than a
 * clip.
 */
const PLAYING_TOLERANCE_SEC = 0.3;

type Handle = {
  video: HTMLVideoElement;
  /** The preset asset this was loaded from, so a preset switch reloads it. */
  source: string;
  ready: boolean;
};

const handles = new Map<string, Handle>();
const failed = new Set<string>();

/**
 * The scope separator.
 *
 * A NUL cannot appear in an element id or a file path, so splitting on it is
 * exact — unlike "|", which the `elementId|source` half already uses and which
 * a path is free to contain.
 */
const SCOPE_SEP = "\u0000";

/**
 * Which frame loop this handle belongs to.
 *
 * The preview's scope is the empty string. An export passes its video scope's
 * id, for the same reason `loadedAssetStore` gained one: `overlayFrame`
 * assigns `currentTime` and calls `play()` on every frame, and
 * `releaseUnusedOverlays` runs from the preview's draw path — so deleting an
 * effect mid-render used to tear a handle out from under the export.
 *
 * Exported for the suite: the property that matters is that two scopes cannot
 * collide, and that is a statement about this function.
 */
export function overlayScopeKey(
  scope: string,
  elementId: string,
  source: string,
): string {
  return scope + SCOPE_SEP + elementId + "|" + source;
}

/** The element id inside a scoped key, or null when the scope does not match. */
function elementIdIn(key: string, scope: string): string | null {
  const split = key.indexOf(SCOPE_SEP);
  if (key.slice(0, split) !== scope) {
    return null;
  }
  const rest = key.slice(split + SCOPE_SEP.length);
  return rest.slice(0, rest.lastIndexOf("|"));
}

/**
 * The absolute path of an overlay preset's media, or `null`.
 *
 * `null` for a shader preset, which has no media, and for a preset whose
 * declared source is missing from the folder — which the validator would have
 * caught, so this is the render path declining to assume it ran.
 */
export function overlaySourceOf(preset: FxPreset): string | null {
  if (preset.render.type !== "overlay") {
    return null;
  }
  return preset.assets[preset.render.source] ?? null;
}

/**
 * The current frame of an overlay, or `null` while it is still decoding.
 *
 * `playing` decides how the handle is positioned. Rolling playback is left
 * alone unless it has genuinely drifted; a paused preview and an export are
 * placed exactly, because export samples one frame at a time and must be
 * frame-accurate.
 */
export function overlayFrame(
  scope: string,
  elementId: string,
  element: EffectElementType,
  preset: FxPreset,
  timeInMs: number,
  playing: boolean,
): CanvasImageSource | null {
  const source = overlaySourceOf(preset);
  if (source == null) {
    return null;
  }

  const key = overlayScopeKey(scope, elementId, source);
  if (failed.has(key)) {
    return null;
  }

  const handle = handles.get(key) ?? create(key, source);
  if (handle == null || !handle.ready) {
    return null;
  }

  const video = handle.video;
  const durationMs = video.duration * 1000;
  const wantMs = overlaySourceTimeAt(element, timeInMs, durationMs);
  const wantSec = wantMs / 1000;

  const rolling = playing && !video.paused;
  const toleranceSec = rolling ? PLAYING_TOLERANCE_SEC : 0;

  if (
    overlayDriftMs(video.currentTime * 1000, wantMs, durationMs) / 1000 >
    toleranceSec
  ) {
    try {
      video.currentTime = wantSec;
    } catch {
      // A seek can throw while the element is in a transient state. Skipping
      // this frame is better than taking the paint loop down.
      return null;
    }
  }

  if (playing) {
    if (video.paused) {
      void video.play().catch(() => {
        // Autoplay policy, or a source that vanished. The frame still draws at
        // whatever position it holds, so this is not worth reporting per frame.
      });
    }
  } else if (!video.paused) {
    video.pause();
  }

  // `readyState < HAVE_CURRENT_DATA` means there is no picture to sample; the
  // browser would draw the previous frame or nothing at all.
  if (video.readyState < 2) {
    return null;
  }
  return video;
}

function create(key: string, source: string): Handle | null {
  let video: HTMLVideoElement;
  try {
    video = document.createElement("video");
  } catch {
    failed.add(key);
    return null;
  }

  const handle: Handle = { video, source, ready: false };

  video.muted = true;
  // An overlay is decoration; it must never make a sound of its own, and it
  // must not participate in the audio graph the exporter builds.
  video.volume = 0;
  video.loop = true;
  video.playsInline = true;
  video.preload = "auto";

  video.addEventListener(
    "loadeddata",
    () => {
      handle.ready = true;
    },
    { once: true },
  );
  video.addEventListener(
    "error",
    () => {
      failed.add(key);
      handles.delete(key);
    },
    { once: true },
  );

  video.src = source.startsWith("file://") ? source : "file://" + source;
  handles.set(key, handle);
  return handle;
}

/**
 * Drop handles for effects that are no longer in the document.
 *
 * Called from the preview's draw path. Without it, deleting an effect leaves a
 * decoding `<video>` alive for the rest of the session, and a project switch
 * accumulates one per effect that ever existed.
 */
export function releaseUnusedOverlays(liveElementIds: Set<string>): void {
  for (const [key, handle] of handles) {
    // The preview's own scope alone. An export's handles are not this
    // function's to drop — that is the whole reason the key carries a scope.
    const elementId = elementIdIn(key, "");
    if (elementId == null || liveElementIds.has(elementId)) {
      continue;
    }
    releaseOverlayHandle(key, handle);
  }
}

/**
 * Drop every handle belonging to one scope.
 *
 * Called from `renderTimeline`'s `finally`, beside `releaseVideoScope`, so an
 * export lets go of its overlay decoders whether it finished, failed or was
 * cancelled.
 */
export function releaseOverlayScope(scope: string): void {
  for (const [key, handle] of handles) {
    if (elementIdIn(key, scope) == null) {
      continue;
    }
    releaseOverlayHandle(key, handle);
  }
}

function releaseOverlayHandle(key: string, handle: Handle): void {
  handle.video.pause();
  handle.video.removeAttribute("src");
  handle.video.load();
  handles.delete(key);
  failed.delete(key);
}

/** For tests and for tearing a render window down. */
export function __resetOverlaysForTesting(): void {
  handles.clear();
  failed.clear();
}
