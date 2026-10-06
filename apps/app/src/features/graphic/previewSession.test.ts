/**
 * The preview's raster loop under load: a seeded simulation of the editor
 * drawing frame after frame while the user plays, seeks, scrubs, edits, moves
 * and deletes clips, exports, and the window stops painting for a while.
 *
 * Everything real except the DOM: the session, the planner (lookahead and
 * template ids included), `prepareGraphics` and the queue run as they do in the
 * app, against a fake host whose paint lands a random number of frames after it
 * is asked for, as Chromium's does. Each raster the fake hands back is the
 * mount's own mutable object, redrawn in place, as the real host's canvas is.
 *
 * Two properties are checked:
 *
 *  - **every frame of playback draws every visible graphic near its own time**,
 *    including the first frame of each clip, which is where the preview used
 *    to draw nothing or the end of the previous pass;
 *  - **after anything at all, the preview settles on exactly the right
 *    rasters**: current keys, the right moment, the right words, and no mount
 *    left for a clip that is gone.
 *
 * And each property is shown to be measured: switching off the fix it relies
 * on (lookahead, template ids in the sweep, the replay after an export,
 * rasterising nothing from a paint that never came and the retry after it,
 * releasing only between prepares) makes the same simulation fail.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GraphicElementType, TemplateElementType, Timeline } from "../../@types/timeline";
import { createGraphicElement } from "../element/graphicElement";
import { coerceInlineProgram, toRawPayload } from "../fx/inlineProgram";
import type { FxPreset } from "../fx/presetTypes";
import { validatePreset } from "../fx/presetValidate";
import { installTemplateResolver, templateCompositionAt } from "../renderer/template";
import type { TimelineRenderers } from "../renderer/timeline";
import type { TemplateData } from "../template/compose";
import { slotsOf } from "../template/slots";
import { createTemplateElement } from "../timeline/templateOps";
import {
  beginExportGraphics,
  endExportGraphics,
  previewMayPrepare,
  serialize,
  whenPreviewMayPrepare,
} from "./graphicQueue";
import type { ApplyState, HtmlRasterPort, MountSpec } from "./htmlRasterPort";
import { graphicInstanceIds, planGraphics, planLookahead, type PlanInput } from "./planGraphics";
import { prepareGraphics } from "./prepare";
import { PreviewRasters } from "./previewRasters";
import { PreviewRasterSession } from "./previewSession";

// ---------------------------------------------------------------- programs

function program(css: string) {
  const result = coerceInlineProgram({
    kind: "graphic",
    name: "P",
    render: { type: "html", html: '<h1 data-param="title"></h1>', css },
    params: [{ key: "title", label: "T", type: "text", default: "Hi" }],
  });
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  const validated = validatePreset(toRawPayload(result.program));
  if (!validated.ok) throw new Error(validated.errors.join("\n"));
  return { program: result.program, preset: validated.preset };
}

const ANIMATED = program("h1 { animation: rise 1s both; } @keyframes rise { from { opacity: 0 } }");
const STILL = program("h1 { color: red; }");
const PRESETS = new Map<string, FxPreset>([
  [ANIMATED.program.hash, ANIMATED.preset],
  [STILL.program.hash, STILL.preset],
]);

const FPS = 30;
const DISPLAY_MS = 1000 / 60;
const END_MS = 6400;

function graphic(
  which: typeof ANIMATED,
  startTime: number,
  duration: number,
  over: Partial<GraphicElementType> = {},
): GraphicElementType {
  return {
    ...createGraphicElement({
      program: which.program,
      params: { title: "t" + startTime },
      name: "g",
      startTime,
      duration,
      width: 400,
      height: 200,
    }),
    trackId: "t",
    priority: 1,
    ...over,
  };
}

const TEMPLATE: TemplateData = (() => {
  const inner: GraphicElementType = { ...graphic(ANIMATED, 0, 2000), key: "inner" } as GraphicElementType;
  const elements = { inner } as Timeline;
  return { id: "tpl-data", name: "T", size: { w: 400, h: 200 }, durationMs: 2000, elements, slots: slotsOf(elements) };
})();

function template(startTime: number): TemplateElementType {
  return {
    ...createTemplateElement({
      templateId: TEMPLATE.id,
      name: "T",
      durationMs: 2000,
      size: { w: 400, h: 200 },
      frame: { w: 400, h: 200 },
    }),
    key: "tpl",
    startTime,
    trackId: "t2",
    priority: 2,
  } as TemplateElementType;
}

/** Adjacent clips, a split pair, a static one across several, and a template. */
function initialElements(): Timeline {
  return {
    a: graphic(ANIMATED, 500, 800),
    b: graphic(ANIMATED, 1300, 700),
    left: graphic(ANIMATED, 2200, 600, { clockTail: 600 } as any),
    right: graphic(ANIMATED, 2800, 600, { clockHead: 600 } as any),
    still: graphic(STILL, 1000, 2000),
    tpl: template(3600),
    d: graphic(ANIMATED, 5600, 700),
  } as Timeline;
}

function planInput(elements: Timeline, cursor: number, scaleOf: (id: string) => number = () => 1): PlanInput {
  return {
    elements,
    timeInMs: cursor,
    fps: FPS,
    presetOf: (element) => PRESETS.get(element.program?.hash ?? "") ?? null,
    expandTemplate: templateCompositionAt,
    scaleOf,
    resolvers: { fontFamilyOf: () => "x", imageUrlOf: () => null },
    fontGeneration: 0,
  };
}

// ---------------------------------------------------------------- fake host

type Raster = { id: string; tMs: number | null; title: string | null };
type Painted = { tMs: number; title: string | null };

const SPEC: MountSpec = {
  programKey: "p",
  nodes: [],
  css: "",
  propertyRules: "",
  renames: {},
  assetUrls: {},
  programHash: "h",
};

/**
 * A host whose paint arrives `latency()` frames after `settle`, or never while
 * `paintOk()` is false (then rasterising draws the last paint it had, as
 * Chromium's cached paint record does). Counts a mount released while a
 * prepare still had to rasterise it.
 */
class FakeHost implements HtmlRasterPort {
  readonly mounts = new Map<string, { applied: Painted | null; painted: Painted | null; raster: Raster }>();
  private touched = new Set<string>();
  private inFlight = new Set<string>();
  private queue: Array<{ due: number; finish: () => void }> = [];
  private frame = 0;
  midPrepareReleases = 0;
  paintOk = () => true;

  constructor(
    private readonly latency: () => number,
    private readonly lies = false,
  ) {}

  get waiting(): number {
    return this.queue.length;
  }

  supported(): boolean {
    return true;
  }

  mount(id: string): void {
    if (!this.mounts.has(id)) {
      this.mounts.set(id, { applied: null, painted: null, raster: { id, tMs: null, title: null } });
    }
  }

  apply(id: string, state: ApplyState): void {
    const mount = this.mounts.get(id);
    if (mount == null) return;
    mount.applied = { tMs: state.timeMs, title: state.texts.title ?? null };
    this.touched.add(id);
    this.inFlight.add(id);
  }

  settle(): Promise<boolean> {
    const touched = [...this.touched];
    this.touched.clear();
    return new Promise((resolve) => {
      this.queue.push({
        due: this.frame + this.latency(),
        finish: () => {
          const ok = this.paintOk();
          if (ok) {
            for (const id of touched) {
              const mount = this.mounts.get(id);
              if (mount != null) mount.painted = mount.applied;
            }
          } else if (!this.lies) {
            // The prepare ends here with nothing rasterised.
            for (const id of touched) this.inFlight.delete(id);
          }
          resolve((ok || this.lies) && touched.every((id) => this.mounts.has(id)));
        },
      });
    });
  }

  rasterize(id: string): CanvasImageSource | null {
    this.inFlight.delete(id);
    const mount = this.mounts.get(id);
    if (mount == null || mount.painted == null) return null;
    mount.raster.tMs = mount.painted.tMs;
    mount.raster.title = mount.painted.title;
    return mount.raster as unknown as CanvasImageSource;
  }

  release(live: ReadonlySet<string>): void {
    for (const id of [...this.mounts.keys()]) {
      if (!live.has(id)) {
        if (this.inFlight.has(id)) this.midPrepareReleases += 1;
        this.inFlight.delete(id);
        this.mounts.delete(id);
      }
    }
  }

  unmount(id: string): void {
    this.mounts.delete(id);
  }

  /** One display frame: every paint that is due lands. */
  tick(): void {
    this.frame += 1;
    const due = this.queue.filter((p) => p.due <= this.frame);
    this.queue = this.queue.filter((p) => p.due > this.frame);
    for (const p of due) p.finish();
  }
}

// ---------------------------------------------------------------- simulation

function mulberry32(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)) };
}

const flush = async () => {
  for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
};

type Failure = { frame: number; kind: string; id: string; cursor: number; want?: number; drew?: number | null };

type SimOptions = {
  seed: number;
  frames: number;
  /** Display frames a paint may take to arrive. */
  latencyMax?: number;
  /** How far a drawn raster may trail the cursor during playback, ms. */
  tolMs?: number;
  // Each switched off to show the property it guards is really measured.
  lookahead?: boolean;
  lookaheadWhilePaused?: boolean;
  sweepTemplates?: boolean;
  replayAfterHold?: boolean;
  /** A host that answers "painted" when its paint never came, as one that skipped the check would. */
  hostLiesAboutPaint?: boolean;
  releaseOnlyBetweenPrepares?: boolean;
  /** Scales every random event's rate. */
  churn?: number;
};

type SimResult = {
  frames: number;
  playbackChecks: number;
  entryChecks: number;
  playback: Failure[];
  settled: Failure[];
  settles: number;
  midPrepareReleases: number;
  /** Whether the loop went idle at the end, nothing left waiting on a paint. */
  idle: boolean;
};

const GRACE_FRAMES = 12;

async function simulate(options: SimOptions): Promise<SimResult> {
  const o = {
    latencyMax: 2,
    tolMs: 150,
    lookahead: true,
    lookaheadWhilePaused: true,
    sweepTemplates: true,
    replayAfterHold: true,
    hostLiesAboutPaint: false,
    releaseOnlyBetweenPrepares: true,
    churn: 1,
    ...options,
  };
  const R = mulberry32(o.seed);
  const host = new FakeHost(() => R.int(0, o.latencyMax), o.hostLiesAboutPaint);
  const rasters = new PreviewRasters();
  let frame = 0;
  let failUntil = -1;
  host.paintOk = () => frame > failUntil;

  const session = new PreviewRasterSession(
    {
      plan: (request, scaleOf) => {
        const input = planInput(request.elements, request.cursor, scaleOf);
        const current = planGraphics(input);
        const looking = o.lookahead && (request.playing || o.lookaheadWhilePaused);
        return { current, ahead: looking ? planLookahead(input, current) : [] };
      },
      prepare: (jobs, sink) =>
        serialize(() =>
          prepareGraphics({ port: host, mountOf: () => ({ spec: SPEC, removed: [] }) as any, fontsOf: () => [] }, jobs, sink),
        ),
      mayPrepare: previewMayPrepare,
      whenMayPrepare: o.replayAfterHold ? whenPreviewMayPrepare : () => undefined,
      releaseMounts: (live) => host.release(live),
      warn: (message, error) => {
        throw new Error(message + " " + String(error));
      },
    },
    rasters,
  );

  let elements = initialElements();
  const removed: Array<[string, Timeline[string]]> = [];
  let cursor = 0;
  let playing = false;
  let graceUntil = 0;
  let holdUntil = -1;
  let playAt = -1;
  let wantDraw = true;
  let previous = new Set<string>();
  const result: SimResult = {
    frames: 0,
    playbackChecks: 0,
    entryChecks: 0,
    playback: [],
    settled: [],
    settles: 0,
    midPrepareReleases: 0,
    idle: false,
  };

  const live = () =>
    o.sweepTemplates
      ? graphicInstanceIds(elements, templateCompositionAt)
      : new Set(Object.keys(elements).filter((id) => elements[id]?.filetype === "graphic"));

  const draw = () => {
    session.request({ elements, cursor, fps: FPS, playing }, () => {
      wantDraw = true;
    });
    if (o.releaseOnlyBetweenPrepares) {
      session.retain(live());
    } else {
      rasters.retain(live());
      host.release(live());
    }
    // What the composite draws: every visible graphic's latest raster.
    const jobs = planGraphics(planInput(elements, cursor));
    const judging = playing && frame >= graceUntil && frame > holdUntil && frame > failUntil;
    for (const job of jobs) {
      if (!judging) continue;
      const entering = !previous.has(job.instanceId);
      result.playbackChecks += 1;
      if (entering) result.entryChecks += 1;
      const raster = rasters.latest(job.instanceId) as unknown as Raster | null;
      const base = { frame, id: job.instanceId, cursor: Math.round(cursor) };
      if (raster == null) {
        result.playback.push({ ...base, kind: entering ? "missing-at-entry" : "missing" });
      } else if (!job.static && (raster.tMs == null || Math.abs(raster.tMs - job.time.tMs) > o.tolMs)) {
        result.playback.push({ ...base, kind: entering ? "wrong-time-at-entry" : "wrong-time", want: job.time.tMs, drew: raster.tMs });
      } else if (raster.title !== job.texts.title) {
        result.playback.push({ ...base, kind: "wrong-text" });
      }
    }
    previous = new Set(jobs.map((job) => job.instanceId));
  };

  const endHold = () => {
    if (holdUntil >= 0) {
      holdUntil = -1;
      endExportGraphics();
    }
  };

  // Stop everything, let the loop go quiet with no help from extra draws, then
  // require exactly the right rasters.
  const settle = async () => {
    result.settles += 1;
    playing = false;
    playAt = -1;
    endHold();
    failUntil = -1;
    for (let i = 0; i < 60; i++) {
      frame += 1;
      host.tick();
      await flush();
      if (wantDraw) {
        wantDraw = false;
        draw();
        await flush();
      }
      if (!session.preparing && host.waiting === 0 && !wantDraw) break;
    }
    const jobs = planGraphics(planInput(elements, cursor, (id) => rasters.scaleOf(id)));
    for (const job of jobs) {
      const raster = rasters.latest(job.instanceId) as unknown as Raster | null;
      const base = { frame, id: job.instanceId, cursor: Math.round(cursor) };
      if (raster == null) {
        result.settled.push({ ...base, kind: "missing" });
      } else if (rasters.keyOf(job.instanceId) !== job.key) {
        result.settled.push({ ...base, kind: "not-current" });
      } else if (!job.static && raster.tMs !== job.time.tMs) {
        result.settled.push({ ...base, kind: "wrong-time", want: job.time.tMs, drew: raster.tMs });
      } else if (raster.title !== job.texts.title) {
        result.settled.push({ ...base, kind: "wrong-text" });
      }
    }
    // The next repaint sweeps; after it no mount may be left for a clip that is gone.
    draw();
    await flush();
    const alive = live();
    for (const id of host.mounts.keys()) {
      if (!alive.has(id) && !session.preparing) {
        result.settled.push({ frame, id, cursor: Math.round(cursor), kind: "leaked-mount" });
      }
    }
  };

  const pickGraphic = () => {
    const ids = Object.keys(elements).filter((id) => elements[id]?.filetype === "graphic");
    return ids.length ? ids[R.int(0, ids.length - 1)] : null;
  };
  const disrupt = () => {
    graceUntil = frame + GRACE_FRAMES;
  };
  const chance = (p: number) => R.next() < p * o.churn;

  try {
    for (; frame < o.frames; ) {
      frame += 1;
      result.frames += 1;
      host.tick();
      await flush();
      let changed = false;

      // Playing and pausing are not churn: they are what the playback check
      // needs. Play is pressed a few frames after the playhead is parked, half
      // the time just before a clip, and is judged from its first frame.
      if (!playing && playAt < 0 && R.next() < 0.05) {
        const starts = Object.values(elements).map((e) => e!.startTime);
        cursor =
          R.next() < 0.5 && starts.length > 0
            ? Math.max(0, starts[R.int(0, starts.length - 1)] - R.int(0, 3) * DISPLAY_MS - R.int(0, 5))
            : R.int(0, END_MS - 600);
        playAt = frame + R.int(4, 20);
        changed = true;
      } else if (playing && R.next() < 0.003) {
        playing = false;
      } else if (chance(0.006)) {
        cursor = R.int(0, END_MS);
        disrupt();
        changed = true;
      } else if (chance(0.004)) {
        const id = pickGraphic();
        if (id != null) {
          const el = elements[id] as GraphicElementType;
          elements = { ...elements, [id]: { ...el, params: { ...el.params, title: "e" + frame } } };
          disrupt();
          changed = true;
        }
      } else if (chance(0.003)) {
        const id = pickGraphic();
        if (id != null) {
          const el = elements[id]!;
          elements = { ...elements, [id]: { ...el, startTime: Math.max(0, el.startTime + R.int(-400, 400)) } };
          disrupt();
          changed = true;
        }
      } else if (chance(0.003)) {
        const ids = Object.keys(elements);
        if (ids.length > 3) {
          const id = ids[R.int(0, ids.length - 1)];
          removed.push([id, elements[id]]);
          const { [id]: _gone, ...rest } = elements;
          elements = rest as Timeline;
          disrupt();
          changed = true;
        }
      } else if (removed.length > 0 && chance(0.003)) {
        const [id, el] = removed.splice(R.int(0, removed.length - 1), 1)[0];
        elements = { ...elements, [id]: el };
        disrupt();
        changed = true;
      } else if (holdUntil < 0 && chance(0.004)) {
        beginExportGraphics();
        holdUntil = frame + R.int(5, 40);
      } else if (failUntil < frame && chance(0.003)) {
        failUntil = frame + R.int(3, 30);
      }

      if (playAt >= 0 && frame >= playAt) {
        playAt = -1;
        playing = true;
      }
      if (holdUntil >= 0 && frame >= holdUntil) {
        endHold();
        disrupt();
      }
      if (failUntil === frame) {
        disrupt();
      }

      // Every cursor change repaints, as the store's subscription does.
      const moved = playing;
      if (playing) {
        cursor += DISPLAY_MS;
        if (cursor >= END_MS) {
          playing = false;
        }
      }
      if (moved || changed || wantDraw) {
        wantDraw = false;
        draw();
        await flush();
      }
      if (chance(0.006)) {
        await settle();
      }
    }
    await settle();
  } finally {
    endHold();
    // Leave nothing waiting on a paint: the queue is shared with the next run.
    for (let i = 0; i < 60 && (session.preparing || host.waiting > 0); i++) {
      frame += 1;
      host.tick();
      await flush();
    }
  }
  result.idle = !session.preparing && host.waiting === 0;
  result.midPrepareReleases = host.midPrepareReleases;
  return result;
}

const table = {} as unknown as TimelineRenderers;

beforeEach(() => {
  installTemplateResolver((id) => (id === TEMPLATE.id ? TEMPLATE : null), table);
});

afterEach(() => {
  installTemplateResolver(() => null, table);
  expect(previewMayPrepare()).toBe(true);
});

const SEEDS = Array.from({ length: Number(process.env.GRAPHIC_SOAK_SEEDS ?? 6) }, (_, i) => 101 + i * 7919);
const FRAMES = Number(process.env.GRAPHIC_SOAK_FRAMES ?? 4000);

describe("the preview's raster loop, under a seeded stress simulation", () => {
  it.each(SEEDS)("draws every visible graphic near its time on every frame of playback, seed %i", async (seed) => {
    const result = await simulate({ seed, frames: FRAMES, churn: 0.3 });
    expect(result.entryChecks).toBeGreaterThan(25);
    expect(result.playback.slice(0, 5)).toEqual([]);
    expect(result.idle).toBe(true);
  });

  it.each(SEEDS)("settles on exactly the right rasters after anything, seed %i", async (seed) => {
    const result = await simulate({ seed, frames: FRAMES, churn: 3 });
    expect(result.settles).toBeGreaterThan(5);
    expect(result.settled.slice(0, 5)).toEqual([]);
    expect(result.midPrepareReleases).toBe(0);
    expect(result.idle).toBe(true);
  });

  it("holds up when every paint takes as long as the loop allows", async () => {
    const result = await simulate({ seed: 7, frames: FRAMES, latencyMax: 4, tolMs: 250, churn: 2 });
    expect(result.playback.slice(0, 5)).toEqual([]);
    expect(result.settled.slice(0, 5)).toEqual([]);
  });
});

describe("the simulation measures what it claims", () => {
  // Each of these switches one fix off and requires the same seeds to fail.
  const failing = async (over: Partial<SimOptions>, pick: (r: SimResult) => Failure[]) => {
    let count = 0;
    for (const seed of SEEDS.slice(0, 3)) {
      const result = await simulate({ seed, frames: FRAMES, churn: 3, ...over });
      expect(result.idle).toBe(true);
      count += pick(result).length;
    }
    return count;
  };

  it("fails at clip entries without the lookahead", async () => {
    const result = await simulate({ seed: SEEDS[0], frames: FRAMES, lookahead: false });
    expect(result.idle).toBe(true);
    expect(result.playback.filter((f) => f.kind.endsWith("at-entry")).length).toBeGreaterThan(0);
  });

  it("fails at entries just after play is pressed without the lookahead while paused", async () => {
    let count = 0;
    for (const seed of SEEDS.slice(0, 6)) {
      const result = await simulate({ seed, frames: FRAMES, churn: 0.3, lookaheadWhilePaused: false });
      expect(result.idle).toBe(true);
      count += result.playback.filter((f) => f.kind.endsWith("at-entry")).length;
      if (count > 0) break;
    }
    expect(count).toBeGreaterThan(0);
  }, 60_000);

  it("loses the template's graphic when the sweep sees top-level ids only", async () => {
    const result = await simulate({ seed: SEEDS[0], frames: FRAMES, sweepTemplates: false });
    expect(result.idle).toBe(true);
    expect(result.playback.some((f) => f.id.includes("::"))).toBe(true);
  });

  it("stays stale after an export when the held request is not replayed", async () => {
    expect(await failing({ replayAfterHold: false }, (r) => r.settled)).toBeGreaterThan(0);
  }, 60_000);

  it("keeps a stale paint for good when a paint that never came is taken as painted", async () => {
    expect(await failing({ hostLiesAboutPaint: true }, (r) => r.settled)).toBeGreaterThan(0);
  }, 60_000);

  it("leaves a clip missing when a failed first paint is never asked for again", async () => {
    // Deterministic: a clip's very first paint fails, then the window paints
    // again and nothing else happens. Only the retry brings the clip back.
    const run = async (retry: boolean) => {
      const host = new FakeHost(() => 1);
      let painting = false;
      host.paintOk = () => painting;
      const rasters = new PreviewRasters();
      let wantDraw = false;
      const session = new PreviewRasterSession(
        {
          plan: (request, scaleOf) => ({
            current: planGraphics(planInput(request.elements, request.cursor, scaleOf)),
            ahead: [],
          }),
          prepare: (jobs, sink) =>
            serialize(() =>
              prepareGraphics({ port: host, mountOf: () => ({ spec: SPEC, removed: [] }) as any, fontsOf: () => [] }, jobs, sink),
            ).then((result) => (retry ? result : { ...result, painted: true })),
          mayPrepare: () => true,
          whenMayPrepare: () => undefined,
          releaseMounts: (live) => host.release(live),
          warn: () => undefined,
        },
        rasters,
      );
      const elements = { x: graphic(ANIMATED, 0, 1000) } as Timeline;
      const draw = () => {
        session.request({ elements, cursor: 500, fps: FPS, playing: false }, () => {
          wantDraw = true;
        });
        session.retain(new Set(["x"]));
      };
      draw();
      for (let i = 0; i < 4; i++) {
        host.tick();
        await flush();
      }
      painting = true;
      for (let i = 0; i < 10; i++) {
        host.tick();
        await flush();
        if (wantDraw) {
          wantDraw = false;
          draw();
          await flush();
        }
      }
      for (let i = 0; i < 10 && (session.preparing || host.waiting > 0); i++) {
        host.tick();
        await flush();
      }
      return rasters.latest("x");
    };
    expect(await run(true)).not.toBeNull();
    expect(await run(false)).toBeNull();
  });

  it("releases mounts mid-prepare when the sweep ignores a running prepare", async () => {
    let count = 0;
    for (const seed of SEEDS.slice(0, 3)) {
      const result = await simulate({ seed, frames: FRAMES, churn: 5, releaseOnlyBetweenPrepares: false });
      expect(result.idle).toBe(true);
      count += result.midPrepareReleases;
    }
    expect(count).toBeGreaterThan(0);
  });
});

describe("PreviewRasterSession, playing", () => {
  const job = (id: string, key: string) => ({ instanceId: id, key, static: false }) as any;
  const make = (ahead: any[]) => {
    const rasters = new PreviewRasters();
    const session = new PreviewRasterSession(
      {
        plan: () => ({ current: [], ahead }),
        prepare: () => new Promise(() => undefined),
        mayPrepare: () => true,
        whenMayPrepare: () => undefined,
        releaseMounts: () => undefined,
        warn: () => undefined,
      },
      rasters,
    );
    return { rasters, session };
  };
  const request = { elements: {}, cursor: 0, fps: 30, playing: true };

  it("drops an upcoming clip's raster from an earlier visit, so its entry cannot draw it", () => {
    const { rasters, session } = make([job("next", "entry")]);
    rasters.put("next", "parked-mid-clip", { stale: true } as unknown as CanvasImageSource);
    session.request(request, () => undefined);
    expect(rasters.latest("next")).toBeNull();
  });

  it("keeps an upcoming clip's raster that is already the lookahead's", () => {
    const { rasters, session } = make([job("next", "entry")]);
    rasters.put("next", "entry", { ready: true } as unknown as CanvasImageSource);
    session.request(request, () => undefined);
    expect(rasters.latest("next")).toEqual({ ready: true });
  });

  it("keeps everything while paused", () => {
    const { rasters, session } = make([job("next", "entry")]);
    rasters.put("next", "parked-mid-clip", { stale: true } as unknown as CanvasImageSource);
    rasters.put("gone", "k", { gone: true } as unknown as CanvasImageSource);
    session.request({ ...request, playing: false }, () => undefined);
    expect(rasters.latest("next")).toEqual({ stale: true });
    expect(rasters.latest("gone")).toEqual({ gone: true });
  });
});

describe("PreviewRasters", () => {
  const raster = (name: string) => ({ name }) as unknown as CanvasImageSource;

  it("keeps a raster whose paint never came drawable but not current", () => {
    const rasters = new PreviewRasters();
    rasters.put("a", null, raster("a"));
    expect(rasters.latest("a")).toEqual({ name: "a" });
    expect(rasters.keyOf("a")).toBeNull();
  });

  it("drops an off-screen animated raster and keeps a static one", () => {
    const rasters = new PreviewRasters();
    rasters.put("moving", "k1", raster("moving"));
    rasters.put("still", "k2", raster("still"), true);
    rasters.put("shown", "k3", raster("shown"));
    rasters.keepAnimated(new Set(["shown"]));
    expect(rasters.latest("moving")).toBeNull();
    expect(rasters.latest("still")).toEqual({ name: "still" });
    expect(rasters.latest("shown")).toEqual({ name: "shown" });
  });
});
