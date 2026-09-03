/**
 * Reading a file's length and its path — the two things every import depends on.
 *
 * The prober is injected and path arithmetic is pure, so all of this runs under
 * vitest's node environment with no DOM and no ffprobe. The DOM seek that
 * `domProber` performs for a headerless file is deliberately *not* covered
 * here: it needs a real media pipeline, and keeping it behind `MediaProber` is
 * what lets everything around it be tested at all.
 */

import { describe, it, expect } from "vitest";
import { probeMedia, resolveDurationMs, toLocalPath } from "./mediaProbe";
import type { MediaProber } from "./mediaProbe";

/** A prober that answers instantly, matching the import suite's. */
function proberWith(over: Partial<MediaProber> = {}): MediaProber {
  return {
    image: async () => ({ width: 800, height: 600 }),
    gif: async () => ({ width: 320, height: 240 }),
    video: async () => ({
      width: 1920,
      height: 1080,
      durationMs: 5_000,
      hasAudio: true,
    }),
    audio: async () => ({ durationMs: 3_000 }),
    ...over,
  };
}

// ------------------------------------------------------------ resolveDurationMs

describe("resolveDurationMs", () => {
  it("prefers what the file says over what the caller guessed", () => {
    // The load-bearing case. A recorder's wall clock includes MediaRecorder
    // start latency and the final partial frame, so letting it win would grow
    // a tail with no frames in it and make `sourceDuration` lie to every trim
    // afterwards.
    expect(resolveDurationMs(4_870, 5_000, "/m/rec.webm")).toBe(4_870);
  });

  it("falls back when the container states no length", () => {
    expect(resolveDurationMs(Infinity, 5_000, "/m/rec.webm")).toBe(5_000);
  });

  it("falls back on NaN", () => {
    expect(resolveDurationMs(NaN, 5_000, "/m/rec.webm")).toBe(5_000);
  });

  it("falls back on zero", () => {
    // Zero is not a length a clip can have, and treating it as one places a
    // clip that looks fine and holds nothing.
    expect(resolveDurationMs(0, 5_000, "/m/rec.webm")).toBe(5_000);
  });

  it("throws naming the file when nothing can measure it", () => {
    expect(() => resolveDurationMs(Infinity, undefined, "/m/rec.webm")).toThrow(
      /rec\.webm/,
    );
  });

  it("throws rather than using an unusable fallback", () => {
    expect(() => resolveDurationMs(Infinity, 0, "/m/rec.webm")).toThrow();
    expect(() => resolveDurationMs(Infinity, Infinity, "/m/rec.webm")).toThrow();
  });
});

// -------------------------------------------------------------------- probeMedia

describe("probeMedia", () => {
  it("uses the fallback for a video the container cannot measure", async () => {
    const result = await probeMedia(
      "/m/rec.webm",
      proberWith({
        video: async () => ({
          width: 1920,
          height: 1080,
          durationMs: Infinity,
          hasAudio: true,
        }),
      }),
      { fallbackDurationMs: 4_200 },
    );

    expect(result.durationMs).toBe(4_200);
    expect(result.kind).toBe("video");
  });

  it("uses the fallback for audio too", async () => {
    // `saveBufferToAudio` writes a MediaRecorder blob under a `.wav` name, so
    // the audio recorder hits exactly the same headerless case.
    const result = await probeMedia(
      "/m/rec.wav",
      proberWith({ audio: async () => ({ durationMs: Infinity }) }),
      { fallbackDurationMs: 3_300 },
    );

    expect(result.durationMs).toBe(3_300);
    expect(result.kind).toBe("audio");
  });

  it("still prefers the measured length when there is one", async () => {
    const result = await probeMedia("/m/a.mp4", proberWith(), {
      fallbackDurationMs: 999_999,
    });

    expect(result.durationMs).toBe(5_000);
  });

  it("rejects an unmeasurable file with no fallback", async () => {
    await expect(
      probeMedia(
        "/m/rec.webm",
        proberWith({
          video: async () => ({
            width: 1920,
            height: 1080,
            durationMs: Infinity,
            hasAudio: true,
          }),
        }),
      ),
    ).rejects.toThrow(/rec\.webm/);
  });

  it("leaves stills alone — they carry no length to resolve", async () => {
    const image = await probeMedia("/m/a.png", proberWith());
    const gif = await probeMedia("/m/a.gif", proberWith());

    expect(image.durationMs).toBe(0);
    expect(gif.durationMs).toBe(0);
  });

  it("throws for an extension the editor cannot render", async () => {
    await expect(probeMedia("/m/notes.txt", proberWith())).rejects.toThrow(
      /no renderer/,
    );
  });
});

// ------------------------------------------------------------------ toLocalPath

describe("toLocalPath", () => {
  it("makes a bare path into a file URL", () => {
    expect(toLocalPath("/m/a.mp4")).toBe("file:///m/a.mp4");
  });

  it("escapes '#' and nothing else", () => {
    // `functions/path.ts#encode` escapes `#` alone, deliberately: `localpath`
    // is not percent-encoded, so `decodeURIComponent` would throw on a file
    // named `100%.mp4`.
    expect(toLocalPath("/m/a#b.mp4")).toBe("file:///m/a%23b.mp4");
    expect(toLocalPath("/m/100%.mp4")).toBe("file:///m/100%.mp4");
  });

  it("passes an already-addressed source through untouched", () => {
    // So a caller can hand us whatever `list_assets` returned.
    expect(toLocalPath("file:///m/a.mp4")).toBe("file:///m/a.mp4");
    expect(toLocalPath("blob:nodedata:1234")).toBe("blob:nodedata:1234");
    expect(toLocalPath("https://x.test/a.mp4")).toBe("https://x.test/a.mp4");
  });
});
