import { describe, expect, it } from "vitest";
import { parseTemplateManifest, readArchiveLayout } from "./archive";

/**
 * The rule this suite exists for is the first line of the format:
 * **`template.ngt` sits at the root of the archive, or the archive is not a
 * template.** Everything else here is the junk a real zip arrives carrying.
 */

function names(...entries: string[]): string[] {
  return entries;
}

describe("the root template.ngt rule", () => {
  it("accepts an archive whose root holds template.ngt", () => {
    const layout = readArchiveLayout(names("template.ngt"));
    expect(layout.ok).toBe(true);
    if (!layout.ok) return;
    expect(layout.ngt).toBe("template.ngt");
  });

  it("refuses an archive with no template.ngt at all", () => {
    const layout = readArchiveLayout(names("timeline.json", "assets/a.mp4"));
    expect(layout.ok).toBe(false);
  });

  it("refuses a template.ngt one level down", () => {
    // The single most likely way to get this wrong is to zip the *folder*
    // rather than its contents, which buries the entry under the folder name.
    const layout = readArchiveLayout(
      names("my-template/template.ngt", "my-template/assets/a.mp4"),
    );
    expect(layout.ok).toBe(false);
  });

  it("refuses an archive holding only a differently-named .ngt", () => {
    const layout = readArchiveLayout(names("project.ngt"));
    expect(layout.ok).toBe(false);
  });

  it("matches the name case-insensitively", () => {
    // Zip entry names are case-sensitive but the tools that write them are not
    // consistently so, and refusing `Template.ngt` would look like corruption.
    const layout = readArchiveLayout(names("Template.NGT"));
    expect(layout.ok).toBe(true);
    if (!layout.ok) return;
    expect(layout.ngt).toBe("Template.NGT");
  });

  it("refuses two entries that both claim the name", () => {
    // Ambiguous rather than lenient: picking one would silently open half an
    // archive, and there is no reading of this that is obviously right.
    const layout = readArchiveLayout(names("template.ngt", "Template.ngt"));
    expect(layout.ok).toBe(false);
  });
});

describe("what the archive carries besides the document", () => {
  it("finds the optional manifest and thumbnail", () => {
    const layout = readArchiveLayout(
      names("template.ngt", "template.json", "thumbnail.png"),
    );
    expect(layout.ok).toBe(true);
    if (!layout.ok) return;
    expect(layout.manifest).toBe("template.json");
    expect(layout.thumbnail).toBe("thumbnail.png");
  });

  it("answers null for both when they are absent", () => {
    const layout = readArchiveLayout(names("template.ngt"));
    expect(layout.ok).toBe(true);
    if (!layout.ok) return;
    expect(layout.manifest).toBeNull();
    expect(layout.thumbnail).toBeNull();
  });

  it("takes a .jpg thumbnail as readily as a .png", () => {
    const layout = readArchiveLayout(names("template.ngt", "thumbnail.jpg"));
    expect(layout.ok).toBe(true);
    if (!layout.ok) return;
    expect(layout.thumbnail).toBe("thumbnail.jpg");
  });

  it("keeps resources at any subdirectory depth", () => {
    // The user requirement in one assertion: a template may organise its media
    // however it likes, because `template.ngt` names it by a relative path and
    // `assetPaths.ts#resolveInside` splits that on `/` at any depth.
    const layout = readArchiveLayout(
      names(
        "template.ngt",
        "assets/a.mp4",
        "assets/clips/b/deep.mov",
        "fonts/Inter.ttf",
      ),
    );
    expect(layout.ok).toBe(true);
    if (!layout.ok) return;
    expect(layout.assets).toEqual([
      "assets/a.mp4",
      "assets/clips/b/deep.mov",
      "fonts/Inter.ttf",
    ]);
  });

  it("leaves the document, manifest and thumbnail out of the asset list", () => {
    const layout = readArchiveLayout(
      names("template.ngt", "template.json", "thumbnail.png", "assets/a.mp4"),
    );
    expect(layout.ok).toBe(true);
    if (!layout.ok) return;
    expect(layout.assets).toEqual(["assets/a.mp4"]);
  });
});

describe("the junk a real zip arrives carrying", () => {
  it("ignores directory entries", () => {
    const layout = readArchiveLayout(names("template.ngt", "assets/"));
    expect(layout.ok).toBe(true);
    if (!layout.ok) return;
    expect(layout.assets).toEqual([]);
  });

  it("ignores the resource fork a macOS zip adds", () => {
    // Archive Utility writes these for every entry. Extracted blindly they
    // would double the install and put files where nothing expects them.
    const layout = readArchiveLayout(
      names(
        "template.ngt",
        "__MACOSX/._template.ngt",
        "__MACOSX/assets/._a.mp4",
        "assets/a.mp4",
      ),
    );
    expect(layout.ok).toBe(true);
    if (!layout.ok) return;
    expect(layout.assets).toEqual(["assets/a.mp4"]);
  });

  it("ignores .DS_Store at any depth", () => {
    const layout = readArchiveLayout(
      names("template.ngt", ".DS_Store", "assets/.DS_Store", "assets/a.mp4"),
    );
    expect(layout.ok).toBe(true);
    if (!layout.ok) return;
    expect(layout.assets).toEqual(["assets/a.mp4"]);
  });

  it("normalises a leading ./ before deciding what is at the root", () => {
    const layout = readArchiveLayout(names("./template.ngt", "./assets/a.mp4"));
    expect(layout.ok).toBe(true);
    if (!layout.ok) return;
    expect(layout.assets).toEqual(["./assets/a.mp4"]);
  });

  it("refuses an entry that climbs out of the archive", () => {
    // A trust boundary: these names are extracted to disk, and `../` is how a
    // zip writes outside the directory it is being unpacked into.
    const layout = readArchiveLayout(names("template.ngt", "../escape.mp4"));
    expect(layout.ok).toBe(false);
  });

  it("refuses an absolute entry name", () => {
    const layout = readArchiveLayout(names("template.ngt", "/etc/passwd"));
    expect(layout.ok).toBe(false);
  });

  it("refuses a backslash in an entry name", () => {
    // Zip mandates `/`. A backslash is either a separator written by a broken
    // writer or a legal posix filename, and both are refused rather than
    // guessed — the rule `assetPaths.ts` already states for relative paths.
    const layout = readArchiveLayout(names("template.ngt", "assets\\a.mp4"));
    expect(layout.ok).toBe(false);
  });

  it("refuses an empty archive without throwing", () => {
    expect(readArchiveLayout([]).ok).toBe(false);
  });
});

describe("parseTemplateManifest", () => {
  it("reads the three fields it understands", () => {
    expect(
      parseTemplateManifest({
        name: "Neon Intro",
        author: "Jun",
        thumbnail: "cover.png",
      }),
    ).toEqual({ name: "Neon Intro", author: "Jun", thumbnail: "cover.png" });
  });

  it("answers nulls for anything it cannot use, and never throws", () => {
    // The manifest arrives from a file someone else wrote, so every reading of
    // it is a guard. A template with an unusable manifest is still a template:
    // `template.ngt` is what makes it one, and the name falls back to the
    // folder it was installed into.
    for (const raw of [null, undefined, 42, "text", [], { name: 7 }]) {
      expect(parseTemplateManifest(raw)).toEqual({
        name: null,
        author: null,
        thumbnail: null,
      });
    }
  });

  it("refuses a thumbnail path that could escape the install folder", () => {
    expect(parseTemplateManifest({ thumbnail: "../../evil.png" }).thumbnail)
      .toBeNull();
    expect(parseTemplateManifest({ thumbnail: "/etc/passwd" }).thumbnail)
      .toBeNull();
  });

  it("trims a name of surrounding space and refuses an empty one", () => {
    expect(parseTemplateManifest({ name: "  Neon  " }).name).toBe("Neon");
    expect(parseTemplateManifest({ name: "   " }).name).toBeNull();
  });
});
