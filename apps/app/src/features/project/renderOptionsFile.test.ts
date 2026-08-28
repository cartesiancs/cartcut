/**
 * A project's frame rate has to survive a save and a load.
 *
 * It did not, and in two separate ways: `saveProjectFile` never wrote the field
 * at all, and the load path substituted a literal 60 for whatever the file said.
 * Both were invisible from inside the app — the rate looked right until the
 * project was reopened.
 *
 * This file is also where the reading of an *old* project is pinned. The schema
 * version deliberately does not move for a new field, so every `.ngt` already
 * in the wild arrives here without an `fps` key, and has to open as the 60fps
 * project it is rather than as an error.
 */

import { describe, expect, it } from "vitest";
import {
  deserializeRenderOptions,
  serializeRenderOptions,
  type RenderOptionsFile,
} from "./renderOptionsFile";
import {
  renderOptionStore,
  type RenderOptions,
} from "../../states/renderOptionStore";
import { DEFAULT_EXPORT_SETTINGS } from "../export/settings";
import { FPS_PRESETS } from "../timeline/frames";

const DEFAULTS: RenderOptions = renderOptionStore.getInitialState().options;

const CONTEXT = { previewRatio: 16 / 9, videoDestination: "/tmp/out.mp4" };

function options(patch: Partial<RenderOptions> = {}): RenderOptions {
  return { ...DEFAULTS, ...patch };
}

/** The save-then-load round trip, as JSON, so nothing survives by reference. */
function roundTrip(source: RenderOptions) {
  const file = serializeRenderOptions(source, CONTEXT);
  return deserializeRenderOptions(JSON.parse(JSON.stringify(file)), DEFAULTS);
}

describe("serializeRenderOptions", () => {
  it("writes the frame rate", () => {
    expect(serializeRenderOptions(options({ fps: 30 }), CONTEXT).fps).toBe(30);
  });

  it("keeps the field names already on disk", () => {
    // Renaming any of these is a schema change, and `project.ts` refuses to
    // open a project whose schema version it does not recognise.
    const file = serializeRenderOptions(options(), CONTEXT);
    expect(Object.keys(file).sort()).toEqual(
      [
        "backgroundColor",
        "exportSettings",
        "fps",
        "previewRatio",
        "previewSize",
        "videoDestination",
        "videoDuration",
      ].sort(),
    );
  });

  it("stores the duration in seconds, under its historical name", () => {
    const file = serializeRenderOptions(options({ duration: 42 }), CONTEXT);
    expect(file.videoDuration).toBe(42);
  });
});

describe("the round trip", () => {
  it("preserves every preset rate", () => {
    for (const fps of FPS_PRESETS) {
      expect(roundTrip(options({ fps })).fps).toBe(fps);
    }
  });

  it("preserves a custom rate", () => {
    for (const fps of [1, 12, 48, 90, 144, 240]) {
      expect(roundTrip(options({ fps })).fps).toBe(fps);
    }
  });

  it("preserves everything else it carries", () => {
    const source = options({
      fps: 120,
      duration: 37,
      backgroundColor: "#123456",
      previewSize: { w: 3840, h: 2160 },
    });
    const read = roundTrip(source);
    expect(read.fps).toBe(120);
    expect(read.duration).toBe(37);
    expect(read.backgroundColor).toBe("#123456");
    expect(read.previewSize).toEqual({ w: 3840, h: 2160 });
  });

  it("is stable under a second pass", () => {
    const once = roundTrip(options({ fps: 25, duration: 9 }));
    const twice = roundTrip(options(once as Partial<RenderOptions>));
    expect(twice).toEqual(once);
  });
});

describe("deserializeRenderOptions, on a file that predates the field", () => {
  it("opens a project with no fps as a 60fps project", () => {
    const legacy = {
      videoDuration: 10,
      previewRatio: 1.777,
      videoDestination: "",
      backgroundColor: "#000000",
      previewSize: { w: 1920, h: 1080 },
      exportSettings: DEFAULT_EXPORT_SETTINGS,
    };
    expect(deserializeRenderOptions(legacy, DEFAULTS).fps).toBe(DEFAULTS.fps);
    expect(DEFAULTS.fps).toBe(60);
  });

  it("does not throw on a file missing everything", () => {
    const read = deserializeRenderOptions({}, DEFAULTS);
    expect(read.fps).toBe(DEFAULTS.fps);
    expect(read.duration).toBe(DEFAULTS.duration);
    expect(read.previewSize).toEqual(DEFAULTS.previewSize);
    expect(read.backgroundColor).toBe(DEFAULTS.backgroundColor);
  });

  it("does not throw on something that is not an object at all", () => {
    // The old load path indexed straight into `options.previewSize.w`.
    for (const raw of [null, undefined, 0, "", "nonsense", [], true]) {
      expect(() => deserializeRenderOptions(raw, DEFAULTS)).not.toThrow();
      expect(deserializeRenderOptions(raw, DEFAULTS).fps).toBe(DEFAULTS.fps);
    }
  });

  it("survives a truncated previewSize", () => {
    const read = deserializeRenderOptions(
      { previewSize: { w: 1280 } },
      DEFAULTS,
    );
    expect(read.previewSize).toEqual({ w: 1280, h: DEFAULTS.previewSize.h });
  });
});

describe("deserializeRenderOptions, on a corrupt field", () => {
  it("coerces a broken frame rate rather than storing it", () => {
    for (const fps of [0, -30, "abc", null, {}, NaN, 1e9]) {
      const read = deserializeRenderOptions(
        { fps } as unknown as RenderOptionsFile,
        DEFAULTS,
      );
      expect(Number.isInteger(read.fps)).toBe(true);
      expect(read.fps).toBeGreaterThan(0);
      expect(read.fps).toBeLessThanOrEqual(240);
    }
  });

  it("rounds a fractional rate written by some other tool", () => {
    expect(
      deserializeRenderOptions({ fps: 29.97 } as RenderOptionsFile, DEFAULTS)
        .fps,
    ).toBe(30);
  });

  it("falls back to a fresh project's defaults, never to the caller's state", () => {
    // The leak the explicit `exportSettings` pass in the old load path was
    // already guarding against: a project saved before a field existed must not
    // inherit whatever the previously open project set.
    const previousProject = options({
      fps: 120,
      duration: 999,
      backgroundColor: "#ff0000",
    });
    const read = deserializeRenderOptions({}, DEFAULTS);
    expect(read.fps).not.toBe(previousProject.fps);
    expect(read.duration).not.toBe(previousProject.duration);
    expect(read.backgroundColor).not.toBe(previousProject.backgroundColor);
  });

  it("normalizes export settings, so an illegal combination cannot load", () => {
    const read = deserializeRenderOptions(
      { exportSettings: { container: "webm", videoCodec: "prores" } as never },
      DEFAULTS,
    );
    expect(read.exportSettings?.container).not.toBe("webm");
  });

  it("rejects a non-positive duration", () => {
    for (const videoDuration of [0, -1, NaN, "x"]) {
      const read = deserializeRenderOptions(
        { videoDuration } as unknown as RenderOptionsFile,
        DEFAULTS,
      );
      expect(read.duration).toBe(DEFAULTS.duration);
    }
  });
});
