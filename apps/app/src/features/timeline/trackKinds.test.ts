import { describe, it, expect } from "vitest";
import {
  TRACK_KINDS,
  TRACK_KIND_ICON,
  TRACK_KIND_LABEL,
  TRACK_KIND_TITLE,
} from "./trackKinds";
import { createTrack, type TrackKind } from "./tracks";

/**
 * The list is pinned by set equality, the way `tools.test.ts` pins the MCP tool
 * names: a kind added to `TrackKind` without an entry here would compile — a
 * `Record<TrackKind, string>` catches the tables, but nothing makes the *order*
 * exhaustive — and would then be missing from the toolbar's menu with no sign
 * anywhere that it should have been there.
 */
const EVERY_KIND: TrackKind[] = ["video", "audio", "text", "effect", "group"];

describe("TRACK_KINDS", () => {
  it("offers every kind, once", () => {
    expect([...TRACK_KINDS].sort()).toEqual([...EVERY_KIND].sort());
    expect(new Set(TRACK_KINDS).size).toBe(TRACK_KINDS.length);
  });

  it("names and draws every one of them", () => {
    for (const kind of TRACK_KINDS) {
      expect(TRACK_KIND_ICON[kind]).toBeTruthy();
      expect(TRACK_KIND_LABEL[kind]).toBeTruthy();
    }
  });

  it("gives each kind an icon of its own", () => {
    const icons = TRACK_KINDS.map((kind) => TRACK_KIND_ICON[kind]);
    expect(new Set(icons).size).toBe(icons.length);
  });

  // The pair is one string and a suffix, so it cannot drift.
  it("derives the standalone title from the label", () => {
    expect(TRACK_KIND_TITLE.video).toBe("Video track");
    for (const kind of TRACK_KINDS) {
      expect(TRACK_KIND_TITLE[kind]).toBe(`${TRACK_KIND_LABEL[kind]} track`);
    }
  });

  // Every kind here is one `createTrack` accepts — the menu cannot offer a
  // choice the registry has no prefix for, which would name the row `undefined1`.
  it("names a real track for every kind it offers", () => {
    for (const kind of TRACK_KINDS) {
      expect(createTrack("t", kind, 0).name).toMatch(/^[A-Z]1$/);
    }
  });
});
