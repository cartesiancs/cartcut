import { beforeEach, describe, expect, it } from "vitest";
import { renderOptionStore } from "./renderOptionStore";
import {
  DEFAULT_EXPORT_SETTINGS,
  EXPORT_PRESETS,
} from "../features/export/settings";

const initial = renderOptionStore.getInitialState().options;
const reset = () =>
  renderOptionStore.setState({ options: JSON.parse(JSON.stringify(initial)) });

const options = () => renderOptionStore.getState().options;
const settings = () => options().exportSettings;
const patch = (p: any) => renderOptionStore.getState().updateExportSettings(p);

describe("renderOptionStore export settings", () => {
  beforeEach(reset);

  it("starts on the shipped defaults", () => {
    expect(settings()).toEqual(DEFAULT_EXPORT_SETTINGS);
  });

  it("merges a partial patch and leaves the rest of the project alone", () => {
    patch({ crf: 20 });

    expect(settings().crf).toBe(20);
    expect(settings().audioCodec).toBe(DEFAULT_EXPORT_SETTINGS.audioCodec);
    expect(options().previewSize).toEqual(initial.previewSize);
    expect(options().duration).toBe(initial.duration);
    expect(options().backgroundColor).toBe(initial.backgroundColor);
    expect(options().fps).toBe(initial.fps);
  });

  it("hands back a fresh options identity, which is what re-renders the panel", () => {
    const before = options();
    patch({ crf: 20 });
    expect(options()).not.toBe(before);
  });

  it("normalizes on write, so an illegal combination cannot be stored", () => {
    patch({ videoCodec: "vp9" });

    expect(settings().container).toBe("webm");
    expect(settings().audioCodec).toBe("opus");
    expect(settings().sampleRate).toBe(48000);
  });

  it("repairs a value that is out of range for the current codec", () => {
    patch({ videoCodec: "h264", crf: 999 });
    expect(settings().crf).toBe(51);
  });

  it("takes a whole preset in one patch", () => {
    patch(EXPORT_PRESETS.high);
    expect(settings()).toEqual(EXPORT_PRESETS.high);
  });

  it("keeps the stored export settings when updateOptions omits them", () => {
    patch({ crf: 20, videoCodec: "h265" });
    const chosen = settings();

    renderOptionStore.getState().updateOptions({
      previewSize: { w: 1280, h: 720 },
      fps: 30,
      duration: 42,
      backgroundColor: "#ffffff",
    });

    expect(settings()).toEqual(chosen);
    expect(options().previewSize).toEqual({ w: 1280, h: 720 });
    expect(options().duration).toBe(42);
  });

  it("adopts export settings when updateOptions does supply them", () => {
    renderOptionStore.getState().updateOptions({
      previewSize: { w: 1920, h: 1080 },
      fps: 60,
      duration: 10,
      backgroundColor: "#000000",
      exportSettings: EXPORT_PRESETS.low,
    });

    expect(settings()).toEqual(EXPORT_PRESETS.low);
  });

  it("falls back to the defaults when a loaded project has none", () => {
    patch(EXPORT_PRESETS.high);

    renderOptionStore.getState().updateOptions({
      previewSize: { w: 1920, h: 1080 },
      fps: 60,
      duration: 10,
      backgroundColor: "#000000",
      // What normalizeExportSettings(undefined) yields for a pre-feature .ngt.
      exportSettings: DEFAULT_EXPORT_SETTINGS,
    });

    expect(settings()).toEqual(DEFAULT_EXPORT_SETTINGS);
  });
});
