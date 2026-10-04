import { describe, expect, it } from "vitest";
import { planProgramSave } from "./programSave";

const MANIFEST = '{"schema":1,"id":"com.me.glow"}';

describe("planProgramSave", () => {
  it("lays a program out as a folder named by its id", () => {
    const plan = planProgramSave(
      "com.me.glow",
      MANIFEST,
      { "main.frag": "void x() {}" },
      { "photo.png": "/abs/photo.png" },
    );
    expect(plan.folder).toBe("com.me.glow");
    expect(plan.files).toEqual({
      "manifest.json": MANIFEST,
      "main.frag": "void x() {}",
    });
    expect(plan.copies).toEqual({ "photo.png": "/abs/photo.png" });
  });

  it.each([
    "../escape",
    "a/b",
    ".hidden",
    "",
    "inline.0123456789abcdef",
    "com..me",
  ])("refuses the id %j", (id) => {
    expect(() => planProgramSave(id, MANIFEST, {}, {})).toThrow();
  });

  it("refuses a source name that is a path or overwrites the manifest", () => {
    expect(() =>
      planProgramSave("com.me.x", MANIFEST, { "../x.frag": "" }, {}),
    ).toThrow(/not a usable source/);
    expect(() =>
      planProgramSave("com.me.x", MANIFEST, { "manifest.json": "" }, {}),
    ).toThrow(/not a usable source/);
  });

  it("copies only images and fonts", () => {
    expect(() =>
      planProgramSave("com.me.x", MANIFEST, {}, { "key.png": "/Users/me/.ssh/id_rsa" }),
    ).toThrow(/image or a font/);
  });

  it("refuses an asset with a relative source or a clashing name", () => {
    expect(() =>
      planProgramSave("com.me.x", MANIFEST, {}, { "a.png": "relative/a.png" }),
    ).toThrow(/absolute/);
    expect(() =>
      planProgramSave("com.me.x", MANIFEST, { "a.png": "" }, { "a.png": "/abs/a.png" }),
    ).toThrow(/not a usable asset/);
  });
});
