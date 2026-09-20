/**
 * One frame out of a video file, for an asset tile.
 *
 * **It does not read the file.** The version this replaces did
 * `fetch(url).then(res => res.blob())`, which buffers the whole video into
 * renderer memory to obtain a single frame: for the 3600x2338 120fps screen
 * recordings this app is routinely pointed at, that is hundreds of megabytes
 * per tile, and a folder starts one per video in the same frame. A `<video>`
 * pointed straight at the URL range-reads instead, which is what
 * `hoverPreviewOverlay.ts` has always done. Both environments support it:
 * Electron loads `file://` directly, and the web shim's `/api/file?path=` is
 * served by Express `res.sendFile`, which answers `Range`.
 *
 * Drawing a `file://` video onto a canvas and reading it back is safe here,
 * tainting notwithstanding: it is exactly what the export does
 * (`export/renderTimeline.ts` composites `loadedAssetStore`'s `file://` videos
 * and reads the frame back with `getImageData`).
 *
 * The pure half is separated out because there is no DOM test environment in
 * this repo. `seekTargetFor` and `thumbnailSize` are where this can be wrong
 * without looking broken, so they are the part a node suite can hold.
 */

import { previewSrcFor } from "./hoverPreviewOverlay";
import { releaseVideo } from "./releaseVideo";
import type { Thumbnail } from "./thumbnailCache";

/**
 * Longest edge of the stored thumbnail, in pixels.
 *
 * `_asset.scss` shows a tile preview at 55px, so this is comfortable headroom
 * at 2x DPR and leaves room for the tile to grow. The version this replaces
 * sized its canvas to `videoWidth`/`videoHeight` and kept a full 3600x2338 PNG
 * per file, which is several thousand times the pixels anybody sees.
 */
export const THUMBNAIL_MAX_PX = 160;

/**
 * How long one capture may take before it is abandoned.
 *
 * There must be a ceiling, not merely an error handler. The old code hung
 * forever on any clip shorter than its hard-coded 1s seek: `seeked` never
 * arrived, the promise never settled, and the element plus its whole-file blob
 * were retained with no thumbnail ever appearing.
 */
export const CAPTURE_TIMEOUT_MS = 10_000;

/**
 * How far to stay clear of the end, in seconds.
 *
 * `timeline/strip/videoTiles.ts` uses the same guard for the same measured
 * reason: seeking at or past the end never fires `seeked`, so a target that
 * lands there is a wait that never completes.
 */
const END_GUARD_SEC = 0.05;

/**
 * A seek nearer than this to where the element already sits is not a seek.
 *
 * The other half of the same trap, and the one that bit the code this replaces:
 * setting `currentTime` to the position it already holds fires no `seeked`
 * either, so a target of 0 on a fresh element hangs forever waiting for an
 * event the spec never sends.
 */
const SEEK_EPSILON = 1e-3;

/**
 * Where to seek for the frame, given what the container claims.
 *
 * A `normalizeX` guard in the sense `CLAUDE.md` uses: it runs on whatever the
 * file reports and never throws. A `MediaRecorder` capture answers `Infinity`
 * and a container that states no length answers `NaN`; both mean "take the
 * first frame" rather than "seek to a number that does not exist".
 *
 * 1s where there is room, which skips a black lead-in and still decodes from
 * the keyframe at 0 rather than a mid-file one, so it stays cheap on the 8
 * second GOPs this app's own screen recordings carry. A short clip gets
 * whatever is left before the end guard, so a 0.4s clip yields 0.35 instead of
 * the silent hang a flat 1s produced.
 */
export function seekTargetFor(duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0) {
    return 0;
  }

  return Math.min(1, Math.max(0, duration - END_GUARD_SEC));
}

/**
 * The canvas to draw into, or null when the source reported no usable size.
 *
 * Never upscales: a 32x32 icon stays 32x32 rather than becoming a blurry 160px
 * one. Declining on a bad size rather than clamping is deliberate, because a
 * zero there means the decoder has not actually produced a frame and drawing
 * would store a blank tile in the cache forever.
 */
export function thumbnailSize(
  w: number,
  h: number,
  max: number = THUMBNAIL_MAX_PX,
): { w: number; h: number } | null {
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    return null;
  }

  const longest = Math.max(w, h);
  if (longest <= max) {
    return { w: Math.round(w), h: Math.round(h) };
  }

  const scale = max / longest;
  return {
    w: Math.max(1, Math.round(w * scale)),
    h: Math.max(1, Math.round(h * scale)),
  };
}

/**
 * Decode one frame of `fileUrl` and hand back a blob URL for it.
 *
 * Settles exactly once, and releases the decoder on every path out. The caller
 * owns the returned `url` and must revoke it; `thumbnailCache` does that on
 * eviction.
 */
export function captureThumbnail(fileUrl: string): Promise<Thumbnail> {
  return new Promise<Thumbnail>((resolve, reject) => {
    const video = document.createElement("video");
    let settled = false;
    // Declared before the closures that clear it. Assigned below, once the
    // handlers it can cancel exist.
    let timer = 0;

    const done = () => {
      settled = true;
      window.clearTimeout(timer);
      video.removeEventListener("loadedmetadata", onMetadata);
      video.removeEventListener("loadeddata", onFrame);
      video.removeEventListener("seeked", onFrame);
      video.removeEventListener("error", onError);
      // Before the callbacks resume: whatever the caller does next, this file's
      // decoder is already one of Chromium's 75 again.
      releaseVideo(video);
    };

    const fail = (reason: string) => {
      if (settled) {
        return;
      }
      done();
      reject(new Error(`${reason}: ${fileUrl}`));
    };

    const succeed = (thumbnail: Thumbnail) => {
      done();
      resolve(thumbnail);
    };

    const onError = () => fail("thumbnail capture failed to decode");

    const onMetadata = () => {
      if (settled) {
        return;
      }

      const target = seekTargetFor(video.duration);
      if (Math.abs(video.currentTime - target) > SEEK_EPSILON) {
        video.currentTime = target;
        return;
      }

      // The target is where the element already sits, so no `seeked` is
      // coming. `preload="metadata"` stops at `HAVE_METADATA` with no frame
      // decoded, so asking for data is the only thing that produces one.
      // Reached by clips too short to seek inside and by the files that report
      // no length at all, never by ordinary footage.
      video.preload = "auto";
    };

    /**
     * Both `seeked` and `loadeddata` land here.
     *
     * Two arrivals because there are two ways to get a frame: the seek above,
     * or the buffering that the `preload` bump asks for. The `readyState`
     * check is what makes listening to both safe, since either can arrive
     * before a frame is actually decoded.
     */
    const onFrame = () => {
      if (settled || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
        return;
      }

      const size = thumbnailSize(video.videoWidth, video.videoHeight);
      if (size == null) {
        fail("thumbnail capture read no dimensions");
        return;
      }

      const canvas = document.createElement("canvas");
      canvas.width = size.w;
      canvas.height = size.h;

      const ctx = canvas.getContext("2d");
      if (ctx == null) {
        fail("thumbnail capture got no 2d context");
        return;
      }

      ctx.drawImage(video, 0, 0, size.w, size.h);

      // Read before `done()` releases the element, and store the *source's*
      // dimensions rather than the thumbnail's: `hoverPreview.open` opens at
      // this aspect before its own `loadedmetadata`, and a thumbnail-shaped
      // guess there is a visible jump.
      const w = video.videoWidth;
      const h = video.videoHeight;

      canvas.toBlob(
        (blob) => {
          if (blob == null) {
            fail("thumbnail capture encoded nothing");
            return;
          }

          const url = URL.createObjectURL(blob);
          if (settled) {
            // The timeout won the race while the encoder was working. Nothing
            // will ever read this URL, so it has to go back now.
            URL.revokeObjectURL(url);
            return;
          }

          succeed({ url: url, w: w, h: h });
        },
        // JPEG, not the default PNG: a photographic frame at this size is a few
        // kilobytes rather than a few hundred.
        "image/jpeg",
        0.8,
      );
    };

    video.addEventListener("loadedmetadata", onMetadata);
    video.addEventListener("loadeddata", onFrame);
    video.addEventListener("seeked", onFrame);
    video.addEventListener("error", onError);

    timer = window.setTimeout(
      () => fail("thumbnail capture timed out"),
      CAPTURE_TIMEOUT_MS,
    );

    video.preload = "metadata";
    video.muted = true;
    // The proxy where one exists, for the same reason the hover preview uses
    // one: the originals are routinely 3600x2338 at 120fps.
    video.src = previewSrcFor(fileUrl);
  });
}
