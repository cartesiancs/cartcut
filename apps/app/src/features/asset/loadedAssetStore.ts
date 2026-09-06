import { createStore } from "zustand/vanilla";
import { getLocationEnv } from "../../functions/getLocationEnv";
import { decompressFrames, parseGIF, type ParsedFrame } from "gifuct-js";
import {
  isVisualTimelineElement,
  type AudioElementType,
  type Timeline,
  type VideoElementType,
  type VisualTimelineElement,
} from "../../@types/timeline";
import { VideoFilterPipeline } from "../renderer/filter/videoPipeline";
import { isElementVisibleAtTime } from "../element/time";
import { decodersFor } from "./decoderWindow";
import { playbackPathFor } from "../../states/proxyStore";
import { toLocalPath } from "../element/mediaProbe";
import { count as perfCount, gauge as perfGauge } from "../debug/frameStats";
import { sourceTimeAt, speedOf } from "../timeline/geometry";
import { frameSampleMs } from "../timeline/frames";
import {
  syncPlayback as syncPlaybackHandles,
  whenSeeksLand,
  type MediaHandle,
  type SeekRequest,
} from "../timeline/playback";
import { runAssetBatch, type AssetLoadTask } from "./assetBatch";
import { SCHEMA_VERSION, type TimelineTrack } from "../timeline/tracks";

type GifMetadata = {
  imageData: ImageData;
  parsedFrame: ParsedFrame;
};

/**
 * A decoded video, addressed by the element that asked for it.
 *
 * It deliberately holds **no copy of the element**. It used to, and because
 * every edit returns a new object while this entry was never refreshed, the
 * copy froze at load time — so a moved clip played footage offset by exactly
 * the drag distance. The live element is now passed in at every call site
 * instead, which makes that class of bug unrepresentable.
 */
export type VideoMetadataPerElement = {
  elementId: string;
  /** The source this was decoded from, so a changed path can be detected. */
  localpath: string;
  /**
   * The file this handle actually opened — the proxy when one is in use.
   *
   * Distinct from `localpath`, which stays the element's own path so every
   * other consumer is unaffected. Compared on each reconcile so that toggling
   * proxies, or a proxy finishing generation mid-session, rebuilds the handles
   * that are now pointing at the wrong rendition.
   */
  playbackPath: string;
  path: string;
  object: HTMLVideoElement;
};

/** What a load pass may skip. */
export type AssetLoadOptions = {
  /**
   * Decode `<audio>` handles. Export passes `false`: FFmpeg reconstructs the
   * audio graph from the timeline, so the renderer never reads them.
   */
  audio?: boolean;
};

export interface ILoadedAssetStore {
  // path, image
  _loadedImage: Record<string, HTMLImageElement>;

  /**
   * Paths whose decode is in flight, for the same reason video has one: the
   * preview fires `loadAssetsNeededAtTime` un-awaited on every repaint, so
   * without this a clip that takes a moment to decode spawns a fresh loader on
   * every frame until the first one lands.
   */
  _loadingImage: Set<string>;

  // path, gif
  _loadedGif: Record<string, GifMetadata[]>;
  _loadingGif: Set<string>;

  // elementId, video
  _loadedElementVideo: Record<string, VideoMetadataPerElement>;

  /**
   * Element ids whose decode is in flight.
   *
   * The cache only fills on `loadeddata`, and the preview calls
   * `loadAssetsNeededAtTime` un-awaited on every repaint — so without this a
   * scrub onto an unloaded clip spawned a fresh `<video>` at frame rate until
   * the first one resolved, and every loser leaked.
   */
  _loadingElementVideo: Set<string>;

  /**
   * elementId → `<audio>`.
   *
   * Audio clips used to be driven by a second scheduler in `elementControl`
   * that ignored `trim` and `speed` outright — a split clip replayed the part
   * that had been cut. They go through the same sync as video now.
   */
  _loadedElementAudio: Record<string, HTMLAudioElement>;
  _loadingElementAudio: Set<string>;

  loadElementAudio: (
    elementId: string,
    element: AudioElementType,
  ) => Promise<void>;

  gifCanvasCtx: CanvasRenderingContext2D;
  videoFilterCanvasCtx: WebGLRenderingContext;
  videoFilterPipeline: VideoFilterPipeline | null;

  loadImage: (localpath: string) => Promise<void>;
  getImage: (localpath: string) => HTMLImageElement | null;

  loadGif: (localpath: string) => Promise<void>;
  getGif: (localpath: string) => GifMetadata[] | null;

  loadElementVideo: (
    elementId: string,
    videoElement: VideoElementType,
  ) => Promise<void>;
  getElementVideo: (elementId: string) => VideoMetadataPerElement | null;

  loadEntireTimeline: (
    timeline: Timeline,
    options?: AssetLoadOptions,
  ) => Promise<void>;
  /** Resolves true when something new finished decoding. */
  loadAssetsNeededAtTime: (t: number, timeline: Timeline) => Promise<boolean>;
  _loadAssetsWithFilter: (
    timeline: Timeline,
    filter:
      | ((element: VisualTimelineElement, elementId: string) => boolean)
      | null,
    options?: AssetLoadOptions,
    /**
     * The playhead, when the caller wants distant decoders released too.
     *
     * Absent for export, which loads the whole timeline deliberately and must
     * never have a handle taken away from under its frame loop.
     */
    cursorMs?: number,
  ) => Promise<boolean>;

  /**
   * `fps` is the project frame rate, and it is required rather than optional:
   * without it a frame is addressed at its boundary and a third to two thirds
   * of an export shows the previous frame. See `frames.ts#frameSampleMs`.
   */
  seek: (timeline: Timeline, time: number, fps: number) => Promise<void>;

  /**
   * Bring every decoded handle in line with the timeline.
   *
   * Called from the preview's draw path, which runs on every store change —
   * including every cursor tick — so this is what keeps playback positions
   * honest and, crucially, silences a clip the moment the playhead leaves it.
   *
   * `onSeeksLand` is invoked once after the frames requested by this call have
   * actually decoded. Callers that paint must pass it: assigning `currentTime`
   * only requests a frame, so painting immediately paints the previous one.
   *
   * Returns the seeks it issued.
   */
  syncPlayback: (
    timeline: Timeline,
    cursorMs: number,
    isPlaying: boolean,
    onSeeksLand?: () => void,
  ) => SeekRequest[];

  /**
   * elementId → the seek target we last waited on, so the same target is never
   * waited on twice. See `whenSeeksLand` for why that would otherwise loop.
   */
  _awaitedSeeks: Map<string, number>;

  /**
   * elementId → the source time this handle was last *asked* to go to.
   *
   * Distinct from `_awaitedSeeks`, which records what a repaint is waiting on.
   * This is what stops the seek being issued in the first place — see
   * `playback.ts#applyIntent`. A handle that is parked off the playhead has a
   * constant target, so after the first placement every later reconcile finds
   * the same number here and does nothing.
   */
  _lastSeekRequests: Map<string, number>;

  /**
   * Drop videos whose element is gone or whose source path changed.
   *
   * With `cursorMs`, also drop those that have drifted outside
   * `decoderWindow.releaseWindow` — the preview passes it, export does not.
   */
  releaseUnusedVideos: (timeline: Timeline, cursorMs?: number) => void;
}

export const loadedAssetStore = createStore<ILoadedAssetStore>((set, get) => ({
  _awaitedSeeks: new Map<string, number>(),
  _lastSeekRequests: new Map<string, number>(),
  _loadedImage: {},
  _loadingImage: new Set<string>(),
  _loadedGif: {},
  _loadingGif: new Set<string>(),
  _loadedElementVideo: {},
  _loadingElementVideo: new Set<string>(),
  _loadedElementAudio: {},
  _loadingElementAudio: new Set<string>(),

  gifCanvasCtx: document
    .createElement("canvas")
    .getContext("2d") as CanvasRenderingContext2D,
  videoFilterCanvasCtx: document.createElement("canvas").getContext("webgl", {
    preserveDrawingBuffer: true,
    alpha: true,
  }) as WebGLRenderingContext,
  videoFilterPipeline: null,

  loadImage(localpath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.src = getPath(localpath);
      img.addEventListener(
        "load",
        () => {
          set((state) => ({
            _loadedImage: { ...state._loadedImage, [localpath]: img },
          }));
          resolve();
        },
        { once: true },
      );
      img.addEventListener(
        "error",
        (e) => {
          console.error("Failed to load image:", e);
          reject(e);
        },
        { once: true },
      );
    });
  },
  getImage(localpath) {
    return get()._loadedImage[localpath] ?? null;
  },

  async loadGif(localpath) {
    const response = await fetch(getPath(localpath));
    const buffer = await response.arrayBuffer();

    const gif = parseGIF(buffer);
    const frames = decompressFrames(gif, true);
    const drawnFrames = frames.map((frame) => {
      const { width, height } = frame.dims;
      const imageData = this.gifCanvasCtx.createImageData(width, height);
      imageData.data.set(frame.patch);
      return {
        imageData,
        parsedFrame: frame,
      };
    });

    set((state) => ({
      _loadedGif: { ...state._loadedGif, [localpath]: drawnFrames },
    }));
  },
  getGif(localpath) {
    return get()._loadedGif[localpath] ?? null;
  },

  async loadElementVideo(elementId, videoElement) {
    return new Promise((resolve, reject) => {
      const video = document.createElement("video");
      video.playbackRate = videoElement.speed;

      // **The one place a proxy is substituted for its source.**
      //
      // Everything downstream — the compositor, `syncPlayback`, the hit tests,
      // the MCP tools — goes on reading `element.localpath` and never learns
      // that a smaller file is what actually decoded, which is exactly the
      // property that let this feature be added without touching any of them.
      // Export does not come through here at all: it drives handles built by
      // `loadEntireTimeline` and reads `localpath` directly, so a delivered
      // file is always cut from the originals.
      const playbackPath = toLocalPath(playbackPathFor(videoElement.localpath));
      video.src = playbackPath;

      video.addEventListener(
        "loadeddata",
        () => {
          video.currentTime = 0;
          // A brand new handle sits at zero whatever the old one was doing, so
          // any remembered request would suppress its first real placement.
          this._lastSeekRequests.delete(elementId);
          this._awaitedSeeks.delete(elementId);
          this._loadedElementVideo[elementId] = {
            elementId,
            localpath: videoElement.localpath,
            // What this handle is actually decoding. `localpath` above stays
            // the element's own, so the "did the clip change file?" test keeps
            // working; this is the separate question "is this handle still the
            // right *rendition*?", which a proxy toggle changes without the
            // element changing at all.
            playbackPath,
            path: getPath(videoElement.localpath),
            object: video,
          };
          resolve();
        },
        { once: true },
      );
      video.addEventListener(
        "error",
        (e) => {
          console.error("Failed to load video:", e);
          reject(e);
        },
        { once: true },
      );
    });
  },
  getElementVideo(elementId) {
    return get()._loadedElementVideo[elementId] ?? null;
  },

  loadElementAudio(elementId, element) {
    return new Promise<void>((resolve, reject) => {
      // Detached: an `Audio` plays perfectly well without being in the DOM,
      // and the old path's reliance on finding a rendered `<audio>` by id is
      // exactly what threw a TypeError and froze the playback loop.
      const audio = new Audio(getPath(element.localpath));
      audio.preload = "auto";

      audio.addEventListener(
        "loadeddata",
        () => {
          this._loadedElementAudio[elementId] = audio;
          resolve();
        },
        { once: true },
      );
      audio.addEventListener("error", (e) => reject(e), { once: true });
    });
  },

  async loadEntireTimeline(timeline: Timeline, options) {
    await this._loadAssetsWithFilter(timeline, null, options);
  },
  async loadAssetsNeededAtTime(t: number, timeline: Timeline) {
    // Video answers to the decoder window rather than to visibility, for the
    // two reasons `decoderWindow.ts` sets out: a clip that only starts decoding
    // when the playhead reaches it stutters at the cut, and a clip that keeps
    // its decoder forever is one of seventy-five a page is allowed. Everything
    // else — images, gifs — is cheap and keeps the visibility test it had.
    const { load } = decodersFor(timeline, t);
    return this._loadAssetsWithFilter(
      timeline,
      (element, elementId) =>
        element.filetype === "video"
          ? load.has(elementId) || isElementVisibleAtTime(t, timeline, element)
          : isElementVisibleAtTime(t, timeline, element),
      undefined,
      t,
    );
  },
  async _loadAssetsWithFilter(timeline, filter, options, cursorMs) {
    // Drop handles for clips that are gone or now point at another file, so
    // the cache cannot outlive the timeline it was built from — and, when a
    // cursor is supplied, for clips that have drifted out of reach of it.
    get().releaseUnusedVideos(timeline, cursorMs);

    const idElementPairs = Object.entries(timeline);
    const visibleElements = idElementPairs.filter(
      (x): x is [string, VisualTimelineElement] => {
        return isVisualTimelineElement(x[1]) && (filter?.(x[1], x[0]) ?? true);
      },
    );

    const store = get();
    const tasks: AssetLoadTask[] = [];

    for (const [elementId, element] of visibleElements) {
      switch (element.filetype) {
        case "image":
          if (store._loadedImage[element.localpath] == null) {
            const key = element.localpath;
            tasks.push({
              key,
              inFlight: store._loadingImage,
              start: () => store.loadImage(key),
            });
          }
          break;
        case "gif":
          if (store._loadedGif[element.localpath] == null) {
            const key = element.localpath;
            tasks.push({
              key,
              inFlight: store._loadingGif,
              start: () => store.loadGif(key),
            });
          }
          break;
        case "video":
          if (store._loadedElementVideo[elementId] == null) {
            tasks.push({
              key: elementId,
              inFlight: store._loadingElementVideo,
              start: () => store.loadElementVideo(elementId, element),
            });
          }
          break;
      }
    }

    // Audio is not a visual element, so it never reaches the switch above.
    //
    // Export opts out: FFmpeg rebuilds the whole audio graph from the timeline,
    // so an `Audio()` per clip is pure cost there — and a hazard, since export
    // never calls `syncPlayback`, leaving nothing to own their state.
    if (options?.audio !== false) {
      for (const [elementId, element] of idElementPairs) {
        if (
          element.filetype !== "audio" ||
          store._loadedElementAudio[elementId] != null
        ) {
          continue;
        }
        tasks.push({
          key: elementId,
          inFlight: store._loadingElementAudio,
          start: () => store.loadElementAudio(elementId, element),
        });
      }
    }

    // Whether anything new arrived. A handle that finishes decoding after the
    // last repaint would otherwise sit unsynchronised — at position zero,
    // silent or not, until some unrelated change happened to redraw.
    return runAssetBatch(tasks);
  },

  /**
   * Seek every visible video to `time` and wait for it to land.
   *
   * The export path needs frame-exact positioning, so unlike the preview it
   * waits. `timeline` was already a parameter here and was then ignored in
   * favour of a stale copy; it is now actually used.
   *
   * `fps` is what makes the positioning frame-exact rather than merely close.
   * A frame is addressed at its centre, not at its boundary — see
   * `frames.ts#frameSampleMs` for why that distinction decides whether an
   * export shows the right frame or the one before it.
   */
  async seek(timeline, time, fps) {
    const metas = Object.values(get()._loadedElementVideo).filter((meta) => {
      const element = timeline[meta.elementId];
      return (
        element != null &&
        isVisualTimelineElement(element) &&
        // The *unbiased* instant. Visibility is a question about the timeline
        // moment, and asking it half a frame late would let a clip appear or
        // vanish one frame off. Only the address inside a visible clip moves.
        isElementVisibleAtTime(time, timeline, element)
      );
    });

    await Promise.all(
      metas.map(
        (meta) =>
          new Promise<void>((resolve) => {
            const element = timeline[meta.elementId] as VideoElementType;
            const video = meta.object;
            // Deliberately NOT clamped to the trim window. Inside a transition
            // this clip is being asked for frames past its out-point — or
            // before its in-point — which is the whole mechanism, and
            // `sourceTimeAt` extrapolates there correctly because it is linear.
            // `maxTransitionMs` already guarantees the frames exist in the file.
            //
            // The half-frame goes in on the *timeline* side of `sourceTimeAt`,
            // not after it. That is what makes it correct for a retimed clip:
            // the conversion multiplies by `speed`, so a 2x clip needs two
            // source frames of offset per timeline frame and a 0.25x clip a
            // quarter of one. Adding a fixed offset to the source time instead
            // would be right only at speed 1.
            const want = sourceTimeAt(element, frameSampleMs(time, fps)) / 1000;

            video.playbackRate = speedOf(element);

            // Export drives the handles itself rather than through
            // `syncPlayback`, so it has to keep the request record honest — a
            // stale entry would suppress the preview's next placement when the
            // export finishes and the user scrubs.
            get()._lastSeekRequests.set(meta.elementId, want);

            // Assigning the position it already holds fires no `seeked`, so
            // waiting for one would stall the export's frame loop forever.
            if (Math.abs(video.currentTime - want) < 1e-3) {
              resolve();
              return;
            }

            video.addEventListener("seeked", () => resolve(), { once: true });
            video.currentTime = want;
          }),
      ),
    );
  },

  syncPlayback(timeline, cursorMs, isPlaying, onSeeksLand) {
    const state = get();
    const handles: Record<string, MediaHandle> = {};
    for (const meta of Object.values(state._loadedElementVideo)) {
      handles[meta.elementId] = meta.object;
    }
    for (const [elementId, audio] of Object.entries(
      state._loadedElementAudio,
    )) {
      handles[elementId] = audio;
    }

    const seeks = syncPlaybackHandles(
      asDocument(timeline),
      cursorMs,
      isPlaying,
      handles,
      undefined,
      get()._lastSeekRequests,
    );

    // The two numbers that say whether the media layer is healthy: how many
    // decoders are alive, and how many seeks a frame costs. A parked clip
    // should contribute nothing to the second.
    perfGauge("media.decoders", Object.keys(state._loadedElementVideo).length);
    for (let i = 0; i < seeks.length; i++) {
      perfCount("media.seek");
    }

    // The seeked frames are not decoded yet. A painter that stops here shows
    // the frame from before the seek — which for a clip that was just added is
    // no frame at all, until something unrelated happens to repaint.
    if (onSeeksLand != null && seeks.length > 0) {
      whenSeeksLand(handles, seeks, onSeeksLand, get()._awaitedSeeks);
    }

    return seeks;
  },

  releaseUnusedVideos(timeline, cursorMs) {
    const loadedAudio = get()._loadedElementAudio;
    for (const [elementId, audio] of Object.entries(loadedAudio)) {
      const element = timeline[elementId];
      if (element != null && element.filetype === "audio") {
        continue;
      }
      audio.pause();
      audio.muted = true;
      audio.removeAttribute("src");
      delete loadedAudio[elementId];
      get()._loadingElementAudio.delete(elementId);
      // The next handle for this id starts at zero, so a remembered request
      // from the old one would suppress its first placement.
      get()._lastSeekRequests.delete(elementId);
      get()._awaitedSeeks.delete(elementId);
    }

    const loaded = get()._loadedElementVideo;
    // Only computed when a cursor was supplied; export passes none and must
    // keep every handle it has been given.
    const keep =
      cursorMs == null ? null : decodersFor(timeline, cursorMs).keep;

    for (const [elementId, meta] of Object.entries(loaded)) {
      const element = timeline[elementId];
      const stillValid =
        element != null &&
        element.filetype === "video" &&
        element.localpath === meta.localpath &&
        // A proxy toggle changes nothing about the element, so this is the only
        // thing that notices it. Without it, turning proxies on would take
        // effect only for clips that happened to be loaded afterwards.
        meta.playbackPath === toLocalPath(playbackPathFor(element.localpath)) &&
        (keep == null || keep.has(elementId));

      if (stillValid) {
        continue;
      }

      // Nothing else will ever visit this handle again, so silence it before
      // letting go — otherwise a deleted clip keeps playing.
      meta.object.pause();
      meta.object.muted = true;
      meta.object.removeAttribute("src");
      meta.object.load();
      delete loaded[elementId];
      get()._loadingElementVideo.delete(elementId);
      get()._lastSeekRequests.delete(elementId);
      get()._awaitedSeeks.delete(elementId);
    }
  },
}));

/**
 * Wrap a bare element map so the pure playback module can consume it.
 *
 * Playback only reads `elements`, so the tracks are irrelevant here — but the
 * module's input type is the whole document, which keeps it honest for every
 * other caller.
 */
function asDocument(timeline: Timeline) {
  return {
    schemaVersion: SCHEMA_VERSION,
    tracks: [] as TimelineTrack[],
    elements: timeline,
  };
}

function getPath(path: string) {
  const nowEnv = getLocationEnv();
  let filepath = path;
  if (nowEnv == "electron") {
    filepath = path;
  } else if (nowEnv == "web") {
    filepath = `/api/file?path=${path}`;
  } else {
    filepath = path;
  }

  return filepath;
}
