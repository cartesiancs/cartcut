import { describe, expect, it } from "vitest";
import {
  basenameOf,
  isValidAutosaveKey,
  keyForProjectFile,
  keyForSession,
  labelSegment,
  normalizeProjectPath,
  ringLabel,
} from "./autosaveIdentity";

/**
 * The failure this suite is built around: **a project whose name mints an
 * invalid key is a project that silently never autosaves.** Nothing on screen
 * would say so — the write is refused in the main process, on a timer, with
 * nobody watching. So the nasty-name table below is not thoroughness for its
 * own sake; every row is a filename a user can actually produce.
 */

const NASTY = [
  "Film.ngt",
  "aux",
  "aux.ngt",
  "con.ngt",
  "..",
  ".",
  "...",
  "a b c.ngt",
  "a/b.ngt",
  "a\\b.ngt",
  "a:b.ngt",
  "100%.ngt",
  "a?b.ngt",
  "a#b.ngt",
  "a*b.ngt",
  'a"b.ngt',
  "a<b>c.ngt",
  "a|b.ngt",
  "恐怖.ngt",
  "가나다.ngt",
  "🙂.ngt",
  "-leading.ngt",
  "trailing-.ngt",
  "---.ngt",
  "___.ngt",
  ".hidden.ngt",
  "a".repeat(300) + ".ngt",
  "한글 프로젝트 2026.ngt",
  "Проект.ngt",
  "  spaces  .ngt",
  "tab\there.ngt",
  "new\nline.ngt",
  "",
] as const;

describe("isValidAutosaveKey", () => {
  it.each(["f-abc", "s-abc", "f-0123456789abcdef-Film", "f-a.b_c-d"])(
    "accepts %j",
    (key) => {
      expect(isValidAutosaveKey(key)).toBe(true);
    },
  );

  it.each([
    "..",
    ".",
    "/etc",
    "a/b",
    "f-a/b",
    "f-a\\b",
    "",
    "x-abc",
    "f-",
    "f-a b",
    "f-" + "a".repeat(81),
    null,
    undefined,
    7,
  ])("rejects %j", (key) => {
    expect(isValidAutosaveKey(key)).toBe(false);
  });

  it("agrees with the main-process pattern", () => {
    // Two copies of one rule, because `electron/` may not import
    // `apps/app/src`. They have to stay in step or a key the renderer mints
    // is a key main refuses — silently, on a timer.
    //
    // The main-process copy is `electron/lib/autosaveCache.ts#KEY`; this
    // asserts the shape both are written to.
    expect(isValidAutosaveKey("f-" + "a".repeat(80))).toBe(true);
    expect(isValidAutosaveKey("f-" + "a".repeat(81))).toBe(false);
  });
});

describe("keyForProjectFile", () => {
  it.each(NASTY)("mints a valid key for %j", (name) => {
    // LOAD-BEARING, every row.
    const key = keyForProjectFile(`/Users/me/Projects/${name}`, "posix");
    expect(isValidAutosaveKey(key)).toBe(true);
    expect(key.startsWith("f-")).toBe(true);
  });

  it.each(NASTY)("mints a valid key for %j on win32", (name) => {
    const key = keyForProjectFile(`C:\\Users\\me\\${name}`, "win32");
    expect(isValidAutosaveKey(key)).toBe(true);
  });

  it("is stable across calls", () => {
    const one = keyForProjectFile("/Users/me/Film.ngt", "posix");
    const two = keyForProjectFile("/Users/me/Film.ngt", "posix");
    expect(one).toBe(two);
  });

  it("gives two different projects two different keys", () => {
    expect(keyForProjectFile("/a/One.ngt", "posix")).not.toBe(
      keyForProjectFile("/a/Two.ngt", "posix"),
    );
  });

  it("gives two same-named projects in different folders different keys", () => {
    // The digest is over the whole path, not the basename — otherwise two
    // projects both called Film.ngt would share one ring and a save of either
    // would drop the other's recovery points.
    expect(keyForProjectFile("/a/Film.ngt", "posix")).not.toBe(
      keyForProjectFile("/b/Film.ngt", "posix"),
    );
  });

  it("does not fold case", () => {
    // Deliberate. Two rings for one project is a harmless duplicate; merging
    // two genuinely different files on a case-sensitive volume is not.
    expect(keyForProjectFile("/a/Film.ngt", "posix")).not.toBe(
      keyForProjectFile("/a/film.ngt", "posix"),
    );
  });

  it("collapses . and .. so one file is one ring", () => {
    expect(keyForProjectFile("/a/b/../Film.ngt", "posix")).toBe(
      keyForProjectFile("/a/Film.ngt", "posix"),
    );
    expect(keyForProjectFile("/a/./Film.ngt", "posix")).toBe(
      keyForProjectFile("/a/Film.ngt", "posix"),
    );
    expect(keyForProjectFile("/a//Film.ngt", "posix")).toBe(
      keyForProjectFile("/a/Film.ngt", "posix"),
    );
  });

  it("treats a file:// URL and a bare path as the same project", () => {
    // `localpath` is usually a `file://` URL and `#projectFile` is usually a
    // bare path, and both reach this.
    expect(keyForProjectFile("file:///a/Film.ngt", "posix")).toBe(
      keyForProjectFile("/a/Film.ngt", "posix"),
    );
  });

  it("keeps the basename in the key when it is legible", () => {
    expect(keyForProjectFile("/a/Film.ngt", "posix")).toMatch(/-Film\.ngt$/);
  });

  it("drops the label entirely when nothing legible survives", () => {
    // Rather than padding it into a run of dashes that reads as corruption.
    const key = keyForProjectFile("/a/🙂.ngt", "posix");
    expect(isValidAutosaveKey(key)).toBe(true);
    expect(key).toMatch(/^f-[0-9a-f]{16}(-.*)?$/);
  });

  it("does not let a 300-character name overflow the key", () => {
    const key = keyForProjectFile(`/a/${"x".repeat(300)}.ngt`, "posix");
    expect(isValidAutosaveKey(key)).toBe(true);
    expect(key.length).toBeLessThanOrEqual(82);
  });

  it("mints no key containing a separator", () => {
    for (const name of NASTY) {
      for (const key of [
        keyForProjectFile(`/a/${name}`, "posix"),
        keyForProjectFile(`C:\\a\\${name}`, "win32"),
      ]) {
        expect(key).not.toContain("/");
        expect(key).not.toContain("\\");
      }
    }
  });
});

describe("keyForSession", () => {
  it("mints a valid key", () => {
    expect(isValidAutosaveKey(keyForSession("9d41c0a2-fe8b-5613"))).toBe(true);
  });

  it("is stable and distinct", () => {
    expect(keyForSession("a")).toBe(keyForSession("a"));
    expect(keyForSession("a")).not.toBe(keyForSession("b"));
  });

  it("never collides with a file key", () => {
    // The prefix is the discriminator, so this is structural — but a save
    // drops rings by key, and a session key that looked like a file key would
    // have the wrong ring dropped.
    expect(keyForSession("a").startsWith("s-")).toBe(true);
    expect(keyForProjectFile("/a/b.ngt", "posix").startsWith("f-")).toBe(true);
  });

  it("survives a hostile session id", () => {
    for (const id of ["", "../..", "/etc/passwd", "🙂", "a".repeat(500)]) {
      expect(isValidAutosaveKey(keyForSession(id))).toBe(true);
    }
  });
});

describe("normalizeProjectPath", () => {
  it.each([
    ["/a/b/../Film.ngt", "/a/Film.ngt"],
    ["/a/./Film.ngt", "/a/Film.ngt"],
    ["/a//Film.ngt", "/a/Film.ngt"],
    ["/a/b/c/../../Film.ngt", "/a/Film.ngt"],
    ["/Film.ngt", "/Film.ngt"],
  ])("normalizes %j to %j", (input, expected) => {
    expect(normalizeProjectPath(input, "posix")).toBe(expected);
  });

  it("normalizes a win32 path with either separator", () => {
    expect(normalizeProjectPath("C:\\a\\b\\..\\Film.ngt", "win32")).toBe(
      "C:\\a\\Film.ngt",
    );
    expect(normalizeProjectPath("C:/a/b/../Film.ngt", "win32")).toBe(
      "C:\\a\\Film.ngt",
    );
  });

  it("strips a file scheme", () => {
    expect(normalizeProjectPath("file:///a/Film.ngt", "posix")).toBe(
      "/a/Film.ngt",
    );
  });

  it("does not climb above the root", () => {
    expect(normalizeProjectPath("/../../../a.ngt", "posix")).toBe("/a.ngt");
  });
});

describe("basenameOf", () => {
  it.each([
    ["/a/b/Film.ngt", "Film.ngt"],
    ["/a/b/", "b"],
    ["Film.ngt", "Film.ngt"],
    ["/", ""],
    ["", ""],
  ])("reads %j as %j", (input, expected) => {
    expect(basenameOf(input, "posix")).toBe(expected);
  });

  it("reads a win32 path", () => {
    expect(basenameOf("C:\\a\\Film.ngt", "win32")).toBe("Film.ngt");
  });
});

describe("labelSegment", () => {
  it.each([
    ["Film.ngt", "Film.ngt"],
    ["a b c.ngt", "a-b-c.ngt"],
    ["a///b.ngt", "a-b.ngt"],
    ["---.ngt", "ngt"],
    ["..", ""],
    [".", ""],
    ["🙂", ""],
    ["", ""],
    [".hidden", "hidden"],
  ])("cleans %j to %j", (input, expected) => {
    expect(labelSegment(input)).toBe(expected);
  });

  it("never emits a separator or a dot-only segment", () => {
    for (const name of NASTY) {
      const label = labelSegment(name);
      expect(label).not.toContain("/");
      expect(label).not.toContain("\\");
      expect(label).not.toBe(".");
      expect(label).not.toBe("..");
    }
  });

  it("caps its length", () => {
    expect(labelSegment("x".repeat(200)).length).toBeLessThanOrEqual(40);
  });
});

describe("ringLabel", () => {
  const at = () => "13 Sep 09:12";

  it("names a saved project by its file", () => {
    expect(ringLabel("/Users/me/Film.ngt", 0, at)).toBe("Film.ngt");
  });

  it("names an unsaved project by when its session started", () => {
    // LOAD-BEARING for the menu rather than for the data: two rows both
    // reading "Untitled" is the one thing a recovery list must never show.
    expect(ringLabel(null, 0, at)).toBe("Untitled (13 Sep 09:12)");
    expect(ringLabel("", 0, at)).toBe("Untitled (13 Sep 09:12)");
  });

  it("keeps the non-ASCII name a human would recognise", () => {
    // The *label* is not sanitized — only the key's segment is. A user whose
    // project is called 한글.ngt must see that in the menu.
    expect(ringLabel("/Users/me/한글.ngt", 0, at)).toBe("한글.ngt");
  });
});
