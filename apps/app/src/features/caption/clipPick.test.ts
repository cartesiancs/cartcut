import { describe, expect, it } from "vitest";
import {
  allPicked,
  initialPick,
  movePick,
  nudgePick,
  pickAll,
  pickNumber,
  pickedSources,
  reconcilePick,
  removePick,
  togglePick,
} from "./clipPick";
import { captionSources } from "./sources";

/** Three clips at 0s, 5s and 10s: a, b, c in timeline order. */
const rows = () =>
  captionSources({
    c: { filetype: "video", localpath: "file:///c.mp4", duration: 1000, startTime: 10_000 },
    a: { filetype: "video", localpath: "file:///a.mp4", duration: 1000, startTime: 0 },
    b: { filetype: "audio", localpath: "file:///b.wav", duration: 1000, startTime: 5_000 },
  });

describe("togglePick", () => {
  it("adds to the end, in the order clicked", () => {
    expect(togglePick(togglePick([], "c"), "a")).toEqual(["c", "a"]);
  });

  // The badges are positions, so taking one out has to close the gap.
  it("takes a clip out and renumbers what follows", () => {
    const pick = togglePick(["a", "b", "c"], "a");
    expect(pick).toEqual(["b", "c"]);
    expect(pickNumber(pick, "c")).toBe(2);
  });
});

describe("removePick", () => {
  it("declines by identity for a clip that is not chosen", () => {
    const pick = ["a"];
    expect(removePick(pick, "z")).toBe(pick);
  });
});

describe("movePick", () => {
  it("moves forwards and backwards", () => {
    expect(movePick(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
    expect(movePick(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
  });

  it("clamps a drop past either end to that end", () => {
    expect(movePick(["a", "b", "c"], 0, 99)).toEqual(["b", "c", "a"]);
    expect(movePick(["a", "b", "c"], 2, -5)).toEqual(["c", "a", "b"]);
  });

  it("declines by identity when nothing moves", () => {
    const pick = ["a", "b"];
    expect(movePick(pick, 1, 1)).toBe(pick);
    expect(movePick(pick, 1, 7)).toBe(pick);
    expect(movePick(pick, 5, 0)).toBe(pick);
    expect(movePick(pick, -1, 0)).toBe(pick);
  });
});

describe("nudgePick", () => {
  it("moves one step either way", () => {
    expect(nudgePick(["a", "b", "c"], "b", -1)).toEqual(["b", "a", "c"]);
    expect(nudgePick(["a", "b", "c"], "b", 1)).toEqual(["a", "c", "b"]);
  });

  it("declines by identity at either end and for an unknown key", () => {
    const pick = ["a", "b"];
    expect(nudgePick(pick, "a", -1)).toBe(pick);
    expect(nudgePick(pick, "b", 1)).toBe(pick);
    expect(nudgePick(pick, "z", 1)).toBe(pick);
  });
});

describe("pickNumber", () => {
  it("counts from one, and is null for a clip that is not chosen", () => {
    expect(pickNumber(["b", "a"], "a")).toBe(2);
    expect(pickNumber(["b", "a"], "c")).toBeNull();
  });
});

describe("pickAll", () => {
  it("keeps the chosen order and appends the rest in timeline order", () => {
    expect(pickAll(["c"], rows())).toEqual(["c", "a", "b"]);
  });

  it("clears when every clip is already chosen", () => {
    const all = ["b", "a", "c"];
    expect(allPicked(all, rows())).toBe(true);
    expect(pickAll(all, rows())).toEqual([]);
  });

  it("declines by identity with no clips to choose", () => {
    const pick: string[] = [];
    expect(pickAll(pick, [])).toBe(pick);
    expect(allPicked(pick, [])).toBe(false);
  });
});

describe("reconcilePick", () => {
  it("drops a clip that is no longer on the timeline, keeping the order", () => {
    expect(reconcilePick(["c", "gone", "a"], rows())).toEqual(["c", "a"]);
  });

  it("declines by identity when every clip is still there", () => {
    const pick = ["c", "a"];
    expect(reconcilePick(pick, rows())).toBe(pick);
  });
});

describe("initialPick", () => {
  it("reopens on the last choice", () => {
    expect(
      initialPick({ previous: ["c", "a"], timelineSelection: ["b"], rows: rows() }),
    ).toEqual(["c", "a"]);
  });

  it("falls back to the timeline's selection, in timeline order", () => {
    expect(
      initialPick({
        previous: ["gone"],
        timelineSelection: ["c", "text-clip", "a"],
        rows: rows(),
      }),
    ).toEqual(["a", "c"]);
  });

  it("chooses the only clip there is", () => {
    const one = rows().slice(0, 1);
    expect(initialPick({ previous: [], timelineSelection: [], rows: one })).toEqual([
      "a",
    ]);
  });

  it("chooses nothing when there is a choice to make", () => {
    expect(initialPick({ previous: [], timelineSelection: [], rows: rows() })).toEqual(
      [],
    );
  });
});

describe("pickedSources", () => {
  it("returns the chosen rows in the chosen order, skipping unknown keys", () => {
    expect(pickedSources(["c", "nope", "a"], rows()).map((r) => r.key)).toEqual([
      "c",
      "a",
    ]);
  });
});
