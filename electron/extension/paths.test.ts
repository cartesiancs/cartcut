import path from "path";
import { describe, expect, it } from "vitest";

import { isInside, isSafeRelativePath, resolveContained, toPosix } from "./paths";

/**
 * The inputs both sides have to agree on.
 *
 * Each rejected one is a real escape: a traversal, an absolute path, a Windows
 * drive, a separator that means two different things on two platforms, and a
 * NUL that truncates the string inside a syscall.
 */
const CASES: Array<[string, boolean]> = [
  ["views/panel.html", true],
  ["a/b/c/d.frag", true],
  ["shader.frag", true],
  ["", false],
  ["   ", false],
  ["../secrets", false],
  ["a/../../b", false],
  ["/etc/passwd", false],
  ["C:/Windows/System32", false],
  ["c:\\windows", false],
  ["views\\panel.html", false],
  ["a//b", false],
  ["./a", false],
  ["a/./b", false],
  ["a\u0000b", false],
];

describe("isSafeRelativePath", () => {
  for (const [value, expected] of CASES) {
    it((expected ? "accepts " : "refuses ") + JSON.stringify(value), () => {
      expect(isSafeRelativePath(value)).toBe(expected);
    });
  }

  /**
   * The copy in `features/fx/presetValidate.ts` is the original. Nothing can
   * import across that boundary in the build, so the only way to know the two
   * have not drifted is to load both here, where vitest can.
   */
  it("agrees with the renderer's copy on every case", async () => {
    const renderer = await import("../../apps/app/src/features/fx/presetValidate");
    for (const [value] of CASES) {
      expect([value, renderer.isSafeRelativePath(value)]).toEqual([value, isSafeRelativePath(value)]);
    }
  });
});

describe("isInside", () => {
  it("accepts a real child", () => {
    expect(isInside("/a/b", "/a/b/c")).toBe(true);
  });

  it("refuses the directory itself", () => {
    // Equal is not inside. A caller that deletes "everything inside" would
    // otherwise delete the root it was handed.
    expect(isInside("/a/b", "/a/b")).toBe(false);
  });

  it("refuses a sibling whose name starts the same way", () => {
    expect(isInside("/a/b", "/a/bc")).toBe(false);
  });

  it("refuses a parent", () => {
    expect(isInside("/a/b", "/a")).toBe(false);
  });
});

describe("resolveContained", () => {
  const root = path.resolve("/tmp/ext-root");

  it("resolves a plain relative path", () => {
    expect(resolveContained(root, "views/panel.html")).toBe(path.join(root, "views", "panel.html"));
  });

  it("refuses a traversal even though it would resolve", () => {
    expect(resolveContained(root, "../other/file")).toBeNull();
  });

  it("refuses an absolute path", () => {
    expect(resolveContained(root, "/etc/passwd")).toBeNull();
  });
});

describe("toPosix", () => {
  it("leaves a posix path alone", () => {
    expect(toPosix("a/b/c")).toBe("a/b/c");
  });

  it("rewrites the host separator", () => {
    expect(toPosix(["a", "b"].join(path.sep))).toBe("a/b");
  });
});
