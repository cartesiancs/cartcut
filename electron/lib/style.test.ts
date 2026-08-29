/**
 * The shipped style profiles, checked against reality.
 *
 * Read off disk rather than imported, because these are data files a person
 * edits by hand — the interesting failure is a typo in JSON, and a test that
 * imported a TypeScript constant would not see one.
 *
 * `lib/style.ts` itself is not imported: it reaches `electron` and
 * `electron-is-dev` at load. What is under test here is the *content* of the
 * files and the validator, which is pure.
 */

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { validateStyle, type StyleProfile } from "../mcp/analysis/style";

const STYLE_DIR = path.join(__dirname, "..", "..", "assets", "styles");
const PRESET_DIR = path.join(__dirname, "..", "..", "assets", "presets");

function shippedStyles(): Array<{ file: string; raw: unknown }> {
  return fs
    .readdirSync(STYLE_DIR)
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => ({
      file: entry,
      raw: JSON.parse(fs.readFileSync(path.join(STYLE_DIR, entry), "utf8")),
    }));
}

/**
 * Every preset id the app actually ships, read from the manifests.
 *
 * `assets/presets/<kind>/<name>/manifest.json` — the kind is a directory, which
 * is why this walks two levels rather than one.
 */
function shippedPresetIds(): Set<string> {
  const ids = new Set<string>();
  for (const kind of fs.readdirSync(PRESET_DIR)) {
    const kindDir = path.join(PRESET_DIR, kind);
    if (!fs.statSync(kindDir).isDirectory()) {
      continue;
    }
    for (const entry of fs.readdirSync(kindDir)) {
      const manifest = path.join(kindDir, entry, "manifest.json");
      if (!fs.existsSync(manifest)) {
        continue;
      }
      try {
        const parsed = JSON.parse(fs.readFileSync(manifest, "utf8"));
        if (typeof parsed?.id === "string") {
          ids.add(parsed.id);
        }
      } catch {
        // A preset with an unreadable manifest is that suite's problem, not
        // this one's — it simply is not available to be referenced.
      }
    }
  }
  return ids;
}

describe("the shipped style profiles", () => {
  const styles = shippedStyles();

  it("ships more than one, or there is no choice to make", () => {
    expect(styles.length).toBeGreaterThan(1);
  });

  it("every one validates", () => {
    for (const { file, raw } of styles) {
      const result = validateStyle(raw);
      expect(result.errors, `${file}: ${result.errors.join("; ")}`).toEqual([]);
    }
  });

  it("uses its filename as its id, so a directory reads as a list of styles", () => {
    for (const { file, raw } of styles) {
      expect((raw as StyleProfile).id).toBe(file.replace(/\.json$/, ""));
    }
  });

  it("gives every id exactly once", () => {
    const ids = styles.map((s) => (s.raw as StyleProfile).id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("names only presets the app actually ships", () => {
    // The failure this prevents: a profile that reaches for a transition by an
    // id nobody has, which fails at the moment an edit is being applied rather
    // than when the profile was written.
    const available = shippedPresetIds();
    expect(available.size).toBeGreaterThan(50);

    for (const { file, raw } of styles) {
      const profile = raw as StyleProfile;
      for (const id of [
        ...profile.transitions.allowed,
        ...profile.effects.allowed,
      ]) {
        expect(available.has(id), `${file} names a missing preset: ${id}`).toBe(
          true,
        );
      }
    }
  });

  it("keeps a style that reaches for transitions supplied with some", () => {
    for (const { file, raw } of styles) {
      const profile = raw as StyleProfile;
      if (profile.transitions.perMinute > 0) {
        expect(
          profile.transitions.allowed.length,
          `${file} wants transitions but allows none`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it("keeps at least one profile eligible for anything", () => {
    // Without a profile that declares no `fit`, material that matches nothing
    // would get no style at all.
    const general = styles.filter(
      (s) => (s.raw as StyleProfile).fit == null,
    );
    expect(general.length).toBeGreaterThan(0);
  });

  it("describes each one well enough to choose between them", () => {
    for (const { file, raw } of styles) {
      const profile = raw as StyleProfile;
      expect(profile.description.length, file).toBeGreaterThan(60);
    }
  });

  it("spans a real range of pace, or the choice is cosmetic", () => {
    const punches = styles.map(
      (s) => (s.raw as StyleProfile).motion.punchesPerMinute,
    );
    expect(Math.max(...punches)).toBeGreaterThan(Math.min(...punches) * 5);
  });
});
