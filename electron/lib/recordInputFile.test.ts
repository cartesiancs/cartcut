/**
 * Main's copy of the input-log format against the renderer's.
 *
 * `electron/` cannot import `apps/app/src`, because `.tsconfig` pins `rootDir` and
 * one such import relocates the build out of `main/`, so the packing exists twice.
 * A suite *can* reach across, because `.tsconfig` excludes tests from that
 * build, which is how `render/speedCurve.test.ts` and `render/exportSettings.test.ts`
 * already pin their own copies.
 *
 * The check that matters is the round trip: main encodes, the renderer decodes,
 * and what comes out is what went in. That catches a renamed field, a reordered
 * tuple and a version bump on one side, which reading the two files side by side
 * does not.
 */
import { describe, it, expect } from "vitest";
import * as main from "./recordInputFile";
import {
  INPUT_LOG_VERSION,
  normalizeInputLog,
  encodeInputLog as rendererEncode,
  inputLogPathFor as rendererPath,
} from "../../apps/app/src/features/record/inputLog";

const log = {
  capture: { width: 3024, height: 1964, fps: 30 },
  durationMs: 4200,
  cursor: [
    { t: 0, x: 1512, y: 982 },
    { t: 33, x: 1514, y: 980 },
    { t: 66, x: 900, y: 400 },
  ],
  pointer: [
    { t: 2140, x: 880, y: 412, kind: "down" as const },
    { t: 2280, x: 884, y: 415, kind: "up" as const },
  ],
};

describe("the input log format", () => {
  it("states the same version on both sides", () => {
    expect(main.INPUT_LOG_VERSION).toBe(INPUT_LOG_VERSION);
  });

  it("names the sidecar identically", () => {
    const video = "/Users/me/Movies/Cartcut 2026-09-27 16.42.10.mp4";
    expect(main.inputLogPathFor(video)).toBe(rendererPath(video));
    expect(main.inputLogPathFor(video)).toBe(
      "/Users/me/Movies/Cartcut 2026-09-27 16.42.10.cartcut-input.json",
    );
  });

  it("produces byte-identical output from either copy", () => {
    expect(main.encodeInputLog(log)).toBe(rendererEncode(log));
  });

  it("round trips through the renderer's reader", () => {
    const decoded = normalizeInputLog(JSON.parse(main.encodeInputLog(log)));
    expect(decoded).toEqual(log);
  });

  // The harness has to be able to fail. Two different inputs must not agree,
  // or the round trip above would pass against a reader that returned a
  // constant.
  it("disagrees when the inputs differ", () => {
    const other = { ...log, durationMs: 4201 };
    expect(main.encodeInputLog(other)).not.toBe(main.encodeInputLog(log));
  });
});
