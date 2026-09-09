import { describe, expect, it } from "vitest";
import { imageElement, videoElement } from "../renderer/testing";
import { SCHEMA_VERSION } from "../timeline/tracks";
import {
  readTemplateDocument,
  templateDurationOf,
  templateSizeOf,
  type NgtEntries,
} from "./templateDocument";

/**
 * Reading an installed `template.ngt`.
 *
 * The interesting half is that it reuses `relinkAssets` rather than reinventing
 * it: a template folder and a portable project folder are the same problem, and
 * the relative paths inside the archive resolve against the extracted `.ngt`
 * exactly as a project's do against its own file.
 */

const NGT = "/Users/me/Library/templates/neon/template.ngt";

function entries(over: Partial<NgtEntries> = {}): NgtEntries {
  return {
    project: JSON.stringify({ schemaVersion: SCHEMA_VERSION }),
    timeline: JSON.stringify({
      a: imageElement({ key: "a", startTime: 0, duration: 4000 }),
    }),
    tracks: JSON.stringify([
      { id: "v1", kind: "video", name: "V1", index: 0 },
    ]),
    renderOptions: JSON.stringify({
      previewSize: { w: 1080, h: 1920 },
      videoDuration: 30,
    }),
    assetPaths: null,
    ...over,
  };
}

const nothingExists = async () => false;
const everythingExists = async () => true;

function input(over: Partial<Parameters<typeof readTemplateDocument>[0]> = {}) {
  return {
    id: "neon",
    ngtPath: NGT,
    manifest: { name: null, author: null, thumbnail: null },
    fallbackName: "neon",
    entries: entries(),
    ...over,
  };
}

describe("the version gate", () => {
  it("reads a template written by this version", async () => {
    const data = await readTemplateDocument(input(), nothingExists);
    expect(data.id).toBe("neon");
  });

  it("refuses one written by another version", async () => {
    // A compatibility check, not a migrator — the rule `functions/project.ts`
    // already states for a project.
    await expect(
      readTemplateDocument(
        input({ entries: entries({ project: JSON.stringify({ schemaVersion: 99 }) }) }),
        nothingExists,
      ),
    ).rejects.toThrow(/different version/);
  });

  it("treats a missing project.json as version 1 and refuses it", async () => {
    await expect(
      readTemplateDocument(
        input({ entries: entries({ project: null }) }),
        nothingExists,
      ),
    ).rejects.toThrow(/different version/);
  });

  it("refuses an unreadable timeline", async () => {
    await expect(
      readTemplateDocument(
        input({ entries: entries({ timeline: "{ not json" }) }),
        nothingExists,
      ),
    ).rejects.toThrow(/timeline\.json/);
  });
});

describe("the name", () => {
  it("prefers the manifest", async () => {
    const data = await readTemplateDocument(
      input({
        manifest: { name: "Neon Intro", author: null, thumbnail: null },
      }),
      nothingExists,
    );
    expect(data.name).toBe("Neon Intro");
  });

  it("falls back to the installed folder", async () => {
    const data = await readTemplateDocument(
      input({ fallbackName: "neon-intro" }),
      nothingExists,
    );
    expect(data.name).toBe("neon-intro");
  });
});

describe("templateSizeOf", () => {
  it("takes the project's preview size", () => {
    expect(templateSizeOf({ previewSize: { w: 1080, h: 1920 } })).toEqual({
      w: 1080,
      h: 1920,
    });
  });

  it("falls back to 1920x1080 for anything unusable", () => {
    for (const raw of [null, undefined, {}, { previewSize: {} }, 7]) {
      expect(templateSizeOf(raw)).toEqual({ w: 1920, h: 1080 });
    }
  });

  it("refuses a zero or negative dimension", () => {
    expect(templateSizeOf({ previewSize: { w: 0, h: 100 } })).toEqual({
      w: 1920,
      h: 1080,
    });
  });
});

describe("templateDurationOf", () => {
  it("is the extent of the content, not the project setting", () => {
    // A ten-second project whose picture stops at four seconds is a
    // four-second template. The alternative is a bar that runs on past
    // anything visible with nothing on screen saying why.
    const duration = templateDurationOf(
      {
        a: imageElement({ startTime: 0, duration: 2000 }),
        b: imageElement({ startTime: 2000, duration: 2000 }),
      } as any,
      { videoDuration: 30 },
    );
    expect(duration).toBe(4000);
  });

  it("accounts for speed, through spanEnd", () => {
    const duration = templateDurationOf(
      {
        a: videoElement({
          startTime: 0,
          duration: 4000,
          speed: 2,
          trim: { startTime: 0, endTime: 4000 },
        }),
      } as any,
      {},
    );
    expect(duration).toBe(2000);
  });

  it("falls back to the project setting when there is no content", () => {
    expect(templateDurationOf({} as any, { videoDuration: 6 })).toBe(6000);
  });

  it("answers zero when there is nothing to go on", () => {
    expect(templateDurationOf({} as any, null)).toBe(0);
  });
});

describe("relinking", () => {
  it("resolves a relative path against the extracted folder", async () => {
    const data = await readTemplateDocument(
      input({
        entries: entries({
          timeline: JSON.stringify({
            a: videoElement({
              key: "a",
              localpath: "file:///the/authors/machine/clip.mp4",
            }),
          }),
          assetPaths: JSON.stringify({
            version: 1,
            entries: {
              a: {
                localpath: {
                  rel: "assets/clips/deep/clip.mp4",
                  abs: "file:///the/authors/machine/clip.mp4",
                },
              },
            },
          }),
        }),
      }),
      everythingExists,
    );
    // Subdirectories survive — the user requirement, met by machinery that
    // already existed.
    expect((data.elements.a as any).localpath).toBe(
      "file:///Users/me/Library/templates/neon/assets/clips/deep/clip.mp4",
    );
  });

  it("keeps the absolute path when the relative one is not on disk", async () => {
    const data = await readTemplateDocument(
      input({
        entries: entries({
          timeline: JSON.stringify({
            a: videoElement({ key: "a", localpath: "file:///elsewhere/clip.mp4" }),
          }),
          assetPaths: JSON.stringify({
            version: 1,
            entries: {
              a: {
                localpath: {
                  rel: "assets/clip.mp4",
                  abs: "file:///elsewhere/clip.mp4",
                },
              },
            },
          }),
        }),
      }),
      nothingExists,
    );
    expect((data.elements.a as any).localpath).toBe(
      "file:///elsewhere/clip.mp4",
    );
  });
});

describe("the document it produces", () => {
  it("derives priorities through normalizeDocument", async () => {
    const data = await readTemplateDocument(
      input({
        entries: entries({
          timeline: JSON.stringify({
            a: imageElement({ key: "a", trackId: "v1", priority: 99 }),
          }),
        }),
      }),
      nothingExists,
    );
    // 99 was whatever the file happened to say; the compositor's rank is
    // derived from track order.
    expect(data.elements.a.priority).toBe(1);
  });

  it("derives the slot list once, at load", async () => {
    const data = await readTemplateDocument(
      input({
        entries: entries({
          timeline: JSON.stringify({
            a: videoElement({
              key: "a",
              trackId: "v1",
              replaceable: { slotId: "hero" },
            }),
          }),
        }),
      }),
      nothingExists,
    );
    expect(data.slots.map((slot) => slot.slotId)).toEqual(["hero"]);
  });

  it("survives a template with no tracks entry", async () => {
    const data = await readTemplateDocument(
      input({ entries: entries({ tracks: null }) }),
      nothingExists,
    );
    expect(Object.keys(data.elements)).toEqual(["a"]);
  });
});
