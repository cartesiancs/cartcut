/**
 * Where an imported LUT is allowed to land.
 *
 * Mostly a security test. The folder name comes from the *filename of a file
 * someone downloaded*, and a folder name is a path — so the interesting cases
 * are not "does it handle spaces" but "can a name reach outside
 * `userData/presets`". They cannot, and the reason is that `slugify` reduces to
 * `[a-z0-9-]` rather than looking for the sequences that would be dangerous:
 * a denylist has to be right about every attack, an allowlist only has to be
 * right about what a name is made of.
 *
 * It also runs the manifest it writes through the *real* validator, which is
 * what proves an imported LUT is a preset like any other rather than something
 * the registry tolerates.
 */

import { describe, it, expect } from "vitest";
import path from "path";

import {
  LUT_INSTALL_EXTENSIONS,
  MAX_SLUG_LENGTH,
  installExtension,
  planLutInstall,
  slugify,
} from "./lutInstall";
import { validatePreset } from "../../apps/app/src/features/fx/presetValidate";

describe("slugify — names that must not become paths", () => {
  // Each of these is a real filename shape, and each would be a write outside
  // the presets folder if the slug were a denylist rather than an allowlist.
  it.each([
    ["../../../etc/passwd", "etc-passwd"],
    ["..", ""],
    ["../..", ""],
    ["/absolute/path", "absolute-path"],
    ["C:\\Windows\\System32", "c-windows-system32"],
    ["con", "con"],
    [".hidden", "hidden"],
    ["with\0null", "with-null"],
    ["a/b\\c:d*e?f", "a-b-c-d-e-f"],
    ["....", ""],
    ["~/.ssh/id_rsa", "ssh-id_rsa".replace("_", "-")],
  ])("reduces %j to %j", (input, want) => {
    expect(slugify(input)).toBe(want);
  });

  it("never produces anything outside [a-z0-9-]", () => {
    const nasty =
      "Ko̶dak 2383 ✨ / .. \\ : * ? \" < > | \u0000 \n\t —– 日本語 🎬";
    expect(slugify(nasty)).toMatch(/^[a-z0-9-]*$/);
  });

  it("never starts or ends with a dash", () => {
    for (const input of ["  spaces  ", "---a---", "!!!b!!!", "..c.."]) {
      const slug = slugify(input);
      expect(slug.startsWith("-")).toBe(false);
      expect(slug.endsWith("-")).toBe(false);
    }
  });

  it("is bounded, and still not left with a trailing dash by the cut", () => {
    // Truncating mid-run is how a slug ends in a dash after being cleaned.
    const long = `${"a".repeat(MAX_SLUG_LENGTH - 1)} tail`;
    const slug = slugify(long);
    expect(slug.length).toBeLessThanOrEqual(MAX_SLUG_LENGTH);
    expect(slug.endsWith("-")).toBe(false);
  });

  it("keeps an ordinary name readable", () => {
    expect(slugify("Kodak 2383 Print")).toBe("kodak-2383-print");
    expect(slugify("Teal & Orange")).toBe("teal-orange");
  });
});

describe("planLutInstall", () => {
  it("refuses a name with nothing usable in it", () => {
    for (const name of ["", "...", "///", "   ", "\u0000"]) {
      expect(() => planLutInstall(name, "cube")).toThrow(/no usable characters/);
    }
  });

  it("puts the folder inside the presets root and nowhere else", () => {
    // The property, stated as the filesystem sees it rather than as a string
    // comparison: joining the plan onto a root must not escape the root.
    const root = "/tmp/userData/presets";
    for (const name of [
      "../../../etc",
      "Kodak 2383",
      "C:\\Windows",
      "a/b/c",
    ]) {
      const plan = planLutInstall(name, "cube");
      const resolved = path.resolve(root, plan.folder);
      expect(resolved.startsWith(`${path.resolve(root)}${path.sep}`)).toBe(true);
      expect(path.resolve(root, plan.folder, plan.source)).toContain(
        path.resolve(root, plan.folder),
      );
    }
  });

  it("prefixes the folder so it cannot collide with a shipped preset", () => {
    // `assets/presets/luts/teal-orange` ships; a user importing something they
    // called "Teal & Orange" must not shadow it.
    expect(planLutInstall("Teal & Orange", "cube").folder).toBe(
      "lut-teal-orange",
    );
    expect(planLutInstall("Teal & Orange", "cube").id).toBe(
      "com.user.lut.teal-orange",
    );
  });

  it("keeps the extensions it understands and normalises the rest", () => {
    for (const extension of LUT_INSTALL_EXTENSIONS) {
      expect(installExtension(extension.toUpperCase())).toBe(extension);
      expect(planLutInstall("x", extension).source).toBe(`lut.${extension}`);
    }
    // An extension it does not know is stored as `.cube`, because the renderer
    // has already parsed the bytes and the sniffer reads content anyway.
    expect(planLutInstall("x", "txt").source).toBe("lut.cube");
    expect(planLutInstall("x", "").source).toBe("lut.cube");
    expect(planLutInstall("x", "../evil").source).toBe("lut.cube");
  });

  it("keeps the display name as the user wrote it", () => {
    // Only the *folder* is sanitised. The name is data, shown on a tile, and
    // flattening it would rename everybody's imports.
    expect(planLutInstall("Kodak 2383 ✨", "cube").manifest).toContain(
      '"name": "Kodak 2383 ✨"',
    );
  });
});

describe("the manifest it writes is a real preset", () => {
  it("passes the renderer's own validator", () => {
    const plan = planLutInstall("Kodak 2383", "cube");
    const result = validatePreset({
      id: plan.folder,
      dir: `/tmp/userData/presets/${plan.folder}`,
      origin: "user",
      manifestJson: plan.manifest,
      sources: {},
      // What the scanner would report: the LUT as an absolute path, unread.
      assets: { [plan.source]: `/tmp/userData/presets/${plan.folder}/${plan.source}` },
    });
    expect(result.ok ? [] : result.errors).toEqual([]);
    if (result.ok) {
      expect(result.preset.kind).toBe("lut");
      expect(result.preset.origin).toBe("user");
      expect(result.preset.render).toEqual({ type: "lut", source: plan.source });
    }
  });

  it("is rejected when the file it names is not there", () => {
    // The scanner reports what it found; a manifest naming a file it did not
    // must fail rather than install a preset that can never grade.
    const plan = planLutInstall("Kodak 2383", "cube");
    const result = validatePreset({
      id: plan.folder,
      dir: `/tmp/userData/presets/${plan.folder}`,
      origin: "user",
      manifestJson: plan.manifest,
      sources: {},
      assets: {},
    });
    expect(result.ok).toBe(false);
  });

  it("writes JSON in the shape every other manifest uses", () => {
    const manifest = planLutInstall("Kodak 2383", "cube").manifest;
    expect(manifest.endsWith("\n")).toBe(true);
    expect(manifest).toContain('\n  "id"');
    expect(JSON.parse(manifest).schema).toBe(1);
  });
});
