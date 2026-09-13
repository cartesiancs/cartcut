import { describe, expect, it } from "vitest";
import {
  NGT_ENTRY_NAMES,
  serializeProjectEntries,
  type WrittenEntries,
} from "./projectEntries";
import { readProjectDocument } from "./projectDocument";
import { renderOptionStore, type RenderOptions } from "../../states/renderOptionStore";
import {
  SCHEMA_VERSION,
  normalizeDocument,
  type TimelineTrack,
} from "../timeline/tracks";
import type { Timeline } from "../../@types/timeline";

/**
 * The two things this suite exists to hold.
 *
 * 1. **An autosave can actually be recovered.** The round trip below is the
 *    only place that is asserted end to end without a real zip in the way, and
 *    a writer that produces something the reader cannot read is a recovery
 *    point that looks fine in the menu and restores nothing.
 * 2. **The anchor changes `assetPaths.json` and nothing else.** That is what
 *    lets an autosave of `Film.ngt` be byte-comparable to a save of it in the
 *    three entries the digest covers, while still recording relative asset
 *    paths against the project's real folder.
 */

function options(over: Partial<RenderOptions> = {}): RenderOptions {
  return { ...renderOptionStore.getInitialState().options, ...over };
}

const TRACKS: TimelineTrack[] = [
  { id: "t1", kind: "video", name: "V1", index: 0 },
  { id: "t2", kind: "text", name: "T1", index: 1 },
];

function elements(): Timeline {
  return {
    clip: {
      filetype: "video",
      startTime: 0,
      duration: 5000,
      location: { x: 0, y: 0 },
      trim: { startTime: 0, endTime: 5000 },
      width: 1920,
      height: 1080,
      localpath: "file:///Users/me/Projects/assets/a.mp4",
      priority: 1,
    },
  } as unknown as Timeline;
}

/** The entries, as an `NgtEntries` for the reader. */
function asRead(written: WrittenEntries) {
  return written;
}

const PROJECT = "/Users/me/Projects/Film.ngt";

async function readBack(written: WrittenEntries, anchor: string) {
  return readProjectDocument(asRead(written), anchor, async (p) =>
    p.includes("/Users/me/Projects/assets/") ? true : false,
  );
}

describe("serializeProjectEntries", () => {
  it("writes exactly the five entries, and no others", () => {
    const written = serializeProjectEntries({
      elements: elements(),
      tracks: TRACKS,
      options: options(),
      anchor: PROJECT,
    });
    expect(Object.keys(written).sort()).toEqual(
      ["assetPaths", "project", "renderOptions", "timeline", "tracks"].sort(),
    );
  });

  it("names the entries as the archive names them", () => {
    expect(NGT_ENTRY_NAMES).toEqual({
      project: "project.json",
      timeline: "timeline.json",
      tracks: "tracks.json",
      renderOptions: "renderOptions.json",
      assetPaths: "assetPaths.json",
    });
  });

  it("writes project.json as exactly the schema version", () => {
    // The canary. `SCHEMA_VERSION` is a compatibility gate that *refuses* on a
    // mismatch rather than migrating, so moving it for an added field or entry
    // stops every existing .ngt from opening. Auto Save adds an entry and must
    // not move it.
    const written = serializeProjectEntries({
      elements: elements(),
      tracks: TRACKS,
      options: options(),
      anchor: PROJECT,
    });
    expect(written.project).toBe('{"schemaVersion":2}');
    expect(SCHEMA_VERSION).toBe(2);
  });

  it("writes the elements and tracks verbatim", () => {
    const written = serializeProjectEntries({
      elements: elements(),
      tracks: TRACKS,
      options: options(),
      anchor: PROJECT,
    });
    expect(JSON.parse(written.timeline)).toEqual(
      JSON.parse(JSON.stringify(elements())),
    );
    expect(JSON.parse(written.tracks)).toEqual(TRACKS);
  });

  it("defaults previewRatio rather than requiring it", () => {
    // It is written and never read back, and it comes off a Lit component an
    // autosave may fire without — so a missing one must not fail a write.
    const written = serializeProjectEntries({
      elements: elements(),
      tracks: TRACKS,
      options: options(),
      anchor: PROJECT,
    });
    expect(JSON.parse(written.renderOptions).previewRatio).toBe(1);
  });

  // ---------------------------------------------------------- the anchor
  it("changes only assetPaths when the anchor changes", () => {
    // LOAD-BEARING. An autosave anchors on the `.ngt` it stands in for while
    // writing to a different file. If the anchor leaked into the other
    // entries, an autosave's digest could never match the save's baseline and
    // the recovery ring would never be dropped.
    const save = serializeProjectEntries({
      elements: elements(),
      tracks: TRACKS,
      options: options(),
      anchor: PROJECT,
    });
    const autosave = serializeProjectEntries({
      elements: elements(),
      tracks: TRACKS,
      options: options(),
      anchor: "/Users/me/Library/autosave/f-abc/1.ngt",
    });

    expect(autosave.timeline).toBe(save.timeline);
    expect(autosave.tracks).toBe(save.tracks);
    expect(autosave.project).toBe(save.project);
    // These two do differ, and must: one records where the media sits relative
    // to the project folder, the other is the "written, never read" field.
    expect(autosave.assetPaths).not.toBe(save.assetPaths);
    expect(autosave.renderOptions).not.toBe(save.renderOptions);
  });

  it("records a relative path for an asset inside the anchor's folder", () => {
    const written = serializeProjectEntries({
      elements: elements(),
      tracks: TRACKS,
      options: options(),
      anchor: PROJECT,
    });
    const parsed = JSON.parse(written.assetPaths);
    expect(parsed.entries.clip.localpath.rel).toBe("assets/a.mp4");
  });

  it("records no relative path for an asset outside the anchor's folder", () => {
    // An autosave anchored on its own location under userData would hit this
    // for every asset — which is exactly why it does not anchor there.
    const written = serializeProjectEntries({
      elements: elements(),
      tracks: TRACKS,
      options: options(),
      anchor: "/Users/me/Library/autosave/f-abc/1.ngt",
    });
    expect(JSON.parse(written.assetPaths).entries).toEqual({});
  });

  it("puts the anchor in videoDestination", () => {
    const written = serializeProjectEntries({
      elements: elements(),
      tracks: TRACKS,
      options: options(),
      anchor: PROJECT,
    });
    expect(JSON.parse(written.renderOptions).videoDestination).toBe(PROJECT);
  });

  it("carries the render options the file preserves", () => {
    const written = serializeProjectEntries({
      elements: elements(),
      tracks: TRACKS,
      options: options({ fps: 30, backgroundColor: "#112233" }),
      anchor: PROJECT,
    });
    const parsed = JSON.parse(written.renderOptions);
    expect(parsed.fps).toBe(30);
    expect(parsed.backgroundColor).toBe("#112233");
  });
});

describe("the round trip", () => {
  it("reads back a document equal to the normalized original", async () => {
    // LOAD-BEARING: "an autosave can actually be recovered".
    const written = serializeProjectEntries({
      elements: elements(),
      tracks: TRACKS,
      options: options(),
      anchor: PROJECT,
    });

    const result = await readBack(written, PROJECT);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const expected = normalizeDocument({
      schemaVersion: SCHEMA_VERSION,
      tracks: TRACKS,
      elements: JSON.parse(JSON.stringify(elements())),
    });
    expect(result.document).toEqual(expected);
  });

  it("survives a project with no elements and no tracks", async () => {
    const written = serializeProjectEntries({
      elements: {} as Timeline,
      tracks: [],
      options: options(),
      anchor: PROJECT,
    });
    const result = await readBack(written, PROJECT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.document.elements).toEqual({});
      expect(result.document.tracks).toEqual([]);
    }
  });

  it("keeps the render options readable", async () => {
    const written = serializeProjectEntries({
      elements: elements(),
      tracks: TRACKS,
      options: options({ fps: 24 }),
      anchor: PROJECT,
    });
    const result = await readBack(written, PROJECT);
    expect(result.ok && (result.renderOptions as { fps: number }).fps).toBe(24);
  });

  it("reports no missing media when every asset is found", async () => {
    const written = serializeProjectEntries({
      elements: elements(),
      tracks: TRACKS,
      options: options(),
      anchor: PROJECT,
    });
    const result = await readBack(written, PROJECT);
    expect(result.ok && result.missing).toBe(0);
  });

  it("survives a round trip through an autosave anchor", async () => {
    // The recovery case: written anchored on the project, read anchored on the
    // project, even though the bytes lived somewhere else in between.
    const written = serializeProjectEntries({
      elements: elements(),
      tracks: TRACKS,
      options: options(),
      anchor: PROJECT,
    });
    const result = await readBack(written, PROJECT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const clip = result.document.elements.clip as { localpath: string };
      expect(clip.localpath).toContain("/Users/me/Projects/assets/a.mp4");
    }
  });
});
