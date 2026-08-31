/**
 * The path arithmetic that makes a project folder portable.
 *
 * Every case here is a way a real project has of being wrong. The two that
 * matter most, because they are silent when they fail:
 *
 *  - **`/p/proj` vs `/p/proj2`.** A `startsWith` implementation passes every
 *    other test in this file and relativises a sibling folder's clip into the
 *    project, which then resolves to the wrong file after a move.
 *  - **the Windows form.** `toLocalPath` concatenates `file://` onto
 *    `C:\Users\…` without converting separators, so Windows projects in the
 *    wild carry `file://C:\Users\me\a.mp4`. Node's `fileURLToPath` does not
 *    throw on it — run on posix it silently returns `/C:/Users/me/a.mp4` — so
 *    "it would have errored" is not available as a safety net.
 *
 * Both flavours are exercised on whichever machine this runs on, because
 * `flavour` is a parameter rather than `process.platform`. That is the whole
 * reason it is a parameter.
 */

import { describe, it, expect } from "vitest";

import { toLocalPath } from "../element/mediaProbe";
import {
  detectFlavour,
  mintLocalPath,
  relativizeInside,
  resolveInside,
  shapeOf,
  splitSegments,
  stripFileScheme,
  toFsPath,
} from "./assetPaths";

const POSIX = "posix" as const;
const WIN32 = "win32" as const;

describe("detectFlavour", () => {
  it("reads a posix path", () => {
    expect(detectFlavour("/Users/me/p.ngt")).toBe(POSIX);
  });

  it("reads a drive letter, with either separator and either case", () => {
    expect(detectFlavour("C:\\p\\p.ngt")).toBe(WIN32);
    expect(detectFlavour("c:/p/p.ngt")).toBe(WIN32);
  });

  it("reads a UNC share", () => {
    expect(detectFlavour("\\\\srv\\share\\p.ngt")).toBe(WIN32);
  });

  it("sees through a file:// prefix, including the malformed Windows one", () => {
    expect(detectFlavour("file:///Users/me/p.ngt")).toBe(POSIX);
    expect(detectFlavour("file://C:\\p\\p.ngt")).toBe(WIN32);
  });

  it("calls a backslash inside a posix path a filename, not a separator", () => {
    // The ordering trap: a backslash sniff placed before the leading-slash test
    // reads this as Windows, and every path in the project stops matching.
    expect(detectFlavour("/Users/me/we\\ird/p.ngt")).toBe(POSIX);
  });

  it("defaults to posix for something it cannot place", () => {
    expect(detectFlavour("")).toBe(POSIX);
    expect(detectFlavour("relative/p.ngt")).toBe(POSIX);
  });
});

describe("stripFileScheme", () => {
  it("removes the scheme and only the scheme", () => {
    expect(stripFileScheme("file:///Users/me/a.mp4")).toBe("/Users/me/a.mp4");
    expect(stripFileScheme("FILE:///Users/me/a.mp4")).toBe("/Users/me/a.mp4");
    expect(stripFileScheme("/Users/me/a.mp4")).toBe("/Users/me/a.mp4");
  });

  it("leaves a host form alone, so the caller keeps the path absolute", () => {
    expect(stripFileScheme("file://localhost/Users/a.mp4")).toBe(
      "localhost/Users/a.mp4",
    );
    // …and that is not an absolute path, so nothing downstream will touch it.
    expect(splitSegments("localhost/Users/a.mp4", POSIX)).toBeNull();
  });
});

describe("toFsPath", () => {
  it("unwraps a posix file URL", () => {
    expect(toFsPath("file:///Users/me/a.mp4", POSIX)).toBe("/Users/me/a.mp4");
  });

  it("passes a bare path through", () => {
    expect(toFsPath("/Users/me/a.mp4", POSIX)).toBe("/Users/me/a.mp4");
  });

  it("decodes %23 back to #, which is the only thing encode escapes", () => {
    expect(toFsPath("file:///U/a%23b.mp4", POSIX)).toBe("/U/a#b.mp4");
  });

  it("leaves a lone % alone rather than throwing on it", () => {
    // decodeURIComponent("100%.mp4") throws "URI malformed". Nothing in this
    // app percent-encodes, so there is nothing to decode but %23.
    expect(() => toFsPath("file:///U/100%.mp4", POSIX)).not.toThrow();
    expect(toFsPath("file:///U/100%.mp4", POSIX)).toBe("/U/100%.mp4");
  });

  it("does not truncate at a question mark", () => {
    // new URL(...).pathname drops everything from the "?" onward.
    expect(toFsPath("file:///U/a?b.mp4", POSIX)).toBe("/U/a?b.mp4");
  });

  it("leaves a space and non-ASCII byte-identical", () => {
    expect(toFsPath("file:///U/my clip.mp4", POSIX)).toBe("/U/my clip.mp4");
    expect(toFsPath("file:///U/한글 영상.mp4", POSIX)).toBe("/U/한글 영상.mp4");
  });

  it("handles all three Windows shapes", () => {
    expect(toFsPath("file://C:\\p\\a.mp4", WIN32)).toBe("C:\\p\\a.mp4");
    expect(toFsPath("file:///C:/p/a.mp4", WIN32)).toBe("C:/p/a.mp4");
    expect(toFsPath("file://\\\\srv\\sh\\a.mp4", WIN32)).toBe(
      "\\\\srv\\sh\\a.mp4",
    );
  });

  it("is idempotent", () => {
    const table = [
      "file:///U/a.mp4",
      "/U/a.mp4",
      "file:///U/a%23b.mp4",
      "file://C:\\p\\a.mp4",
      "file:///C:/p/a.mp4",
    ];
    for (const value of table) {
      for (const flavour of [POSIX, WIN32] as const) {
        const once = toFsPath(value, flavour);
        expect(toFsPath(once, flavour)).toBe(once);
      }
    }
  });
});

describe("mintLocalPath / shapeOf", () => {
  it("gives a posix URL three slashes", () => {
    expect(mintLocalPath("/Users/me/a.mp4", "url")).toBe(
      "file:///Users/me/a.mp4",
    );
  });

  it("re-escapes #", () => {
    expect(mintLocalPath("/U/a#b.mp4", "url")).toBe("file:///U/a%23b.mp4");
  });

  it("passes a bare path through untouched", () => {
    expect(mintLocalPath("/U/a#b.mp4", "bare")).toBe("/U/a#b.mp4");
  });

  it("reproduces the malformed Windows form on purpose", () => {
    // Two slashes and a drive letter where a URL host goes. This is what
    // `toLocalPath` produces, Chromium accepts it, and `localFilePath` running
    // on Windows converts it back correctly. Minting the *tidy* form instead
    // would give the same file two spellings, and `mergeOps` compares these
    // strings to decide two clips share a source.
    expect(mintLocalPath("C:\\p\\a.mp4", "url")).toBe("file://C:\\p\\a.mp4");
    expect(mintLocalPath("\\\\srv\\sh\\a.mp4", "url")).toBe(
      "file://\\\\srv\\sh\\a.mp4",
    );
  });

  it("round-trips everything awkward", () => {
    const table = [
      "/U/a.mp4",
      "/U/a#b.mp4",
      "/U/my clip.mp4",
      "/U/100%.mp4",
      "/U/a?b.mp4",
      "/U/한글.mp4",
    ];
    for (const fsPath of table) {
      expect(toFsPath(mintLocalPath(fsPath, "url"), POSIX)).toBe(fsPath);
      expect(toFsPath(mintLocalPath(fsPath, "bare"), POSIX)).toBe(fsPath);
    }
    for (const fsPath of ["C:\\p\\a.mp4", "\\\\srv\\sh\\a.mp4"]) {
      expect(toFsPath(mintLocalPath(fsPath, "url"), WIN32)).toBe(fsPath);
    }
  });

  it("agrees with the real toLocalPath, which is the format of record", () => {
    // The tripwire. `mintLocalPath` deliberately reproduces `toLocalPath`'s
    // output, malformed Windows form and all, so that the same file never gets
    // two spellings. If someone fixes `toLocalPath` — which it does need —
    // this fails and tells them the two have to move together.
    for (const fsPath of [
      "/U/a.mp4",
      "/U/a#b.mp4",
      "/U/my clip.mp4",
      "/U/100%.mp4",
      "/U/한글.mp4",
    ]) {
      expect(mintLocalPath(fsPath, "url")).toBe(toLocalPath(fsPath));
    }
  });

  it("reads back the shape it minted", () => {
    expect(shapeOf(mintLocalPath("/U/a.mp4", "url"))).toBe("url");
    expect(shapeOf(mintLocalPath("/U/a.mp4", "bare"))).toBe("bare");
    expect(shapeOf("file://C:\\p\\a.mp4")).toBe("url");
    expect(shapeOf("C:\\p\\a.mp4")).toBe("bare");
  });
});

describe("splitSegments", () => {
  it("splits a posix path", () => {
    expect(splitSegments("/a/b/c.mp4", POSIX)).toEqual({
      root: "",
      segs: ["a", "b", "c.mp4"],
    });
  });

  it("collapses doubled and trailing separators, and drops .", () => {
    expect(splitSegments("//a///b/./c.mp4/", POSIX)?.segs).toEqual([
      "a",
      "b",
      "c.mp4",
    ]);
  });

  it("uppercases a drive so case cannot decide equality", () => {
    expect(splitSegments("c:\\p\\a.mp4", WIN32)).toEqual({
      root: "C:",
      segs: ["p", "a.mp4"],
    });
  });

  it("accepts mixed separators on win32", () => {
    expect(splitSegments("C:/p\\q/a.mp4", WIN32)?.segs).toEqual([
      "p",
      "q",
      "a.mp4",
    ]);
  });

  it("keeps a UNC server and share together as the root", () => {
    expect(splitSegments("\\\\srv\\share\\p\\a.mp4", WIN32)).toEqual({
      root: "\\\\srv\\share",
      segs: ["p", "a.mp4"],
    });
  });

  it("refuses what it cannot reason about", () => {
    expect(splitSegments("relative/a.mp4", POSIX)).toBeNull();
    expect(splitSegments("/a/../b", POSIX)).toBeNull();
    expect(splitSegments("C:p\\a.mp4", WIN32)).toBeNull(); // drive-relative
    expect(splitSegments("\\\\?\\C:\\p\\a.mp4", WIN32)).toBeNull(); // long path
    expect(splitSegments("\\\\srv", WIN32)).toBeNull(); // no share
    expect(splitSegments("\\\\srv\\", WIN32)).toBeNull();
    expect(splitSegments("/a/\0/b", POSIX)).toBeNull();
  });

  it("does not treat a backslash as a separator on posix", () => {
    expect(splitSegments("/a/b\\c.mp4", POSIX)?.segs).toEqual(["a", "b\\c.mp4"]);
  });
});

describe("relativizeInside — posix", () => {
  const PROJECT = "/p/proj/a.ngt";
  const rel = (p: string) => relativizeInside(p, PROJECT, POSIX);

  it("relativises a file beside the project and one below it", () => {
    expect(rel("/p/proj/a.mp4")).toBe("a.mp4");
    expect(rel("/p/proj/clips/a.mp4")).toBe("clips/a.mp4");
    expect(rel("/p/proj/x/y/z/a.mp4")).toBe("x/y/z/a.mp4");
  });

  it("refuses a sibling folder whose name merely starts the same", () => {
    // The startsWith trap. Both of these pass a naive prefix check.
    expect(rel("/p/proj2/a.mp4")).toBeNull();
    expect(rel("/p/project/a.mp4")).toBeNull();
  });

  it("refuses anything above the project folder", () => {
    expect(rel("/p/a.mp4")).toBeNull();
    expect(rel("/a.mp4")).toBeNull();
    expect(rel("/other/a.mp4")).toBeNull();
  });

  it("refuses the project directory itself", () => {
    expect(rel("/p/proj")).toBeNull();
  });

  it("is case-sensitive, because posix is", () => {
    expect(rel("/P/PROJ/a.mp4")).toBeNull();
  });

  it("normalises separators in the input", () => {
    expect(rel("/p//proj/./clips/a.mp4")).toBe("clips/a.mp4");
    expect(rel("/p/proj/clips/a.mp4/")).toBe("clips/a.mp4");
  });

  it("refuses a path containing ..", () => {
    expect(rel("/p/proj/../proj/a.mp4")).toBeNull();
  });

  it("takes a file:// URL and hands back a decoded relative path", () => {
    expect(rel("file:///p/proj/clips/a%23b.mp4")).toBe("clips/a#b.mp4");
  });

  it("leaves a filename containing a backslash absolute", () => {
    // One legal posix file. Storing "a\\b.mp4" would split into two segments
    // when read on Windows.
    expect(rel("/p/proj/a\\b.mp4")).toBeNull();
    expect(rel("/p/proj/clips/a\\b.mp4")).toBeNull();
  });

  it("treats a project at the volume root as containing the volume", () => {
    // Pinned as a decision rather than left as an accident: with no directory
    // segments, everything on the volume is 'inside'.
    expect(relativizeInside("/clips/a.mp4", "/a.ngt", POSIX)).toBe(
      "clips/a.mp4",
    );
  });

  it("refuses a project path with no filename", () => {
    expect(relativizeInside("/clips/a.mp4", "/", POSIX)).toBeNull();
    expect(relativizeInside("/clips/a.mp4", "", POSIX)).toBeNull();
  });
});

describe("relativizeInside — win32", () => {
  const PROJECT = "C:\\Templates\\Promo\\p.ngt";
  const rel = (p: string) => relativizeInside(p, PROJECT, WIN32);

  it("relativises the malformed URL form this app actually stores", () => {
    expect(rel("file://C:\\Templates\\Promo\\clips\\a.mp4")).toBe(
      "clips/a.mp4",
    );
  });

  it("handles the mixed separators the asset panel produces", () => {
    // `directoryEntries.joinPath` is posix-only, so a Windows browse produces
    // `C:\Templates\Promo\clips/a.mp4`.
    expect(rel("C:\\Templates\\Promo\\clips/a.mp4")).toBe("clips/a.mp4");
    expect(rel("C:/Templates/Promo/clips\\a.mp4")).toBe("clips/a.mp4");
  });

  it("ignores case in the directory part but preserves it in the tail", () => {
    expect(rel("c:\\templates\\promo\\Clips\\A.mp4")).toBe("Clips/A.mp4");
  });

  it("always emits POSIX separators, whatever it was given", () => {
    expect(rel("C:\\Templates\\Promo\\a\\b\\c.mp4")).toBe("a/b/c.mp4");
  });

  it("refuses another drive and a same-prefixed sibling", () => {
    expect(rel("D:\\Templates\\Promo\\a.mp4")).toBeNull();
    expect(rel("C:\\Templates\\Promo2\\a.mp4")).toBeNull();
    expect(rel("C:\\Templates\\a.mp4")).toBeNull();
  });

  it("relativises within one UNC share and refuses across shares", () => {
    const unc = "\\\\srv\\share\\proj\\p.ngt";
    expect(relativizeInside("\\\\srv\\share\\proj\\a.mp4", unc, WIN32)).toBe(
      "a.mp4",
    );
    // A share name is case-insensitive like the rest of the path.
    expect(relativizeInside("\\\\SRV\\SHARE\\proj\\a.mp4", unc, WIN32)).toBe(
      "a.mp4",
    );
    expect(
      relativizeInside("\\\\srv\\other\\proj\\a.mp4", unc, WIN32),
    ).toBeNull();
    expect(
      relativizeInside("\\\\srv2\\share\\proj\\a.mp4", unc, WIN32),
    ).toBeNull();
  });

  it("refuses a long-path prefix", () => {
    expect(rel("\\\\?\\C:\\Templates\\Promo\\a.mp4")).toBeNull();
  });
});

describe("resolveInside", () => {
  it("joins with the target platform's separator", () => {
    expect(resolveInside("clips/a.mp4", "/p/proj/a.ngt", POSIX)).toBe(
      "/p/proj/clips/a.mp4",
    );
    expect(
      resolveInside("clips/a.mp4", "C:\\Templates\\Promo\\p.ngt", WIN32),
    ).toBe("C:\\Templates\\Promo\\clips\\a.mp4");
    expect(
      resolveInside("a.mp4", "\\\\srv\\share\\proj\\p.ngt", WIN32),
    ).toBe("\\\\srv\\share\\proj\\a.mp4");
  });

  it("refuses anything that could escape the project folder", () => {
    const at = (rel: unknown) => resolveInside(rel, "/p/proj/a.ngt", POSIX);
    expect(at("../a.mp4")).toBeNull();
    expect(at("clips/../../a.mp4")).toBeNull();
    expect(at("/etc/passwd")).toBeNull();
    expect(at("C:/x.mp4")).toBeNull();
    expect(at("C:x.mp4")).toBeNull();
    expect(at("clips\\a.mp4")).toBeNull();
    expect(at("clips//a.mp4")).toBeNull();
    expect(at("./a.mp4")).toBeNull();
    expect(at("clips/a.mp4/")).toBeNull();
    expect(at("a\0b.mp4")).toBeNull();
    expect(at("")).toBeNull();
    expect(at(null)).toBeNull();
    expect(at(7)).toBeNull();
  });

  it("refuses a project path it cannot split", () => {
    expect(resolveInside("a.mp4", "", POSIX)).toBeNull();
    expect(resolveInside("a.mp4", "relative/p.ngt", POSIX)).toBeNull();
  });
});

describe("the two journeys this whole module exists for", () => {
  it("carries a template made on Windows to a Mac", () => {
    // Authored at C:\Templates\Promo\, with the mixed separators the asset
    // panel really produces, and the malformed URL `toLocalPath` really mints.
    const authored = "file://C:\\Templates\\Promo\\clips/a.mp4";
    const winProject = "C:\\Templates\\Promo\\promo.ngt";

    const rel = relativizeInside(
      toFsPath(authored, WIN32),
      winProject,
      detectFlavour(winProject),
    );
    expect(rel).toBe("clips/a.mp4");

    // The folder is copied to /Users/me/Promo/ and opened there.
    const macProject = "/Users/me/Promo/promo.ngt";
    const resolved = resolveInside(rel, macProject, detectFlavour(macProject));
    expect(resolved).toBe("/Users/me/Promo/clips/a.mp4");

    // Re-minted in the shape it had, it is byte-identical to what a fresh
    // import on this Mac would have produced.
    expect(mintLocalPath(resolved!, shapeOf(authored))).toBe(
      "file:///Users/me/Promo/clips/a.mp4",
    );
  });

  it("carries a template made on a Mac to Windows", () => {
    const authored = "file:///Users/me/Promo/clips/a.mp4";
    const macProject = "/Users/me/Promo/promo.ngt";

    const rel = relativizeInside(
      toFsPath(authored, POSIX),
      macProject,
      detectFlavour(macProject),
    );
    expect(rel).toBe("clips/a.mp4");

    const winProject = "D:\\Templates\\Promo\\promo.ngt";
    const resolved = resolveInside(rel, winProject, detectFlavour(winProject));
    expect(resolved).toBe("D:\\Templates\\Promo\\clips\\a.mp4");

    // The malformed-but-canonical form, which is what every other Windows
    // clip in the project carries too.
    expect(mintLocalPath(resolved!, shapeOf(authored))).toBe(
      "file://D:\\Templates\\Promo\\clips\\a.mp4",
    );
  });

  it("round-trips on one platform to the documented canonical form", () => {
    // win32 canonicalisation is lossy on purpose: the drive is uppercased and
    // separators are unified. That is why a Windows save-then-reload re-decodes
    // filmstrips once — the text changes, the meaning does not.
    const project = "c:/Templates/Promo/p.ngt";
    const rel = relativizeInside(
      "c:/Templates/Promo/clips\\a.mp4",
      project,
      WIN32,
    );
    expect(resolveInside(rel, project, WIN32)).toBe(
      "C:\\Templates\\Promo\\clips\\a.mp4",
    );
  });
});
