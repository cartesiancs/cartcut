/**
 * The stabilize rig, read from the element map.
 *
 * A rig is two groups that `features/track/stabilizeOp.ts` builds and nothing
 * else does:
 *
 * ```
 * zoom    root, rig: "stabilize-zoom"; its pivot is the target, its scale the zoom
 *  └ camera   rig: "stabilize-camera"; position = an affine copy of a null's
 *     ├ the footage            parentId written directly, numbers untouched
 *     └ the tracking null(s)   the same
 * ```
 *
 * Everything under the camera keeps the numbers it had before it went in, so
 * its local space there is exactly the world it was measured in. That is the
 * one fact the rest of this file leans on: taking a member out is dropping its
 * `parentId`, and measuring it as it was is reading it without the camera.
 *
 * **No imports but types.** `geometry.ts` and `groupOps.ts` both need these
 * answers, and `groupOps.ts` imports `geometry.ts`, so anything this file
 * imported from either would close a cycle.
 */

import type { RigRole, Timeline, TimelineElement } from "../../@types/timeline";

export const RIG_ZOOM: RigRole = "stabilize-zoom";
export const RIG_CAMERA: RigRole = "stabilize-camera";

export type Rig = { zoomId: string; cameraId: string };

/**
 * The part a group plays in a rig, or `null`.
 *
 * The read guard: only a group, and only one of the two exact strings. A key
 * on anything else, or any other value, is no rig at all.
 */
export function rigRoleOf(element: unknown): RigRole | null {
  const candidate = element as { filetype?: unknown; rig?: unknown } | null;
  if (candidate == null || candidate.filetype !== "group") {
    return null;
  }
  return candidate.rig === RIG_ZOOM || candidate.rig === RIG_CAMERA
    ? (candidate.rig as RigRole)
    : null;
}

/** `parentId` when it is a non-empty string, else `null`. Dangling is kept. */
function parentIdOf(element: unknown): string | null {
  const parentId = (element as { parentId?: unknown } | null)?.parentId;
  return typeof parentId === "string" && parentId !== "" ? parentId : null;
}

/** The ids whose `parentId` names `groupId`, in key order. */
export function rigChildrenOf(elements: Timeline, groupId: string): string[] {
  const out: string[] = [];
  for (const [id, element] of Object.entries(elements)) {
    if (parentIdOf(element) === groupId) {
      out.push(id);
    }
  }
  return out;
}

/**
 * The intact rig `id` belongs to: as its zoom, its camera, or a direct child
 * of its camera. `null` for anything else, and for a rig that is no longer
 * whole.
 *
 * Whole means exactly what the build leaves: a zoom at the root, and exactly
 * one camera inside it. A pasted half, a camera moved somewhere else or a
 * second camera under one zoom is not a rig, so nothing treats it as one and
 * the ordinary group rules apply to it.
 */
export function rigOf(elements: Timeline, id: string): Rig | null {
  const element = elements[id];
  if (element == null) {
    return null;
  }

  let cameraId: string | null = null;
  const role = rigRoleOf(element);
  if (role === RIG_ZOOM) {
    const cameras = rigChildrenOf(elements, id).filter(
      (child) => rigRoleOf(elements[child]) === RIG_CAMERA,
    );
    if (cameras.length !== 1) {
      return null;
    }
    cameraId = cameras[0];
  } else if (role === RIG_CAMERA) {
    cameraId = id;
  } else {
    const parentId = parentIdOf(element);
    if (parentId == null || rigRoleOf(elements[parentId]) !== RIG_CAMERA) {
      return null;
    }
    cameraId = parentId;
  }

  const zoomId = parentIdOf(elements[cameraId]);
  if (zoomId == null) {
    return null;
  }
  const zoom = elements[zoomId];
  if (rigRoleOf(zoom) !== RIG_ZOOM || parentIdOf(zoom) != null) {
    return null;
  }
  const cameras = rigChildrenOf(elements, zoomId).filter(
    (child) => rigRoleOf(elements[child]) === RIG_CAMERA,
  );
  if (cameras.length !== 1 || cameras[0] !== cameraId) {
    return null;
  }

  return { zoomId, cameraId };
}

/**
 * Whether `id` is held by a rig: one of its two groups, or something sitting
 * directly in a camera.
 *
 * These are the elements whose own numbers the lock is built on. Moving the
 * footage, the null or the camera by hand, or re-parenting any of them, would
 * leave the camera's copy describing a picture that is no longer there, so the
 * preview does not hand them to the pointer and `setParent` declines them.
 * Something parented to a null inside the camera, a label riding the tracked
 * point, is not held: it can move freely without disturbing anything.
 */
export function isRigMember(elements: Timeline, id: string): boolean {
  return isHeldByRig(elements, elements[id]);
}

/** `isRigMember` for a caller holding the element rather than its id. */
export function isHeldByRig(
  elements: Timeline,
  element: TimelineElement | null | undefined,
): boolean {
  if (element == null) {
    return false;
  }
  if (rigRoleOf(element) != null) {
    return true;
  }
  const parentId = parentIdOf(element);
  return parentId != null && rigRoleOf(elements[parentId]) === RIG_CAMERA;
}

/**
 * The element map as it was before the rig, for one clip.
 *
 * The clip's `parentId` is dropped when it names a rig camera, and nothing
 * else changes, which is exact because the clip's numbers were never
 * rewritten: its world matrix without the camera is the one it had before.
 * The space `toDisplayedPath` has to measure a stabilized clip in, or a second
 * track would read a picture the camera has already moved.
 */
export function preRigElements(elements: Timeline, clipId: string): Timeline {
  const clip = elements[clipId];
  const parentId = parentIdOf(clip);
  if (parentId == null || rigRoleOf(elements[parentId]) !== RIG_CAMERA) {
    return elements;
  }
  return { ...elements, [clipId]: withoutParent(clip) };
}

/** A copy of `element` with no `parentId` key. */
export function withoutParent<T extends TimelineElement>(element: T): T {
  const { parentId: _dropped, ...rest } = element as T & { parentId?: unknown };
  return rest as T;
}
