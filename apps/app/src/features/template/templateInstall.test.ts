import { describe, expect, it } from "vitest";
import { templateIdFor } from "./templateInstall";

/**
 * The folder an imported archive lands in.
 *
 * It is a path segment built from a filename someone else chose, so the rules
 * are `lutInstall.ts#planLutInstall`'s: one segment, nothing that could climb,
 * and a **stable** answer — re-importing a template has to replace it rather
 * than pile up `neon-2`, because re-importing is overwhelmingly "I fixed that
 * template" and never "I want both".
 */
describe("templateIdFor", () => {
  it("takes the basename without the extension", () => {
    expect(templateIdFor("/Users/me/Downloads/neon.cttpl")).toBe("neon");
  });

  it("is stable, so a second import replaces the first", () => {
    expect(templateIdFor("/a/neon.cttpl")).toBe(templateIdFor("/b/neon.cttpl"));
  });

  it("lower-cases, so two spellings cannot become two folders", () => {
    expect(templateIdFor("Neon Intro.cttpl")).toBe("neon-intro");
  });

  it("strips the extension case-insensitively", () => {
    expect(templateIdFor("neon.CTTPL")).toBe("neon");
  });

  it("produces exactly one path segment", () => {
    for (const name of [
      "../../escape.cttpl",
      "/etc/passwd.cttpl",
      "a/b/c.cttpl",
      "a\\b.cttpl",
    ]) {
      const id = templateIdFor(name);
      expect(id.includes("/")).toBe(false);
      expect(id.includes("\\")).toBe(false);
      expect(id.includes("..")).toBe(false);
    }
  });

  it("never starts with a dot or a dash", () => {
    expect(templateIdFor(".hidden.cttpl").startsWith(".")).toBe(false);
    expect(templateIdFor("---x.cttpl").startsWith("-")).toBe(false);
  });

  it("never answers empty", () => {
    expect(templateIdFor(".cttpl")).toBe("template");
    expect(templateIdFor("")).toBe("template");
    expect(templateIdFor("한글.cttpl")).not.toBe("");
  });

  it("collapses runs of replacements", () => {
    expect(templateIdFor("a???b.cttpl")).toBe("a-b");
  });

  it("caps the length, so a pathological name cannot make an unusable path", () => {
    expect(templateIdFor(`${"a".repeat(500)}.cttpl`).length).toBeLessThanOrEqual(
      64,
    );
  });
});
