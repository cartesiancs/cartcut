/**
 * The shape of a media element, in one place — and deliberately DOM-free.
 *
 * `elementControl.addVideo/addImage/addAudio/addGif` used to build these inline
 * and commit them, in callbacks with no promise and no returned id. That is
 * right for a user clicking an asset and wrong for anything that needs to place
 * several files as one undo step, or to know afterwards what it created.
 *
 * The split here goes one step further than `textElement.ts`'s: the *probe* —
 * reading a file's dimensions, duration and whether it carries sound — needs
 * `<video>`, `<img>` and an IPC call, and lives in `mediaProbe.ts`. What is
 * left is arithmetic on a plain object, which is what makes it testable under
 * vitest's `environment: "node"`.
 */

import { emptyAnimation } from "../animation/keyframes";
import { renderOptionStore } from "../../states/renderOptionStore";
import mime from "../../functions/mime";
import type {
  AudioElementType,
  GifElementType,
  ImageElementType,
  TimelineElement,
  VideoElementType,
} from "../../@types/timeline";

export type MediaKind = "video" | "image" | "audio" | "gif";

/** Default length for a still, matching what the asset panel places. */
export const DEFAULT_STILL_MS = 1000;

/**
 * What a file turns out to be, once something has looked at it.
 *
 * `hasAudio` is only meaningful for video. `width`/`height` are 0 for audio,
 * which carries no picture.
 */
export type MediaProbe = {
  kind: MediaKind;
  localpath: string;
  durationMs: number;
  width: number;
  height: number;
  hasAudio: boolean;
};

/**
 * Which of the four kinds a path is, or `null` if the editor cannot place it.
 *
 * GIF is checked before image on purpose: `mime.lookup` reports it as its own
 * type here, and the two take different code paths — a GIF carries frames.
 */
export function mediaKindOf(filepath: string): MediaKind | null {
  const type = mime.lookup(filepath)?.type;
  if (type === "video" || type === "image" || type === "audio" || type === "gif") {
    return type;
  }
  return null;
}

/**
 * Fit a source's pixel size inside the project's frame, keeping its aspect.
 *
 * Lifted from `ElementControl.fitElementSizeOnPreview`, which now delegates
 * here — the agent and the mouse have to land the same size or the same file
 * added two ways looks different.
 */
export function fitToPreview(
  width: number,
  height: number,
  preview?: { w: number; h: number },
): { width: number; height: number } {
  const size = preview ?? renderOptionStore.getState().options.previewSize;
  const frame = { w: Number(size.w), h: Number(size.h) };

  const originRatio = width / height;
  const resizeHeight = height < frame.h ? height : frame.h;

  return { width: resizeHeight * originRatio, height: resizeHeight };
}

export type BuildOptions = {
  startTime?: number;
  /** Stills only. Video and audio take their length from the file. */
  durationMs?: number;
  previewSize?: { w: number; h: number };
};

/**
 * Turn a probe into a timeline element.
 *
 * `trackId` and `priority` are left unset: `placeNewElement` picks the row and
 * `derivePriorities` computes the paint rank from it. `blob` stays empty —
 * nothing on the preview or export path reads it (both load from `localpath`),
 * and the object URL the asset panel used to mint for it was never revoked.
 *
 * `key` is absent, which is why each builder casts through `unknown`. The type
 * declares it required, but the asset and preview layers are the only things
 * that ever populate it — `serialize.ts` takes an id parameter rather than
 * reading `element.key` for exactly this reason. Writing `key: ""` here to
 * satisfy the compiler would be worse than leaving it out: `audioTwinOf` copies
 * `key` into a tile cache key, and an empty string would collide across every
 * clip that shared it.
 */
export function buildMediaElement(
  probe: MediaProbe,
  options: BuildOptions = {},
): TimelineElement {
  const startTime = options.startTime ?? 0;

  switch (probe.kind) {
    case "video":
      return buildVideo(probe, startTime);
    case "audio":
      return buildAudio(probe, startTime);
    case "gif":
      return buildGif(probe, startTime, options);
    case "image":
    default:
      return buildImage(probe, startTime, options);
  }
}

function buildVideo(probe: MediaProbe, startTime: number): VideoElementType {
  const { width, height, durationMs } = probe;

  return {
    trackId: "",
    priority: 0,
    blob: "",
    startTime,
    duration: durationMs,
    opacity: 100,
    location: { x: 0, y: 0 },
    trim: { startTime: 0, endTime: durationMs },
    sourceDuration: durationMs,
    rotation: 0,
    // Video keeps its native pixel size rather than being fitted to the frame,
    // which is what `addVideo` has always done. Preserved deliberately: images
    // are fitted and video is not, and changing that here would silently
    // resize every clip an agent adds relative to one the user adds.
    width,
    height,
    ratio: width / height,
    localpath: probe.localpath,
    isExistAudio: probe.hasAudio,
    filetype: "video",
    codec: { video: "default", audio: "default" },
    speed: 1,
    filter: { enable: false, list: [] },
    origin: { width, height },
    animation: emptyAnimation("video"),
    timelineOptions: { color: "rgb(71, 59, 179)" },
  } as unknown as VideoElementType;
}

function buildAudio(probe: MediaProbe, startTime: number): AudioElementType {
  const { durationMs } = probe;

  return {
    trackId: "",
    priority: 0,
    blob: "",
    startTime,
    duration: durationMs,
    location: { x: 0, y: 0 }, // NOT USING
    trim: { startTime: 0, endTime: durationMs },
    sourceDuration: durationMs,
    localpath: probe.localpath,
    filetype: "audio",
    speed: 1,
    timelineOptions: { color: "rgb(133, 179, 59)" },
  } as unknown as AudioElementType;
}

function buildImage(
  probe: MediaProbe,
  startTime: number,
  options: BuildOptions,
): ImageElementType {
  const fitted = fitToPreview(probe.width, probe.height, options.previewSize);

  return {
    trackId: "",
    priority: 0,
    blob: "",
    startTime,
    duration: options.durationMs ?? DEFAULT_STILL_MS,
    opacity: 100,
    location: { x: 0, y: 0 },
    rotation: 0,
    width: fitted.width,
    height: fitted.height,
    localpath: probe.localpath,
    filetype: "image",
    ratio: probe.width / probe.height,
    animation: emptyAnimation("image"),
    timelineOptions: { color: "rgb(134, 41, 143)" },
  } as unknown as ImageElementType;
}

function buildGif(
  probe: MediaProbe,
  startTime: number,
  options: BuildOptions,
): GifElementType {
  return {
    trackId: "",
    priority: 0,
    blob: "",
    startTime,
    duration: options.durationMs ?? DEFAULT_STILL_MS,
    opacity: 100,
    location: { x: 0, y: 0 },
    rotation: 0,
    // A GIF keeps its frame size, as `addGif` has always done.
    width: probe.width,
    height: probe.height,
    localpath: probe.localpath,
    filetype: "gif",
    ratio: probe.width / probe.height,
    timelineOptions: { color: "rgb(134, 41, 143)" },
  } as unknown as GifElementType;
}
