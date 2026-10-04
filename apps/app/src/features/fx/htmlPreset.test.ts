import { describe, expect, it } from "vitest";
import { coerceInlineProgram } from "./inlineProgram";
import type { RawPresetPayload } from "./presetTypes";
import { validatePreset } from "./presetValidate";

const HTML = '<div class="card"><h1 data-param="title" data-split="chars">Hi</h1></div>';
const CSS = ".card { color: var(--color); font-family: var(--font); }";

function payload(manifest: Record<string, unknown>, over: Partial<RawPresetPayload> = {}): RawPresetPayload {
  return {
    id: "t",
    dir: "/p/t",
    origin: "user",
    manifestJson: JSON.stringify({
      schema: 1,
      id: "com.example.card",
      kind: "graphic",
      name: "Card",
      category: "layout",
      render: { type: "html", source: "index.html", styles: ["style.css"] },
      params: [
        { key: "title", label: "Title", type: "text", default: "Hello" },
        { key: "color", label: "Colour", type: "color", default: "#ffffff" },
        { key: "font", label: "Font", type: "font", default: "bundled:Anton-Regular.ttf" },
      ],
      ...manifest,
    }),
    sources: { "index.html": HTML, "style.css": CSS },
    assets: {},
    ...over,
  };
}

function errorsOf(result: ReturnType<typeof validatePreset>): string {
  return result.ok ? "" : result.errors.join("\n");
}

describe("an html graphic preset", () => {
  it("validates, with text and font parameters and no uniforms", () => {
    const result = validatePreset(payload({}));
    expect(errorsOf(result)).toBe("");
    if (result.ok) {
      expect(result.preset.render.type).toBe("html");
      expect(result.preset.params.map((p) => p.type)).toEqual(["text", "color", "font"]);
      expect(result.warnings).toBeUndefined();
    }
  });

  it("is a graphic's only: an effect may not be html", () => {
    expect(errorsOf(validatePreset(payload({ kind: "effect", category: "color" })))).toMatch(
      /only a graphic may be html/,
    );
  });

  it("refuses a text parameter with no element to fill", () => {
    const result = validatePreset(
      payload({}, { sources: { "index.html": "<div></div>", "style.css": CSS } }),
    );
    expect(errorsOf(result)).toMatch(/no element in index.html has data-param="title"/);
  });

  it("warns about a parameter no stylesheet reads", () => {
    const result = validatePreset(
      payload({}, { sources: { "index.html": HTML, "style.css": ".card { color: red; }" } }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings?.join("\n")).toMatch(/`color` is never read/);
    }
  });

  it("takes a hyphenated key on every type, since nothing compiles it as GLSL", () => {
    const params = [
      { key: "title", label: "Title", type: "text", default: "Hello" },
      { key: "accent-color", label: "Accent", type: "color", default: "#ffffff" },
      { key: "font-size", label: "Size", type: "number", default: 40, min: 1, max: 400 },
      { key: "font", label: "Font", type: "font", default: "default" },
    ];
    const css = ".card { color: var(--accent-color); font: calc(var(--font-size) * 1px) var(--font); }";
    const result = validatePreset(
      payload({ params }, { sources: { "index.html": HTML, "style.css": css } }),
    );
    expect(errorsOf(result)).toBe("");
    if (result.ok) {
      expect(result.warnings).toBeUndefined();
    }
  });

  it("does not count a mention inside a comment as reading a parameter", () => {
    const result = validatePreset(
      payload({}, { sources: { "index.html": HTML, "style.css": "/* var(--color) */ .card { font-family: var(--font); }" } }),
    );
    expect(result.ok && result.warnings?.join("\n")).toMatch(/`color` is never read/);
  });

  it("counts a split as reading `seed`, which feeds --rand", () => {
    const seed = { key: "seed", label: "Seed", type: "number", default: 0, min: 0, max: 99 };
    const params = [
      { key: "title", label: "Title", type: "text", default: "Hello" },
      { key: "color", label: "Colour", type: "color", default: "#ffffff" },
      { key: "font", label: "Font", type: "font", default: "default" },
      seed,
    ];
    const split = validatePreset(payload({ params }));
    expect(split.ok && split.warnings).toBeUndefined();
    const unsplit = validatePreset(
      payload({ params }, { sources: { "index.html": '<h1 data-param="title"></h1>', "style.css": CSS } }),
    );
    expect(unsplit.ok && unsplit.warnings?.join("\n")).toMatch(/`seed` is never read/);
  });

  it("refuses a key that shadows a host variable, or is not a CSS name", () => {
    const shadow = validatePreset(
      payload({ params: [{ key: "t", label: "T", type: "number", default: 0, min: 0, max: 1 }] }),
    );
    expect(errorsOf(shadow)).toMatch(/`--t` is set by the host/);
    const name = validatePreset(
      payload({ params: [{ key: "a b", label: "A", type: "number", default: 0, min: 0, max: 1 }] }),
    );
    expect(errorsOf(name)).toMatch(/must be a CSS name/);
  });

  it("refuses html parameter kinds on a shader preset", () => {
    const result = validatePreset({
      id: "s",
      dir: "/p/s",
      origin: "user",
      manifestJson: JSON.stringify({
        schema: 1,
        id: "com.example.s",
        kind: "graphic",
        name: "S",
        category: "background",
        render: { type: "shader", source: "a.frag" },
        params: [{ key: "title", label: "T", uniform: "title", type: "text", default: "" }],
      }),
      sources: { "a.frag": "vec4 graphic(vec2 uv) { return vec4(1.0); }" },
      assets: {},
    });
    expect(errorsOf(result)).toMatch(/is for html graphics/);
  });

  it("needs a design size to scale, and checks bindings against parameter kinds", () => {
    expect(errorsOf(validatePreset(payload({ render: { type: "html", source: "index.html", layout: "scale" } })))).toMatch(
      /a `scale` layout needs one/,
    );
    const bound = validatePreset(
      payload({
        render: {
          type: "html",
          source: "index.html",
          styles: ["style.css"],
          bindings: { text: "title", font: "font", color: "title" },
        },
      }),
    );
    expect(errorsOf(bound)).toMatch(/bindings.color: `title` is a text, and color needs color/);
  });

  it("refuses a font default that is neither default, bundled nor a path", () => {
    const result = validatePreset(
      payload({ params: [{ key: "font", label: "F", type: "font", default: "Comic Sans" }] }),
    );
    expect(errorsOf(result)).toMatch(/must be "default", "bundled:<file>"/);
  });
});

describe("an inline html program", () => {
  it("is stored sanitised, and says what was removed", () => {
    const result = coerceInlineProgram({
      kind: "graphic",
      name: "Card",
      render: {
        type: "html",
        html: '<h1 data-param="title" onclick="alert(1)">x</h1><script>alert(1)</script>',
        css: "h1 { color: var(--color); background: url(https://evil.example/x.png); }",
      },
      params: [
        { key: "title", label: "Title", type: "text", default: "Hello" },
        { key: "color", label: "Colour", type: "color", default: "#ffffff" },
      ],
    });
    if (!result.ok) {
      throw new Error(JSON.stringify(result.errors));
    }
    const html = result.program.sources["index.html"];
    expect(html).not.toMatch(/onclick|script/);
    expect(html).toMatch(/data-param="title"/);
    expect(result.program.sources["style.css"]).not.toMatch(/evil/);
    expect(result.warnings.length).toBeGreaterThanOrEqual(3);
  });

  it("gets the same id whatever the sanitiser removed", () => {
    const base = {
      kind: "graphic" as const,
      name: "Card",
      params: [{ key: "title", label: "Title", type: "text", default: "Hello" }],
    };
    const clean = coerceInlineProgram({
      ...base,
      render: { type: "html", html: '<h1 data-param="title">x</h1>' },
    });
    const dirty = coerceInlineProgram({
      ...base,
      render: { type: "html", html: '<h1 data-param="title" onmouseover="x()">x</h1>' },
    });
    if (!clean.ok || !dirty.ok) {
      throw new Error("expected both to store");
    }
    expect(dirty.program.hash).toBe(clean.program.hash);
  });
});
