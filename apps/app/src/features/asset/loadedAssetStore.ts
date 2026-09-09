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
import {
  activeVideoScope,
  type VideoMetadataPerElement,
  type VideoScope,
} from "./videoScope";
import { SCHEMA_VERSION, type TimelineTrack } from "../timeline/tracks";

type GifMetadata = {
  imageData: ImageData;
  parsedFrame: ParsedFrame;
};

/**
 * Re-exported so `renderer/filter/videoPipeline.ts` and the rest go on
 * importing it from here. It lives in `videoScope.ts` because that module is
 * DOM-free and this one builds canvases at load.
 */
export type { VideoMetadataPerElement } from "./videoScope";

/** What a load pass may skip, and where its video handles land. */
export type AssetLoadOptions = {
  /**
   * Decode `<audio>` handles. Export passes `false`: FFmpeg reconstructs the
   * audio graph from the timeline, so the renderer never reads them.
   */
  audio?: boolean;
  /**
   * Put decoded videos here rather than in the shared cache.
   *
   * Set only by `loadExportScope`. With a scope, the stale-handle sweep at the
   * top of the pass is skipped as well — a fresh scope has nothing stale in it,
   * and running the sweep would have an export release the *preview's* handles.
   */
  scope?: VideoScope;
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
    /** Where the handle lands. Absent means the shared cache. */
    scope?: VideoScope,
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
   * Decode everything an export will draw, with the videos in a scope of its own.
   *
   * Replaces `loadEntireTimeline` on the export path. Images and gifs stay in
   * the shared cache — they are keyed by path and immutable once decoded, so
   * nothing can move one under a frame loop — and only `<video>`, which carries
   * mutable seek state, is separated.
   *
   * Audio is never loaded: FFmpeg rebuilds the whole audio graph from the
   * timeline sent at `render:v2:start`.
   */
  loadExportScope: (scope: VideoScope, timeline: Timeline) => Promise<void>;

  /** `seek`, against a scope's handles rather than the shared ones. */
  seekScope: (
    scope: VideoScope,
    timeline: Timeline,
    time: number,
    fps: number,
  ) => Promise<void>;

  /**
   * Silence and drop every handle in a scope.
   *
   * Called from `renderTimeline`'s `finally`, so an export releases its
   * decoders deterministically at the end of its run rather than leaving them
   * in the shared cache until the preview's decoder window happens to evict
   * them.
   */
  releaseVideoScope: (scope: VideoScope) => void;

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

  async loadElementVideo(elementId, videoElement, scope) {
    return new Promise((resolve, reject) => {
      const video = document.createElement("video");
      video.playbackRate = videoElement.speed;

      // **The one place a proxy is substituted for its source.**
      //
      // Everything downstream — the compositor, `syncPlayback`, the hit tests,
      // the MCP tools — goes on reading `element.localpath` and never learns
      // that a smaller file is what actually decoded, which is exactly the
      // property that let this feature be added without touching any of them.
      //
      // This comment used to claim export did not come through here and that a
      // delivered file was therefore always cut from the originals. That is
      // simply false — `loadExportScope` reaches this function like everything
      // else, so an export encodes whatever rendition `playbackPathFor`
      // answers with, and `proxyStore`'s default mode is "prefer". Left as it
      // is on purpose: changing it changes what the app renders, which is a
      // separate decision from where the render runs.
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
          const meta: VideoMetadataPerElement = {
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
          // The scope this load belongs to owns the handle. Without the
          // parameter an export's decoder would land in the shared cache and
          // the preview would seek it on its next repaint.
          if (scope != null) {
            scope.videos[elementId] = meta;
            scope.lastSeekRequests.delete(elementId);
          } else {
            this._loadedElementVideo[elementId] = meta;
          }
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
    // **The seam that makes a background export safe.**
    //
    // The active scope answers alone — there is deliberately no fallback to
    // the shared map. A handle an export did not load is a handle nothing has
    // placed, and drawing the preview's copy of it would be exactly the
    // corruption this scope exists to prevent: it turns a visible "this clip
    // is missing" into an invisible "this clip is at the preview's playhead".
    //
    // Scoping the *lookup* rather than the renderer table is what covers a
    // template's nested clips too — `App.ts` installs one table on the
    // template resolver globally, so a per-caller table would never reach them.
    const scope = activeVideoScope();
    if (scope != null) {
      return scope.videos[elementId] ?? null;
    }
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
    const scope = options?.scope;

    // Drop handles for clips that are gone or now point at another file, so
    // the cache cannot outlive the timeline it was built from — and, when a
    // cursor is supplied, for clips that have drifted out of reach of it.
    //
    // Skipped for a scope load. A fresh scope has nothing stale in it, and
    // this sweep reads `_loadedElementVideo` — so running it would have an
    // export release the *preview's* handles, which is the bug inverted.
    if (scope == null) {
      get().releaseUnusedVideos(timeline, cursorMs);
    }

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
        case "video": {
          // A scope has its own handle record and its own in-flight set. The
          // second is what closes a real defect for the export: `runAssetBatch`
          // skips a key already in flight, so a clip the preview had started
          // decoding made `loadEntireTimeline` resolve without it.
          const videos = scope?.videos ?? store._loadedElementVideo;
          const inFlight = scope?.loading ?? store._loadingElementVideo;
          if (videos[elementId] == null) {
            tasks.push({
              key: elementId,
              inFlight,
              start: () => store.loadElementVideo(elementId, element, scope),
            });
          }
          break;
        }
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
    await seekHandles(
      get()._loadedElementVideo,
      get()._lastSeekRequests,
      timeline,
      time,
      fps,
    );
  },

  async loadExportScope(scope, timeline) {
    await get()._loadAssetsWithFilter(timeline, null, {
      audio: false,
      scope,
    });
  },

  async seekScope(scope, timeline, time, fps) {
    await seekHandles(
      scope.videos,
      scope.lastSeekRequests,
      timeline,
      time,
      fps,
    );
  },

  releaseVideoScope(scope) {
    for (const elementId of Object.keys(scope.videos)) {
      releaseHandle(scope.videos[elementId].object);
      delete scope.videos[elementId];
    }
    scope.loading.clear();
    scope.lastSeekRequests.clear();
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

      releaseHandle(meta.object);
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


/**
 * Seek every handle in `videos` that is visible at `time`, and wait.
 *
 * Shared by `seek` (the shared cache) and `seekScope` (an export's own), so
 * the two cannot drift — the frame-addressing rules below are the difference
 * between an export showing the right frame and the one before it.
 *
 * The export path needs frame-exact positioning, so unlike the preview it
 * waits.
 */
async function seekHandles(
  videos: Record<string, VideoMetadataPerElement>,
  lastSeekRequests: Map<string, number>,
  timeline: Timeline,
  time: number,
  fps: number,
): Promise<void> {
  const metas = Object.values(videos).filter((meta) => {
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

          // The caller drives the handles itself rather than through
          // `syncPlayback`, so it has to keep its own request record honest —
          // a stale entry would suppress the next placement.
          lastSeekRequests.set(meta.elementId, want);

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
}

/**
 * Silence a handle and let go of it.
 *
 * Shared by `releaseUnusedVideos` and `releaseVideoScope`: nothing will ever
 * visit this handle again, so it has to be silenced before it is dropped —
 * otherwise a deleted clip keeps playing.
 */
function releaseHandle(video: HTMLVideoElement): void {
  video.pause();
  video.muted = true;
  video.removeAttribute("src");
  video.load();
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
