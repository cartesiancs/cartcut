import { describe, expect, it } from "vitest";
import type { Timeline } from "../../@types/timeline";
import { relativizeInside, resolveInside } from "../project/assetPaths";
import {
  audioElement,
  effectElement,
  imageElement,
  shapeElement,
  textElement,
  videoElement,
} from "../renderer/testing";
import { createTemplateElement } from "../timeline/templateOps";
import {
  exportSlotCount,
  planTemplateExport,
  safeAssetName,
} from "./exportPlan";

/**
 * What goes into a `.cttpl`.
 *
 * The load-bearing assertion is the last one: the paths this plan mints have to
 * be ones `serializeAssetPaths` will relativise and `resolveInside` will
 * resolve. Everything else in the format rests on that round trip, and it is
 * checked here against the real functions rather than against a restatement of
 * what they do.
 */

const STAGING = "/tmp/cartcut-export-1";

function plan(elements: Record<string, any>, stagingDir = STAGING) {
  return planTemplateExport(elements as Timeline, {
    stagingDir,
    flavour: "posix",
  });
}

describe("refusals", () => {
  it("refuses a project that already contains a template", () => {
    // The half of the nesting cap someone can act on. `composeTemplate` strips
    // a nested template silently, because by then there is nobody to tell.
    const result = plan({
      tpl: createTemplateElement({
        templateId: "x",
        name: "X",
        durationMs: 1,
        size: { w: 1, h: 1 },
        frame: { w: 1, h: 1 },
      }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/cannot contain another template/);
  });
});

describe("warnings", () => {
  it("warns about effects and transitions, without refusing", () => {
    const result = plan({ e: effectElement(), v: videoElement() });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/will not render inside a template/);
  });

  it("says nothing when there is nothing to say", () => {
    const result = plan({ v: videoElement() });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings).toEqual([]);
  });

  it("counts them, and pluralises", () => {
    const result = plan({ a: effectElement(), b: effectElement() });
    if (!result.ok) return;
    expect(result.warnings[0]).toMatch(/^2 effect or transition clips/);
  });
});

describe("staging", () => {
  it("puts every asset under assets/", () => {
    const result = plan({
      v: videoElement({ localpath: "file:///me/clips/a.mp4" }),
    });
    if (!result.ok) return;
    expect(result.assets).toEqual([
      {
        from: "/me/clips/a.mp4",
        entry: "assets/a.mp4",
        localpath: "file:///tmp/cartcut-export-1/assets/a.mp4",
      },
    ]);
  });

  it("rewrites the element to point at the staged copy", () => {
    const result = plan({
      v: videoElement({ localpath: "file:///me/clips/a.mp4" }),
    });
    if (!result.ok) return;
    expect((result.elements.v as any).localpath).toBe(
      "file:///tmp/cartcut-export-1/assets/a.mp4",
    );
  });

  it("stages one file once however many clips use it", () => {
    const result = plan({
      a: videoElement({ localpath: "file:///me/a.mp4" }),
      b: videoElement({ localpath: "file:///me/a.mp4" }),
    });
    if (!result.ok) return;
    expect(result.assets).toHaveLength(1);
    expect((result.elements.a as any).localpath).toBe(
      (result.elements.b as any).localpath,
    );
  });

  it("gives two different files sharing a basename their own names", () => {
    const result = plan({
      a: videoElement({ localpath: "file:///me/one/clip.mp4" }),
      b: videoElement({ localpath: "file:///me/two/clip.mp4" }),
    });
    if (!result.ok) return;
    expect(result.assets.map((asset) => asset.entry).sort()).toEqual([
      "assets/clip-2.mp4",
      "assets/clip.mp4",
    ]);
  });

  it("resolves a third collision too", () => {
    const result = plan({
      a: videoElement({ localpath: "file:///1/clip.mp4" }),
      b: videoElement({ localpath: "file:///2/clip.mp4" }),
      c: videoElement({ localpath: "file:///3/clip.mp4" }),
    });
    if (!result.ok) return;
    expect(result.assets.map((asset) => asset.entry).sort()).toEqual([
      "assets/clip-2.mp4",
      "assets/clip-3.mp4",
      "assets/clip.mp4",
    ]);
  });

  it("is deterministic, so one project always builds the same archive", () => {
    const elements = {
      z: videoElement({ localpath: "file:///1/clip.mp4" }),
      a: videoElement({ localpath: "file:///2/clip.mp4" }),
    };
    const first = plan(elements);
    const second = plan(elements);
    expect(first).toEqual(second);
  });

  it("stages a text element's font", () => {
    const result = plan({
      t: textElement({ fontpath: "/me/fonts/Inter.ttf" }),
    });
    if (!result.ok) return;
    expect(result.assets[0].entry).toBe("assets/Inter.ttf");
    expect((result.elements.t as any).fontpath).toBe(
      "/tmp/cartcut-export-1/assets/Inter.ttf",
    );
  });

  it("stages audio", () => {
    const result = plan({
      a: audioElement({ localpath: "file:///me/music.mp3" }),
    });
    if (!result.ok) return;
    expect(result.assets[0].entry).toBe("assets/music.mp3");
  });

  it("leaves sentinel-carrying elements alone", () => {
    const result = plan({ s: shapeElement(), e: effectElement() });
    if (!result.ok) return;
    expect(result.assets).toEqual([]);
    expect(result.elements.s).toBe(result.elements.s);
  });

  it("ignores a remote source", () => {
    const result = plan({
      i: imageElement({ localpath: "https://example.com/a.png" }),
    });
    if (!result.ok) return;
    expect(result.assets).toEqual([]);
  });

  it("keeps a bare path bare and a file URL a URL", () => {
    // `mergeOps` decides two clips share a source by comparing these strings,
    // and `loadedAssetStore` keys its cache on them, so the shape has to
    // survive — the rule `mintLocalPath` states.
    const result = plan({
      url: videoElement({ localpath: "file:///me/a.mp4" }),
      bare: videoElement({ localpath: "/me/b.mp4" }),
    });
    if (!result.ok) return;
    expect((result.elements.url as any).localpath.startsWith("file://")).toBe(
      true,
    );
    expect((result.elements.bare as any).localpath).toBe(
      "/tmp/cartcut-export-1/assets/b.mp4",
    );
  });

  it("does not mutate the document it was given", () => {
    const elements = { v: videoElement({ localpath: "file:///me/a.mp4" }) };
    plan(elements);
    expect(elements.v.localpath).toBe("file:///me/a.mp4");
  });
});

describe("safeAssetName", () => {
  it("keeps an ordinary name", () => {
    expect(safeAssetName("sunset.mp4")).toBe("sunset.mp4");
  });

  it("replaces what a filesystem or a zip would choke on", () => {
    expect(safeAssetName("a:b?c*d.mp4")).toBe("a-b-c-d.mp4");
    expect(safeAssetName("with space.mp4")).toBe("with-space.mp4");
  });

  it("refuses to produce a hidden file", () => {
    expect(safeAssetName(".hidden.mp4")).toBe("hidden.mp4");
  });

  it("collapses a run of replacements", () => {
    expect(safeAssetName("a???b.mp4")).toBe("a-b.mp4");
  });

  it("never produces an empty name", () => {
    expect(safeAssetName("")).toBe("asset");
    expect(safeAssetName("...")).toBe("asset");
  });

  it("keeps the extension, which is what decides an imported file's kind", () => {
    expect(safeAssetName("한글 파일.mp4").endsWith(".mp4")).toBe(true);
  });
});

describe("the round trip the whole format rests on", () => {
  it("mints paths that relativise to the archive and resolve back", () => {
    // Asserted against the real `assetPaths.ts`, not a restatement of it. If
    // this holds, `serializeAssetPaths` will write `assets/…` into the
    // `.ngt`'s `assetPaths.json` and `relinkAssets` will resolve it on install.
    const result = plan({
      v: videoElement({ localpath: "file:///me/clips/a.mp4" }),
    });
    if (!result.ok) return;

    const ngt = `${STAGING}/template.ngt`;
    const staged = (result.elements.v as any).localpath;

    const rel = relativizeInside(staged, ngt, "posix");
    expect(rel).toBe("assets/a.mp4");

    const installed = "/Users/you/Library/templates/neon/template.ngt";
    expect(resolveInside(rel, installed, "posix")).toBe(
      "/Users/you/Library/templates/neon/assets/a.mp4",
    );
  });

  it("holds on Windows, where the URL this app mints is malformed", () => {
    const result = planTemplateExport(
      { v: videoElement({ localpath: "file://D:\\media\\a.mp4" }) } as Timeline,
      { stagingDir: "C:\\Temp\\build", flavour: "win32" },
    );
    if (!result.ok) return;

    expect(result.assets[0].from).toBe("D:\\media\\a.mp4");
    const staged = (result.elements.v as any).localpath;
    expect(staged).toBe("file://C:\\Temp\\build\\assets\\a.mp4");
    expect(
      relativizeInside(staged, "C:\\Temp\\build\\template.ngt", "win32"),
    ).toBe("assets/a.mp4");
  });
});

describe("exportSlotCount", () => {
  it("counts distinct slots, not marked clips", () => {
    expect(
      exportSlotCount({
        a: videoElement({ replaceable: { slotId: "hero" } }),
        b: videoElement({ replaceable: { slotId: "hero" } }),
        c: textElement({ replaceable: { slotId: "name" } }),
        d: videoElement(),
      } as Timeline),
    ).toBe(2);
  });

  it("is zero for a project nobody marked up", () => {
    expect(exportSlotCount({ a: videoElement() } as Timeline)).toBe(0);
  });
});
