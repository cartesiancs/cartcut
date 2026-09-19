import { describe, expect, it } from "vitest";
import {
  DEFAULT_TIME_BASE,
  resolveTimeBase,
  timeBaseOptions,
  type TimeBaseInput,
} from "./importChoice";

const input = (over: Partial<TimeBaseInput> = {}): TimeBaseInput => ({
  selectedClip: null,
  current: DEFAULT_TIME_BASE,
  ...over,
});

const CLIP = { key: "clip", name: "interview.mp4" };

describe("timeBaseOptions", () => {
  it("always offers both, so neither moves under the pointer", () => {
    expect(timeBaseOptions(input())).toHaveLength(2);
    expect(timeBaseOptions(input({ selectedClip: CLIP }))).toHaveLength(2);
  });

  it("disables the clip option rather than hiding it when nothing is selected", () => {
    // Absent, it would shift the row below up under the pointer, and nothing
    // would tell the user that selecting a clip first is what unlocks it.
    const [timeline, clip] = timeBaseOptions(input());

    expect(timeline.disabled).toBe(false);
    expect(clip.disabled).toBe(true);
  });

  it("enables the clip option once a clip is selected", () => {
    expect(timeBaseOptions(input({ selectedClip: CLIP }))[1].disabled).toBe(false);
  });

  it("carries an icon and one word for each", () => {
    const [timeline, clip] = timeBaseOptions(input({ selectedClip: CLIP }));

    expect(timeline).toMatchObject({ icon: "schedule", label: "Timeline" });
    expect(clip).toMatchObject({ icon: "movie", label: "Clip" });
  });

  it("puts the clip's name in the detail line and leaves the other empty", () => {
    const [timeline, clip] = timeBaseOptions(input({ selectedClip: CLIP }));

    expect(timeline.detail).toBe("");
    expect(clip.detail).toBe("interview.mp4");
  });

  it("starts on Timeline", () => {
    const [timeline, clip] = timeBaseOptions(input({ selectedClip: CLIP }));

    expect(timeline.selected).toBe(true);
    expect(clip.selected).toBe(false);
  });

  it("follows the current choice", () => {
    const [timeline, clip] = timeBaseOptions(
      input({ selectedClip: CLIP, current: { kind: "clip", key: "clip" } }),
    );

    expect(timeline.selected).toBe(false);
    expect(clip.selected).toBe(true);
  });

  it("selects exactly one, whatever it is handed", () => {
    const cases: TimeBaseInput[] = [
      input(),
      input({ selectedClip: CLIP }),
      input({ selectedClip: CLIP, current: { kind: "clip", key: "clip" } }),
      input({ current: { kind: "clip", key: "clip" } }),
      input({ selectedClip: CLIP, current: { kind: "clip", key: "other" } }),
    ];

    for (const one of cases) {
      expect(timeBaseOptions(one).filter((o) => o.selected)).toHaveLength(1);
    }
  });

  it("falls back to Timeline when the chosen clip is no longer the selected one", () => {
    // The selection can change while the dialog is open. Left alone, the dialog
    // would show nothing selected and Import would do something unshown.
    const options = timeBaseOptions(
      input({ selectedClip: CLIP, current: { kind: "clip", key: "gone" } }),
    );

    expect(options[0].selected).toBe(true);
  });

  it("falls back to Timeline when the selection went away entirely", () => {
    const options = timeBaseOptions(input({ current: { kind: "clip", key: "clip" } }));

    expect(options[0].selected).toBe(true);
    expect(options[1].disabled).toBe(true);
  });

  it("never offers a clip base naming a clip that is not selected", () => {
    const [, clip] = timeBaseOptions(input());

    expect(clip.base).toEqual({ kind: "timeline" });
  });
});

describe("resolveTimeBase", () => {
  it("answers with what the dialog showed as selected", () => {
    expect(resolveTimeBase(input())).toEqual({ kind: "timeline" });
    expect(
      resolveTimeBase(input({ selectedClip: CLIP, current: { kind: "clip", key: "clip" } })),
    ).toEqual({ kind: "clip", key: "clip" });
  });

  it("refuses a stale clip choice the same way the options do", () => {
    // What runs is always what was shown. Two answers to that question is how a
    // dialog ends up lying about what it did.
    expect(
      resolveTimeBase(input({ selectedClip: CLIP, current: { kind: "clip", key: "gone" } })),
    ).toEqual({ kind: "timeline" });
  });
});
