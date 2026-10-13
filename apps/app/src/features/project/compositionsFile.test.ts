import { describe, expect, it, vi } from "vitest";
import type { Timeline } from "../../@types/timeline";
import type { Composition } from "../composition/project";
import { imageElement, videoElement } from "../renderer/testing";
import { createTrack } from "../timeline/tracks";
import {
  COMPOSITIONS_ENTRY,
  compositionsDigestText,
  compositionsExtraEntries,
  readCompositions,
  serializeCompositions,
} from "./compositionsFile";

/**
 * The project's own templates on disk. Four claims:
 *
 *  - **Nothing to hold, nothing written**, so a project without one is the
 *    file it always was.
 *  - **A round trip is exact**, and a moved project folder relinks a
 *    template's media as it relinks main's, on either platform.
 *  - **A malformed composition is left out, never thrown on.**
 *  - **The digest does not see asset paths**, which depend on where the file
 *    is going.
 */

const PROJECT = "/p/proj/promo.ngt";

function existsOnly(...present: string[]) {
  const set = new Set(present);
  return vi.fn(async (p: string) => set.has(p));
}

function composition(over: Partial<Composition> = {}): Composition {
  return {
    id: "c1",
    name: "Intro",
    size: { w: 1080, h: 1920 },
    source: { templateId: "neon", name: "Neon" },
    tracks: [createTrack("ct", "video", 0)],
    elements: {
      shot: videoElement({
        trackId: "ct",
        localpath: "file:///p/proj/clips/a.mp4",
      }),
    } as Timeline,
    ...over,
  };
}

describe("serializeCompositions", () => {
  it("writes nothing for no compositions", () => {
    expect(serializeCompositions({}, PROJECT)).toBeNull();
    expect(compositionsExtraEntries({}, PROJECT)).toEqual({});
  });

  it("writes them under one entry, sorted by id", () => {
    const text = serializeCompositions(
      { z: composition({ id: "z" }), a: composition({ id: "a" }) },
      PROJECT,
    )!;
    const parsed = JSON.parse(text);
    expect(parsed.v).toBe(1);
    expect(parsed.compositions.map((c: any) => c.id)).toEqual(["a", "z"]);
    expect(Object.keys(compositionsExtraEntries({ a: composition() }, PROJECT))).toEqual([
      COMPOSITIONS_ENTRY,
    ]);
  });

  it("is the same text for the same compositions in any key order", () => {
    const a = composition({ id: "a" });
    const z = composition({ id: "z" });
    expect(serializeCompositions({ a, z }, PROJECT)).toBe(
      serializeCompositions({ z, a }, PROJECT),
    );
  });

  it("records relative paths for media inside the project folder", () => {
    const parsed = JSON.parse(serializeCompositions({ c1: composition() }, PROJECT)!);
    expect(parsed.compositions[0].assetPaths.entries).toEqual({
      shot: { localpath: { rel: "clips/a.mp4", abs: "file:///p/proj/clips/a.mp4" } },
    });
  });
});

describe("readCompositions", () => {
  it("reads nothing from nothing, and from junk", async () => {
    for (const text of [null, undefined, "", "{", "[]", '{"compositions":3}']) {
      expect((await readCompositions(text, PROJECT, existsOnly())).compositions).toEqual(
        {},
      );
    }
  });

  it("round-trips a composition exactly", async () => {
    const written = composition();
    const text = serializeCompositions({ c1: written }, PROJECT);
    const read = await readCompositions(
      text,
      PROJECT,
      existsOnly("/p/proj/clips/a.mp4"),
    );
    expect(read.compositions.c1).toEqual(written);
    expect(read.missing).toBe(0);
  });

  it("relinks a template's media when the project folder moved", async () => {
    const text = serializeCompositions({ c1: composition() }, PROJECT);
    const read = await readCompositions(
      text,
      "/Users/you/promo/promo.ngt",
      existsOnly("/Users/you/promo/clips/a.mp4"),
    );
    expect((read.compositions.c1.elements.shot as any).localpath).toBe(
      "file:///Users/you/promo/clips/a.mp4",
    );
    expect(read.relinked).toBe(1);
  });

  it("carries a Windows project's template to a Mac", async () => {
    const text = serializeCompositions(
      {
        c1: composition({
          elements: {
            shot: videoElement({
              trackId: "ct",
              localpath: "file://C:\\Work\\Promo\\clips\\a.mp4",
            }),
          } as Timeline,
        }),
      },
      "C:\\Work\\Promo\\promo.ngt",
    );
    const read = await readCompositions(
      text,
      "/Users/me/Promo/promo.ngt",
      existsOnly("/Users/me/Promo/clips/a.mp4"),
    );
    expect((read.compositions.c1.elements.shot as any).localpath).toBe(
      "file:///Users/me/Promo/clips/a.mp4",
    );
  });

  it("counts a file that is nowhere as missing", async () => {
    const text = serializeCompositions({ c1: composition() }, PROJECT);
    const read = await readCompositions(text, "/elsewhere/p.ngt", existsOnly());
    expect(read.missing).toBe(1);
    expect(read.compositions.c1).toBeDefined();
  });

  it("leaves out a malformed composition and keeps the rest", async () => {
    const good = JSON.parse(serializeCompositions({ c1: composition() }, PROJECT)!)
      .compositions[0];
    const text = JSON.stringify({
      v: 1,
      compositions: [
        good,
        { ...good, id: "" },
        { ...good, id: "c1" },
        { ...good, id: "noSize", size: { w: 0, h: 10 } },
        { ...good, id: "array", elements: [] },
        null,
        "x",
      ],
    });
    const read = await readCompositions(text, PROJECT, existsOnly());
    expect(Object.keys(read.compositions)).toEqual(["c1"]);
  });

  it("drops a malformed source rather than the composition", async () => {
    const good = JSON.parse(serializeCompositions({ c1: composition() }, PROJECT)!)
      .compositions[0];
    const text = JSON.stringify({ v: 1, compositions: [{ ...good, source: { name: 3 } }] });
    const read = await readCompositions(text, PROJECT, existsOnly());
    expect(read.compositions.c1.source).toBeUndefined();
  });
});

describe("compositionsDigestText", () => {
  it("is null for none", () => {
    expect(compositionsDigestText({})).toBeNull();
  });

  it("changes with the content and not with the destination", () => {
    const one = compositionsDigestText({ c1: composition() });
    const moved = composition({
      elements: {
        shot: imageElement({ trackId: "ct", startTime: 100 }),
      } as Timeline,
    });
    expect(compositionsDigestText({ c1: moved })).not.toBe(one);
    expect(one).not.toContain("assetPaths");
  });
});
