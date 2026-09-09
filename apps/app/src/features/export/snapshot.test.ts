import { describe, expect, it } from "vitest";
import type { Timeline } from "../../@types/timeline";
import type { RenderOptions } from "../../states/renderOptionStore";
import { imageElement, videoElement } from "../renderer/testing";
import { DEFAULT_EXPORT_SETTINGS } from "./settings";
import { snapshotExportOptions, snapshotTimeline } from "./snapshot";

function document(): Timeline {
  return {
    img: imageElement({ localpath: "/media/a.png" }),
    vid: videoElement({ localpath: "/media/b.mp4" }),
  } as unknown as Timeline;
}

describe("snapshotTimeline", () => {
  it("gives a new map and a new object per element", () => {
    const live = document();
    const snap = snapshotTimeline(live);

    expect(snap).not.toBe(live);
    expect(snap.img).not.toBe(live.img);
    expect(snap.vid).not.toBe(live.vid);
    expect(Object.keys(snap)).toEqual(Object.keys(live));
  });

  it("does not see a field written onto a live element afterwards", () => {
    // `option/optionImage.ts` sets `.localpath` in place on a background
    // removal, and the export resolves images through
    // `_loadedImage[element.localpath]` — so without the copy that clip
    // vanishes from the delivered file mid-render.
    const live = document();
    const snap = snapshotTimeline(live);

    (live.img as any).localpath = "/media/a-removed.png";
    (live.vid as any).blob = "blob:whatever";

    expect((snap.img as any).localpath).toBe("/media/a.png");
    expect((snap.vid as any).blob).toBe("");
  });

  it("shares the nested blocks by reference, deliberately", () => {
    // Asserted so nobody "fixes" this into a deep clone. Nothing mutates an
    // animation block in place — every pure op returns a new one — and a baked
    // lane runs to 36,000 samples per property, so a deep clone of a real
    // project is hundreds of megabytes allocated on one click.
    const live = document();
    const snap = snapshotTimeline(live);

    expect((snap.img as any).animation).toBe((live.img as any).animation);
    expect((snap.vid as any).filter).toBe((live.vid as any).filter);
  });

  it("survives an empty document", () => {
    expect(snapshotTimeline({})).toEqual({});
  });
});

const options = (): RenderOptions => ({
  previewSize: { w: 1920, h: 1080 },
  fps: 60,
  duration: 12,
  backgroundColor: "#000000",
  exportSettings: { ...DEFAULT_EXPORT_SETTINGS, videoBitrate: 9000 },
});

describe("snapshotExportOptions", () => {
  it("copies the two objects the settings panel edits in place", () => {
    // `ControlSetting._handleUpdatePreviewSizeW` writes
    // `this.renderOption.previewSize.w` on the live store object before
    // calling `updateOptions`, and this object outlives the click by the whole
    // length of the render.
    const live = options();
    const snap = snapshotExportOptions(live, "/tmp/out.mp4");

    expect(snap.previewSize).not.toBe(live.previewSize);
    expect(snap.exportSettings).not.toBe(live.exportSettings);

    live.previewSize.w = 640;
    live.exportSettings.videoBitrate = 1;

    expect(snap.previewSize.w).toBe(1920);
    expect(snap.exportSettings.videoBitrate).toBe(9000);
  });

  it("carries the destination and the legacy aliases ffmpegArgs reads", () => {
    const snap = snapshotExportOptions(options(), "/tmp/out.mp4");

    expect(snap.videoDestination).toBe("/tmp/out.mp4");
    expect(snap.videoDuration).toBe(12);
    expect(snap.videoBitrate).toBe(9000);
  });

  it("keeps every other option field as it was", () => {
    const snap = snapshotExportOptions(options(), "/tmp/out.mp4");

    expect(snap.fps).toBe(60);
    expect(snap.duration).toBe(12);
    expect(snap.backgroundColor).toBe("#000000");
  });
});
