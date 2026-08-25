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

/**
 * Long enough for a large file on a slow disk, short enough that a broken one
 * surfaces as an error rather than a wedged tool call.
 */
const PROBE_TIMEOUT_MS = 60_000;

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
          video.onloadedmetadata = () =>
            resolve({
              width: video.videoWidth,
              height: video.videoHeight,
              durationMs: video.duration * 1000,
            });
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
        audio.onloadedmetadata = () =>
          resolve({ durationMs: audio.duration * 1000 });
        audio.onerror = () => reject(new Error(`Could not decode audio: ${src}`));
        audio.src = src;
      }),
      src,
    ),
};

/**
 * Look at one file and say what it is.
 *
 * Throws for an extension the editor has no renderer for — the caller decides
 * whether that loses the whole batch or just one item.
 */
export async function probeMedia(
  filepath: string,
  prober: MediaProber = domProber,
): Promise<MediaProbe> {
  const localpath = toLocalPath(filepath);
  const kind: MediaKind | null = mediaKindOf(filepath);

  if (kind == null) {
    throw new Error(
      `Cartcut has no renderer for "${filepath}". Supported: video, image, gif and audio files.`,
    );
  }

  switch (kind) {
    case "video": {
      const probed = await prober.video(localpath);
      return { kind, localpath, ...probed };
    }
    case "audio": {
      const probed = await prober.audio(localpath);
      return {
        kind,
        localpath,
        durationMs: probed.durationMs,
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
