import { describe, it, expect } from "vitest";
import {
  clipDetail,
  clipRow,
  documentDuration,
  paginate,
  TEXT_PREVIEW_CHARS,
} from "./serialize";
import {
  SCHEMA_VERSION,
  createTrack,
  normalizeDocument,
  type TimelineDocument,
} from "../timeline/tracks";
import {
  imageElement,
  shapeElement,
  textElement,
  videoElement,
} from "../renderer/testing";
import { addKeyframe, setTrackActive } from "../animation/keyframeOps";
import { MAX_BAKED_SAMPLES } from "../animation/keyframes";

/**
 * The property that matters most: nothing enormous can reach the agent.
 *
 * Claude Code truncates tool output at 25,000 tokens, and a single animated
 * element carries up to `MAX_BAKED_SAMPLES` (36,000) numbers per lane. If a
 * field is ever added to `TimelineElement` that the whitelist does not know
 * about, these tests are what notice.
 */
function collectNumbersDeep(value: unknown, out: number[] = []): number[] {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectNumbersDeep(item, out);
    }
  } else if (value != null && typeof value === "object") {
    for (const item of Object.values(value)) {
      collectNumbersDeep(item, out);
    }
  } else if (typeof value === "number") {
    out.push(value);
  }
  return out;
}

function jsonOf(value: unknown): string {
  return JSON.stringify(value);
}

function doc(elements: Record<string, any>): TimelineDocument {
  return normalizeDocument({
    schemaVersion: SCHEMA_VERSION,
    tracks: [createTrack("v1", "video", 0)],
    elements,
  });
}

/** An element with a real, baked opacity curve — not the inactive stub. */
function withBakedCurve() {
  let d = doc({
    a: imageElement({ trackId: "v1", startTime: 0, duration: 4000 }),
  });
  d = setTrackActive(d, "a", "opacity", true);
  d = addKeyframe(d, "a", "opacity", "x", 0, 0);
  d = addKeyframe(d, "a", "opacity", "x", 3000, 100);
  return d;
}

describe("clipRow", () => {
  it("uses the map key as the id, not element.key", () => {
    // `key` is only set by the preview and asset layers; the elements addText
    // and addImage create do not have one, and the map key is what every op
    // takes. A row carrying `element.key` would name a clip that no tool can
    // address.
    const element = imageElement({ trackId: "v1", key: "stale-or-absent" });
    expect(clipRow("real-id", element).id).toBe("real-id");
  });

  it("reports the timeline span, not the source duration, for a sped-up clip", () => {
    const element = videoElement({
      trackId: "v1",
      startTime: 1000,
      duration: 4000,
      trim: { startTime: 0, endTime: 4000 },
      sourceDuration: 4000,
      speed: 2,
    });

    const row = clipRow("a", element);
    // 4000ms of source at 2x occupies 2000ms of timeline.
    expect(row.dur).toBe(2000);
    expect(row.start).toBe(1000);
    expect(row.end).toBe(3000);
    expect(row.speed).toBe(2);
  });

  it("truncates long text rather than echoing a monologue", () => {
    const element = textElement({ trackId: "v1", text: "a".repeat(500) });
    const row = clipRow("a", element) as any;
    expect(row.text.length).toBeLessThanOrEqual(TEXT_PREVIEW_CHARS + 1);
  });

  it("names which properties are animated without shipping the curves", () => {
    const d = withBakedCurve();
    const row = clipRow("a", d.elements.a) as any;
    expect(row.animated).toEqual(["opacity"]);
    expect(jsonOf(row)).not.toContain('"ax"');
  });

  it("never carries a blob URL", () => {
    const element = imageElement({
      trackId: "v1",
      blob: "blob:file:///aaaa-bbbb-cccc",
    });
    expect(jsonOf(clipRow("a", element))).not.toContain("blob:");
  });

  it("never carries a shape's point list", () => {
    // Not a substring check: `"type":"shape"` legitimately contains the word.
    const element = shapeElement({ trackId: "v1" });
    const row = clipRow("a", element) as any;
    expect(row.shape).toBeUndefined();
    expect(row.option).toBeUndefined();
  });
});

describe("clipDetail", () => {
  it("summarises keyframes instead of emitting baked samples", () => {
    const d = withBakedCurve();

    // Sanity: the element really does hold a baked array worth guarding.
    const baked = (d.elements.a as any).animation.opacity.ax;
    expect(baked.length).toBeGreaterThan(50);

    const detail = clipDetail("a", d.elements.a) as any;
    const opacity = detail.animation.find((t: any) => t.property === "opacity");

    expect(opacity.active).toBe(true);
    expect(opacity.lanes.x.count).toBe(2);
    expect(opacity.lanes.x.times).toEqual([0, 3000]);

    // The whole point: the detail view is a rounding error next to the data.
    expect(collectNumbersDeep(detail).length).toBeLessThan(100);
    expect(collectNumbersDeep(detail).length).toBeLessThan(MAX_BAKED_SAMPLES);
  });

  it("gives text clips their full text back", () => {
    const element = textElement({ trackId: "v1", text: "b".repeat(500) });
    const detail = clipDetail("a", element) as any;
    expect(detail.text).toHaveLength(500);
  });

  it("stays small even for a heavily animated clip", () => {
    let d = doc({
      a: videoElement({ trackId: "v1", startTime: 0, duration: 60_000 }),
    });
    d = setTrackActive(d, "a", "position", true);
    for (let t = 0; t < 60_000; t += 500) {
      d = addKeyframe(d, "a", "position", "x", t, t / 100);
      d = addKeyframe(d, "a", "position", "y", t, t / 100);
    }

    const size = jsonOf(clipDetail("a", d.elements.a)).length;
    // 120 keyframes across two lanes, plus the fixed fields — kilobytes, not
    // the megabytes the baked arrays would be.
    expect(size).toBeLessThan(4000);
  });
});

describe("documentDuration", () => {
  it("is the furthest clip end", () => {
    const d = doc({
      a: imageElement({ trackId: "v1", startTime: 0, duration: 1000 }),
      b: imageElement({ trackId: "v1", startTime: 4000, duration: 2500 }),
    });
    expect(documentDuration(d)).toBe(6500);
  });

  it("is zero for an empty project", () => {
    expect(documentDuration(doc({}))).toBe(0);
  });
});

describe("paginate", () => {
  const items = Array.from({ length: 10 }, (_, i) => i);

  it("flags a short page as truncated so the caller knows to ask again", () => {
    const page = paginate(items, 0, 4);
    expect(page.items).toEqual([0, 1, 2, 3]);
    expect(page.total).toBe(10);
    expect(page.truncated).toBe(true);
  });

  it("does not flag the last page", () => {
    expect(paginate(items, 8, 4).truncated).toBe(false);
    expect(paginate(items, 0, 10).truncated).toBe(false);
  });

  it("survives an offset past the end", () => {
    const page = paginate(items, 99, 4);
    expect(page.items).toEqual([]);
    expect(page.total).toBe(10);
    expect(page.truncated).toBe(false);
  });
});
