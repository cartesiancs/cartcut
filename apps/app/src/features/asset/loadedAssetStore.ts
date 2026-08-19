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
import { sourceTimeAt, speedOf } from "../timeline/geometry";
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
  path: string;
  canvas: HTMLCanvasElement;
  object: HTMLVideoElement;
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

  loadEntireTimeline: (timeline: Timeline) => Promise<void>;
  /** Resolves true when something new finished decoding. */
  loadAssetsNeededAtTime: (t: number, timeline: Timeline) => Promise<boolean>;
  _loadAssetsWithFilter: (
    timeline: Timeline,
    filter: ((element: VisualTimelineElement) => boolean) | null,
  ) => Promise<boolean>;

  seek: (timeline: Timeline, time: number) => Promise<void>;

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

  /** Drop videos whose element is gone or whose source path changed. */
  releaseUnusedVideos: (timeline: Timeline) => void;
}

export const loadedAssetStore = createStore<ILoadedAssetStore>((set, get) => ({
  _awaitedSeeks: new Map<string, number>(),
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

      const canvas = document.createElement("canvas");
      canvas.width = videoElement.width;
      canvas.height = videoElement.height;

      video.src = videoElement.localpath;

      video.addEventListener(
        "loadeddata",
        () => {
          video.currentTime = 0;
          this._loadedElementVideo[elementId] = {
            elementId,
            localpath: videoElement.localpath,
            path: getPath(videoElement.localpath),
            canvas: canvas,
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

  async loadEntireTimeline(timeline: Timeline) {
    await this._loadAssetsWithFilter(timeline, null);
  },
  async loadAssetsNeededAtTime(t: number, timeline: Timeline) {
    return this._loadAssetsWithFilter(timeline, (element) => {
      return isElementVisibleAtTime(t, timeline, element);
    });
  },
  async _loadAssetsWithFilter(timeline, filter) {
    // Drop handles for clips that are gone or now point at another file, so
    // the cache cannot outlive the timeline it was built from.
    get().releaseUnusedVideos(timeline);

    const idElementPairs = Object.entries(timeline);
    const visibleElements = idElementPairs.filter(
      (x): x is [string, VisualTimelineElement] => {
        return isVisualTimelineElement(x[1]) && (filter?.(x[1]) ?? true);
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
   */
  async seek(timeline, time) {
    const metas = Object.values(get()._loadedElementVideo).filter((meta) => {
      const element = timeline[meta.elementId];
      return (
        element != null &&
        isVisualTimelineElement(element) &&
        isElementVisibleAtTime(time, timeline, element)
      );
    });

    await Promise.all(
      metas.map(
        (meta) =>
          new Promise<void>((resolve) => {
            const element = timeline[meta.elementId] as VideoElementType;
            const video = meta.object;
            const want = sourceTimeAt(element, time) / 1000;

            video.playbackRate = speedOf(element);

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
    );

    // The seeked frames are not decoded yet. A painter that stops here shows
    // the frame from before the seek — which for a clip that was just added is
    // no frame at all, until something unrelated happens to repaint.
    if (onSeeksLand != null && seeks.length > 0) {
      whenSeeksLand(handles, seeks, onSeeksLand, get()._awaitedSeeks);
    }

    return seeks;
  },

  releaseUnusedVideos(timeline) {
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
    }

    const loaded = get()._loadedElementVideo;

    for (const [elementId, meta] of Object.entries(loaded)) {
      const element = timeline[elementId];
      const stillValid =
        element != null &&
        element.filetype === "video" &&
        element.localpath === meta.localpath;

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
