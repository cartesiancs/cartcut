/**
 * Grouping, ungrouping and re-parenting, as pure document transforms.
 *
 * The contract every op here keeps, and the reason they are pure: an op that
 * declines returns **the document it was given, by identity**.
 * `useTimelineStore.withCheckpoint` reads that as "nothing happened" and
 * records no undo step, so a refused group costs the user nothing.
 *
 * ## The one invariant that matters
 *
 * **Grouping must not move anything.** A user who selects two clips and presses
 * Group expects the picture to be identical the instant after. Since a child's
 * `location` is thereafter read in the group's space, keeping the picture still
 * means rewriting each child's position by the inverse of the group's
 * transform.
 *
 * That rewrite is only *exact* for a translation. A general affine would have to
 * push a rotation through the two position lanes, and the lanes carry
 * independent bezier handle abscissae — x(t) and y(t) are separately
 * parameterised curves, so a transform mixing one into the other has no exact
 * representation in this data model.
 *
 * So `createGroup` never needs one: it seats the new group at the selection's
 * bounding box with no rotation and unit scale, which makes the compensation it
 * owes each child exactly `−bbox.topLeft`. A translation. Exact, for the static
 * value and for every keyframe and handle on the curve.
 *
 * `ungroup` and `setParent` can face a rotated or scaled group, and there the
 * anchors are still exact while the handles are carried through the same linear
 * map — the easing between keyframes can bow slightly. `groupOps.test.ts` pins
 * the anchor exactness and marks the boundary.
 */

import {
  isGroupElement as isGroupType,
  type GroupElementType,
  type Timeline,
  type TimelineElement,
} from "../../@types/timeline";
import {
  bakeTrack,
  emptyAnimation,
  mapKeyframeValues,
  offsetKeyframeValues,
  type Keyframe,
} from "../animation/keyframes";
import { spanEnd } from "./geometry";
import {
  MAX_GROUP_DEPTH,
  depthOf,
  descendantsOf,
  parentOf,
  subtreeHeight,
  wouldCycle,
} from "./hierarchy";
import { normalizeDocument, type TimelineDocument } from "./tracks";
import {
  applyPoint,
  invert,
  localMatrixOf,
  localSampleAt,
  multiply,
  rotationOf,
  scaleOf,
  worldMatrixOf,
  type Mat,
  type Point,
} from "./transform";

/** Default colour for a group's bar on the timeline. */
const GROUP_BAR_COLOR = "rgb(120, 110, 190)";

/** The shortest span a group's bar may occupy, so it stays grabbable. */
const MIN_GROUP_DURATION_MS = 100;

/**
 * Whether an element may be parented at all.
 *
 * Audio is excluded because it has no picture to place — it carries `location`
 * only because `TimelinePlaced` gives it one, and nothing reads it. Putting a
 * sound inside a group would suggest that moving the group moves the sound,
 * which it cannot.
 */
export function canBeGrouped(element: TimelineElement | undefined): boolean {
  return element != null && element.filetype !== "audio";
}

// ------------------------------------------------------------------ bounds

type Rect = { x: number; y: number; w: number; h: number };

/**
 * The bounding box of `elementIds` in the space they currently share.
 *
 * Deliberately the **static** axis-aligned rects — `location` plus
 * `width`/`height` — ignoring rotation, scale and animation. That keeps the
 * pivot a pure function of the document, with no cursor in it: grouping the
 * same clips twice gives the same group, and a test can state the expected box
 * without sampling anything. The cost is that a rotated child can push its
 * corner slightly outside the box, so the pivot is not quite the visual centre;
 * the user can move it by editing the group's `width`/`height`, which is what
 * those fields mean on a group.
 */
function boundsOf(elements: Timeline, elementIds: string[]): Rect | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const id of elementIds) {
    const element = elements[id] as any;
    if (element == null) {
      continue;
    }
    const x = element.location?.x ?? 0;
    const y = element.location?.y ?? 0;
    const w = element.width ?? 0;
    const h = element.height ?? 0;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + w);
    maxY = Math.max(maxY, y + h);
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
    return null;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

// ------------------------------------------------------- child compensation

/**
 * Rewrite one element's placement so that `m` applied to the result equals
 * where it is now.
 *
 * `m` is the transform newly interposed above the element. The element's own
 * values move into `m`'s space: its centre goes through `m⁻¹`, its size divides
 * by `m`'s scale, and its rotation loses `m`'s rotation.
 *
 * Position keyframes go through the same map. When `m` is a pure translation
 * the map is `value − delta` per lane and the result is exact, handles included
 * — the common case, and the only one `createGroup` can produce.
 */
function reframe(
  element: TimelineElement,
  m: Mat,
  cursor: number,
): TimelineElement {
  const inverse = invert(m);
  const any = element as any;

  const scale = scaleOf(inverse);
  const rotationDelta = rotationOf(inverse);

  const w = any.width ?? 0;
  const h = any.height ?? 0;

  // The element's top-left in the new space. `location` is the top-left, and
  // `localMatrixOf` rotates about the centre, so moving the corner through the
  // inverse and then re-deriving from the resized box is what keeps the centre
  // where it was.
  const oldCentre: Point = {
    x: (any.location?.x ?? 0) + w / 2,
    y: (any.location?.y ?? 0) + h / 2,
  };
  const newCentre = applyPoint(inverse, oldCentre);
  const newW = w * scale;
  const newH = h * scale;

  const next: any = {
    ...element,
    location: { x: newCentre.x - newW / 2, y: newCentre.y - newH / 2 },
  };

  if ("width" in any) {
    next.width = newW;
    next.height = newH;
  }
  if ("rotation" in any) {
    next.rotation = (any.rotation ?? 0) + rotationDelta;
  }

  const position = any.animation?.position;
  if (position != null && Array.isArray(position.x)) {
    next.animation = {
      ...any.animation,
      position: reframePositionTrack(position, inverse, w, h, newW, newH),
    };
  }

  return next as TimelineElement;
}

/**
 * Push a paired position track through `inverse`.
 *
 * The lanes hold the element's *top-left* over time. Since the new box may be a
 * different size, each sample is converted to a centre, mapped, and converted
 * back — the same round trip the static `location` takes above, so an animated
 * element and a still one land in the same place.
 *
 * The lanes are mapped together by index. `keyframeOps` enforces that the two
 * lanes of a position track share their anchor instants (`addKeyframePaired`,
 * `moveKeyframePaired`), so index `i` is the same moment on both — and where a
 * legacy project broke that, the fallback below keeps each lane's own time.
 */
function reframePositionTrack(
  track: any,
  inverse: Mat,
  oldW: number,
  oldH: number,
  newW: number,
  newH: number,
): any {
  const xs: Keyframe[] = Array.isArray(track.x) ? track.x : [];
  const ys: Keyframe[] = Array.isArray(track.y) ? track.y : [];

  const paired = xs.length === ys.length && xs.length > 0;

  if (!paired) {
    // Nothing sensible to pair with. A translation still applies cleanly per
    // lane; anything else would need the other axis, which is not there.
    const dx = applyPoint(inverse, { x: 0, y: 0 });
    return {
      ...track,
      x: rebake(offsetKeyframeValues(xs, dx.x)).list,
      ax: rebake(offsetKeyframeValues(xs, dx.x)).baked,
      y: rebake(offsetKeyframeValues(ys, dx.y)).list,
      ay: rebake(offsetKeyframeValues(ys, dx.y)).baked,
    };
  }

  const mappedX: number[] = [];
  const mappedY: number[] = [];
  const mappedCsX: number[] = [];
  const mappedCsY: number[] = [];
  const mappedCeX: number[] = [];
  const mappedCeY: number[] = [];

  const convert = (px: number, py: number) => {
    const centre = applyPoint(inverse, {
      x: px + oldW / 2,
      y: py + oldH / 2,
    });
    return { x: centre.x - newW / 2, y: centre.y - newH / 2 };
  };

  for (let i = 0; i < xs.length; i++) {
    const p = convert(xs[i].p[1], ys[i].p[1]);
    mappedX.push(p.x);
    mappedY.push(p.y);
    const cs = convert(xs[i].cs[1], ys[i].cs[1]);
    mappedCsX.push(cs.x);
    mappedCsY.push(cs.y);
    const ce = convert(xs[i].ce[1], ys[i].ce[1]);
    mappedCeX.push(ce.x);
    mappedCeY.push(ce.y);
  }

  const rebuild = (
    list: Keyframe[],
    p: number[],
    cs: number[],
    ce: number[],
  ): Keyframe[] =>
    list.map((keyframe, i) => ({
      type: keyframe.type,
      p: [keyframe.p[0], p[i]] as [number, number],
      cs: [keyframe.cs[0], cs[i]] as [number, number],
      ce: [keyframe.ce[0], ce[i]] as [number, number],
    }));

  const nextX = rebuild(xs, mappedX, mappedCsX, mappedCeX);
  const nextY = rebuild(ys, mappedY, mappedCsY, mappedCeY);

  return {
    ...track,
    x: nextX,
    ax: bakeTrack(nextX),
    y: nextY,
    ay: bakeTrack(nextY),
  };
}

function rebake(list: Keyframe[]): { list: Keyframe[]; baked: number[][] } {
  return { list, baked: bakeTrack(list) };
}

/**
 * Divide a scale track by `factor`.
 *
 * A group carrying scale hands part of it to each child on ungroup. The static
 * side of this is `width`/`height`, handled in `reframe`; this is the animated
 * side, and it has to move in the same direction or a scaled group's animated
 * child would jump the moment it was released.
 */
function divideScaleTrack(track: any, factor: number): any {
  if (track == null || !Array.isArray(track.x) || factor === 0) {
    return track;
  }
  const next = mapKeyframeValues(track.x, (value) => value / factor);
  return { ...track, x: next, ax: bakeTrack(next) };
}

/** Multiply an opacity track by `factor` (0..1), clamped to 0..100. */
function scaleOpacityTrack(track: any, factor: number): any {
  if (track == null || !Array.isArray(track.x) || factor === 1) {
    return track;
  }
  const next = mapKeyframeValues(track.x, (value) =>
    Math.max(0, Math.min(100, value * factor)),
  );
  return { ...track, x: next, ax: bakeTrack(next) };
}

/** Add `deltaDeg` to every keyframe on a rotation track. */
function offsetRotationTrack(track: any, deltaDeg: number): any {
  if (track == null || !Array.isArray(track.x) || deltaDeg === 0) {
    return track;
  }
  const next = offsetKeyframeValues(track.x, deltaDeg);
  return { ...track, x: next, ax: bakeTrack(next) };
}

// ------------------------------------------------------------- createGroup

export type CreateGroupOptions = {
  /** Shown on the group's bar. Defaults to "Group". */
  name?: string;
  color?: string;
};

/**
 * Wrap `elementIds` in a new group, without moving anything on screen.
 *
 * Declines, by identity, when:
 *   - fewer than one live, groupable element is named;
 *   - any named element is audio, which has nothing to place;
 *   - the named elements do not all share the same current parent — the
 *     compensation each would need differs, and silently reseating half a
 *     selection is worse than refusing;
 *   - the new level would push some descendant past `MAX_GROUP_DEPTH`.
 *
 * The group lands on `trackId`, at the span covering its children, with the
 * selection's bounding box as its `location`/`width`/`height` — which puts its
 * rotation and scale pivot at the centre of what was selected.
 */
export function createGroup(
  doc: TimelineDocument,
  elementIds: string[],
  groupId: string,
  trackId: string,
  options: CreateGroupOptions = {},
): TimelineDocument {
  const elements = doc.elements;

  if (groupId === "" || elements[groupId] != null) {
    return doc;
  }

  // Deduplicate: a selection can name the same clip twice, and the second pass
  // would compensate an already-compensated child.
  const ids = [...new Set(elementIds)].filter((id) => elements[id] != null);
  if (ids.length === 0) {
    return doc;
  }
  if (ids.some((id) => !canBeGrouped(elements[id]))) {
    return doc;
  }

  const sharedParent = parentOf(elements, ids[0]);
  if (ids.some((id) => parentOf(elements, id) !== sharedParent)) {
    return doc;
  }

  // The new group takes the members' place in the chain, so it sits at exactly
  // the depth they occupy now; they move one below it, and whatever hangs off
  // them moves down by the same one. The deepest node afterwards is therefore
  // `groupDepth + 1 + tallest subtree`.
  //
  // The tallest subtree among the members is what decides it, not each member's
  // own depth: a member that is itself a deep group would otherwise slide under
  // the cap on the strength of its root.
  const groupDepth = depthOf(elements, ids[0]);
  const tallest = Math.max(...ids.map((id) => subtreeHeight(elements, id)));
  if (groupDepth + 1 + tallest > MAX_GROUP_DEPTH) {
    return doc;
  }

  const box = boundsOf(elements, ids);
  if (box == null) {
    return doc;
  }

  const startTime = Math.min(...ids.map((id) => elements[id].startTime));
  const endTime = Math.max(...ids.map((id) => spanEnd(elements[id])));

  const group: GroupElementType = {
    filetype: "group",
    name: options.name ?? "Group",
    key: groupId,
    localpath: "GROUP",
    trackId,
    priority: 0,
    blob: "",
    startTime,
    duration: Math.max(MIN_GROUP_DURATION_MS, endTime - startTime),
    location: { x: box.x, y: box.y },
    // Not a size to draw — the pivot. `localMatrixOf` rotates and scales about
    // `w/2, h/2`, so the bounding box puts that at the centre of the selection.
    width: box.w,
    height: box.h,
    ratio: box.h === 0 ? 1 : box.w / box.h,
    opacity: 100,
    rotation: 0,
    animation: emptyAnimation("group"),
    timelineOptions: { color: options.color ?? GROUP_BAR_COLOR },
    ...(sharedParent != null ? { parentId: sharedParent } : {}),
  } as GroupElementType;

  // The group is a pure translation to `box.x, box.y`, so each child owes
  // exactly `−box.x, −box.y`. Exact for the static value and for every
  // keyframe and handle: see the module header.
  const groupMatrix: Mat = { a: 1, b: 0, c: 0, d: 1, e: box.x, f: box.y };

  const next: Timeline = { ...elements, [groupId]: group };
  for (const id of ids) {
    next[id] = {
      ...(reframe(elements[id], groupMatrix, startTime) as any),
      parentId: groupId,
    };
  }

  return normalizeDocument({ ...doc, elements: next });
}

// ----------------------------------------------------------------- ungroup

/**
 * Dissolve a group, leaving its children where they appear at `atMs`.
 *
 * Each child inherits the group's parent and absorbs the group's transform
 * sampled at `atMs` — position into `location`, scale into `width`/`height`,
 * rotation into `rotation`, opacity into `opacity`.
 *
 * **Lossy when the group was animated.** A time-varying transform cannot be
 * folded into a child's static fields, so the group's own animation ends here;
 * `atMs` decides which instant of it survives. Callers that can ask should
 * confirm first — `isGroupAnimated` is provided for exactly that.
 *
 * Declines by identity when `groupId` is not a group.
 */
export function ungroup(
  doc: TimelineDocument,
  groupId: string,
  atMs: number,
): TimelineDocument {
  const elements = doc.elements;
  const group = elements[groupId];
  if (group == null || !isGroupType(group)) {
    return doc;
  }

  const groupMatrix = localMatrixOf(group, atMs);
  const sample = localSampleAt(group, atMs);
  const alpha = sample.opacity / 100;
  const grandparent = parentOf(elements, groupId);

  const next: Timeline = {};
  for (const [id, element] of Object.entries(elements)) {
    if (id === groupId) {
      continue;
    }
    if (parentOf(elements, id) !== groupId) {
      next[id] = element;
      continue;
    }

    // `reframe` removes an interposed transform when handed its inverse, which
    // is what adopting the group's transform into the child amounts to.
    const promoted: any = reframe(element, invert(groupMatrix), atMs);

    if ("opacity" in promoted) {
      promoted.opacity = Math.max(
        0,
        Math.min(100, (promoted.opacity ?? 100) * alpha),
      );
    }
    if (promoted.animation != null) {
      promoted.animation = {
        ...promoted.animation,
        scale: divideScaleTrack(promoted.animation.scale, 1 / sample.scale),
        rotation: offsetRotationTrack(
          promoted.animation.rotation,
          sample.rotationDeg,
        ),
        opacity: scaleOpacityTrack(promoted.animation.opacity, alpha),
      };
    }

    if (grandparent != null) {
      promoted.parentId = grandparent;
    } else {
      delete promoted.parentId;
    }

    next[id] = promoted;
  }

  return normalizeDocument({ ...doc, elements: next });
}

/** Whether dissolving this group would discard animation. */
export function isGroupAnimated(
  elements: Timeline,
  groupId: string,
): boolean {
  const animation = (elements[groupId] as any)?.animation;
  if (animation == null) {
    return false;
  }
  return Object.keys(animation).some(
    (property) =>
      animation[property]?.isActivate === true &&
      (animation[property]?.x?.length ?? 0) > 0,
  );
}

// --------------------------------------------------------------- setParent

/**
 * Move `elementIds` into `parentId` (or out to the canvas with `null`), keeping
 * them where they appear at `atMs`.
 *
 * Declines by identity when any element is missing or ungroupable, when
 * `parentId` is not a live group, when the link would close a cycle, or when it
 * would breach the depth cap. It is all-or-nothing: a partial re-parent would
 * split a selection across two coordinate spaces, which is never what was meant.
 */
export function setParent(
  doc: TimelineDocument,
  elementIds: string[],
  parentId: string | null,
  atMs: number,
): TimelineDocument {
  const elements = doc.elements;
  const ids = [...new Set(elementIds)].filter((id) => elements[id] != null);
  if (ids.length === 0) {
    return doc;
  }
  if (ids.some((id) => !canBeGrouped(elements[id]))) {
    return doc;
  }

  if (parentId != null) {
    if (!isGroupType(elements[parentId] ?? ({} as any))) {
      return doc;
    }
    const parentDepth = depthOf(elements, parentId) + 1;
    for (const id of ids) {
      if (wouldCycle(elements, id, parentId)) {
        return doc;
      }
      if (parentDepth + subtreeHeight(elements, id) > MAX_GROUP_DEPTH) {
        return doc;
      }
    }
  }

  // Nothing to do when every element already sits where it is being sent.
  if (ids.every((id) => parentOf(elements, id) === parentId)) {
    return doc;
  }

  const target =
    parentId == null
      ? { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }
      : worldMatrixOf(elements, parentId, atMs);
  const targetInverse = invert(target);

  const next: Timeline = { ...elements };
  for (const id of ids) {
    // The transform newly interposed above this element is
    // `M_newParent⁻¹ · M_oldParent` seen from its own frame — equivalently,
    // hand `reframe` the change of basis between the two spaces.
    const current = parentOf(elements, id);
    const source =
      current == null
        ? { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }
        : worldMatrixOf(elements, current, atMs);

    const interposed = multiply(targetInverse, source);
    const moved: any = reframe(elements[id], invert(interposed), atMs);

    if (parentId == null) {
      delete moved.parentId;
    } else {
      moved.parentId = parentId;
    }
    next[id] = moved;
  }

  return normalizeDocument({ ...doc, elements: next });
}

/** Detach `elementIds` from whatever holds them, keeping them in place. */
export function removeFromParent(
  doc: TimelineDocument,
  elementIds: string[],
  atMs: number,
): TimelineDocument {
  return setParent(doc, elementIds, null, atMs);
}

/**
 * The group ids among `elementIds` whose whole subtree a delete would take.
 *
 * Exposed so the UI can say how much is about to go.
 */
export function subtreeOf(elements: Timeline, groupId: string): string[] {
  return descendantsOf(elements, groupId);
}
