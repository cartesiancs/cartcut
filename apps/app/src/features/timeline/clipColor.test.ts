import { describe, expect, it } from "vitest";
import { FILETYPES, type TimelineElement } from "../../@types/timeline";
import { AUDIO_CLIP_COLOR } from "./audio";
import {
  CLIP_FALLBACK,
  CLIP_PALETTE,
  clipColorOf,
  isDefaultClipColor,
} from "./clipColor";

/** Only the two fields the resolver reads. */
function clip(filetype: string, color?: string): TimelineElement {
  return {
    filetype,
    timelineOptions: color === undefined ? undefined : { color },
  } as unknown as TimelineElement;
}

describe("clipColorOf", () => {
  it("repaints each creation default in its type's palette colour", () => {
    const stamped: [string, string][] = [
      ["video", "rgb(71, 59, 179)"],
      ["audio", "rgb(133, 179, 59)"],
      ["image", "rgb(134, 41, 143)"],
      ["gif", "rgb(134, 41, 143)"],
      ["text", "rgb(59, 143, 179)"],
      ["shape", "rgb(59, 143, 179)"],
      ["effect", "rgb(120, 170, 140)"],
      ["group", "rgb(120, 110, 190)"],
      ["template", "#6a5acd"],
    ];
    for (const [filetype, color] of stamped) {
      expect(clipColorOf(clip(filetype, color))).toBe(
        CLIP_PALETTE[filetype as TimelineElement["filetype"]],
      );
    }
  });

  it("recognises the exported audio default, so the copy cannot drift", () => {
    expect(isDefaultClipColor(AUDIO_CLIP_COLOR)).toBe(true);
    expect(clipColorOf(clip("audio", AUDIO_CLIP_COLOR))).toBe(CLIP_PALETTE.audio);
  });

  it("tells text and shape apart, which the old default did not", () => {
    const shared = "rgb(59, 143, 179)";
    expect(clipColorOf(clip("text", shared))).not.toBe(
      clipColorOf(clip("shape", shared)),
    );
  });

  it("keeps a colour somebody chose", () => {
    expect(clipColorOf(clip("group", "#ff3355"))).toBe("#ff3355");
    expect(clipColorOf(clip("video", "rgb(10, 20, 30)"))).toBe("rgb(10, 20, 30)");
  });

  it("gives a default and a chosen colour different answers", () => {
    // The harness check: the two inputs differ, so the outputs must too.
    const chosen = clipColorOf(clip("group", "#123456"));
    const defaulted = clipColorOf(clip("group", "rgb(120, 110, 190)"));
    expect(chosen).not.toBe(defaulted);
  });

  it("ignores spacing and case when matching a default", () => {
    expect(clipColorOf(clip("video", "RGB(71,59,179)"))).toBe(CLIP_PALETTE.video);
    expect(clipColorOf(clip("template", "#6A5ACD"))).toBe(CLIP_PALETTE.template);
  });

  it("falls back to the palette when there is no colour at all", () => {
    expect(clipColorOf(clip("audio"))).toBe(CLIP_PALETTE.audio);
    expect(clipColorOf(clip("text", ""))).toBe(CLIP_PALETTE.text);
  });

  it("answers for every filetype, and for one it has never heard of", () => {
    for (const filetype of FILETYPES) {
      expect(typeof clipColorOf(clip(filetype))).toBe("string");
    }
    expect(clipColorOf(clip("hologram"))).toBe(CLIP_FALLBACK);
  });
});
