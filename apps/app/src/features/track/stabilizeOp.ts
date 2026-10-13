/**
 * Stabilize: hold a tracked point still by moving the picture under it.
 *
 * The inverse of what a tracking null is usually for. Parent a label to the
 * null and the label follows the feature; stabilize on the null and the
 * feature stays on one spot of the frame while the footage moves. It builds a
 * rig of two groups (`timeline/rig.ts` has the picture):
 *
 * ```
 * "Stabilize"  zoom    root; pivot centred on the target T; scale = the zoom
 *  └ "Camera"  camera  position = an affine copy of the null's
 *     ├ the footage    numbers untouched
 *     └ the null       numbers untouched
 * ```
 *
 * ## Why the lock is exact
 *
 * Three facts, and a test for each in `stabilizeOp.test.ts`.
 *
 * 1. **Nothing in the camera is rewritten** (`groupOps.ts#adoptIntoRig`), so
 *    the footage and the null keep the space they were measured in, and the
 *    feature's position there is the null's centre, `F(t) = L(t) + c_null`.
 * 2. **The camera is `K - null`, sample for sample.** Every keyframe value,
 *    handle, baked sample and the static location is mapped `v -> K - v`, with
 *    the times untouched. Same times means the same bake grid and the same
 *    nearest-sample snap in `sampleBaked`, so the camera reads `K - L(t)` at
 *    every cursor, between frames, before the null's bar (both static) and
 *    after it (both hold their last sample). Resampling the path instead would
 *    shift the time base, and a 24fps frame sits exactly between two 60Hz
 *    samples: a shifted grid breaks that tie the other way.
 * 3. **The target is the zoom's fixed point.** With `K = c_zoom - c_null` the
 *    feature lands at `L_z + c_zoom + s * R * (K - L + L + c_null - c_zoom)`,
 *    which is `L_z + c_zoom = T` whatever the zoom's scale `s` and rotation
 *    `R`. So the auto-zoom, or anyone editing the zoom later, cannot move it.
 *
 * ## The zoom
 *
 * Moving the picture uncovers the frame's edges. The zoom is the smallest one
 * scale, about `T`, that keeps every frame corner inside every visible piece of
 * footage at every frame instant, solved against the frame grown by a pixel so
 * an anti-aliased corner is covered too. It is capped (`maxZoom`), because
 * locking a point that crosses the frame needs a magnification nobody wants,
 * and the outcome says so. Footage that never filled the frame (a picture in
 * picture) is not zoomed at all: covering the frame was never its job.
 *
 * Pure: the caller passes ids, the frame and the fps, and the op declines by
 * returning the document it was given.
 */

import type {
  GroupElementType,
  Timeline,
  TimelineElement,
  TransitionElementType,
} from "../../@types/timeline";
import type { Keyframe, VectorTrack } from "../animation/keyframes";
import { emptyAnimation } from "../animation/keyframes";
import { linkOf } from "../animation/link";
import { createNullElement } from "../element/nullElement";
import { isElementVisibleAtTime } from "../element/time";
import { spanOf } from "../timeline/geometry";
import { frameToMs, msToFrameCeil } from "../timeline/frames";
import { adoptIntoRig } from "../timeline/groupOps";
import { MAX_GROUP_DEPTH, subtreeHeight } from "../timeline/hierarchy";
import { chooseTrackFor, placeNewElement } from "../timeline/placement";
import {
  RIG_CAMERA,
  RIG_ZOOM,
  preRigElements,
  rigChildrenOf,
  rigOf,
  rigRoleOf,
} from "../timeline/rig";
import { normalizeDocument, type TimelineDocument } from "../timeline/tracks";
import { transitionIndex } from "../timeline/transitionWindow";
import { windowOf } from "../timeline/transitionGeometry";
import { createMemo, worldCornersOf, type Point } from "../timeline/transform";

/** The magnification past which the edges are left to show. */
export const DEFAULT_MAX_STABILIZE_ZOOM = 2;

/** How far past the frame the zoom covers, so the corner pixel is footage. */
const COVER_MARGIN_PX = 1;

/** How far a corner may sit outside the footage and still count as covered. */
const FULL_FRAME_SLACK_PX = 1e-6;

/** The picture types that can be held still. A group draws nothing. */
const STABILIZABLE = new Set([
  "video",
  "image",
  "gif",
  "text",
  "shape",
  "template",
  "graphic",
]);

export type StabilizeRefusal =
  | "missing-clip"
  | "clip-not-visual"
  | "clip-parented"
  | "missing-null"
  | "not-a-null"
  | "null-not-tracked"
  | "null-linked"
  | "null-sized"
  | "null-parented"
  | "depth"
  | "bad-target"
  | "bad-ids";

export type StabilizeParams = {
  clipId: string;
  nullId: string;
  /**
   * Where the tracked point is held, in project pixels: the centre of the
   * frame being edited. A re-run keeps the rig's own, which the user may have
   * moved.
   */
  target: Point;
  /** The frame being edited, for the zoom. */
  frame: { width: number; height: number };
  fps: number;
  autoZoom: boolean;
  maxZoom?: number;
  /** Ids for a new rig. A re-run keeps the ones it has. */
  zoomId: string;
  cameraId: string;
  /** A row each, used only if a new one has to be made: the spans overlap. */
  trackIds: { zoom: string; camera: string };
};

export type StabilizeOutcome =
  | {
      ok: true;
      /** The zoom the rig ended with, 1 for none. */
      zoom: number;
      /** Whether every frame corner is footage at every instant. */
      covered: boolean;
      /** What covering would have taken; `Infinity` when nothing could. */
      zoomNeeded: number;
      /** Why the zoom was not solved for. */
      zoomSkipped?: "not-full-frame" | "off";
      zoomId: string;
      cameraId: string;
    }
  | { ok: false; reason: StabilizeRefusal };

/**
 * Why `stabilize` would refuse, from the document's structure alone, or
 * `null` when it would go ahead.
 *
 * Cheap enough to ask on every right-click: no frame is sampled. The menu asks
 * it, so an entry that could only decline is never offered.
 */
export function stabilizeRefusal(
  doc: TimelineDocument,
  clipId: string,
  nullId: string,
): StabilizeRefusal | null {
  const elements = doc.elements;
  const clip = elements[clipId];
  if (clip == null) {
    return "missing-clip";
  }
  if (!STABILIZABLE.has(clip.filetype)) {
    return "clip-not-visual";
  }

  const clipParent = parentIdOf(clip);
  const rig = clipParent == null ? null : rigOf(elements, clipId);
  if (clipParent != null && rig == null) {
    return "clip-parented";
  }

  const nullElement = elements[nullId];
  if (nullElement == null) {
    return "missing-null";
  }
  if (
    nullId === clipId ||
    nullElement.filetype !== "group" ||
    rigRoleOf(nullElement) != null
  ) {
    return "not-a-null";
  }

  const position = (nullElement as GroupElementType).animation?.position;
  if (
    position == null ||
    position.isActivate !== true ||
    !(position.x?.length > 0) ||
    !(position.y?.length > 0) ||
    !(position.ax?.length > 0) ||
    !(position.ay?.length > 0)
  ) {
    return "null-not-tracked";
  }
  if (linkOf(nullElement, "position") != null) {
    return "null-linked";
  }
  if ((nullElement as GroupElementType).animation?.size?.isActivate === true) {
    return "null-sized";
  }

  // A fresh rig takes a null from the root, measured in the world. A rigged
  // clip takes only a null already in its camera: one at the root may have
  // been measured on the stabilized picture, and there is no telling which.
  const nullParent = parentIdOf(nullElement);
  if (rig == null ? nullParent != null : nullParent !== rig.cameraId) {
    return "null-parented";
  }

  // Inside the camera, two levels down.
  if (rig == null && 2 + subtreeHeight(elements, nullId) > MAX_GROUP_DEPTH) {
    return "depth";
  }

  return null;
}

/**
 * Build the rig, or re-aim the one the clip is already in.
 *
 * A fresh rig gets `zoomId`/`cameraId`; a clip already in an intact rig keeps
 * its rig, its rows, its target and the zoom's rotation, and only the camera's
 * copy and the zoom's scale are redone. Refusals return `doc` by identity.
 */
export function stabilize(
  doc: TimelineDocument,
  params: StabilizeParams,
): { doc: TimelineDocument; outcome: StabilizeOutcome } {
  const refuse = (reason: StabilizeRefusal) => ({
    doc,
    outcome: { ok: false as const, reason },
  });

  const reason = stabilizeRefusal(doc, params.clipId, params.nullId);
  if (reason != null) {
    return refuse(reason);
  }
  const rig = rigOf(doc.elements, params.clipId);
  if (rig == null && !isFinitePoint(params.target)) {
    return refuse("bad-target");
  }
  if (
    rig == null &&
    (params.zoomId === "" ||
      params.cameraId === "" ||
      params.zoomId === params.cameraId ||
      doc.elements[params.zoomId] != null ||
      doc.elements[params.cameraId] != null)
  ) {
    return refuse("bad-ids");
  }

  const nullElement = doc.elements[params.nullId] as GroupElementType;
  const built =
    rig == null
      ? buildRig(doc, params, nullElement)
      : reaimRig(doc, params, nullElement, rig);
  if (built == null) {
    return refuse("depth");
  }

  const zoomed = applyZoom(built.doc, built.zoomId, built.cameraId, params);
  return {
    doc: zoomed.doc,
    outcome: {
      ok: true,
      zoom: zoomed.zoom,
      covered: zoomed.covered,
      zoomNeeded: zoomed.zoomNeeded,
      ...(zoomed.skipped != null ? { zoomSkipped: zoomed.skipped } : {}),
      zoomId: built.zoomId,
      cameraId: built.cameraId,
    },
  };
}

/** `stabilize` in the shape every other op has. */
export function stabilizeClip(
  doc: TimelineDocument,
  params: StabilizeParams,
): TimelineDocument {
  return stabilize(doc, params).doc;
}

/**
 * The clip and the null a right-click on exactly those two means, if
 * stabilizing one on the other would go ahead. `null` otherwise, so the menu
 * offers "Stabilize on null" only where it would do something.
 */
export function stabilizePairOf(
  doc: TimelineDocument,
  elementIds: readonly string[],
): { clipId: string; nullId: string } | null {
  const ids = [...new Set(elementIds)].filter((id) => doc.elements[id] != null);
  if (ids.length !== 2) {
    return null;
  }
  const [a, b] = ids;
  const isNull = (id: string) =>
    doc.elements[id].filetype === "group" && rigRoleOf(doc.elements[id]) == null;
  const pair =
    isNull(a) && !isNull(b)
      ? { clipId: b, nullId: a }
      : isNull(b) && !isNull(a)
        ? { clipId: a, nullId: b }
        : null;
  if (pair == null || stabilizeRefusal(doc, pair.clipId, pair.nullId) != null) {
    return null;
  }
  return pair;
}

// ------------------------------------------------------------- the camera

/**
 * The camera's position: `K - v` for every value in the null's position track
 * and its static location, every time untouched.
 *
 * The keyframes are spread so whatever else they carry (`type`) survives; only
 * the value half of `p`, `cs` and `ce` changes. Mapping the baked lanes
 * directly, rather than baking the mapped keyframes, keeps the camera equal to
 * `K - null` to the last bit as the renderer reads it. A later rebake (a load,
 * a frame-rate change) bakes both from their keyframes at one rate, and they
 * then agree to a few ulps.
 */
export function cameraTrackFrom(
  nullElement: GroupElementType,
  k: Point,
): { location: Point; position: VectorTrack } {
  const track = nullElement.animation.position as unknown as VectorTrack;
  const lane = (list: Keyframe[], at: number): Keyframe[] =>
    list.map((keyframe) => ({
      ...keyframe,
      p: [keyframe.p[0], at - keyframe.p[1]],
      cs: [keyframe.cs[0], at - keyframe.cs[1]],
      ce: [keyframe.ce[0], at - keyframe.ce[1]],
    }));
  const baked = (list: number[][], at: number): number[][] =>
    list.map((entry) => [entry[0], at - entry[1]]);

  return {
    location: {
      x: k.x - nullElement.location.x,
      y: k.y - nullElement.location.y,
    },
    position: {
      isActivate: track.isActivate,
      x: lane(track.x, k.x),
      y: lane(track.y, k.y),
      ax: baked(track.ax, k.x),
      ay: baked(track.ay, k.y),
    },
  };
}

/** `K`: the zoom's pivot half less the null's, per lane. */
function offsetFor(zoom: { width: number; height: number }, nullElement: GroupElementType): Point {
  return {
    x: zoom.width / 2 - nullElement.width / 2,
    y: zoom.height / 2 - nullElement.height / 2,
  };
}

// ---------------------------------------------------------------- the rig

type Built = { doc: TimelineDocument; zoomId: string; cameraId: string };

function buildRig(
  doc: TimelineDocument,
  params: StabilizeParams,
  nullElement: GroupElementType,
): Built | null {
  const clip = doc.elements[params.clipId];
  const clipSpan = spanOf(clip);
  const start = Math.min(clipSpan.start, nullElement.startTime);
  const end = Math.max(clipSpan.end, nullElement.startTime + nullElement.duration);

  const zoom: GroupElementType = {
    ...createNullElement({
      name: "Stabilize",
      center: params.target,
      startTime: start,
      duration: end - start,
    }),
    rig: RIG_ZOOM,
  };

  const k = offsetFor(zoom, nullElement);
  const copy = cameraTrackFrom(nullElement, k);
  const camera: GroupElementType = {
    ...createNullElement({
      name: "Camera",
      startTime: nullElement.startTime,
      duration: nullElement.duration,
    }),
    location: copy.location,
    animation: { ...emptyAnimation("group"), position: copy.position },
    rig: RIG_CAMERA,
  };

  let next = placeNewElement(doc, params.zoomId, zoom, start, params.trackIds.zoom);
  next = placeNewElement(
    next,
    params.cameraId,
    camera,
    nullElement.startTime,
    params.trackIds.camera,
  );
  next = normalizeDocument({
    ...next,
    elements: {
      ...next.elements,
      [params.cameraId]: { ...next.elements[params.cameraId], parentId: params.zoomId },
    },
  });

  const adopted = adoptIntoRig(next, params.cameraId, [params.clipId, params.nullId]);
  if (adopted === next) {
    return null;
  }
  return { doc: adopted, zoomId: params.zoomId, cameraId: params.cameraId };
}

/**
 * A re-run: the camera's copy redone from the null, the zoom's span widened to
 * what it now holds, and nothing else. The target, the zoom's rotation and
 * every id and row stay, except a bar whose new span collides on its row,
 * which moves to a free one.
 */
function reaimRig(
  doc: TimelineDocument,
  params: StabilizeParams,
  nullElement: GroupElementType,
  rig: { zoomId: string; cameraId: string },
): Built | null {
  const zoom = doc.elements[rig.zoomId] as GroupElementType;
  const camera = doc.elements[rig.cameraId] as GroupElementType;
  const copy = cameraTrackFrom(nullElement, offsetFor(zoom, nullElement));

  let next = reseat(
    doc,
    rig.cameraId,
    {
      ...camera,
      startTime: nullElement.startTime,
      duration: nullElement.duration,
      location: copy.location,
      animation: { ...camera.animation, position: copy.position },
    } as GroupElementType,
    params.trackIds.camera,
  );

  let start = zoom.startTime;
  let end = zoom.startTime + zoom.duration;
  for (const id of rigChildrenOf(next.elements, rig.cameraId)) {
    const span = spanOf(next.elements[id]);
    start = Math.min(start, span.start);
    end = Math.max(end, span.end);
  }
  next = reseat(
    next,
    rig.zoomId,
    { ...zoom, startTime: start, duration: end - start } as GroupElementType,
    params.trackIds.zoom,
  );

  return { doc: next, zoomId: rig.zoomId, cameraId: rig.cameraId };
}

/**
 * Write `element` over the one at `id`, on its own row if its span is still
 * free there and on another otherwise. Never by removing and re-adding the
 * element: a normalize in between would see the camera gone and drop its
 * children's `parentId`.
 */
function reseat(
  doc: TimelineDocument,
  id: string,
  element: GroupElementType,
  newTrackId: string,
): TimelineDocument {
  const others = { ...doc.elements };
  delete others[id];
  const { doc: withTrack, trackId } = chooseTrackFor(
    { ...doc, elements: others },
    element,
    element.startTime,
    newTrackId,
    element.trackId,
  );
  return normalizeDocument({
    ...doc,
    tracks: withTrack.tracks,
    elements: { ...doc.elements, [id]: { ...element, trackId } },
  });
}

// --------------------------------------------------------------- the zoom

type Zoomed = {
  doc: TimelineDocument;
  zoom: number;
  covered: boolean;
  zoomNeeded: number;
  skipped?: "not-full-frame" | "off";
};

function applyZoom(
  doc: TimelineDocument,
  zoomId: string,
  cameraId: string,
  params: StabilizeParams,
): Zoomed {
  const zoom = doc.elements[zoomId] as GroupElementType;
  const current = typeof zoom.scale === "number" ? zoom.scale / 10 : 1;
  if (!params.autoZoom) {
    return { doc, zoom: current, covered: false, zoomNeeded: Number.NaN, skipped: "off" };
  }

  // Solved with the zoom at 1, which the formula wants: a corner's reach
  // inside the footage is measured on the unmagnified picture.
  const flat = withZoom(doc, zoomId, 1);
  const target = {
    x: zoom.location.x + zoom.width / 2,
    y: zoom.location.y + zoom.height / 2,
  };
  const pieces = rigChildrenOf(flat.elements, cameraId).filter((id) =>
    STABILIZABLE.has(flat.elements[id].filetype),
  );

  const quads: Quad[] = [];
  let fullFrame = true;
  for (const id of pieces) {
    const before = preRigElements(flat.elements, id);
    for (const t of frameInstants(flat.elements, id, params.fps)) {
      quads.push(worldCornersOf(flat.elements, id, t, createMemo()));
      if (fullFrame && !containsFrame(worldCornersOf(before, id, t, createMemo()), params.frame)) {
        fullFrame = false;
      }
    }
  }

  if (!fullFrame) {
    return { doc: flat, zoom: 1, covered: false, zoomNeeded: Number.NaN, skipped: "not-full-frame" };
  }

  const solved = coverZoom(
    quads,
    params.frame,
    target,
    params.maxZoom ?? DEFAULT_MAX_STABILIZE_ZOOM,
  );
  return {
    doc: withZoom(flat, zoomId, solved.zoom),
    zoom: solved.zoom,
    covered: solved.covered,
    zoomNeeded: solved.zoomNeeded,
  };
}

/** The zoom's `scale`, in tenths, with the key deleted at 1 as `scaleOps` does. */
function withZoom(doc: TimelineDocument, zoomId: string, zoom: number): TimelineDocument {
  const element = doc.elements[zoomId] as GroupElementType;
  if (zoom === 1) {
    if (typeof element.scale !== "number") {
      return doc;
    }
    const { scale: _dropped, ...rest } = element;
    return { ...doc, elements: { ...doc.elements, [zoomId]: rest as TimelineElement } };
  }
  if (element.scale === zoom * 10) {
    return doc;
  }
  return {
    ...doc,
    elements: { ...doc.elements, [zoomId]: { ...element, scale: zoom * 10 } },
  };
}

/**
 * Every project frame instant at which `id` is drawn, transitions included,
 * at exactly the times the export samples (`frameToMs`).
 */
export function frameInstants(elements: Timeline, id: string, fps: number): number[] {
  const element = elements[id];
  if (element == null) {
    return [];
  }
  let { start, end } = spanOf(element);
  for (const transition of transitionIndex(elements).get(element) ?? []) {
    const window = windowOf(transition as TransitionElementType);
    start = Math.min(start, window.start);
    end = Math.max(end, window.end);
  }

  const out: number[] = [];
  for (let k = msToFrameCeil(start, fps); frameToMs(k, fps) < end; k++) {
    const t = frameToMs(k, fps);
    if (isElementVisibleAtTime(t, elements, element as any)) {
      out.push(t);
    }
  }
  return out;
}

// ------------------------------------------------------------ the geometry

export type Quad = [Point, Point, Point, Point];

/**
 * The smallest zoom about `target` that puts every corner of the frame, grown
 * by `COVER_MARGIN_PX`, inside every quad.
 *
 * Scaling about `T` by `s` covers a frame corner `c` exactly when
 * `T + (c - T) / s` is inside the quad, so per corner and quad the answer is
 * `1 / lambda`, `lambda` the furthest the ray from `T` towards `c` stays inside.
 * A quad `T` is not inside cannot be covered at any zoom; those are counted
 * and leave `covered` false without dragging the zoom to the cap.
 */
export function coverZoom(
  quads: readonly Quad[],
  frame: { width: number; height: number },
  target: Point,
  maxZoom: number,
): { zoom: number; covered: boolean; zoomNeeded: number; outside: number } {
  const m = COVER_MARGIN_PX;
  const corners: Point[] = [
    { x: -m, y: -m },
    { x: frame.width + m, y: -m },
    { x: frame.width + m, y: frame.height + m },
    { x: -m, y: frame.height + m },
  ];

  let needed = 1;
  let outside = 0;
  for (const quad of quads) {
    const reaches = corners.map((corner) =>
      reachInQuad(quad, target, { x: corner.x - target.x, y: corner.y - target.y }),
    );
    if (reaches.some((reach) => reach == null)) {
      outside++;
      continue;
    }
    for (const reach of reaches as number[]) {
      needed = Math.max(needed, reach > 0 ? 1 / reach : Infinity);
    }
  }

  const cap = Number.isFinite(maxZoom) && maxZoom >= 1 ? maxZoom : DEFAULT_MAX_STABILIZE_ZOOM;
  return {
    zoom: Math.min(needed, cap),
    covered: outside === 0 && needed <= cap,
    zoomNeeded: needed,
    outside,
  };
}

/**
 * The largest `lambda >= 0` with `from + lambda * direction` inside the convex
 * quad, `Infinity` if the ray never leaves, `null` if `from` is outside.
 */
function reachInQuad(quad: Quad, from: Point, direction: Point): number | null {
  const sign = Math.sign(signedArea(quad));
  if (sign === 0) {
    return null;
  }
  let reach = Infinity;
  for (let i = 0; i < 4; i++) {
    const p = quad[i];
    const q = quad[(i + 1) % 4];
    const edge = { x: q.x - p.x, y: q.y - p.y };
    const length = Math.hypot(edge.x, edge.y);
    // Signed distance from the edge's line, positive inside.
    const inside = (sign * cross(edge, { x: from.x - p.x, y: from.y - p.y })) / length;
    const rate = (sign * cross(edge, direction)) / length;
    if (inside < -FULL_FRAME_SLACK_PX) {
      return null;
    }
    if (rate < 0) {
      reach = Math.min(reach, Math.max(0, inside) / -rate);
    }
  }
  return reach;
}

/** Whether every corner of the frame is inside the quad, to a hair. */
function containsFrame(quad: Quad, frame: { width: number; height: number }): boolean {
  const corners: Point[] = [
    { x: 0, y: 0 },
    { x: frame.width, y: 0 },
    { x: frame.width, y: frame.height },
    { x: 0, y: frame.height },
  ];
  const sign = Math.sign(signedArea(quad));
  if (sign === 0) {
    return false;
  }
  return corners.every((corner) => {
    for (let i = 0; i < 4; i++) {
      const p = quad[i];
      const q = quad[(i + 1) % 4];
      const edge = { x: q.x - p.x, y: q.y - p.y };
      const distance =
        (sign * cross(edge, { x: corner.x - p.x, y: corner.y - p.y })) /
        Math.hypot(edge.x, edge.y);
      if (distance < -FULL_FRAME_SLACK_PX) {
        return false;
      }
    }
    return true;
  });
}

function cross(a: Point, b: Point): number {
  return a.x * b.y - a.y * b.x;
}

function signedArea(quad: Quad): number {
  let area = 0;
  for (let i = 0; i < 4; i++) {
    const p = quad[i];
    const q = quad[(i + 1) % 4];
    area += p.x * q.y - q.x * p.y;
  }
  return area / 2;
}

// ------------------------------------------------------------ the messages

/** What the panel and the menu say when Stabilize declines. */
export function refusalMessage(reason: StabilizeRefusal): string {
  switch (reason) {
    case "missing-clip":
      return "Select a clip to stabilize.";
    case "clip-not-visual":
      return "Only a picture can be stabilized.";
    case "clip-parented":
      return "This clip is inside a group. Take it out of the group to stabilize it.";
    case "missing-null":
      return "The tracking null is gone. Track again to make one.";
    case "not-a-null":
      return "Stabilize follows a null, such as one Create Null made.";
    case "null-not-tracked":
      return "That null does not move: its position has no keyframes.";
    case "null-linked":
      return "That null's position is driven by a link, so it has no path of its own.";
    case "null-sized":
      return "That null's size is animated, so its centre moves on its own.";
    case "null-parented":
      return "That null is not on this clip's own picture. Track the clip again and stabilize on the new null.";
    case "depth":
      return "Groups cannot nest more than 8 deep.";
    case "bad-target":
      return "There is no frame to hold the point in.";
    case "bad-ids":
      return "Stabilize could not name its new groups.";
  }
}

/** What to say after a stabilize that went ahead, or `null` for nothing. */
export function zoomMessage(outcome: StabilizeOutcome, maxZoom = DEFAULT_MAX_STABILIZE_ZOOM): string | null {
  if (!outcome.ok) {
    return null;
  }
  if (outcome.zoomSkipped === "not-full-frame") {
    return "Stabilized without zooming: the clip does not fill the frame.";
  }
  if (outcome.zoomSkipped === "off" || outcome.covered) {
    return null;
  }
  if (!Number.isFinite(outcome.zoomNeeded) || outcome.zoomNeeded <= maxZoom) {
    return "Stabilized. The tracked point leaves the picture at some frames, so the edges show there.";
  }
  const percent = (zoom: number) => `${Math.round(zoom * 100)}%`;
  return `Stabilized at ${percent(outcome.zoom)}. Hiding every edge would take ${percent(outcome.zoomNeeded)}, past the ${percent(maxZoom)} limit.`;
}

// ---------------------------------------------------------------- helpers

function parentIdOf(element: unknown): string | null {
  const parentId = (element as { parentId?: unknown } | null)?.parentId;
  return typeof parentId === "string" && parentId !== "" ? parentId : null;
}

function isFinitePoint(point: Point | null | undefined): boolean {
  return point != null && Number.isFinite(point.x) && Number.isFinite(point.y);
}
