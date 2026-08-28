/**
 * Which of the 18,000 frames get looked at closely.
 *
 * Literal frame numbers would rot the moment anyone edits the scenario, so
 * anchors say *what* to sample and are resolved against the timeline that was
 * actually built. A failure then reads
 *
 *     frame 3601 = clipEdge(main:v03-vp9-540p25, out, +1)
 *
 * rather than "frame 3601", which is the difference between a diagnosis and a
 * starting point.
 *
 * The strata are chosen for where bugs live rather than for even coverage:
 * clip boundaries, transition midpoints (where `planFrame` snaps progress to
 * the frame grid and preview and export could disagree), effect windows (shader
 * effects take the `needsScratch` path, which nothing else does), and the first
 * and last frames of the file.
 */

import type { Profile } from "../harness/paths";
import type { ScenarioResult } from "./kitchenSink";

export type SampleFrame = {
  index: number;
  label: string;
  stratum: string;
};

export type SampleSet = {
  frames: SampleFrame[];
  seed: number;
  strata: Record<string, number>;
};

/**
 * The seeded PRNG from `renderer/testing.ts`.
 *
 * Seeded so a failure is reproducible; `Math.random` would make a random-stratum
 * failure a one-off nobody can chase. The seed is written into the artifact.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DEFAULT_SEED = 0x5ca1ab1e;

export function chooseSampleFrames(input: {
  profile: Profile;
  scenario: ScenarioResult;
  totalFrames: number;
  seed?: number;
  randomCount?: number;
}): SampleSet {
  const { profile, scenario, totalFrames } = input;
  const seed = input.seed ?? DEFAULT_SEED;
  const toFrame = (timeMs: number) =>
    Math.max(0, Math.min(totalFrames - 1, Math.round((timeMs / 1000) * profile.fps)));

  const picked = new Map<number, SampleFrame>();
  const add = (index: number, label: string, stratum: string) => {
    if (index < 0 || index >= totalFrames) return;
    if (picked.has(index)) return;
    picked.set(index, { index, label, stratum });
  };

  // The boundaries. Off-by-one lives at the ends more than anywhere else.
  add(0, "absolute(first)", "boundary");
  add(1, "absolute(first+1)", "boundary");
  add(totalFrames - 2, "absolute(last-1)", "boundary");
  add(totalFrames - 1, "absolute(last)", "boundary");

  // Clip edges, one frame either side.
  const mainClips = scenario.placed.filter((c) => c.role.startsWith("main:"));
  for (const clip of mainClips) {
    for (const [edge, timeMs] of [["in", clip.startMs], ["out", clip.endMs]] as const) {
      const base = toFrame(timeMs);
      for (const offset of [-1, 0, 1]) {
        add(base + offset, `clipEdge(${clip.role}, ${edge}, ${offset >= 0 ? "+" : ""}${offset})`, "clipEdge");
      }
    }
  }

  // Transitions: first, middle and last frame of the window. The midpoint is
  // where `progressOf` is snapped to the frame grid, which is the one place
  // preview and export are supposed to agree by construction.
  for (const clip of scenario.placed.filter((c) => c.role === "transition")) {
    const start = toFrame(clip.startMs);
    const end = toFrame(clip.endMs);
    add(start, `transition(${clip.id.slice(0, 8)}, start)`, "transition");
    add(Math.round((start + end) / 2), `transition(${clip.id.slice(0, 8)}, mid)`, "transition");
    add(Math.max(start, end - 1), `transition(${clip.id.slice(0, 8)}, end)`, "transition");
  }

  // Effects: a shader effect composites into a scratch canvas at project
  // resolution — a code path nothing else in the document takes.
  for (const clip of scenario.placed.filter((c) => c.role === "effect")) {
    const start = toFrame(clip.startMs);
    const end = toFrame(clip.endMs);
    add(start, `effect(${clip.id.slice(0, 8)}, start)`, "effect");
    add(Math.round(start + (end - start) * 0.4), `effect(${clip.id.slice(0, 8)}, interior)`, "effect");
  }

  // Animated and overlay elements, where the keyframe interpolation shows.
  for (const role of ["anim:keyframed", "anim:fade_in", "overlay:gif", "overlay:alphaImage", "group", "carrier:animation"]) {
    for (const clip of scenario.placed.filter((c) => c.role === role)) {
      const start = toFrame(clip.startMs);
      const end = toFrame(clip.endMs);
      add(start + 1, `${role}(start+1)`, "animation");
      if (end > start + 2) add(Math.round((start + end) / 2), `${role}(mid)`, "animation");
    }
  }

  // GOP boundaries, so a keyframe-adjacent decode difference is distinguishable
  // from a real mismatch rather than being mistaken for one.
  const gop = 250;
  for (const nth of [1, 2, 3]) {
    const base = nth * gop * 4;
    for (const offset of [-1, 0, 1]) {
      add(base + offset, `gop(${nth}, ${offset >= 0 ? "+" : ""}${offset})`, "gop");
    }
  }

  // A/V sync anchors: the fixture puts a click and a flash on the same frames.
  for (let second = 2; second < profile.durationSec; second += Math.max(2, Math.floor(profile.durationSec / 4))) {
    add(toFrame(second * 1000), `sync(${second}s)`, "sync");
  }

  // A seeded spread over everything else, so the sampler is not blind to the
  // stretches no anchor happens to name.
  const random = mulberry32(seed);
  const randomCount = input.randomCount ?? 20;
  for (let i = 0; i < randomCount * 4 && [...picked.values()].filter((f) => f.stratum === "random").length < randomCount; i++) {
    const index = Math.floor(random() * totalFrames);
    add(index, `random(${index})`, "random");
  }

  const frames = [...picked.values()].sort((a, b) => a.index - b.index);
  const strata: Record<string, number> = {};
  for (const frame of frames) strata[frame.stratum] = (strata[frame.stratum] ?? 0) + 1;

  return { frames, seed, strata };
}
