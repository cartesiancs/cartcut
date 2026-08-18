import { createStore } from "zustand/vanilla";
import { getLocationEnv } from "../../functions/getLocationEnv";
import { decompressFrames, parseGIF, type ParsedFrame } from "gifuct-js";
import {
  isVisualTimelineElement,
  type Timeline,
  type VideoElementType,
  type VisualTimelineElement,
} from "../../@types/timeline";
import { VideoFilterPipeline } from "../renderer/filter/videoPipeline";
import { isElementVisibleAtTime } from "../element/time";
import { sourceTimeAt } from "../timeline/geometry";

type GifMetadata = {
  imageData: ImageData;
  parsedFrame: ParsedFrame;
};

export type VideoMetadataPerElement = {
  elementId: string;
  element: VideoElementType;
  path: string;
  canvas: HTMLCanvasElement;
  object: HTMLVideoElement;
  isPlay: boolean;
};

export interface ILoadedAssetStore {
  // path, image
  _loadedImage: Record<string, HTMLImageElement>;

  // path, gif
  _loadedGif: Record<string, GifMetadata[]>;

  // elementId, video
  _loadedElementVideo: Record<string, VideoMetadataPerElement>;

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
  loadAssetsNeededAtTime: (t: number, timeline: Timeline) => Promise<void>;
  _loadAssetsWithFilter: (
    timeline: Timeline,
    filter: ((element: VisualTimelineElement) => boolean) | null,
  ) => Promise<void>;

  seek: (timeline: Timeline, time: number) => Promise<void>;
  startPlay: (timelineCursor: number) => void;
  stopPlay: (timelineCursor: number) => void;
}

export const loadedAssetStore = createStore<ILoadedAssetStore>((set, get) => ({
  _loadedImage: {},
  _loadedGif: {},
  _loadedElementVideo: {},

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
            element: videoElement,
            path: getPath(videoElement.localpath),
            canvas: canvas,
            object: video,
            isPlay: false,
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

  async loadEntireTimeline(timeline: Timeline) {
    await this._loadAssetsWithFilter(timeline, null);
  },
  async loadAssetsNeededAtTime(t: number, timeline: Timeline) {
    await this._loadAssetsWithFilter(timeline, (element) => {
      return isElementVisibleAtTime(t, timeline, element);
    });
  },
  async _loadAssetsWithFilter(timeline, filter) {
    const idElementPairs = Object.entries(timeline);
    const visibleElements = idElementPairs.filter(
      (x): x is [string, VisualTimelineElement] => {
        return isVisualTimelineElement(x[1]) && (filter?.(x[1]) ?? true);
      },
    );

    const store = get();
    const loadPromises = visibleElements.map(([elementId, element]) => {
      switch (element.filetype) {
        case "image":
          if (store._loadedImage[element.localpath] == null) {
            return store.loadImage(element.localpath);
          }
          break;
        case "gif":
          if (store._loadedGif[element.localpath] == null) {
            return store.loadGif(element.localpath);
          }
          break;
        case "video":
          if (store._loadedElementVideo[elementId] == null) {
            return store.loadElementVideo(elementId, element);
          }
          break;
      }

      return null;
    });
    await Promise.all(loadPromises.filter((x) => x != null));
  },

  async seek(timeline, time) {
    const videoMetas = Object.values(get()._loadedElementVideo);
    const visibleVideoMetas = videoMetas.filter((meta) => {
      const element = meta.element;
      return isElementVisibleAtTime(time, timeline, element);
    });
    const seekPromises = visibleVideoMetas.map(
      (meta) =>
        new Promise<void>((resolve, reject) => {
          const video = meta.object;
          // `sourceTimeAt` adds the trim offset this line used to drop, which
          // is why a trimmed clip previewed the untrimmed frame.
          video.currentTime = sourceTimeAt(meta.element, time) / 1000;
          video.playbackRate = meta.element.speed;

          video.addEventListener(
            "seeked",
            () => {
              resolve();
            },
            { once: true },
          );
        }),
    );

    await Promise.all(seekPromises);
  },

  startPlay(timelineCursor: number) {
    const videoMetas = Object.values(get()._loadedElementVideo);
    for (const meta of videoMetas) {
      meta.object.currentTime =
        sourceTimeAt(meta.element, timelineCursor) / 1000;
      meta.object.playbackRate = meta.element.speed;
      meta.object.muted = true;
      meta.isPlay = true;
      meta.object.play();
    }
  },

  stopPlay(timelineCursor: number) {
    const videoMetas = Object.values(get()._loadedElementVideo);
    for (const meta of videoMetas) {
      meta.isPlay = false;
      meta.object.pause();
      meta.object.currentTime =
        sourceTimeAt(meta.element, timelineCursor) / 1000;
    }
  },
}));

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
