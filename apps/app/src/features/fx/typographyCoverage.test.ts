/**
 * The typography coverage matrix, as code.
 *
 * Each row is something a text clip cannot do. The HTML graphic layer exists to
 * make all of them possible, and a row is only "covered" when a shipped preset
 * does it: a contract nobody exercises is a contract that quietly stops
 * holding. So every row names the preset that proves it and the mechanism that
 * preset has to contain, and this suite fails when a preset is renamed, removed
 * or rewritten into something that no longer uses the mechanism.
 *
 * Two rows have no preset. Right-to-left text and OpenType features are the
 * browser's layout working as it always does; what this repository can break
 * is the sanitiser or the stylesheet filter removing what they need, so those
 * rows pin that instead.
 *
 * It reads the real folders through the real scanner and validator, as
 * `catalogue.test.ts` does.
 */

import { beforeAll, describe, expect, it } from "vitest";
import path from "path";
import { scanPresetRoot } from "../../../../../electron/lib/presetScan";
import { validatePreset } from "./presetValidate";
import type { FxPreset } from "./presetTypes";
import { sanitizeHtml, type SafeNode } from "../graphic/sanitizeHtml";
import { filterStylesheet } from "../graphic/cssFilter";

const PRESET_ROOT = path.resolve(__dirname, "../../../../../assets/presets");

type Row = {
  row: number;
  /** What a text clip cannot do. */
  need: string;
  /** Preset ids (after `com.cartcut.graphic.`) that prove it. */
  presets: string[];
  /** What each of those presets' sources must contain. */
  mechanism: RegExp[];
};

/** The matrix rows a shipped preset proves. Rows 13, 14 and 19 are below. */
const MATRIX: Row[] = [
  {
    row: 1,
    need: "per-letter motion that loops",
    presets: ["wave"],
    mechanism: [/data-split="chars"/, /var\(--char-index\)/, /\binfinite\b/],
  },
  {
    row: 2,
    need: "an entrance and an exit in one clip",
    presets: ["rise-in-out"],
    mechanism: [/var\(--dur\)/, /@keyframes\s+rise-in/, /@keyframes\s+fall-out/],
  },
  {
    row: 3,
    need: "random order, and from the centre out",
    presets: ["scatter-in"],
    mechanism: [/var\(--rand\)/, /var\(--from-center\)/],
  },
  {
    row: 4,
    need: "3D rotation in perspective",
    presets: ["flip-3d"],
    mechanism: [/perspective/, /rotateX\(/, /preserve-3d/],
  },
  {
    row: 5,
    need: "a colour per letter",
    presets: ["rainbow-type"],
    mechanism: [/hsl\(/, /var\(--char-index\)/],
  },
  {
    row: 6,
    need: "keyframed style fields: tracking, glow",
    presets: ["tracking-breathe"],
    mechanism: [/@keyframes[^}]*\{[^}]*letter-spacing/, /text-shadow/],
  },
  {
    row: 7,
    need: "a moving multi-stop gradient fill",
    presets: ["gradient-sweep"],
    mechanism: [/@property\s+--angle/, /background-clip:\s*text/, /linear-gradient\(/],
  },
  {
    row: 8,
    need: "letters filled with a picture",
    presets: ["image-fill"],
    mechanism: [/background-clip:\s*text/, /var\(--image\)/],
  },
  {
    row: 9,
    need: "more than one outline",
    presets: ["double-outline"],
    mechanism: [/-webkit-text-stroke/, /paint-order/, /<feMorphology/],
  },
  {
    row: 10,
    need: "long shadows and extrusion",
    presets: ["long-shadow", "extrude"],
    mechanism: [/text-shadow:(\s*[^;]*,){10,}/],
  },
  {
    row: 11,
    need: "text on a path",
    presets: ["circle-path"],
    mechanism: [/<textPath/, /startOffset/, /<animate[^>]*attributeName="startOffset"/],
  },
  {
    row: 12,
    need: "vertical writing",
    presets: ["vertical-title"],
    mechanism: [/writing-mode:\s*vertical-rl/, /text-combine-upright/],
  },
  {
    row: 15,
    need: "justification and hyphenation",
    presets: ["lower-third-card"],
    mechanism: [/text-align:\s*justify/, /hyphens:\s*auto/, /lang="/],
  },
  {
    row: 16,
    need: "a highlighter behind the words",
    presets: ["highlighter"],
    mechanism: [/<mark\b/, /box-decoration-break:\s*clone/],
  },
  {
    row: 17,
    need: "ruby and small capitals",
    presets: ["ruby-title"],
    mechanism: [/<rt\b/, /font-variant-caps/],
  },
  {
    row: 18,
    need: "a variable font axis, animated",
    presets: ["weight-wave"],
    mechanism: [/@keyframes[^}]*\{[^}]*font-variation-settings/, /"Noto Sans KR"/],
  },
  {
    row: 20,
    need: "distortion and glitch",
    presets: ["liquid", "glitch"],
    mechanism: [],
  },
  {
    row: 21,
    need: "mask wipes and drawn strokes",
    presets: ["wipe-reveal", "draw-on"],
    mechanism: [],
  },
  {
    row: 22,
    need: "a number that counts",
    presets: ["counter"],
    mechanism: [/syntax:\s*"<integer>"/, /counter\(/, /counter-reset/],
  },
  {
    row: 23,
    need: "layouts with more than one text",
    presets: ["lower-third-card", "quote-card"],
    mechanism: [],
  },
];

/**
 * What each preset of a two-preset row must contain on its own, where the two
 * prove the row by different means.
 */
const PER_PRESET: Record<string, RegExp[]> = {
  liquid: [/<feTurbulence/, /<feDisplacementMap/, /<animate[^>]*attributeName="baseFrequency"/],
  glitch: [/clip-path:\s*inset\(/, /var\(--rand\)/, /steps\(/],
  "wipe-reveal": [/mask-image/, /@property\s+--reveal/],
  "draw-on": [/stroke-dasharray/, /stroke-dashoffset/],
  "quote-card": [/data-split="words lines"/, /var\(--line-index/],
};

let presets = new Map<string, FxPreset>();
let failures: string[] = [];

beforeAll(async () => {
  for (const payload of await scanPresetRoot(PRESET_ROOT, "builtin")) {
    const result = validatePreset(payload);
    if (!result.ok) {
      failures.push(payload.dir + ": " + result.errors.join(" | "));
      continue;
    }
    if (result.preset.kind === "graphic") {
      presets.set(result.preset.id, result.preset);
    }
  }
});

function sourcesOf(preset: FxPreset): string {
  if (preset.render.type !== "html") {
    return "";
  }
  return [preset.render.source, ...(preset.render.styles ?? [])]
    .map((name) => preset.sources[name] ?? "")
    .join("\n");
}

function lookup(name: string): FxPreset {
  const preset = presets.get("com.cartcut.graphic." + name);
  expect(preset, "com.cartcut.graphic." + name + " is not in the shipped catalogue").toBeDefined();
  return preset as FxPreset;
}

function findElement(nodes: SafeNode[], tag: string): (SafeNode & { kind: "element" }) | null {
  for (const node of nodes) {
    if (node.kind !== "element") {
      continue;
    }
    if (node.tag === tag) {
      return node;
    }
    const inner = findElement(node.children, tag);
    if (inner != null) {
      return inner;
    }
  }
  return null;
}

describe("the typography coverage matrix", () => {
  it("is read from a catalogue that loads", () => {
    expect(failures).toEqual([]);
    expect(presets.size).toBeGreaterThan(0);
  });

  it("numbers every row once, and every row from 1 to 23 is accounted for", () => {
    const rows = [...MATRIX.map((r) => r.row), 13, 14, 19].sort((a, b) => a - b);
    expect(rows).toEqual(Array.from({ length: 23 }, (_, i) => i + 1));
  });

  for (const entry of MATRIX) {
    it(`row ${entry.row}: ${entry.need} (${entry.presets.join(", ")})`, () => {
      for (const name of entry.presets) {
        const preset = lookup(name);
        expect(preset.render.type, preset.id).toBe("html");
        const text = sourcesOf(preset);
        for (const pattern of [...entry.mechanism, ...(PER_PRESET[name] ?? [])]) {
          expect(text, preset.id + " lacks " + pattern).toMatch(pattern);
        }
      }
    });
  }

  it("row 8: the image is a parameter the user picks", () => {
    expect(lookup("image-fill").params.some((p) => p.type === "image")).toBe(true);
  });

  it("row 6: tracking is a number parameter, so it keyframes on an fx: track", () => {
    const tracking = lookup("tracking-breathe").params.find((p) => p.key === "tracking");
    expect(tracking?.type).toBe("number");
  });

  it("row 23: the layouts each take more than one text", () => {
    for (const name of ["lower-third-card", "quote-card"]) {
      const texts = lookup(name).params.filter((p) => p.type === "text");
      expect(texts.length, name).toBeGreaterThanOrEqual(2);
    }
  });

  it("row 13: every HTML graphic wraps Korean by eojeol", () => {
    const html = [...presets.values()].filter((p) => p.render.type === "html");
    expect(html.length).toBeGreaterThan(0);
    for (const preset of html) {
      expect(sourcesOf(preset), preset.id).toMatch(/word-break:\s*keep-all/);
    }
  });

  it("row 14 (contract): direction and isolation survive the sanitiser", () => {
    // No preset: right-to-left layout is the browser's, given `dir`. What
    // could break it here is the allowlist dropping `dir`, `<bdi>` or `<bdo>`.
    const { nodes, removed } = sanitizeHtml(
      '<p dir="rtl" data-param="text">مرحبا <bdi>Cartcut</bdi> <bdo dir="ltr">123</bdo></p>',
      { assetNames: new Set() },
    );
    expect(removed).toEqual([]);
    const p = findElement(nodes, "p");
    expect(p?.attrs).toContainEqual(["dir", "rtl"]);
    expect(findElement(nodes, "bdi")).not.toBeNull();
    expect(findElement(nodes, "bdo")?.attrs).toContainEqual(["dir", "ltr"]);
  });

  it("row 19 (contract): OpenType controls survive the stylesheet filter", () => {
    const css = [
      ".a { font-feature-settings: \"liga\" 0, \"ss01\" 1, \"tnum\"; }",
      ".b { font-kerning: none; }",
      ".c { font-variant-ligatures: discretionary-ligatures; }",
      ".d { font-variant-numeric: tabular-nums oldstyle-nums; }",
    ].join("\n");
    const filtered = filterStylesheet(css, { assetNames: new Set() });
    expect(filtered.removed).toEqual([]);
    for (const property of [
      "font-feature-settings",
      "font-kerning",
      "font-variant-ligatures",
      "font-variant-numeric",
    ]) {
      expect(filtered.css, property).toContain(property);
    }
  });
});
