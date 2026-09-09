/**
 * The `assetPaths.json` round trip: does a template survive being moved?
 *
 * `project.ts` cannot answer that question — it reaches for
 * `document.querySelector`, `window.electronAPI` and JSZip within a few lines
 * of every branch — which is why the format lives in its own module, exactly as
 * `renderOptionsFile.ts` does. Here the question is a round trip between two
 * functions with a fake `exists`.
 *
 * The cases worth naming, because each of them is silent when it breaks:
 *
 *  - **the relative path must win when both resolve.** That ordering *is* the
 *    feature. Reverse it and a moved template keeps opening the author's files
 *    on the author's machine and nobody notices until they ship it.
 *  - **`abs` must still match.** It is the only thing standing between a
 *    hand-edited archive and a clip that silently plays the wrong video.
 *  - **`exists` returning `"none"`.** The web build's shim answers with that
 *    string, which is truthy, so a naive `if (await exists(p))` reports every
 *    path on earth as present.
 *  - **the filetype filter.** A text element's `localpath` is `/TEXTELEMENT`,
 *    which looks exactly like a posix absolute path.
 */

import { describe, it, expect, vi } from "vitest";

import {
  assetFieldsOf,
  relinkAssets,
  serializeAssetPaths,
  type AssetPathsFile,
} from "./assetsFile";
import {
  audioElement,
  effectElement,
  gifElement,
  groupElement,
  imageElement,
  shapeElement,
  textElement,
  transitionElement,
  videoElement,
} from "../renderer/testing";

const PROJECT = "/p/proj/promo.ngt";

/** An `exists` that answers `true` for exactly the paths listed. */
function existsOnly(...present: string[]) {
  const set = new Set(present);
  return vi.fn(async (p: string) => set.has(p));
}

/** Save, then reopen from `openedAt`, as JSON so nothing survives by reference. */
async function roundTrip(
  elements: Record<string, any>,
  savedAt: string,
  openedAt: string,
  exists: (p: string) => Promise<unknown>,
) {
  const file = serializeAssetPaths(elements as any, savedAt);
  const onDisk = JSON.parse(JSON.stringify(file));
  return relinkAssets(elements as any, onDisk, openedAt, exists);
}

describe("assetFieldsOf", () => {
  it("names a path field only for the four types that have one", () => {
    expect(assetFieldsOf(videoElement())).toEqual(["localpath"]);
    expect(assetFieldsOf(imageElement())).toEqual(["localpath"]);
    expect(assetFieldsOf(gifElement())).toEqual(["localpath"]);
    expect(assetFieldsOf(audioElement())).toEqual(["localpath"]);
    expect(assetFieldsOf(textElement())).toEqual(["fontpath"]);
  });

  it("names none for the types whose localpath is a sentinel", () => {
    expect(assetFieldsOf(shapeElement())).toEqual([]);
    expect(assetFieldsOf(effectElement())).toEqual([]);
    expect(assetFieldsOf(transitionElement())).toEqual([]);
    expect(assetFieldsOf(groupElement())).toEqual([]);
  });
});

describe("serializeAssetPaths", () => {
  it("records a file beside the project and one below it", () => {
    const file = serializeAssetPaths(
      {
        a: videoElement({ localpath: "file:///p/proj/a.mp4" }),
        b: imageElement({ localpath: "file:///p/proj/art/logo.png" }),
      } as any,
      PROJECT,
    );

    expect(file).toEqual({
      version: 1,
      entries: {
        a: { localpath: { rel: "a.mp4", abs: "file:///p/proj/a.mp4" } },
        b: {
          localpath: { rel: "art/logo.png", abs: "file:///p/proj/art/logo.png" },
        },
      },
    });
  });

  it("covers all four media types", () => {
    const file = serializeAssetPaths(
      {
        v: videoElement({ localpath: "file:///p/proj/v.mp4" }),
        i: imageElement({ localpath: "file:///p/proj/i.png" }),
        g: gifElement({ localpath: "file:///p/proj/g.gif" }),
        a: audioElement({ localpath: "file:///p/proj/a.wav" }),
      } as any,
      PROJECT,
    );
    expect(Object.keys(file.entries).sort()).toEqual(["a", "g", "i", "v"]);
  });

  it("says nothing about a file outside the folder — never a ../", () => {
    const file = serializeAssetPaths(
      {
        a: videoElement({ localpath: "file:///elsewhere/a.mp4" }),
        b: videoElement({ localpath: "file:///p/other/a.mp4" }),
        c: videoElement({ localpath: "file:///p/a.mp4" }),
      } as any,
      PROJECT,
    );
    expect(file.entries).toEqual({});
  });

  it("never produces an entry for a type whose localpath is a sentinel", () => {
    const file = serializeAssetPaths(
      {
        t: textElement(),
        s: shapeElement(),
        e: effectElement(),
        r: transitionElement(),
        g: groupElement(),
      } as any,
      PROJECT,
    );
    expect(file.entries).toEqual({});
  });

  it("leaves /TEXTELEMENT alone even for a project at the volume root", () => {
    // The trap: at the root there are no directory segments, so every absolute
    // path is 'inside'. Only the filetype filter saves this — a sentinel
    // blocklist keyed on the string would still have to know this exact value,
    // and the next sentinel someone invents would slip through.
    const file = serializeAssetPaths(
      { t: textElement({ localpath: "/TEXTELEMENT" }) } as any,
      "/promo.ngt",
    );
    expect(file.entries).toEqual({});
  });

  it("ignores a font it cannot place", () => {
    const file = serializeAssetPaths(
      {
        a: textElement({ fontpath: "default" }),
        b: textElement({ fontpath: "" }),
        c: textElement({ fontpath: "/Library/Fonts/Helvetica.ttc" }),
      } as any,
      PROJECT,
    );
    expect(file.entries).toEqual({});
  });

  it("records a font dropped next to the project", () => {
    const file = serializeAssetPaths(
      { a: textElement({ fontpath: "/p/proj/fonts/Pretendard.ttf" }) } as any,
      PROJECT,
    );
    expect(file.entries.a.fontpath).toEqual({
      rel: "fonts/Pretendard.ttf",
      abs: "/p/proj/fonts/Pretendard.ttf",
    });
  });

  it("skips a remote or blob source", () => {
    const file = serializeAssetPaths(
      {
        a: videoElement({ localpath: "https://example.com/a.mp4" }),
        b: videoElement({ localpath: "blob:abc-123" }),
      } as any,
      PROJECT,
    );
    expect(file.entries).toEqual({});
  });

  it("gives two clips of one file two entries with the same rel", () => {
    const file = serializeAssetPaths(
      {
        a: videoElement({ localpath: "file:///p/proj/a.mp4" }),
        b: videoElement({ localpath: "file:///p/proj/a.mp4" }),
      } as any,
      PROJECT,
    );
    expect(file.entries.a.localpath!.rel).toBe("a.mp4");
    expect(file.entries.b.localpath!.rel).toBe("a.mp4");
  });

  it("emits POSIX separators for a Windows project", () => {
    const file = serializeAssetPaths(
      {
        a: videoElement({
          localpath: "file://C:\\Templates\\Promo\\clips\\a.mp4",
        }),
        // The mixed form the posix-only `joinPath` in the asset panel produces.
        b: videoElement({ localpath: "C:\\Templates\\Promo\\clips/b.mp4" }),
      } as any,
      "C:\\Templates\\Promo\\promo.ngt",
    );
    expect(file.entries.a.localpath!.rel).toBe("clips/a.mp4");
    expect(file.entries.b.localpath!.rel).toBe("clips/b.mp4");
  });

  it("only ever emits a safe relative path", () => {
    const file = serializeAssetPaths(
      {
        a: videoElement({ localpath: "file:///p/proj/a.mp4" }),
        b: imageElement({ localpath: "file:///p/proj/x/y/b.png" }),
        c: audioElement({ localpath: "file:///p/proj/deep/er/c.wav" }),
        d: textElement({ fontpath: "/p/proj/f/d.ttf" }),
      } as any,
      PROJECT,
    );
    for (const entry of Object.values(file.entries)) {
      for (const record of Object.values(entry)) {
        expect(record!.rel).not.toContain("\\");
        expect(record!.rel).not.toContain("..");
        expect(record!.rel.startsWith("/")).toBe(false);
        expect(/^[A-Za-z]:/.test(record!.rel)).toBe(false);
      }
    }
  });

  it("records abs byte-for-byte, so the load-time check can compare it", () => {
    const localpath = "file:///p/proj/my clip #1.mp4";
    const file = serializeAssetPaths(
      { a: videoElement({ localpath }) } as any,
      PROJECT,
    );
    expect(file.entries.a.localpath!.abs).toBe(localpath);
  });

  it("declines entirely without a usable project path", () => {
    const elements = {
      a: videoElement({ localpath: "file:///p/proj/a.mp4" }),
    } as any;
    // The demo and web builds, where #projectFile is never set.
    expect(serializeAssetPaths(elements, "")).toEqual({
      version: 1,
      entries: {},
    });
    expect(serializeAssetPaths(elements, "relative/p.ngt").entries).toEqual({});
    // A directory, not a project file.
    expect(serializeAssetPaths(elements, "/").entries).toEqual({});
  });

  it("survives JSON, holding no references", () => {
    const file = serializeAssetPaths(
      { a: videoElement({ localpath: "file:///p/proj/a.mp4" }) } as any,
      PROJECT,
    );
    expect(JSON.parse(JSON.stringify(file))).toEqual(file);
  });
});

describe("relinkAssets — the move", () => {
  it("finds the clip after the folder is copied elsewhere", async () => {
    const elements = {
      a: videoElement({ localpath: "file:///p/proj/clips/a.mp4" }),
    } as any;

    const result = await roundTrip(
      elements,
      PROJECT,
      "/Users/you/Promo/promo.ngt",
      existsOnly("/Users/you/Promo/clips/a.mp4"),
    );

    expect(result.relinked).toBe(1);
    expect(result.missing).toBe(0);
    expect(result.elements.a.localpath).toBe(
      "file:///Users/you/Promo/clips/a.mp4",
    );
  });

  it("carries a Windows template to a Mac", async () => {
    const elements = {
      a: videoElement({
        localpath: "file://C:\\Templates\\Promo\\clips\\a.mp4",
      }),
    } as any;

    const result = await roundTrip(
      elements,
      "C:\\Templates\\Promo\\promo.ngt",
      "/Users/me/Promo/promo.ngt",
      existsOnly("/Users/me/Promo/clips/a.mp4"),
    );

    // Three slashes, byte-identical to what a fresh import here would mint.
    expect(result.elements.a.localpath).toBe(
      "file:///Users/me/Promo/clips/a.mp4",
    );
  });

  it("carries a Mac template to Windows", async () => {
    const elements = {
      a: videoElement({ localpath: "file:///Users/me/Promo/clips/a.mp4" }),
    } as any;

    const result = await roundTrip(
      elements,
      "/Users/me/Promo/promo.ngt",
      "D:\\Templates\\Promo\\promo.ngt",
      existsOnly("D:\\Templates\\Promo\\clips\\a.mp4"),
    );

    // The malformed-but-canonical form every other Windows clip carries.
    expect(result.elements.a.localpath).toBe(
      "file://D:\\Templates\\Promo\\clips\\a.mp4",
    );
  });

  it("preserves a bare path as a bare path", async () => {
    // What the screen recorders and rasterised text write.
    const elements = {
      a: videoElement({ localpath: "/p/proj/clips/a.mp4" }),
    } as any;

    const result = await roundTrip(
      elements,
      PROJECT,
      "/moved/promo.ngt",
      existsOnly("/moved/clips/a.mp4"),
    );

    expect(result.elements.a.localpath).toBe("/moved/clips/a.mp4");
  });

  it("relinks a font, which is always a bare path", async () => {
    const elements = {
      a: textElement({ fontpath: "/p/proj/fonts/P.ttf" }),
    } as any;

    const result = await roundTrip(
      elements,
      PROJECT,
      "/moved/promo.ngt",
      existsOnly("/moved/fonts/P.ttf"),
    );

    expect(result.elements.a.fontpath).toBe("/moved/fonts/P.ttf");
  });
});

describe("relinkAssets — which candidate wins", () => {
  const elements = () =>
    ({ a: videoElement({ localpath: "file:///p/proj/a.mp4" }) }) as any;

  const saved = () =>
    JSON.parse(JSON.stringify(serializeAssetPaths(elements(), PROJECT)));

  it("prefers the relative path when both are on disk", async () => {
    // The whole feature is this ordering. If the absolute won, a moved
    // template would keep opening the author's copy on the author's machine.
    const result = await relinkAssets(
      elements(),
      saved(),
      "/moved/promo.ngt",
      existsOnly("/moved/a.mp4", "/p/proj/a.mp4"),
    );
    expect(result.elements.a.localpath).toBe("file:///moved/a.mp4");
    expect(result.relinked).toBe(1);
  });

  it("falls back to the absolute when the relative is not there", async () => {
    // A .ngt moved on its own, away from its media. This is the case a
    // rewrite-in-place design would have broken.
    const result = await relinkAssets(
      elements(),
      saved(),
      "/somewhere/else/promo.ngt",
      existsOnly("/p/proj/a.mp4"),
    );
    expect(result.elements.a.localpath).toBe("file:///p/proj/a.mp4");
    expect(result.relinked).toBe(0);
    expect(result.missing).toBe(0);
  });

  it("keeps the original string byte-for-byte when neither is there", async () => {
    const result = await relinkAssets(
      elements(),
      saved(),
      "/moved/promo.ngt",
      existsOnly(),
    );
    expect(result.elements.a.localpath).toBe("file:///p/proj/a.mp4");
    expect(result.missing).toBe(1);
  });

  it("ignores rel when abs no longer matches the element", async () => {
    // A hand-edited or half-merged archive. Trusting rel here would silently
    // play a different file.
    const tampered = saved();
    tampered.entries.a.localpath.abs = "file:///p/proj/SOMETHING-ELSE.mp4";

    const result = await relinkAssets(
      elements(),
      tampered,
      "/moved/promo.ngt",
      existsOnly("/moved/a.mp4", "/p/proj/a.mp4"),
    );
    expect(result.elements.a.localpath).toBe("file:///p/proj/a.mp4");
    expect(result.relinked).toBe(0);
  });

  it("refuses a relative path that tries to escape the folder", async () => {
    for (const rel of ["../evil.mp4", "/etc/passwd", "C:/x.mp4", "a\\b.mp4"]) {
      const doctored = saved();
      doctored.entries.a.localpath.rel = rel;

      const result = await relinkAssets(
        elements(),
        doctored,
        "/moved/promo.ngt",
        // Say yes to everything, so only the refusal can keep the path put.
        vi.fn(async () => true),
      );
      expect(result.elements.a.localpath).toBe("file:///p/proj/a.mp4");
    }
  });
});

describe("relinkAssets — degrading rather than throwing", () => {
  const elements = () =>
    ({ a: videoElement({ localpath: "file:///p/proj/a.mp4" }) }) as any;

  it("returns the document by identity when nothing moved", async () => {
    const source = elements();
    const result = await relinkAssets(
      source,
      null,
      PROJECT,
      existsOnly("/p/proj/a.mp4"),
    );
    // The decline convention the pure timeline ops use.
    expect(result.elements).toBe(source);
    expect(result.relinked).toBe(0);
    expect(result.missing).toBe(0);
  });

  it("opens an old project, which has no entry at all", async () => {
    const source = elements();
    const result = await relinkAssets(
      source,
      null,
      PROJECT,
      existsOnly("/p/proj/a.mp4"),
    );
    expect(result.elements).toBe(source);
  });

  it("treats an unreadable entry as an absent one", async () => {
    for (const raw of [7, "x", [], null, undefined, {}, { entries: null }, { entries: 3 }]) {
      const result = await relinkAssets(
        elements(),
        raw,
        PROJECT,
        existsOnly("/p/proj/a.mp4"),
      );
      expect(result.elements.a.localpath).toBe("file:///p/proj/a.mp4");
      expect(result.missing).toBe(0);
    }
  });

  it("survives a malformed record inside a well-formed entry", async () => {
    const raws = [
      { version: 1, entries: { a: null } },
      { version: 1, entries: { a: { localpath: 5 } } },
      { version: 1, entries: { a: { localpath: { rel: 5, abs: "x" } } } },
      { version: 1, entries: { a: { localpath: { rel: "a.mp4" } } } },
      // An entry for an element the document no longer has.
      { version: 1, entries: { gone: { localpath: { rel: "a", abs: "b" } } } },
    ];
    for (const raw of raws) {
      const result = await relinkAssets(
        elements(),
        raw,
        PROJECT,
        existsOnly("/p/proj/a.mp4"),
      );
      expect(result.elements.a.localpath).toBe("file:///p/proj/a.mp4");
    }
  });

  it("reads the web build's \"none\" as false, not as truthy", async () => {
    // ipcWrapper's shim answers with this string. `if (await exists(p))` would
    // report every path as present and relink onto files that are not there.
    const result = await relinkAssets(
      elements(),
      JSON.parse(JSON.stringify(serializeAssetPaths(elements(), PROJECT))),
      "/moved/promo.ngt",
      vi.fn(async () => "none"),
    );
    expect(result.elements.a.localpath).toBe("file:///p/proj/a.mp4");
    expect(result.missing).toBe(1);
  });

  it("treats a rejected probe as absent, without an unhandled rejection", async () => {
    const result = await relinkAssets(
      elements(),
      null,
      PROJECT,
      vi.fn(async () => {
        throw new Error("EIO");
      }),
    );
    expect(result.missing).toBe(1);
    expect(result.elements.a.localpath).toBe("file:///p/proj/a.mp4");
  });

  it("does nothing at all without a usable project path", async () => {
    const source = elements();
    const probe = vi.fn(async () => true);
    for (const path of ["", "relative/p.ngt", "/"]) {
      const result = await relinkAssets(source, null, path, probe);
      expect(result.elements).toBe(source);
    }
    expect(probe).not.toHaveBeenCalled();
  });
});

describe("relinkAssets — counting and probing", () => {
  it("probes each distinct file once, not each clip", async () => {
    const elements: Record<string, any> = {};
    for (let i = 0; i < 50; i += 1) {
      elements[`el-${i}`] = videoElement({
        localpath: `file:///p/proj/clip-${i % 3}.mp4`,
      });
    }

    const probe = existsOnly(
      "/p/proj/clip-0.mp4",
      "/p/proj/clip-1.mp4",
      "/p/proj/clip-2.mp4",
    );
    const file = JSON.parse(JSON.stringify(serializeAssetPaths(elements, PROJECT)));
    await relinkAssets(elements, file, PROJECT, probe);

    // Three files, each with at most a relative and an absolute candidate —
    // and here they are the same string, so it should be exactly three.
    expect(probe.mock.calls.length).toBeLessThanOrEqual(6);
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it("counts distinct files, not clips", async () => {
    const elements: Record<string, any> = {};
    for (let i = 0; i < 10; i += 1) {
      elements[`el-${i}`] = videoElement({ localpath: "file:///p/proj/a.mp4" });
    }
    const result = await relinkAssets(elements, null, PROJECT, existsOnly());
    // "1 media file could not be found", not "10 clips".
    expect(result.missing).toBe(1);
  });

  it("counts nothing for a project made only of text and shapes", async () => {
    const probe = vi.fn(async () => false);
    const result = await relinkAssets(
      {
        a: textElement(),
        b: textElement(),
        c: shapeElement(),
        d: effectElement(),
        e: transitionElement(),
      } as any,
      null,
      PROJECT,
      probe,
    );
    expect(result.missing).toBe(0);
    expect(probe).not.toHaveBeenCalled();
  });

  it("counts an outside file that is genuinely gone", async () => {
    const elements = {
      inside: videoElement({ localpath: "file:///p/proj/a.mp4" }),
      outside: videoElement({ localpath: "file:///elsewhere/b.mp4" }),
    } as any;
    const result = await roundTrip(
      elements,
      PROJECT,
      PROJECT,
      existsOnly("/p/proj/a.mp4"),
    );
    expect(result.missing).toBe(1);
    expect(result.elements.outside.localpath).toBe("file:///elsewhere/b.mp4");
  });
});

/**
 * A template's slot fills.
 *
 * The template's own media travels inside its installed archive and is not this
 * project's to relocate — the element carries the `"TEMPLATE"` sentinel and
 * nothing else. What the *user* dropped into a slot is a different thing: it is
 * their own footage, sitting wherever their footage sits, and it has to
 * relativise and relink exactly like an ordinary clip's source or a project
 * folder handed to someone else would open with empty slots.
 */
describe("template slot fills", () => {
  const template = (fills: Record<string, any>) => ({
    filetype: "template",
    key: "tpl",
    templateId: "neon",
    name: "Neon",
    fills,
    localpath: "TEMPLATE",
    trackId: "v1",
    priority: 1,
    blob: "",
    startTime: 0,
    duration: 6000,
    location: { x: 0, y: 0 },
    width: 100,
    height: 100,
    ratio: 1,
    opacity: 100,
    rotation: 0,
    animation: {},
    timelineOptions: { color: "#fff" },
  });

  const mediaFill = (localpath: string) => ({
    kind: "media",
    localpath,
    offsetMs: 0,
    sourceDurationMs: 9000,
  });

  it("records a fill sitting inside the project folder", () => {
    const file = serializeAssetPaths(
      { tpl: template({ hero: mediaFill("file:///p/proj/mine.mp4") }) } as any,
      PROJECT,
    );
    expect(file.entries["tpl#fill:hero"]).toEqual({
      localpath: { rel: "mine.mp4", abs: "file:///p/proj/mine.mp4" },
    });
  });

  it("does not record the template's own sentinel", () => {
    const file = serializeAssetPaths(
      { tpl: template({}) } as any,
      PROJECT,
    );
    expect(file.entries.tpl).toBeUndefined();
  });

  it("relinks a fill when the folder has moved", async () => {
    const result = await roundTrip(
      { tpl: template({ hero: mediaFill("file:///p/proj/mine.mp4") }) },
      PROJECT,
      "/q/moved/promo.ngt",
      existsOnly("/q/moved/mine.mp4"),
    );
    expect(result.elements.tpl.fills.hero.localpath).toBe(
      "file:///q/moved/mine.mp4",
    );
  });

  it("keeps everything else about the fill", async () => {
    const result = await roundTrip(
      {
        tpl: template({
          hero: { ...mediaFill("file:///p/proj/mine.mp4"), offsetMs: 4000 },
        }),
      },
      PROJECT,
      "/q/moved/promo.ngt",
      existsOnly("/q/moved/mine.mp4"),
    );
    expect(result.elements.tpl.fills.hero).toEqual({
      kind: "media",
      localpath: "file:///q/moved/mine.mp4",
      offsetMs: 4000,
      sourceDurationMs: 9000,
    });
  });

  it("handles two slots on one template", async () => {
    const result = await roundTrip(
      {
        tpl: template({
          a: mediaFill("file:///p/proj/one.mp4"),
          b: mediaFill("file:///p/proj/two.mp4"),
        }),
      },
      PROJECT,
      "/q/moved/promo.ngt",
      existsOnly("/q/moved/one.mp4", "/q/moved/two.mp4"),
    );
    expect(result.elements.tpl.fills.a.localpath).toBe(
      "file:///q/moved/one.mp4",
    );
    expect(result.elements.tpl.fills.b.localpath).toBe(
      "file:///q/moved/two.mp4",
    );
  });

  it("ignores a text fill, which names no file", () => {
    const file = serializeAssetPaths(
      { tpl: template({ name: { kind: "text", text: "JUN" } }) } as any,
      PROJECT,
    );
    expect(Object.keys(file.entries)).toEqual([]);
  });

  it("leaves a fill alone when neither candidate is on disk", async () => {
    const result = await roundTrip(
      { tpl: template({ hero: mediaFill("file:///p/proj/gone.mp4") }) },
      PROJECT,
      "/q/moved/promo.ngt",
      existsOnly(),
    );
    expect(result.elements.tpl.fills.hero.localpath).toBe(
      "file:///p/proj/gone.mp4",
    );
    expect(result.missing).toBe(1);
  });

  it("survives a malformed fills record without throwing", () => {
    for (const fills of [null, "x", 7, { a: null }, { a: "x" }]) {
      expect(() =>
        serializeAssetPaths({ tpl: template(fills as any) } as any, PROJECT),
      ).not.toThrow();
    }
  });

  it("reports no asset fields on the template element itself", () => {
    expect(assetFieldsOf(template({}) as any)).toEqual([]);
  });
});
