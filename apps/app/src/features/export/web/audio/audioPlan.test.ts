import { describe, expect, it } from "vitest";
import { collectAudioInputs } from "../../../../../../../electron/render/ffmpegArgs";
import { addKeyframe, setTrackActive } from "../../../animation/keyframeOps";
import { audioElement, imageElement, videoElement } from "../../../renderer/testing";
import { SCHEMA_VERSION, createTrack, normalizeDocument } from "../../../timeline/tracks";
import { needsStretch, planAudio } from "./audioPlan";

/** A document holding every case the desktop mix distinguishes. */
function mixedDocument() {
  let doc = normalizeDocument({
    schemaVersion: SCHEMA_VERSION,
    tracks: [createTrack("v1", "video", 0), createTrack("a1", "audio", 1)],
    elements: {
      plain: audioElement({ trackId: "a1", localpath: "blob:x/1#a.mp3", startTime: 500 }),
      quiet: audioElement({
        trackId: "a1",
        localpath: "blob:x/2#b.mp3",
        startTime: 6000,
        volumeDb: -9,
        trim: { startTime: 1500, endTime: 3500 },
        duration: 2000,
      } as any),
      fast: videoElement({
        trackId: "v1",
        localpath: "blob:x/3#c.mp4",
        startTime: 0,
        duration: 4000,
        speed: 2,
        trim: { startTime: 0, endTime: 4000 },
        sourceDuration: 8000,
      }),
      ramped: audioElement({
        trackId: "a1",
        localpath: "blob:x/4#d.mp3",
        startTime: 9000,
        duration: 4000,
        trim: { startTime: 1000, endTime: 5000 },
        sourceDuration: 30_000,
        speed: 1.44,
        speedCurve: [
          { t: 0, v: 1 },
          { t: 4000, v: 2 },
        ],
      } as any),
      silentVideo: videoElement({ trackId: "v1", startTime: 5000, isExistAudio: false }),
      detached: videoElement({ trackId: "v1", startTime: 9000, audioDetached: true } as any),
      picture: imageElement({ trackId: "v1" }),
      early: audioElement({ trackId: "a1", localpath: "blob:x/5#e.mp3", startTime: -300 }),
    },
  });
  doc = setTrackActive(doc, "plain", "volumeDb", true, { atMs: 0 }, 60);
  doc = addKeyframe(doc, "plain", "volumeDb", "x", 0, 0, 0, 60);
  doc = addKeyframe(doc, "plain", "volumeDb", "x", 4000, -40, 0, 60);
  return doc.elements as Record<string, any>;
}

describe("planAudio", () => {
  it("agrees with the desktop export's inputs, clip by clip", () => {
    const timeline = mixedDocument();
    const desktop = collectAudioInputs(timeline);
    const web = planAudio(timeline);

    expect(web.map((clip) => clip.localpath)).toEqual(desktop.map((input) => input.localpath));
    web.forEach((clip, i) => {
      const input = desktop[i];
      expect(clip.ssSec).toBe(input.ssSec);
      expect(clip.tSec).toBe(input.tSec);
      expect(clip.delayMs).toBe(input.delayMs);
      expect(clip.speed).toBe(input.speed);
      expect(clip.gain).toBe(input.gain);
      expect(clip.envelope ?? null).toEqual(input.envelope ?? null);
    });
  });

  it("is a harness that can disagree: a moved clip is a different plan", () => {
    const timeline = mixedDocument();
    const moved = { ...timeline, plain: { ...timeline.plain, startTime: timeline.plain.startTime + 200 } };
    const desktop = collectAudioInputs(moved);
    const web = planAudio(timeline);
    const at = web.findIndex((clip) => clip.id === "plain");
    expect(desktop[at].localpath).toBe(web[at].localpath);
    expect(web[at].delayMs).not.toBe(desktop[at].delayMs);
  });

  it("leaves out what makes no sound", () => {
    const ids = planAudio(mixedDocument()).map((clip) => clip.id);
    expect(ids).not.toContain("silentVideo");
    expect(ids).not.toContain("detached");
    expect(ids).not.toContain("picture");
  });

  it("knows which clips have to be retimed", () => {
    const byId = new Map(planAudio(mixedDocument()).map((clip) => [clip.id, clip]));
    expect(needsStretch(byId.get("plain")!)).toBe(false);
    expect(needsStretch(byId.get("fast")!)).toBe(true);
    expect(needsStretch(byId.get("ramped")!)).toBe(true);
    // A 2x clip of 4s of source sounds for 2s; the ramp for its curve's span.
    expect(byId.get("fast")!.spanMs).toBe(2000);
    expect(byId.get("ramped")!.spanMs).toBeLessThan(4000);
    expect(byId.get("ramped")!.spanMs).toBeGreaterThan(2000);
  });

  it("starts a clip placed before zero at zero, as adelay does", () => {
    const early = planAudio(mixedDocument()).find((clip) => clip.id === "early")!;
    expect(early.delayMs).toBe(0);
  });
});
