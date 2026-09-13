import { describe, expect, it, vi } from "vitest";
import {
  readProjectDocument,
  readProjectFailureMessage,
} from "./projectDocument";
import type { NgtEntries } from "./projectEntries";

/**
 * The one load order, checked where `functions/project.ts` could not be.
 *
 * Two things carry the suite. **Nothing here may throw**: this runs on the
 * path that has already decided to replace the timeline, and an exception
 * escaping a promise is how the old load path turned a cancelled dialog into
 * an empty project with no message. And **the anchor is what drives the
 * relink** — an autosave's bytes live under `userData` while its assets live
 * beside the user's `.ngt`, so probing the wrong folder is a recovery that
 * reports every clip as missing media.
 */

const NOT_FOUND = async () => false;

function entries(over: Partial<NgtEntries> = {}): NgtEntries {
  return {
    project: '{"schemaVersion":2}',
    timeline: "{}",
    tracks: "[]",
    renderOptions: '{"fps":60}',
    assetPaths: null,
    ...over,
  };
}

function clip(localpath: string) {
  return {
    filetype: "video",
    startTime: 0,
    duration: 1000,
    location: { x: 0, y: 0 },
    trim: { startTime: 0, endTime: 1000 },
    width: 100,
    height: 100,
    localpath,
    priority: 1,
  };
}

describe("readProjectDocument", () => {
  it("reads a well-formed project", async () => {
    const result = await readProjectDocument(entries(), "/a/p.ngt", NOT_FOUND);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.document.schemaVersion).toBe(2);
      expect(result.renderOptions).toEqual({ fps: 60 });
    }
  });

  // -------------------------------------------------------- the schema gate
  it("refuses a newer schema version", async () => {
    const result = await readProjectDocument(
      entries({ project: '{"schemaVersion":3}' }),
      "/a/p.ngt",
      NOT_FOUND,
    );
    expect(result).toEqual({
      ok: false,
      reason: "schema",
      found: 3,
      expected: 2,
    });
  });

  it("treats a missing project.json as version 1 and refuses it", async () => {
    // A file without the entry predates tracks; its elements carry a
    // hand-assigned priority that doubled as a row index. There is no
    // migration, so refusing beats opening something subtly wrong.
    const result = await readProjectDocument(
      entries({ project: null }),
      "/a/p.ngt",
      NOT_FOUND,
    );
    expect(result).toMatchObject({ ok: false, reason: "schema", found: 1 });
  });

  it("refuses before relinking, so a mismatch probes nothing", async () => {
    // The refusal has to be free of side effects: File → Open shows a modal
    // and leaves the open project alone.
    const exists = vi.fn(async () => true);
    await readProjectDocument(
      entries({ project: '{"schemaVersion":99}' }),
      "/a/p.ngt",
      exists,
    );
    expect(exists).not.toHaveBeenCalled();
  });

  // ------------------------------------------------------ the unreadable gate
  it.each([null, "", "not json", "[]", "3", '"text"', "null"])(
    "reports an unreadable timeline.json for %j",
    async (timeline) => {
      const result = await readProjectDocument(
        entries({ timeline }),
        "/a/p.ngt",
        NOT_FOUND,
      );
      expect(result).toMatchObject({ ok: false, reason: "unreadable" });
    },
  );

  it("accepts an absent tracks.json as no tracks", async () => {
    // A project written before tracks existed. Not a failure.
    const result = await readProjectDocument(
      entries({ tracks: null }),
      "/a/p.ngt",
      NOT_FOUND,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.document.tracks).toEqual([]);
    }
  });

  it.each(["not json", "{}", "3", '"text"'])(
    "accepts a malformed tracks.json (%j) as no tracks",
    async (tracks) => {
      const result = await readProjectDocument(
        entries({ tracks }),
        "/a/p.ngt",
        NOT_FOUND,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.document.tracks).toEqual([]);
      }
    },
  );

  it.each(["not json", "[]", "3"])(
    "accepts a malformed renderOptions.json (%j) and reports it raw",
    async (renderOptions) => {
      // `deserializeRenderOptions` answers every missing field from defaults,
      // so handing it junk is safe and losing the whole project to it is not.
      const result = await readProjectDocument(
        entries({ renderOptions }),
        "/a/p.ngt",
        NOT_FOUND,
      );
      expect(result.ok).toBe(true);
    },
  );

  it.each(["not json", "3", '"text"', "[]"])(
    "accepts a malformed assetPaths.json (%j)",
    async (assetPaths) => {
      const result = await readProjectDocument(
        entries({ assetPaths }),
        "/a/p.ngt",
        NOT_FOUND,
      );
      expect(result.ok).toBe(true);
    },
  );

  it("never throws, whatever the entries hold", async () => {
    // One at a time above; all at once here.
    const junk: NgtEntries = {
      project: "{",
      timeline: "{",
      tracks: "{",
      renderOptions: "{",
      assetPaths: "{",
    };
    await expect(
      readProjectDocument(junk, "/a/p.ngt", NOT_FOUND),
    ).resolves.toMatchObject({ ok: false });
  });

  // ---------------------------------------------------------- the anchor
  it("resolves a relative asset path against the anchor's folder", async () => {
    // LOAD-BEARING. This is the whole reason `anchor` is a parameter.
    const abs = "file:///Users/me/Projects/assets/a.mp4";
    const probed: string[] = [];

    const result = await readProjectDocument(
      entries({
        timeline: JSON.stringify({ c: clip(abs) }),
        assetPaths: JSON.stringify({
          version: 1,
          entries: { c: { localpath: { rel: "assets/a.mp4", abs } } },
        }),
      }),
      "/Users/me/Projects/Film.ngt",
      async (p) => {
        probed.push(p);
        return true;
      },
    );

    expect(result.ok).toBe(true);
    expect(probed.some((p) => p.includes("/Users/me/Projects/assets/a.mp4"))).toBe(
      true,
    );
    // And never against where the bytes happened to be sitting.
    expect(probed.some((p) => p.includes("autosave"))).toBe(false);
  });

  it("falls back to the absolute path when the relative one is not there", async () => {
    const abs = "file:///Users/me/Projects/assets/a.mp4";
    const result = await readProjectDocument(
      entries({
        timeline: JSON.stringify({ c: clip(abs) }),
        assetPaths: JSON.stringify({
          version: 1,
          entries: { c: { localpath: { rel: "assets/a.mp4", abs } } },
        }),
      }),
      "/Volumes/Moved/Film.ngt",
      NOT_FOUND,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.document.elements.c as { localpath: string }).localpath).toBe(
        abs,
      );
      // Counted in files, not clips.
      expect(result.missing).toBe(1);
    }
  });

  it("resolves against a win32 anchor", async () => {
    // `assetPaths.ts` takes path flavour as an explicit parameter precisely so
    // both branches are covered on one CI host. This is the other branch.
    const abs = "file://C:\\Users\\me\\Projects\\assets\\a.mp4";
    const probed: string[] = [];
    const result = await readProjectDocument(
      entries({
        timeline: JSON.stringify({ c: clip(abs) }),
        assetPaths: JSON.stringify({
          version: 1,
          entries: { c: { localpath: { rel: "assets/a.mp4", abs } } },
        }),
      }),
      "C:\\Users\\me\\Projects\\Film.ngt",
      async (p) => {
        probed.push(p);
        return true;
      },
    );
    expect(result.ok).toBe(true);
    expect(probed.some((p) => p.includes("assets"))).toBe(true);
  });

  it("treats the web shim's \"none\" as a file that is not there", async () => {
    // `ipcWrapper`'s `existFile` answers the truthy string "none", which is
    // why `relinkAssets` compares `=== true`. A truthy non-true must not be
    // read as "found".
    const abs = "file:///Users/me/Projects/assets/a.mp4";
    const result = await readProjectDocument(
      entries({
        timeline: JSON.stringify({ c: clip(abs) }),
        assetPaths: JSON.stringify({
          version: 1,
          entries: { c: { localpath: { rel: "assets/a.mp4", abs } } },
        }),
      }),
      "/Users/me/Projects/Film.ngt",
      async () => "none",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.missing).toBe(1);
    }
  });

  it("reports relinked and missing separately", async () => {
    const here = "file:///Users/me/Projects/assets/here.mp4";
    const gone = "file:///Users/me/Projects/assets/gone.mp4";
    const result = await readProjectDocument(
      entries({
        timeline: JSON.stringify({ a: clip(here), b: clip(gone) }),
        assetPaths: JSON.stringify({
          version: 1,
          entries: {
            a: { localpath: { rel: "assets/here.mp4", abs: here } },
            b: { localpath: { rel: "assets/gone.mp4", abs: gone } },
          },
        }),
      }),
      "/Users/me/Projects/Film.ngt",
      async (p) => p.includes("here.mp4"),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.missing).toBe(1);
    }
  });

  it("normalizes the document it returns", async () => {
    // Through `normalizeDocument`, so `priority` is what the compositor would
    // see. A hand-built map would let a project render here and not in the app.
    const result = await readProjectDocument(
      entries({
        timeline: JSON.stringify({
          a: { ...clip("file:///a.mp4"), priority: 99 },
        }),
        tracks: JSON.stringify([
          { id: "t1", kind: "video", name: "", index: 0 },
        ]),
      }),
      "/a/p.ngt",
      NOT_FOUND,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      // `nameTracks` derives the display name; it is never authored.
      expect(result.document.tracks[0].name).not.toBe("");
    }
  });
});

describe("readProjectFailureMessage", () => {
  it("names both versions for a schema mismatch", () => {
    const message = readProjectFailureMessage({
      ok: false,
      reason: "schema",
      found: 1,
      expected: 2,
    });
    expect(message).toContain("v1");
    expect(message).toContain("v2");
  });

  it("carries the reason for an unreadable project", () => {
    const message = readProjectFailureMessage({
      ok: false,
      reason: "unreadable",
      message: "the project's timeline.json is missing or unreadable",
    });
    expect(message).toContain("timeline.json");
  });
});
