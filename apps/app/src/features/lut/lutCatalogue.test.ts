/**
 * The eighty shipped tables, checked as a catalogue.
 *
 * `fx/catalogue.test.ts` holds the shader presets to "no two run the same
 * pipeline". A LUT has no pipeline — every one of them runs the same shader —
 * so the equivalent rule has to be stated about the *data*, and that is what
 * most of this file is: no two tables may grade alike, every table must be
 * smooth enough that a 17-node grid reconstructs it, and every one must be
 * regenerable from its recipe.
 *
 * It reads the real folders through the real scanner and the real validator, so
 * a preset that fails here is a preset that would fail in the app.
 */

import { beforeAll, describe, expect, it } from "vitest";
import path from "path";
import fs from "fs";

import { scanPresetRoot } from "../../../../../electron/lib/presetScan";
import { LUT_CATEGORIES, type FxPreset } from "../fx/presetTypes";
import { validatePreset } from "../fx/presetValidate";
import { parseCube } from "./cube";
import {
  BUILTIN_LUT_SIZE,
  generateLut,
  lutPresetId,
} from "./generate";
import { type Lut3d, isIdentity, nodeOffset } from "./lutData";
import { LUT_RECIPES, gradeWith } from "./recipes";
import { sampleLut } from "./sample";

const PRESET_ROOT = path.resolve(__dirname, "../../../../../assets/presets");
const LUT_ROOT = path.join(PRESET_ROOT, "luts");

/** What the catalogue was promised to hold. */
const EXPECTED_COUNT = 80;

/** Below this a category is a heading with too few tiles under it. */
const MINIMUM_PER_CATEGORY = 6;

type Entry = { preset: FxPreset; folder: string; lut: Lut3d };

let entries: Entry[] = [];
let failures: string[] = [];

beforeAll(async () => {
  const payloads = await scanPresetRoot(PRESET_ROOT, "builtin");
  for (const payload of payloads) {
    const result = validatePreset(payload);
    if (!result.ok) {
      failures.push(`${payload.dir}: ${result.errors.join(" | ")}`);
      continue;
    }
    if (result.preset.kind !== "lut") {
      continue;
    }
    const source = result.preset.render;
    if (source.type !== "lut") {
      failures.push(`${payload.dir}: a lut preset must render a lut`);
      continue;
    }
    const file = result.preset.assets[source.source];
    const lut = parseCube(fs.readFileSync(file, "utf8"));
    if (lut.kind !== "3d") {
      failures.push(`${payload.dir}: a shipped LUT must be a cube`);
      continue;
    }
    entries.push({
      preset: result.preset,
      folder: path.basename(payload.dir),
      lut,
    });
  }
});

describe("the shipped LUT catalogue", () => {
  it("loads through the real scanner and validator", () => {
    expect(failures).toEqual([]);
  });

  it("holds exactly the promised eighty", () => {
    expect(entries).toHaveLength(EXPECTED_COUNT);
    expect(LUT_RECIPES).toHaveLength(EXPECTED_COUNT);
  });

  it("has one folder per recipe and no orphans", () => {
    const onDisk = fs
      .readdirSync(LUT_ROOT, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    expect(onDisk).toEqual(LUT_RECIPES.map((r) => r.slug).sort());
  });

  it("gives every preset a distinct id built from its folder", () => {
    for (const { preset, folder } of entries) {
      expect(preset.id).toBe(lutPresetId(folder));
    }
    expect(new Set(entries.map((e) => e.preset.id)).size).toBe(entries.length);
  });

  it("gives every preset a distinct name", () => {
    expect(new Set(entries.map((e) => e.preset.name)).size).toBe(entries.length);
  });

  it("fills every category, and none of them thinly", () => {
    const counts = new Map<string, number>();
    for (const { preset } of entries) {
      counts.set(preset.category, (counts.get(preset.category) ?? 0) + 1);
    }
    for (const category of LUT_CATEGORIES) {
      expect(counts.get(category) ?? 0, category).toBeGreaterThanOrEqual(
        MINIMUM_PER_CATEGORY,
      );
    }
    // Nothing outside the closed list, which `presetValidate` also enforces —
    // stated again here because a category typo would otherwise show up as a
    // silently missing section of the panel.
    for (const category of counts.keys()) {
      expect(LUT_CATEGORIES).toContain(category as never);
    }
  });
});

describe("the tables themselves", () => {
  it("are all 17³, in range, and 0..1 in domain", () => {
    // Violations are collected and asserted once rather than asserted per
    // value: 80 tables of 14,739 numbers is 1.2M `expect` calls, which took ten
    // seconds and reported the same thing this does in one.
    const outOfRange: string[] = [];
    for (const { preset, lut } of entries) {
      expect(lut.size, preset.id).toBe(BUILTIN_LUT_SIZE);
      expect(lut.domainMin, preset.id).toEqual([0, 0, 0]);
      expect(lut.domainMax, preset.id).toEqual([1, 1, 1]);
      for (let i = 0; i < lut.data.length; i++) {
        const v = lut.data[i];
        if (!(v >= 0 && v <= 1)) {
          outOfRange.push(`${preset.id}[${i}] = ${v}`);
          break;
        }
      }
    }
    expect(outOfRange).toEqual([]);
  });

  it("map black to something dark and white to something bright", () => {
    // A table that inverts, or that sends everything to one value, is a table
    // that went wrong in a way no per-node bound would catch.
    for (const { preset, lut } of entries) {
      if (preset.id === lutPresetId("identity")) {
        continue;
      }
      const black = sampleLut(lut, 0, 0, 0);
      const white = sampleLut(lut, 1, 1, 1);
      const dark = (black.r + black.g + black.b) / 3;
      const bright = (white.r + white.g + white.b) / 3;
      expect(dark, `${preset.id} black`).toBeLessThan(0.45);
      expect(bright, `${preset.id} white`).toBeGreaterThan(0.55);
      expect(bright, `${preset.id} range`).toBeGreaterThan(dark);
    }
  });

  it("never invert along the neutral axis", () => {
    // Monotonicity is what `makeCurve`'s Fritsch–Carlson limiter buys, and an
    // inversion here is the bright ring around highlights that people blame
    // LUTs for. A small tolerance, because a table can legitimately be flat.
    for (const { preset, lut } of entries) {
      let previous = -1;
      for (let i = 0; i <= 64; i++) {
        const v = i / 64;
        const out = sampleLut(lut, v, v, v);
        const level = (out.r + out.g + out.b) / 3;
        expect(level, `${preset.id} at ${v}`).toBeGreaterThan(previous - 1e-4);
        previous = level;
      }
    }
  });

  it("ship exactly one identity, and it is bit-exact", () => {
    const identities = entries.filter((e) => isIdentity(e.lut, 1e-6));
    expect(identities.map((e) => e.preset.id)).toEqual([
      lutPresetId("identity"),
    ]);
  });
});

describe("no two tables grade alike", () => {
  /** Largest per-channel difference between two tables, over every node. */
  function distance(a: Lut3d, b: Lut3d): number {
    let worst = 0;
    for (let i = 0; i < a.data.length; i++) {
      worst = Math.max(worst, Math.abs(a.data[i] - b.data[i]));
    }
    return worst;
  }

  /**
   * Eight 8-bit steps.
   *
   * The LUT equivalent of `fx/catalogue.test.ts`'s "distinct shader pipeline"
   * rule, and the number matters: two tables closer than this are two tiles a
   * user cannot tell apart, which is exactly the way a catalogue gets inflated.
   */
  const MINIMUM_SEPARATION = 8 / 255;

  it("keeps every pair at least eight 8-bit steps apart somewhere", () => {
    const tooClose: string[] = [];
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const a = entries[i];
        const b = entries[j];
        // `log-convert` is exempt *within itself*, and only there. Those six
        // are named after an input format, not after a look: a user picks the
        // one matching the camera, never by eye, and two camera makers whose
        // log curves happen to render alike is a fact about the formats rather
        // than a catalogue that has been padded. They are still held apart
        // from every look preset.
        if (a.preset.category === "log-convert" && b.preset.category === "log-convert") {
          continue;
        }
        const d = distance(a.lut, b.lut);
        if (d < MINIMUM_SEPARATION) {
          tooClose.push(
            `${a.preset.id} ~ ${b.preset.id} (${d.toFixed(4)})`,
          );
        }
      }
    }
    expect(tooClose).toEqual([]);
  });
});

describe("the files match their recipes", () => {
  // What keeps `recipes.ts` and 11 MB of checked-in text from drifting apart.
  // The generator is deterministic by construction — no clock, no randomness —
  // so this can be an exact comparison rather than an approximate one.
  it("regenerate byte for byte", () => {
    for (const recipe of LUT_RECIPES) {
      const generated = generateLut(recipe);
      const dir = path.join(LUT_ROOT, recipe.slug);
      expect(
        fs.readFileSync(path.join(dir, "lut.cube"), "utf8"),
        `${recipe.slug} lut.cube`,
      ).toBe(generated.cube);
      expect(
        fs.readFileSync(path.join(dir, "manifest.json"), "utf8"),
        `${recipe.slug} manifest.json`,
      ).toBe(generated.manifest);
    }
  });

  it("are deterministic across runs", () => {
    for (const recipe of LUT_RECIPES.slice(0, 5)) {
      expect(generateLut(recipe)).toEqual(generateLut(recipe));
    }
  });
});

describe("17 nodes is enough for these recipes", () => {
  /**
   * How faithfully the shipped table reproduces the formula it came from.
   *
   * Two bars rather than one, because the residual has two very different
   * sources and only one of them is a defect:
   *
   *  - **Inherent.** Tetrahedral interpolation reproduces a *separable*
   *    function — a per-channel tone curve — only approximately, where
   *    trilinear would be exact; and gamut clipping puts a crease at 0 and 1
   *    that no grid follows. Both are properties of every 17³ LUT ever
   *    shipped, ours and everyone else's, and a look that leans on saturation
   *    will always sit at the top of this range.
   *  - **A defect.** A recipe with a genuinely steep local feature — a narrow
   *    hue band with a large gain — reconstructs badly enough to contour a
   *    gradient. That is a recipe to soften, and this is how it gets noticed:
   *    every number in the outlier list below was brought down by widening a
   *    band rather than by relaxing the bar.
   *
   * So the *median* is held tight, which catches a change that degrades the
   * catalogue as a whole, and the *maximum* is held loosely enough to leave
   * room for the two or three most extreme looks.
   */
  const MAX_WORST = 8 / 255;
  const MAX_MEDIAN = 2 / 255;

  it("reconstructs every recipe closely, and the typical one almost exactly", () => {
    const worstBy: Array<[string, number]> = [];
    for (const { preset, lut } of entries) {
      const recipe = LUT_RECIPES.find((r) => lutPresetId(r.slug) === preset.id);
      expect(recipe, preset.id).toBeDefined();
      let worst = 0;
      // A deterministic spread, deliberately off the grid: the nodes
      // themselves are exact by construction and would prove nothing.
      for (let i = 0; i < 11; i++) {
        for (let j = 0; j < 11; j++) {
          for (let k = 0; k < 11; k++) {
            const r = (i + 0.5) / 11;
            const g = (j + 0.5) / 11;
            const b = (k + 0.5) / 11;
            const direct = gradeWith(recipe!, [r, g, b]);
            const through = sampleLut(lut, r, g, b);
            worst = Math.max(
              worst,
              Math.abs(direct[0] - through.r),
              Math.abs(direct[1] - through.g),
              Math.abs(direct[2] - through.b),
            );
          }
        }
      }
      worstBy.push([preset.id, worst]);
    }
    const over = worstBy.filter(([, worst]) => worst > MAX_WORST);
    expect(over.map(([id, w]) => `${id}: ${(w * 255).toFixed(2)}/255`)).toEqual(
      [],
    );

    const sorted = worstBy.map(([, w]) => w).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    expect(median * 255).toBeLessThan(MAX_MEDIAN * 255);
  });
});

describe("the node ordering survives the round trip to disk", () => {
  // The single most consequential fact about `.cube`, checked here against the
  // shipped files rather than only against a hand-built fixture: a generator
  // that wrote blue-fastest would produce eighty plausible, wrong tables.
  it("writes red fastest, as the reader expects", () => {
    const entry = entries.find(
      (e) => e.preset.id === lutPresetId("mono-neutral"),
    );
    expect(entry).toBeDefined();
    const lut = entry!.lut;
    const last = lut.size - 1;
    // Mono Neutral sends every colour to its luminance, so the node at full
    // red is 0.2126 grey and the node at full blue is 0.0722 grey — two values
    // that could not be confused if the axes were swapped.
    const red = nodeOffset(lut.size, last, 0, 0);
    const blue = nodeOffset(lut.size, 0, 0, last);
    expect(lut.data[red]).toBeCloseTo(0.2126, 3);
    expect(lut.data[blue]).toBeCloseTo(0.0722, 3);
  });
});
