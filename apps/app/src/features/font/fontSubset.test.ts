/**
 * The real `hb-subset` wasm, run in node, checked against Skia drawing the
 * full and the subset face (`@napi-rs/canvas`), which shares no code with the
 * subsetter. CFF faces are compared pixel for pixel. TrueType faces are
 * compared by advance width: Skia draws a subset TrueType glyph's edges
 * slightly differently from the full face's even where all three browsers draw
 * them identically (`tests/e2e/FINDINGS.md` section 11), so pixels would test
 * Skia, not the subset.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import { embedPlan, harvestCodepoints, sfntTables } from "./fontPlan";
import { subsetterFrom, type SubsetExports } from "./fontSubset";

const ROOT = join(__dirname, "../../../../..");
const wasm = readFileSync(join(ROOT, "node_modules/harfbuzzjs/dist/harfbuzz-subset.wasm"));
const subset = subsetterFrom(
  new WebAssembly.Instance(new WebAssembly.Module(wasm), {}).exports as unknown as SubsetExports,
);

const TEXT = "AVATAR To office 0123, 안녕하세요 그래픽!";
const codepoints = harvestCodepoints([TEXT], "ko");
let family = 0;

function register(bytes: Uint8Array): string {
  const name = `subset-test-${family++}`;
  GlobalFonts.register(Buffer.from(bytes), name);
  return name;
}

function drawn(name: string, text: string) {
  const canvas = createCanvas(1600, 120);
  const ctx = canvas.getContext("2d");
  ctx.font = `64px "${name}"`;
  ctx.fillText(text, 4, 90);
  return { pixels: ctx.getImageData(0, 0, 1600, 120).data, width: ctx.measureText(text).width };
}

function differing(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  let n = 0;
  for (let i = 3; i < a.length; i += 4) if (a[i] !== b[i]) n++;
  return n;
}

const read = (rel: string) => new Uint8Array(readFileSync(join(ROOT, rel)));

describe("hb-subset", () => {
  for (const rel of ["assets/fonts/notosanskr-medium.otf", "assets/fonts/Pretendard-Medium.otf"]) {
    it(`cuts ${rel} to a fraction and draws the same pixels`, () => {
      const full = read(rel);
      const plan = embedPlan(full);
      expect(plan.kind).toBe("subset");
      const cut = subset(full, codepoints, { retainGids: plan.kind === "subset" && plan.retainGids })!;
      expect(cut).not.toBeNull();
      expect(cut.length).toBeLessThan(full.length / 20);
      expect(sfntTables(cut)).toContain("CFF ");
      const a = drawn(register(full), TEXT);
      const b = drawn(register(cut), TEXT);
      expect(differing(a.pixels, b.pixels)).toBe(0);
      expect(b.width).toBe(a.width);
    });
  }

  it("proves the harness: a subset missing a glyph draws differently", () => {
    const full = read("assets/fonts/notosanskr-medium.otf");
    const cut = subset(full, codepoints.filter((cp) => cp !== 0x41), { retainGids: false })!;
    expect(differing(drawn(register(full), TEXT).pixels, drawn(register(cut), TEXT).pixels)).toBeGreaterThan(1000);
  });

  it("proves the harness: a legacy kern table subset without its glyph ids lays out wrong", () => {
    const full = read("assets/fonts/google/PermanentMarker-Regular.ttf");
    const text = "AVATAR To office, Wave yA. Ty LT";
    const cut = subset(full, harvestCodepoints([text], "en"), { retainGids: false })!;
    expect(Math.abs(drawn(register(cut), text).width - drawn(register(full), text).width)).toBeGreaterThan(5);
  });

  for (const rel of ["assets/fonts/google/Lobster-Regular.ttf", "assets/fonts/google/Righteous-Regular.ttf", "assets/fonts/google/PermanentMarker-Regular.ttf"]) {
    it(`keeps ${rel}'s advances when the plan's glyph-id rule is followed`, () => {
      const full = read(rel);
      const latin = harvestCodepoints(["AVATAR To office, Wave yA. Ty LT"], "en");
      const retainGids = (sfntTables(full) ?? []).includes("kern");
      const cut = subset(full, latin, { retainGids })!;
      const text = "AVATAR To office, Wave yA. Ty LT";
      expect(drawn(register(cut), text).width).toBeCloseTo(drawn(register(full), text).width, 2);
    });
  }
});
