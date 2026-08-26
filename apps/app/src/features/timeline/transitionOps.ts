/**
 * Transitions: the arithmetic of a cut, and the ops that place one.
 *
 * A transition is a **binary operator on two rendered frames**, not an
 * animation applied to a clip. That distinction decides the whole design.
 *
 * The tempting alternative is to express a slide by writing `position`
 * keyframes onto the two clips. It does not survive contact with real edits:
 * the generated keyframes fight whatever the user already authored, changing
 * the transition's length means recomputing them, and deleting it means
 * knowing which keyframes were ours. Editing becomes destructive.
 *
 * So nothing here writes a keyframe. Clip A evaluates its own animation into
 * one buffer, clip B into another, and the transition mixes the two — a slide
 * is a UV offset in a fragment shader, a swirl is a different fragment shader,
 * and the system cannot tell them apart. Keyframes animate *parameters*;
 * shaders transform *textures*; the two axes stay orthogonal.
 *
 * The second decision is that placing a transition **does not move or trim
 * either clip**. `startTime` and `trim` are untouched on both sides. The
 * transition is a window laid over the cut, and the renderer reads past A's
 * out-point and before B's in-point to fill it — the source frames that are
 * already in the file but outside the trim, what an NLE calls *handles*.
 *
 * That is what keeps `overlap.ts`'s no-overlap invariant intact: the clips
 * still meet at exactly one instant. `occupiesTrack` excludes the transition
 * itself from occupancy arithmetic, and that single exception is the entire
 * cost. Removing a transition restores the edit precisely, and undo needs no
 * special case.
 *
 * Handles are finite, though, and that is what most of this file computes. A
 * clip trimmed to the last frame of its source has no tail; asking for a 2s
 * centred dissolve there is asking for frames that do not exist. The policy is
 * to **shrink rather than refuse**: the transition takes the longest length the
 * two clips can actually supply, and `requestedDuration` remembers what was
 * asked for so the panel can say so and so a later trim can restore it.
 *
 * The arithmetic itself lives in `transitionGeometry.ts`, which imports nothing
 * from `tracks.ts` — that is what lets `repairTransitions` run inside
 * `normalizeDocument` and still share one copy of it with these ops.
 *
 * DOM-free, like the rest of `features/timeline/`.
 */

import {
  occupiesTrack,
  type FxParams,
  type TransitionAlignment,
  type TransitionElementType,
} from "../../@types/timeline";
import { sameParamValue } from "./effectOps";
import {
  cutTimeOf,
  isAdjacent,
  resolveDuration,
  startTimeFor,
} from "./transitionGeometry";
import {
  clipsOnTrack,
  normalizeDocument,
  type TimelineDocument,
} from "./tracks";

/**
 * Every cut on a track, with the transition sitting on it if there is one.
 *
 * Transitions are filtered out of the walk by `occupiesTrack` — they are not
 * clips in a sequence, and including them would invent phantom cuts on both
 * sides of every badge.
 */
export type CutPoint = {
  fromId: string;
  toId: string;
  atMs: number;
  transitionId: string | null;
};

export function cutPointsOn(
  doc: TimelineDocument,
  trackId: string,
): CutPoint[] {
  const clips = clipsOnTrack(doc, trackId).filter(([, element]) =>
    occupiesTrack(element),
  );
  const transitions = transitionsOnTrack(doc, trackId);

  const cuts: CutPoint[] = [];
  for (let i = 0; i + 1 < clips.length; i++) {
    const [fromId, from] = clips[i];
    const [toId, to] = clips[i + 1];
    if (!isAdjacent(from, to)) {
      continue;
    }
    const existing = transitions.find(
      ([, t]) => t.fromId === fromId && t.toId === toId,
    );
    cuts.push({
      fromId,
      toId,
      atMs: cutTimeOf(from),
      transitionId: existing?.[0] ?? null,
    });
  }
  return cuts;
}

/** Every transition element on a track, in time order. */
export function transitionsOnTrack(
  doc: TimelineDocument,
  trackId: string,
): Array<[string, TransitionElementType]> {
  return clipsOnTrack(doc, trackId).filter(
    (entry): entry is [string, TransitionElementType] =>
      entry[1].filetype === "transition",
  );
}

/** The transition on a given cut, if one is already there. */
export function transitionAtCut(
  doc: TimelineDocument,
  fromId: string,
  toId: string,
): string | null {
  for (const [id, element] of Object.entries(doc.elements)) {
    if (
      element.filetype === "transition" &&
      element.fromId === fromId &&
      element.toId === toId
    ) {
      return id;
    }
  }
  return null;
}

function buildTransition(
  fromId: string,
  toId: string,
  trackId: string,
  presetId: string,
  params: FxParams,
  alignment: TransitionAlignment,
  startTime: number,
  duration: number,
  requestedMs: number,
): TransitionElementType {
  return {
    filetype: "transition",
    localpath: "TRANSITION",
    trackId,
    // Derived by `derivePriorities` from track order, like every other element.
    priority: 0,
    blob: "",
    startTime,
    duration,
    // A transition draws nothing of its own at a position, but `TimelinePlaced`
    // requires the field and the timeline UI reads `timelineOptions.color`.
    location: { x: 0, y: 0 },
    timelineOptions: { color: "rgb(150, 120, 200)" },
    presetId,
    params,
    fromId,
    toId,
    alignment,
    // Only recorded when the request was actually cut short. Storing it
    // unconditionally would make every transition look clamped in the panel.
    ...(requestedMs > duration ? { requestedDuration: requestedMs } : {}),
  } as TransitionElementType;
}

/**
 * Attach a transition to the cut between two clips.
 *
 * Declines, returning the document by identity, when:
 *  - either clip is missing, or they are the same element
 *  - they are not on the same track
 *  - they are not adjacent (a gap, or another clip between them)
 *  - that cut already carries a transition
 *  - the handles cannot supply `MIN_TRANSITION_MS`
 *
 * Note what is *not* a decline: asking for longer than the handles allow. That
 * shrinks, and `requestedDuration` records the ask.
 */
export function addTransition(
  doc: TimelineDocument,
  transitionId: string,
  fromId: string,
  toId: string,
  presetId: string,
  requestedMs: number,
  alignment: TransitionAlignment,
  params: FxParams = {},
): TimelineDocument {
  if (fromId === toId) {
    return doc;
  }
  const from = doc.elements[fromId];
  const to = doc.elements[toId];
  if (from == null || to == null) {
    return doc;
  }
  if (from.trackId !== to.trackId) {
    return doc;
  }
  if (!occupiesTrack(from) || !occupiesTrack(to)) {
    return doc;
  }
  if (!isAdjacent(from, to)) {
    return doc;
  }
  if (transitionAtCut(doc, fromId, toId) != null) {
    return doc;
  }
  if (doc.elements[transitionId] != null) {
    return doc;
  }

  const duration = resolveDuration(from, to, requestedMs, alignment);
  if (duration <= 0) {
    return doc;
  }

  const cut = cutTimeOf(from);
  const element = buildTransition(
    fromId,
    toId,
    from.trackId,
    presetId,
    params,
    alignment,
    startTimeFor(cut, duration, alignment),
    duration,
    requestedMs,
  );

  return normalizeDocument({
    ...doc,
    elements: { ...doc.elements, [transitionId]: element },
  });
}

/** The transition at `id`, or `null` if that id is not one. */
function transitionAt(
  doc: TimelineDocument,
  elementId: string,
): TransitionElementType | null {
  const element = doc.elements[elementId];
  return element != null && element.filetype === "transition" ? element : null;
}

/**
 * Re-length a transition, clamped to what its neighbours can supply.
 *
 * The new length is recorded as the request even when it is clamped, so
 * dragging the badge wider than the handles allow and then trimming a
 * neighbour back gives the user the length they asked for rather than the one
 * they were given.
 */
export function setTransitionDuration(
  doc: TimelineDocument,
  elementId: string,
  requestedMs: number,
): TimelineDocument {
  const transition = transitionAt(doc, elementId);
  if (transition == null) {
    return doc;
  }
  const from = doc.elements[transition.fromId];
  const to = doc.elements[transition.toId];
  if (from == null || to == null) {
    return doc;
  }

  const duration = resolveDuration(
    from,
    to,
    requestedMs,
    transition.alignment,
  );
  if (duration <= 0) {
    return doc;
  }

  const startTime = startTimeFor(
    cutTimeOf(from),
    duration,
    transition.alignment,
  );
  if (duration === transition.duration && startTime === transition.startTime) {
    return doc;
  }

  const next: TransitionElementType = {
    ...transition,
    duration,
    startTime,
    ...(requestedMs > duration
      ? { requestedDuration: requestedMs }
      : { requestedDuration: undefined }),
  };

  return normalizeDocument({
    ...doc,
    elements: { ...doc.elements, [elementId]: next },
  });
}

/**
 * Re-anchor a transition to the other side of its cut.
 *
 * The whole reason this is a user-facing control: a clip trimmed to the end of
 * its source has no tail at all, so a centred transition there resolves to
 * zero — but an `end`-aligned one only needs the *incoming* clip's head, which
 * is usually available. Without this the common case of cutting to the end of a
 * take simply refuses transitions.
 *
 * The length is re-resolved against the new alignment, so switching may shrink
 * or grow it.
 */
export function setTransitionAlignment(
  doc: TimelineDocument,
  elementId: string,
  alignment: TransitionAlignment,
): TimelineDocument {
  const transition = transitionAt(doc, elementId);
  if (transition == null || transition.alignment === alignment) {
    return doc;
  }
  const from = doc.elements[transition.fromId];
  const to = doc.elements[transition.toId];
  if (from == null || to == null) {
    return doc;
  }

  const requested = transition.requestedDuration ?? transition.duration;
  const duration = resolveDuration(from, to, requested, alignment);
  if (duration <= 0) {
    return doc;
  }

  const next: TransitionElementType = {
    ...transition,
    alignment,
    duration,
    startTime: startTimeFor(cutTimeOf(from), duration, alignment),
    ...(requested > duration
      ? { requestedDuration: requested }
      : { requestedDuration: undefined }),
  };

  return normalizeDocument({
    ...doc,
    elements: { ...doc.elements, [elementId]: next },
  });
}

/**
 * Swap which preset a transition uses.
 *
 * `params` is replaced wholesale rather than merged, and the caller is expected
 * to pass the new preset's defaults. Carrying the old preset's values across
 * would reinterpret them under keys that mean something else — the failure
 * `filterOps.ts` documents at length, where a blur's `f=5` read as a chromakey
 * threshold makes the clip vanish.
 */
export function setTransitionPreset(
  doc: TimelineDocument,
  elementId: string,
  presetId: string,
  params: FxParams,
): TimelineDocument {
  const transition = transitionAt(doc, elementId);
  if (transition == null) {
    return doc;
  }
  if (transition.presetId === presetId) {
    return doc;
  }

  return {
    ...doc,
    elements: {
      ...doc.elements,
      [elementId]: { ...transition, presetId, params },
    },
  };
}

/**
 * Patch individual parameter values, leaving the rest alone.
 *
 * `FxParams` rather than `Partial<FxParams>`: it is already an index signature,
 * so every key is optional, and wrapping it in `Partial` only adds `undefined`
 * to the value type — which then cannot be written back into the element.
 */
export function setTransitionParams(
  doc: TimelineDocument,
  elementId: string,
  patch: FxParams,
): TimelineDocument {
  const transition = transitionAt(doc, elementId);
  if (transition == null) {
    return doc;
  }

  const entries = Object.entries(patch);
  if (entries.length === 0) {
    return doc;
  }
  if (
    entries.every(([key, value]) =>
      sameParamValue(transition.params[key], value),
    )
  ) {
    return doc;
  }

  return {
    ...doc,
    elements: {
      ...doc.elements,
      [elementId]: {
        ...transition,
        params: { ...transition.params, ...patch },
      },
    },
  };
}

/** Detach a transition. The two clips are already untouched, so this is all. */
export function removeTransition(
  doc: TimelineDocument,
  elementId: string,
): TimelineDocument {
  if (transitionAt(doc, elementId) == null) {
    return doc;
  }
  const { [elementId]: _removed, ...elements } = doc.elements;
  return normalizeDocument({ ...doc, elements });
}
