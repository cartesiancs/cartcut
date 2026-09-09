/**
 * Reading what a media file actually is: size, length, whether it has sound.
 *
 * This is the half of media import that needs a DOM and an IPC round trip, kept
 * apart from `mediaElement.ts` so that module stays testable under vitest's
 * node environment. It is also the seam a test injects at — `MediaProber` is an
 * interface, and `domProber` is only the default.
 *
 * Two differences from the path `AssetController.add` takes:
 *
 *  - **No blob.** That code fetches the whole file into memory and mints an
 *    object URL for `element.blob`. Nothing reads `element.blob`: the preview
 *    and both export paths load from `localpath` through `loadedAssetStore`.
 *    So the round trip is a full-file read and a permanently leaked object URL
 *    in exchange for a field nobody consults.
 *  - **Failures are failures.** The originals attach `onloadedmetadata` and
 *    nothing else, so an unreadable file hangs the import forever with no
 *    error. Every probe here rejects on `error` and on a timeout.
 */

import { parseGIF, decompressFrames } from "gifuct-js";
import { path as pathUtil } from "../../functions/path";
import { getLocationEnv } from "../../functions/getLocationEnv";
import { mediaKindOf, type MediaKind, type MediaProbe } from "./mediaElement";
import { whileLoadingMedia } from "../../states/mediaLoadStore";

/**
 * Long enough for a large file on a slow disk, short enough that a broken one
 * surfaces as an error rather than a wedged tool call.
 */
const PROBE_TIMEOUT_MS = 60_000;

/**
 * Separate, much shorter budget for measuring a length the container does not
 * state. Deliberately not `PROBE_TIMEOUT_MS`: the caller that needs this has a
 * wall-clock figure to fall back on, and making a recording wait a minute
 * before using it is a hang. Expiry falls through rather than failing.
 */
const DURATION_SEEK_TIMEOUT_MS = 5_000;

export type MediaProber = {
  image: (src: string) => Promise<{ width: number; height: number }>;
  gif: (src: string) => Promise<{ width: number; height: number }>;
  video: (
    src: string,
  ) => Promise<{ width: number; height: number; durationMs: number; hasAudio: boolean }>;
  audio: (src: string) => Promise<{ durationMs: number }>;
};

/**
 * The path form the loaders expect.
 *
 * `loadedAssetStore` reads `localpath` directly, and in Electron that has to be
 * a `file://` URL. Already-prefixed paths pass through so a caller can hand us
 * whatever `list_assets` returned.
 */
export function toLocalPath(filepath: string): string {
  if (/^(file|https?|blob):/.test(filepath)) {
    return filepath;
  }
  const encoded = pathUtil.encode(filepath);
  return locationEnv() === "electron"
    ? `file://${encoded}`
    : `/api/file?path=${encoded}`;
}

/**
 * `getLocationEnv` with a guard, because it reads `window.location` unguarded.
 *
 * Path building is the one piece of this module that is pure arithmetic, and
 * the command suites reach it under vitest's node environment. Electron is the
 * right default there: it is what the packaged app always is, and the only
 * difference the web build makes here is the URL prefix.
 */
function locationEnv(): "web" | "electron" | "demo" {
  return typeof window === "undefined" ? "electron" : getLocationEnv();
}

/** Reject if `promise` has not settled in time, naming what we were waiting on. */
function withTimeout<T>(promise: Promise<T>, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out reading ${what}`)),
      PROBE_TIMEOUT_MS,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * How long the media actually is, for a file that will not say.
 *
 * A `MediaRecorder` capture has no Duration in its Segment Info — the recorder
 * cannot know the length when it writes the header — so Chromium reports
 * `Infinity`. ffprobe is no help either: the bundled binary answers
 * `format.duration=N/A` on the same files, because the figure is genuinely not
 * in the container. Seeking past the end is what makes Chromium demux to the
 * last cluster and revise `duration` to the final frame's timestamp, and it is
 * the only mechanism available short of an O(filesize) packet scan.
 *
 * Resolves `Infinity` rather than rejecting when that fails: the caller decides
 * whether it has something better to use. A file that states its length — every
 * normal import — pays nothing here.
 */
function measureDurationMs(el: HTMLMediaElement): Promise<number> {
  if (Number.isFinite(el.duration)) {
    return Promise.resolve(el.duration * 1000);
  }

  return new Promise((resolve) => {
    const finish = (value: number) => {
      clearTimeout(timer);
      el.removeEventListener("durationchange", onDurationChange);
      resolve(value);
    };

    const onDurationChange = () => {
      if (Number.isFinite(el.duration)) {
        const measured = el.duration * 1000;
        // Put the head back: the same element is not reused, but a seek left
        // pending on a large file keeps the decoder busy for no reason.
        el.currentTime = 0;
        finish(measured);
      }
    };

    const timer = setTimeout(() => finish(Infinity), DURATION_SEEK_TIMEOUT_MS);

    el.addEventListener("durationchange", onDurationChange);
    el.currentTime = Number.MAX_SAFE_INTEGER;
  });
}

/**
 * Settle on a length, preferring what the file says over what a caller guessed.
 *
 * The ordering is the load-bearing part. A recorder's wall clock
 * (`endTime - startTime`) includes `MediaRecorder` start latency and the final
 * partial frame, so it overshoots the encoded media by tens of milliseconds — a
 * clip claiming more than it has grows a tail with no frames in it, and
 * `sourceDuration` then lies to every trim made afterwards. The file's own last
 * timestamp is the truth; the wall clock is only what you use when there is no
 * truth to be had.
 *
 * Throws rather than clamping. `planImport` turns that into a `skipped` entry
 * with a reason the user sees, which is the right failure for a file nothing
 * can measure — a silent 0 would place a clip that looks fine and is not.
 */
export function resolveDurationMs(
  raw: number,
  fallback: number | undefined,
  filepath: string,
): number {
  if (Number.isFinite(raw) && raw > 0) {
    return raw;
  }
  if (fallback != null && Number.isFinite(fallback) && fallback > 0) {
    return fallback;
  }
  throw new Error(`Could not read the length of "${filepath}".`);
}

export const domProber: MediaProber = {
  image: (src) =>
    withTimeout(
      new Promise((resolve, reject) => {
        const img = document.createElement("img");
        img.onload = () => resolve({ width: img.width, height: img.height });
        img.onerror = () => reject(new Error(`Could not decode image: ${src}`));
        img.src = src;
      }),
      src,
    ),

  gif: (src) =>
    withTimeout(
      fetch(src)
        .then((response) => {
          if (!response.ok) {
            throw new Error(`Could not read GIF: ${src}`);
          }
          return response.arrayBuffer();
        })
        .then((buffer) => {
          const frames = decompressFrames(parseGIF(buffer), true);
          const dims = frames[0]?.dims;
          if (dims == null) {
            throw new Error(`GIF has no frames: ${src}`);
          }
          return { width: dims.width, height: dims.height };
        }),
      src,
    ),

  video: (src) =>
    withTimeout(
      new Promise<{ width: number; height: number; durationMs: number }>(
        (resolve, reject) => {
          const video = document.createElement("video");
          video.preload = "metadata";
          video.onloadedmetadata = () => {
            measureDurationMs(video).then((durationMs) =>
              resolve({
                width: video.videoWidth,
                height: video.videoHeight,
                durationMs,
              }),
            );
          };
          video.onerror = () =>
            reject(new Error(`Could not decode video: ${src}`));
          video.src = src;
        },
      ).then(async (basic) => {
        // ffprobe answers the one question the `<video>` element will not:
        // whether there is an audio stream. `GET_METADATA` ignores its first
        // argument and probes the second, and it swallows ffprobe's own error
        // — so a file it cannot read resolves with no `streams` at all rather
        // than rejecting. Treat that as "no audio" instead of throwing: the
        // picture already decoded, so the clip is usable.
        let hasAudio = false;
        try {
          const result: any = await window.electronAPI.req.ffmpeg.getMetadata(
            src,
            src,
          );
          hasAudio = (result?.metadata?.streams ?? []).some(
            (stream: any) => stream?.codec_type === "audio",
          );
        } catch {
          hasAudio = false;
        }
        return { ...basic, hasAudio };
      }),
      src,
    ),

  audio: (src) =>
    withTimeout(
      new Promise((resolve, reject) => {
        const audio = document.createElement("audio");
        audio.preload = "metadata";
        // Same headerless case as video: `saveBufferToAudio` writes a
        // `MediaRecorder` blob under a `.wav` name, and what is inside is webm.
        audio.onloadedmetadata = () => {
          measureDurationMs(audio).then((durationMs) => resolve({ durationMs }));
        };
        audio.onerror = () => reject(new Error(`Could not decode audio: ${src}`));
        audio.src = src;
      }),
      src,
    ),
};

export type ProbeOptions = {
  /**
   * Length to use when the file does not state one and cannot be measured.
   *
   * Only a `MediaRecorder` capture needs this, and only its own recorder knows
   * the figure. See `resolveDurationMs` for why it loses to the file.
   */
  fallbackDurationMs?: number;
};

/**
 * Look at one file and say what it is.
 *
 * Throws for an extension the editor has no renderer for — the caller decides
 * whether that loses the whole batch or just one item — and for a video or
 * audio file whose length nothing can establish.
 */
export async function probeMedia(
  filepath: string,
  prober: MediaProber = domProber,
  options: ProbeOptions = {},
): Promise<MediaProbe> {
  const localpath = toLocalPath(filepath);
  const kind: MediaKind | null = mediaKindOf(filepath);

  if (kind == null) {
    throw new Error(
      `Cartcut has no renderer for "${filepath}". Supported: video, image, gif and audio files.`,
    );
  }

  // Raises the bar in `element-timeline-bottom`. Wrapped here rather than at
  // each caller so a drop, the asset panel, a recording and an MCP media add
  // all report the same way, and in a `finally` so a rejected probe — which
  // this module makes a real possibility — lowers it again.
  return whileLoadingMedia(() =>
    probeKind(kind, filepath, localpath, prober, options),
  );
}

async function probeKind(
  kind: MediaKind,
  filepath: string,
  localpath: string,
  prober: MediaProber,
  options: ProbeOptions,
): Promise<MediaProbe> {
  switch (kind) {
    case "video": {
      const probed = await prober.video(localpath);
      return {
        kind,
        localpath,
        ...probed,
        durationMs: resolveDurationMs(
          probed.durationMs,
          options.fallbackDurationMs,
          filepath,
        ),
      };
    }
    case "audio": {
      const probed = await prober.audio(localpath);
      return {
        kind,
        localpath,
        durationMs: resolveDurationMs(
          probed.durationMs,
          options.fallbackDurationMs,
          filepath,
        ),
        width: 0,
        height: 0,
        hasAudio: true,
      };
    }
    case "gif": {
      const probed = await prober.gif(localpath);
      return { kind, localpath, durationMs: 0, ...probed, hasAudio: false };
    }
    case "image":
    default: {
      const probed = await prober.image(localpath);
      return { kind, localpath, durationMs: 0, ...probed, hasAudio: false };
    }
  }
}
