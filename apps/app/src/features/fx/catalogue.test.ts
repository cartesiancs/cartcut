/**
 * The shipped catalogue, checked as a catalogue rather than one preset at a
 * time.
 *
 * Seventy-six presets is past the point where "don't ship two things that do
 * the same job" survives as an intention. It has to be a rule something
 * enforces, so these are the rules:
 *
 * 1. **One preset per (category, mechanism).** The catalogue is a table of
 *    mechanisms, not a list of names, and the folder name is the mechanism.
 * 2. **A variation is a parameter, not a preset.** Not `dip-to-black` and
 *    `dip-to-white` but one Dip to Colour with a colour; not four directional
 *    wipes but one Linear Wipe with a `direction`. Nothing here can check that
 *    directly — what it can check is the symptom, which is two presets whose
 *    shader pipelines are the same code.
 * 3. **Names may repeat across kinds.** Radial Blur is a sensible transition
 *    *and* a sensible effect, and they are different things. Uniqueness is
 *    within a kind.
 *
 * It reads the real folders through the real scanner and the real validator, so
 * a preset that fails here is a preset that would fail in the app.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { existsSync } from "fs";
import path from "path";
import { createHash } from "crypto";
import { scanPresetRoot } from "../../../../../electron/lib/presetScan";
import { validatePreset } from "./presetValidate";
import { categoriesFor, type FxHtmlRender, type FxPreset } from "./presetTypes";
import { mountSpecOf } from "../graphic/mountSpec";

const PRESET_ROOT = path.resolve(__dirname, "../../../../../assets/presets");

/** The floor the catalogue was built to. Below it the panel is a demo. */
const MINIMUM_PER_KIND = 30;

/**
 * The typography catalogue's floor: one graphic per row of the coverage matrix
 * that names a preset (`typographyCoverage.test.ts`), plus the backgrounds.
 */
const MINIMUM_GRAPHICS = 24;

/** The fonts a `bundled:` value may name. */
const BUNDLED_FONTS = path.resolve(__dirname, "../../../../../assets/fonts/google");

/**
 * The one HTML graphic without a font parameter. It animates the weight axis,
 * which needs a variable face, and no bundled face is one; it names the
 * editor's own variable Noto Sans KR instead.
 */
const NO_FONT_PARAMETER = ["com.cartcut.graphic.weight-wave"];

type Entry = {
  preset: FxPreset;
  /** The folder the preset lives in, which is what "mechanism" means here. */
  mechanism: string;
  /** What the validator would tell an author, which a shipped preset must not need told. */
  warnings: string[];
};

let entries: Entry[] = [];
let failures: string[] = [];

beforeAll(async () => {
  const payloads = await scanPresetRoot(PRESET_ROOT, "builtin");
  for (const payload of payloads) {
    const result = validatePreset(payload);
    if (!result.ok) {
      failures.push(payload.dir + ": " + result.errors.join(" | "));
      continue;
    }
    entries.push({
      preset: result.preset,
      mechanism: path.basename(payload.dir),
      warnings: result.warnings ?? [],
    });
  }
});

/**
 * A shader with its comments and whitespace removed.
 *
 * Comments are stripped deliberately: two presets that differ only in what
 * their headers claim are still the same preset, and leaving the prose in would
 * make the duplication check trivial to defeat by accident.
 */
function normalize(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\s+/g, "");
}

/**
 * Markup or a stylesheet with its comments and whitespace removed. Not
 * `normalize`: CSS has no `//` comment, and stripping one would eat a
 * `content: "//"` along with the rest of its line.
 */
function normalizeHtmlOrCss(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\s+/g, "");
}

/** The markup and every style sheet of an HTML graphic, as one text. */
function htmlSourcesOf(preset: FxPreset): string {
  if (preset.render.type !== "html") {
    return "";
  }
  return [preset.render.source, ...(preset.render.styles ?? [])]
    .map((name) => preset.sources[name] ?? "")
    .join("\n");
}

/**
 * Everything the compositor will actually run, in order.
 *
 * The *pipeline* rather than each file, because a shared helper is not
 * duplication. Gaussian Blur, Bloom, Halation and Tilt Shift all run the same
 * separable blur, and forbidding that would push each of them into keeping a
 * private, slightly-drifted copy — the opposite of the thing being prevented.
 * What must not repeat is the whole chain.
 */
function pipelineOf(preset: FxPreset): string {
  if (preset.render.type === "lut") {
    // Every LUT preset runs the same shader and differs only in its table, so
    // there is no pipeline here to compare. The equivalent rule — no two
    // shipped tables grade alike — needs the parsed data and lives in
    // `lut/lutCatalogue.test.ts`.
    return "lut:" + preset.id;
  }
  if (preset.render.type === "html") {
    // An HTML graphic's pipeline is its markup and its sheets: two graphics
    // that differ only in a default are one graphic with a parameter.
    const files = [preset.render.source, ...(preset.render.styles ?? [])];
    const body = files
      .map((name) => name + ":" + normalizeHtmlOrCss(preset.sources[name] ?? ""))
      .join("|");
    return createHash("sha1").update(body).digest("hex");
  }
  if (preset.render.type !== "shader") {
    return "overlay:" + preset.render.source;
  }
  const stages = [
    ...(preset.render.passes ?? []).map(
      (pass) =>
        pass.source + "@" + JSON.stringify(pass.constants ?? {}),
    ),
    preset.render.source,
  ];
  const body = stages
    .map((stage) => {
      const name = stage.split("@")[0];
      return stage + ":" + normalize(preset.sources[name] ?? "");
    })
    .join("|");
  const vertex =
    preset.render.vertex != null
      ? normalize(preset.sources[preset.render.vertex] ?? "")
      : "";
  return createHash("sha1").update(body + "|" + vertex).digest("hex");
}

function duplicates<T>(values: T[]): T[] {
  const seen = new Set<string>();
  const twice = new Set<string>();
  for (const value of values) {
    const key = JSON.stringify(value);
    if (seen.has(key)) twice.add(key);
    seen.add(key);
  }
  return [...twice].map((key) => JSON.parse(key) as T);
}

describe("the shipped catalogue", () => {
  it("all of it loads", () => {
    expect(failures).toEqual([]);
    expect(entries.length).toBeGreaterThan(0);
  });

  it("has at least the minimum of each kind", () => {
    for (const kind of ["effect", "transition"] as const) {
      const count = entries.filter((e) => e.preset.kind === kind).length;
      expect(
        count,
        kind + "s: " + count + ", need " + MINIMUM_PER_KIND,
      ).toBeGreaterThanOrEqual(MINIMUM_PER_KIND);
    }
    const graphics = entries.filter((e) => e.preset.kind === "graphic").length;
    expect(graphics, "graphics: " + graphics + ", need " + MINIMUM_GRAPHICS).toBeGreaterThanOrEqual(
      MINIMUM_GRAPHICS,
    );
  });

  it("gives every preset a distinct id", () => {
    expect(duplicates(entries.map((e) => e.preset.id))).toEqual([]);
  });

  it("gives every preset a distinct name within its kind", () => {
    // Within, not across: see rule 3 in the header.
    expect(
      duplicates(entries.map((e) => [e.preset.kind, e.preset.name])),
    ).toEqual([]);
  });

  it("names each preset's folder after its id", () => {
    // What makes `mechanism` mean anything: the folder is the identifier a
    // reviewer sees in a diff, so it has to be the one the manifest uses.
    //
    // LUTs carry an extra `lut.` segment because their folder names are shared
    // vocabulary with the effects — Sepia and Bleach Bypass exist as both, and
    // they are genuinely different things: one is a shader with parameters, the
    // other a fixed table. The segment is what keeps the ids distinct without
    // making either folder name worse.
    //
    // Graphics carry `graphic.` for the same reason: Glitch is an effect and a
    // graphic, and Light Leak could be either.
    for (const { preset, mechanism } of entries) {
      const prefix =
        preset.kind === "lut"
          ? "com.cartcut.lut."
          : preset.kind === "graphic"
            ? "com.cartcut.graphic."
            : "com.cartcut.";
      expect(preset.id, mechanism).toBe(prefix + mechanism);
    }
  });

  it("puts every preset in a category its kind actually has", () => {
    for (const { preset } of entries) {
      expect(
        categoriesFor(preset.kind),
        preset.id + " is `" + preset.category + "`",
      ).toContain(preset.category);
    }
  });

  it("fills one (category, mechanism) slot per preset", () => {
    // Rule 1. Two presets in the same category with the same folder name cannot
    // happen on one filesystem — this catches the case where `transitions/` and
    // `effects/` each hold a `glitch/`, which is legal, and would only be a
    // problem if they were also the same category of the same kind.
    expect(
      duplicates(
        entries.map((e) => [e.preset.kind, e.preset.category, e.mechanism]),
      ),
    ).toEqual([]);
  });

  it("runs a distinct shader pipeline for every preset", () => {
    // Rule 2's teeth. Copying a preset's folder, renaming it and changing a
    // default is the easy way to inflate a catalogue, and it is exactly what
    // this refuses.
    const byPipeline = new Map<string, string[]>();
    for (const { preset } of entries) {
      const key = preset.kind + "|" + pipelineOf(preset);
      byPipeline.set(key, [...(byPipeline.get(key) ?? []), preset.id]);
    }
    const clashes = [...byPipeline.values()].filter((ids) => ids.length > 1);
    expect(clashes).toEqual([]);
  });

  it("runs the shared blur as one shader, in all four of its stages", () => {
    // A preset folder is self-contained, so each of these ships its own copy
    // of `blur.frag`. A fix made to one copy leaves the others drawing the
    // lattice of shifted copies the old nine-tap kernel drew, and a pipeline
    // that drops a stage blurs by a fraction of its radius. Neither fails to
    // load, and neither can be seen without the GPU.
    const passesOf = (preset: FxPreset) =>
      preset.render.type === "shader" ? (preset.render.passes ?? []) : [];
    const users = entries.filter(({ preset }) =>
      passesOf(preset).some((pass) => pass.source === "blur.frag"),
    );
    expect(users.map(({ mechanism }) => mechanism).sort()).toEqual([
      "bloom",
      "gaussian-blur",
      "halation",
      "tilt-shift",
    ]);

    const copies = new Set(
      users.map(({ preset }) => preset.sources["blur.frag"]),
    );
    expect(copies.size).toBe(1);

    for (const { preset, mechanism } of users) {
      const stages = passesOf(preset)
        .filter((pass) => pass.source === "blur.frag")
        .map((pass) => pass.constants);
      expect(stages, mechanism).toEqual([
        { dir: [1, 0], stage: 0 },
        { dir: [1, 0], stage: 1 },
        { dir: [0, 1], stage: 0 },
        { dir: [0, 1], stage: 1 },
      ]);
    }
  });

  it("keeps every category non-empty and worth its own heading", () => {
    // A category holding one preset is a heading with a single tile under it,
    // which is worse for scanning than no heading at all.
    const counts = new Map<string, number>();
    for (const { preset } of entries) {
      const key = preset.kind + "/" + preset.category;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    for (const kind of ["effect", "transition", "lut", "graphic"] as const) {
      for (const category of categoriesFor(kind)) {
        const count = counts.get(kind + "/" + category) ?? 0;
        expect(count, kind + "/" + category).toBeGreaterThanOrEqual(3);
      }
    }
  });
});

describe("the shipped graphics", () => {
  const graphics = () => entries.filter((e) => e.preset.kind === "graphic");
  const htmlGraphics = () => graphics().filter((e) => e.preset.render.type === "html");

  it("validate without a single warning", () => {
    // A warning is the validator telling an author something is probably
    // wrong, such as a parameter nothing reads. The catalogue is what authors
    // copy, so it has to be the example of none.
    const warned = graphics()
      .filter((e) => e.warnings.length > 0)
      .map((e) => e.preset.id + ": " + e.warnings.join(" | "));
    expect(warned).toEqual([]);
  });

  it("each declare which text parameter a text clip's words go into", () => {
    // `apply_typography` converts a text clip by its bindings. A graphic with
    // no `bindings.text` would take the clip and drop its words.
    for (const { preset } of htmlGraphics()) {
      const render = preset.render as FxHtmlRender;
      const key = render.bindings?.text;
      expect(key, preset.id).toBeTypeOf("string");
      const param = preset.params.find((p) => p.key === key);
      expect(param?.type, preset.id + " binds text to " + key).toBe("text");
    }
  });

  it("each break Korean by eojeol, not between syllables", () => {
    // Matrix row 13. Chromium's default breaks Hangul between any two
    // syllables; `keep-all` breaks at the spaces, which is how Korean wraps.
    for (const { preset } of htmlGraphics()) {
      expect(htmlSourcesOf(preset), preset.id).toMatch(/word-break:\s*keep-all/);
    }
  });

  it("each take a font, defaulting to a face every install has", () => {
    for (const { preset } of htmlGraphics()) {
      const fonts = preset.params.filter((p) => p.type === "font");
      if (NO_FONT_PARAMETER.includes(preset.id)) {
        expect(fonts, preset.id).toEqual([]);
        continue;
      }
      expect(fonts.length, preset.id).toBeGreaterThan(0);
      for (const font of fonts) {
        const value = font.default as string;
        expect(value.startsWith("bundled:"), preset.id + ": " + value).toBe(true);
        expect(
          existsSync(path.join(BUNDLED_FONTS, value.slice("bundled:".length))),
          preset.id + ": " + value + " is not in assets/fonts/google",
        ).toBe(true);
      }
    }
  });

  it("lose nothing to the sanitiser or the stylesheet filter", () => {
    // The read side sanitises every program again before mounting it. A
    // shipped preset that loses a node or a declaration there draws something
    // other than what its author saw, and nobody is told.
    const lost = htmlGraphics().flatMap(({ preset }) =>
      (mountSpecOf(preset)?.removed ?? []).map(
        (d) => preset.id + " " + (d.file ?? "") + ":" + (d.line ?? "") + " " + d.message,
      ),
    );
    expect(lost).toEqual([]);
  });

  it("never name a face by a path, or load anything", () => {
    for (const { preset } of htmlGraphics()) {
      // Comments out first: a comment may well explain what `url(...)` holds.
      const text = htmlSourcesOf(preset)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/<!--[\s\S]*?-->/g, "");
      expect(text, preset.id).not.toMatch(/@font-face|@import/);
      expect(text, preset.id).not.toMatch(/url\(\s*(?!["']?#)/);
    }
  });
});
