import { describe, it, expect, vi, beforeEach } from "vitest";
import { scene, solid, pixel, videoElement } from "./testing";

/**
 * The filter pipeline needs a real WebGL context, so it is stubbed here. These
 * tests cover what the renderer decides — whether the clip is on screen, whether
 * it is audible, and whether the frame goes through the filters — not what the
 * shaders produce.
 */
const pipelineRender = vi.fn();

vi.mock("./filter/videoPipeline", () => ({
  VideoFilterPipeline: class {
    render = pipelineRender;
  },
}));

const store: Record<string, any> = {
  getElementVideo: vi.fn<[string], unknown>(),
  videoFilterPipeline: null,
  videoFilterCanvasCtx: {},
};

vi.mock("../asset/loadedAssetStore", () => ({
  loadedAssetStore: { getState: () => store },
}));

const { renderVideoWithWait, renderVideoWithoutWait } = await import("./video");

/**
 * Stands in for the store's video handle. The canvas has to keep its own
 * identity — a spread copy loses the prototype and `drawImage` rejects it — so
 * `muted` is hung off the canvas the way it would be off a <video>.
 */
function loadedVideo() {
  const object = solid(10, 10, "#ff0000") as any;
  object.muted = true;
  return { object };
}

beforeEach(() => {
  pipelineRender.mockReset();
  store.getElementVideo.mockReset();
  store.videoFilterPipeline = null;
});

describe("renderVideo", () => {
  it("draws the current frame over the element's local box", () => {
    store.getElementVideo.mockReturnValue(loadedVideo());
    const el = videoElement({ width: 80, height: 60 });

    const { canvas, ctx } = scene(100, 100, "#000000");
    renderVideoWithWait(ctx, "v", el, 0);

    expect(pixel(canvas, 1, 1)).toMatchObject({ r: 255, g: 0, b: 0 });
    expect(pixel(canvas, 78, 58)).toMatchObject({ r: 255, g: 0, b: 0 });
    expect(pixel(canvas, 82, 58)).toMatchObject({ r: 0, g: 0, b: 0 });
  });

  it("draws nothing while the video is still loading", () => {
    store.getElementVideo.mockReturnValue(null);
    const { canvas, ctx } = scene(100, 100, "#000000");
    expect(() => renderVideoWithWait(ctx, "v", videoElement(), 0)).not.toThrow();
    expect(pixel(canvas, 50, 50)).toMatchObject({ r: 0, g: 0, b: 0 });
  });

  
  
  it("treats trim as a source-file offset, not a timeline one", () => {
    // A clip placed at 43s whose trim starts at 71.3s into the source file is on
    // screen from 43s. Adding trim to the timeline position used to push it out
    // past the end of the clip and render nothing.
    const video = loadedVideo();
    store.getElementVideo.mockReturnValue(video);

    const el = videoElement({
      startTime: 43_000,
      duration: 38_000,
      speed: 1,
      trim: { startTime: 71_300, endTime: 109_300 },
      width: 50,
      height: 50,
    });

    const { canvas, ctx } = scene(60, 60, "#000000");
    renderVideoWithWait(ctx, "v", el, 43_000);

    expect(pixel(canvas, 25, 25)).toMatchObject({ r: 255, g: 0, b: 0 });
  });

  it("leaves audibility entirely to the playback sync", () => {
    // The compositor skips clips outside their window, so a mute decision made
    // here could never fire for the clip that needs it. That is why audio kept
    // playing over a cut, and why `features/timeline/playback.ts` owns it now.
    const video = loadedVideo();
    store.getElementVideo.mockReturnValue(video);
    video.object.muted = true;

    const { ctx } = scene(100, 100);
    renderVideoWithWait(ctx, "v", videoElement({ startTime: 0, duration: 2000 }), 1000);

    expect(video.object.muted).toBe(true);
  });

  
  it("routes the frame through the filters when they are enabled", () => {
    store.getElementVideo.mockReturnValue(loadedVideo());
    const el = videoElement({
      filter: { enable: true, list: [{ name: "blur", value: "f=4" }] },
    });

    const { ctx } = scene(100, 100);
    renderVideoWithWait(ctx, "v", el, 0);

    expect(pipelineRender).toHaveBeenCalledTimes(1);
  });

  it("skips the pipeline entirely when filters are off", () => {
    store.getElementVideo.mockReturnValue(loadedVideo());
    const { ctx } = scene(100, 100);
    renderVideoWithWait(ctx, "v", videoElement(), 0);
    expect(pipelineRender).not.toHaveBeenCalled();
  });

  it("asks the pipeline to wait for export but not for the live preview", () => {
    store.getElementVideo.mockReturnValue(loadedVideo());
    const el = videoElement({
      filter: { enable: true, list: [{ name: "blur", value: "f=4" }] },
    });
    const { ctx } = scene(100, 100);

    renderVideoWithWait(ctx, "v", el, 0);
    expect(pipelineRender.mock.calls[0][3]).toBe(true);

    renderVideoWithoutWait(ctx, "v", el, 0);
    expect(pipelineRender.mock.calls[1][3]).toBe(false);
  });

  it("builds the filter pipeline once and reuses it", () => {
    store.getElementVideo.mockReturnValue(loadedVideo());
    const el = videoElement({
      filter: { enable: true, list: [{ name: "blur", value: "f=4" }] },
    });
    const { ctx } = scene(100, 100);

    renderVideoWithWait(ctx, "v", el, 0);
    const first = store.videoFilterPipeline;
    expect(first).not.toBeNull();

    renderVideoWithWait(ctx, "v", el, 100);
    expect(store.videoFilterPipeline).toBe(first);
  });
});
