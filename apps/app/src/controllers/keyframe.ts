import { ReactiveController, ReactiveControllerHost } from "lit";
import { useTimelineStore } from "../states/timelineStore";
import type { AnimatableProperty } from "../@types/timeline";
import {
  addKeyframePaired,
  moveKeyframePaired,
  removeKeyframePaired,
  setHandles,
  setTrackActive,
  type Lane,
} from "../features/animation/keyframeOps";
import type { TimelineDocument } from "../features/timeline/tracks";

/**
 * The keyframe editing entry point for the option panels and the curve editor.
 *
 * It is now an adapter and nothing else: every method turns its arguments into
 * one pure document transform and hands it to `withCheckpoint`, which is the
 * same path clip edits take.
 *
 * What it used to be is worth recording, because the failure was not obvious.
 * It cached `this.timeline` from the store, mutated that object graph in place,
 * and called `patchTimeline` — which records no undo entry. Since
 * `derivePriorities` spreads elements shallowly, every `HistoryEntry` shared
 * its `animation` objects with the live document, so an edit did not merely
 * fail to be undoable: it reached back and rewrote every step already on the
 * stack. It also held a `useTimelineStore.subscribe` it never unsubscribed, one
 * per host component.
 *
 * Baking is no longer a second call the caller has to remember either —
 * `keyframeOps` writes the authored list and its baked samples together.
 */
export class KeyframeController implements ReactiveController {
  private host: ReactiveControllerHost;

  constructor(host: ReactiveControllerHost) {
    (this.host = host).addController(this);
  }

  /** Apply one document transform as a single undo step. */
  private commit(fn: (doc: TimelineDocument) => TimelineDocument) {
    useTimelineStore.getState().withCheckpoint(fn);
  }

  private static laneOf(line: unknown): Lane {
    return Number(line) === 1 ? "y" : "x";
  }

  /**
   * Add or replace a keyframe, activating the track.
   *
   * `x` is the time in element-relative ms and `y` the value — the argument
   * names the option panels have always passed, kept so their call sites did
   * not all have to change at once.
   */
  addPoint({
    x,
    y,
    line,
    elementId,
    animationType,
  }: {
    x: number | string;
    y: number | string;
    line: number | string;
    elementId: string;
    animationType: AnimatableProperty | string;
  }) {
    const lane = KeyframeController.laneOf(line);
    const property = animationType as AnimatableProperty;
    const tMs = typeof x === "string" ? parseFloat(x) : x;
    const value = typeof y === "string" ? parseFloat(y) : y;

    this.commit((doc) =>
      setTrackActive(
        addKeyframePaired(doc, elementId, property, lane, tMs, value),
        elementId,
        property,
        true,
      ),
    );
  }

  removePoint({
    elementId,
    animationType,
    line,
    index,
  }: {
    elementId: string;
    animationType: AnimatableProperty | string;
    line: number | string;
    index: number;
  }) {
    this.commit((doc) =>
      removeKeyframePaired(
        doc,
        elementId,
        animationType as AnimatableProperty,
        KeyframeController.laneOf(line),
        index,
      ),
    );
  }

  /**
   * Move a keyframe, returning the index it ended up at.
   *
   * A drag past a neighbour re-sorts the list, so the caller's index is stale
   * the moment that happens — holding it would move a different keyframe on the
   * next mousemove.
   */
  movePoint({
    elementId,
    animationType,
    line,
    index,
    tMs,
    value,
  }: {
    elementId: string;
    animationType: AnimatableProperty | string;
    line: number | string;
    index: number;
    tMs: number;
    value: number;
  }): number {
    const lane = KeyframeController.laneOf(line);
    const property = animationType as AnimatableProperty;
    let landedAt = index;

    this.commit((doc) => {
      const moved = moveKeyframePaired(
        doc,
        elementId,
        property,
        lane,
        index,
        tMs,
        value,
      );
      landedAt = moved.index;
      return moved.doc;
    });

    return landedAt;
  }

  setHandles({
    elementId,
    animationType,
    line,
    index,
    cs,
    ce,
  }: {
    elementId: string;
    animationType: AnimatableProperty | string;
    line: number | string;
    index: number;
    cs?: [number, number];
    ce?: [number, number];
  }) {
    this.commit((doc) =>
      setHandles(
        doc,
        elementId,
        animationType as AnimatableProperty,
        KeyframeController.laneOf(line),
        index,
        { cs, ce },
      ),
    );
  }

  /** Turn a property's animation on or off, seeding it from the static value. */
  setActive({
    elementId,
    animationType,
    active,
    atMs,
  }: {
    elementId: string;
    animationType: AnimatableProperty | string;
    active: boolean;
    atMs?: number;
  }) {
    this.commit((doc) =>
      setTrackActive(
        doc,
        elementId,
        animationType as AnimatableProperty,
        active,
        active && atMs != null ? { atMs } : undefined,
      ),
    );
  }

  hostConnected() {}

  hostDisconnected() {}
}
