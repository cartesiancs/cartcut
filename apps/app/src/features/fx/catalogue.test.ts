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
import path from "path";
import { createHash } from "crypto";
import { scanPresetRoot } from "../../../../../electron/lib/presetScan";
import { validatePreset } from "./presetValidate";
import { categoriesFor, type FxPreset } from "./presetTypes";

const PRESET_ROOT = path.resolve(__dirname, "../../../../../assets/presets");

/** The floor the catalogue was built to. Below it the panel is a demo. */
const MINIMUM_PER_KIND = 30;

type Entry = {
  preset: FxPreset;
  /** The folder the preset lives in, which is what "mechanism" means here. */
  mechanism: string;
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
    for (const { preset, mechanism } of entries) {
      const prefix = preset.kind === "lut" ? "com.cartcut.lut." : "com.cartcut.";
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

  it("keeps every category non-empty and worth its own heading", () => {
    // A category holding one preset is a heading with a single tile under it,
    // which is worse for scanning than no heading at all.
    const counts = new Map<string, number>();
    for (const { preset } of entries) {
      const key = preset.kind + "/" + preset.category;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    for (const kind of ["effect", "transition", "lut"] as const) {
      for (const category of categoriesFor(kind)) {
        const count = counts.get(kind + "/" + category) ?? 0;
        expect(count, kind + "/" + category).toBeGreaterThanOrEqual(3);
      }
    }
  });
});
