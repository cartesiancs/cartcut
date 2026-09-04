import { describe, it, expect } from "vitest";
import {
  NULL_DEFAULT_DURATION_MS,
  NULL_PIVOT_SIZE,
  createNullElement,
} from "./nullElement";
import { placeNewElement } from "../timeline/placement";
import {
  SCHEMA_VERSION,
  createTrack,
  normalizeDocument,
  type TimelineDocument,
} from "../timeline/tracks";
import { applyPoint, localMatrixOf } from "../timeline/transform";
import { animatableProperties, canAnimate } from "../../@types/timeline";
import { emptyAnimation } from "../animation/keyframes";
import { imageElement } from "../renderer/testing";

function doc(elements: Record<string, any> = {}): TimelineDocument {
  return normalizeDocument({
    schemaVersion: SCHEMA_VERSION,
    tracks: [createTrack("v1", "video", 0)],
    elements,
  });
}

/** Where the element's pivot — the point it rotates and scales about — lands. */
function pivot(element: any, cursor = 0) {
  return applyPoint(localMatrixOf(element, cursor), {
    x: element.width / 2,
    y: element.height / 2,
  });
}

describe("createNullElement", () => {
  it("is a group element, so every path that knows about groups knows about it", () => {
    // The whole point of not minting a tenth filetype. `hierarchy.ts#parentOf`
    // admits only `"group"` as a parent, and `isVisualTimelineElement` excludes
    // only `"group"` from the paint loop — a `"null"` filetype would have
    // silently detached its children from one and crashed the other.
    const element = createNullElement();
    expect(element.filetype).toBe("group");
    expect(element.localpath).toBe("GROUP");
  });

  it("is named Null, which is what distinguishes it from a wrapped selection", () => {
    // `createGroup` names its result "Group". Both are `filetype: "group"`; the
    // name on the bar is the only thing that tells the user which gesture made
    // it, and it costs no type change.
    expect(createNullElement().name).toBe("Null");
    expect(createNullElement({ name: "Camera rig" }).name).toBe("Camera rig");
  });

  it("puts its pivot exactly on the requested centre", () => {
    // `localMatrixOf` rotates and scales about `w/2, h/2`, so seating the box
    // means offsetting the location by half its size. Getting this wrong is
    // invisible until someone rotates the null.
    const element = createNullElement({ center: { x: 960, y: 540 } });
    const p = pivot(element);
    expect(p.x).toBeCloseTo(960, 9);
    expect(p.y).toBeCloseTo(540, 9);
    expect(element.location).toEqual({ x: 910, y: 490 });
  });

  it("keeps the pivot on the centre at any size", () => {
    const element = createNullElement({
      center: { x: 100, y: 200 },
      size: 40,
    });
    expect(element.width).toBe(40);
    expect(element.height).toBe(40);
    expect(pivot(element)).toEqual({ x: 100, y: 200 });
  });

  it("defaults to a 100px box at the origin", () => {
    const element = createNullElement();
    expect(element.width).toBe(NULL_PIVOT_SIZE);
    expect(element.height).toBe(NULL_PIVOT_SIZE);
    expect(pivot(element)).toEqual({ x: 0, y: 0 });
  });

  it("starts at zero, so its animation is in effect for the whole timeline", () => {
    // `localSampleAt` falls back to the static value for a cursor before the
    // element's `startTime`. A null seated at the playhead would therefore have
    // its keyframes quietly ignored everywhere to the left of it — the trap
    // that decides this default. After Effects seats a new layer at the top of
    // the comp for the same reason.
    expect(createNullElement().startTime).toBe(0);
    expect(createNullElement({ startTime: 5000 }).startTime).toBe(5000);
  });

  it("spans the project by default, because the bar is where keyframes go", () => {
    // Duration gates nothing — `renderer/timeline.ts` states that a group's
    // span does not gate its children. It is only the length of the bar the
    // user has to aim at to set a keyframe, so it should be long.
    expect(createNullElement().duration).toBe(NULL_DEFAULT_DURATION_MS);
    expect(createNullElement({ duration: 30_000 }).duration).toBe(30_000);
  });

  it("carries the five animation tracks a group gets", () => {
    const element = createNullElement();
    expect(element.animation).toEqual(emptyAnimation("group"));
    expect(canAnimate(element)).toBe(true);
    expect(animatableProperties(element)).toEqual([
      "position",
      "opacity",
      "scale",
      "rotation",
      // A group's box is its rotate/scale pivot rather than something drawn,
      // so animating its size moves the pivot and leaves the children where
      // they are. Offered all the same: the list is the same for all five
      // animatable types, and a filetype exception here would have to be
      // re-derived by the context menu, the diamond lane and the MCP schema.
      "size",
    ]);
  });

  it("is neutral: no rotation, full opacity, no parent", () => {
    const element = createNullElement() as any;
    expect(element.rotation).toBe(0);
    expect(element.opacity).toBe(100);
    expect(element.parentId).toBeUndefined();
  });

  it.each([
    ["zero", 0],
    ["negative", -50],
    ["NaN", NaN],
    ["Infinity", Infinity],
  ])("falls back to the default box on a %s size", (_label, size) => {
    // A degenerate pivot box is not an error worth refusing over — a zero-width
    // box makes `localMatrixOf` rotate about a corner, which reads as a bug in
    // the drag rather than as bad input.
    expect(createNullElement({ size: size as number }).width).toBe(
      NULL_PIVOT_SIZE,
    );
  });

  it.each([
    ["NaN", { x: NaN, y: 0 }],
    ["Infinity", { x: 0, y: Infinity }],
  ])("falls back to the origin on a %s centre", (_label, center) => {
    expect(createNullElement({ center: center as any }).location).toEqual({
      x: -NULL_PIVOT_SIZE / 2,
      y: -NULL_PIVOT_SIZE / 2,
    });
  });

  it("lands on a group row through the ordinary placement path", () => {
    // `defaultTrackKindFor("group")` already answers `"group"`, so no bespoke
    // track handling is needed here — unlike `createGroup`, whose caller has to
    // pick the row itself because the element does not exist yet.
    const placed = placeNewElement(doc(), "n1", createNullElement(), 0, "g1");
    const trackId = (placed.elements.n1 as any).trackId;
    expect(placed.tracks.find((t) => t.id === trackId)?.kind).toBe("group");
  });

  it("does not take a slot from a real clip", () => {
    const withImage = doc({ img: imageElement({ trackId: "v1" }) });
    const placed = placeNewElement(
      withImage,
      "n1",
      createNullElement(),
      0,
      "g1",
    );
    expect((placed.elements.n1 as any).trackId).not.toBe("v1");
    expect((placed.elements.img as any).trackId).toBe("v1");
  });

  it("survives normalizeDocument unchanged", () => {
    // `repairHierarchy` drops a `parentId` that does not name a live group, and
    // `derivePriorities` rewrites every rank. Neither may quietly alter a null.
    const placed = placeNewElement(doc(), "n1", createNullElement(), 0, "g1");
    const again = normalizeDocument(placed);
    expect(again.elements.n1).toEqual(placed.elements.n1);
  });
});
