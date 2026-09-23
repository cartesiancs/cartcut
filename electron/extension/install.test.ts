import path from "path";
import { describe, expect, it } from "vitest";

import { installedDirFor, MANIFEST_ENTRY, planExtractions, stagingDirFor } from "./install";

describe("planExtractions", () => {
  it("plans a plain archive", () => {
    const plan = planExtractions([MANIFEST_ENTRY, "main.js", "views/panel.html"]);
    expect(plan).toEqual({ ok: true, files: [MANIFEST_ENTRY, "main.js", "views/panel.html"] });
  });

  it("drops directory entries rather than creating them separately", () => {
    const plan = planExtractions(["views/", MANIFEST_ENTRY]);
    expect(plan).toEqual({ ok: true, files: [MANIFEST_ENTRY] });
  });

  it("refuses the whole archive over one traversal", () => {
    // Not "skip that entry". An archive containing one hostile name is not an
    // archive with a bad file in it; it is a hostile archive.
    const plan = planExtractions([MANIFEST_ENTRY, "../../../.ssh/authorized_keys"]);
    expect(plan.ok).toBe(false);
  });

  const hostile = [
    "/etc/passwd",
    "C:/Windows/System32/drivers/etc/hosts",
    "views\\panel.html",
    "a/../../../b",
    "a\u0000b",
  ];
  for (const name of hostile) {
    it("refuses " + JSON.stringify(name), () => {
      expect(planExtractions([MANIFEST_ENTRY, name]).ok).toBe(false);
    });
  }

  it("refuses an archive with no manifest at its root", () => {
    expect(planExtractions(["inner/package.json", "inner/main.js"])).toMatchObject({ ok: false });
  });

  it("refuses an empty archive", () => {
    expect(planExtractions([]).ok).toBe(false);
  });
});

describe("install paths", () => {
  it("stages beside the target, under a name discovery skips", () => {
    // The staging directory shares the root so the rename is on one volume,
    // and starts with a dot so a crash mid-install leaves something
    // `scanExtensionRoots` ignores rather than a half extension it reports.
    const root = path.resolve("/ext");
    expect(path.dirname(stagingDirFor(root, "acme.hello"))).toBe(root);
    expect(path.basename(stagingDirFor(root, "acme.hello")).startsWith(".")).toBe(true);
    expect(installedDirFor(root, "acme.hello")).toBe(path.join(root, "acme.hello"));
  });
});
