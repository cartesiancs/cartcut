import { describe, expect, it } from "vitest";
import {
  actionFor,
  createChangeTracker,
  hotReloadEnabled,
  isBundleAsset,
  stylesheetSwapScript,
} from "./devReload";

describe("hotReloadEnabled", () => {
  it("needs both an unpackaged app and the runner's flag", () => {
    expect(hotReloadEnabled(true, { CARTCUT_HOT_RELOAD: "1" })).toBe(true);
  });

  it("stays off in a packaged build even with the flag set", () => {
    expect(hotReloadEnabled(false, { CARTCUT_HOT_RELOAD: "1" })).toBe(false);
  });

  it("stays off for a plain `npm run start`", () => {
    expect(hotReloadEnabled(true, {})).toBe(false);
    expect(hotReloadEnabled(true, { CARTCUT_HOT_RELOAD: "true" })).toBe(false);
  });
});

describe("actionFor", () => {
  it("does nothing when nothing moved", () => {
    expect(actionFor([])).toBe("none");
  });

  it("swaps a stylesheet without reloading the page", () => {
    expect(actionFor(["style.css"])).toBe("css");
  });

  it("reloads when the script moved, with or without the stylesheet", () => {
    expect(actionFor(["index.js"])).toBe("reload");
    expect(actionFor(["style.css", "index.js"])).toBe("reload");
  });
});

describe("isBundleAsset", () => {
  it("admits what index.html loads and nothing else", () => {
    expect(isBundleAsset("index.js")).toBe(true);
    expect(isBundleAsset("style.css")).toBe(true);
    expect(isBundleAsset("index.js.map")).toBe(false);
    expect(isBundleAsset("index.js.LICENSE.txt")).toBe(false);
  });
});

describe("createChangeTracker", () => {
  const disk = (files: Record<string, string | null>) => (file: string) =>
    files[file] == null ? null : Buffer.from(files[file] as string);

  it("ignores a rewrite of the bytes the window already loaded", () => {
    const files: Record<string, string | null> = { "index.js": "a" };
    const tracker = createChangeTracker(disk(files));
    tracker.seed(["index.js"]);
    expect(tracker.changed(["index.js"])).toEqual([]);
  });

  it("reports a real change once, then treats it as the new baseline", () => {
    const files: Record<string, string | null> = { "index.js": "a", "style.css": "x" };
    const tracker = createChangeTracker(disk(files));
    tracker.seed(["index.js", "style.css"]);

    files["style.css"] = "y";
    expect(tracker.changed(["index.js", "style.css"])).toEqual(["style.css"]);
    expect(tracker.changed(["style.css"])).toEqual([]);
  });

  it("skips a file it cannot read, and picks it up once it is back", () => {
    const files: Record<string, string | null> = { "index.js": "a" };
    const tracker = createChangeTracker(disk(files));
    tracker.seed(["index.js"]);

    files["index.js"] = null;
    expect(tracker.changed(["index.js"])).toEqual([]);
    files["index.js"] = "b";
    expect(tracker.changed(["index.js"])).toEqual(["index.js"]);
  });

  it("treats a file with no baseline as changed", () => {
    const tracker = createChangeTracker(disk({ "index.js": "a" }));
    expect(tracker.changed(["index.js"])).toEqual(["index.js"]);
  });
});

describe("stylesheetSwapScript", () => {
  type Link = { attrs: Record<string, string>; getAttribute(n: string): string | null; setAttribute(n: string, v: string): void };
  const link = (href: string): Link => ({
    attrs: { href },
    getAttribute(name) {
      return this.attrs[name] ?? null;
    },
    setAttribute(name, value) {
      this.attrs[name] = value;
    },
  });

  const run = (script: string, links: Link[]) => {
    const document = { querySelectorAll: () => links };
    new Function("document", script)(document);
  };

  it("re-requests the changed stylesheet and leaves the vendor sheets alone", () => {
    const ours = link("dist/style.css");
    const vendor = link("vendor/bootstrap.min.css");
    run(stylesheetSwapScript(["style.css"], 1), [ours, vendor]);
    expect(ours.attrs.href).toBe("dist/style.css?hot=1");
    expect(vendor.attrs.href).toBe("vendor/bootstrap.min.css");
  });

  it("still matches after an earlier swap added a cache-buster", () => {
    const ours = link("dist/style.css?hot=1");
    run(stylesheetSwapScript(["style.css"], 2), [ours]);
    expect(ours.attrs.href).toBe("dist/style.css?hot=2");
  });
});
