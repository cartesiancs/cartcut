/**
 * The real editor behind `runner.ts#TutorialEnv`: its stores, its DOM, and the
 * one listener the snapshot cannot do without.
 *
 * Every read here happens once a frame while the tutorial is up, so each one
 * is kept cheap: the timeline is counted only when its object changes, and a
 * target is re-queried each frame (Lit may have replaced the node) but the
 * walk up its clipping ancestors is cached per element.
 */

import type { Timeline } from "../../@types/timeline";
import { assetStore } from "../../states/assetStore";
import { renderOptionStore } from "../../states/renderOptionStore";
import { useTimelineStore } from "../../states/timelineStore";
import {
  IDLE_RULER,
  pressRuler,
  releaseRuler,
  type RulerGesture,
} from "./completion";
import { intersectRects, playheadClientX, revealDelta, type Rect } from "./placement";
import type { TargetProbe, TutorialEnv } from "./runner";
import { TARGET_SELECTORS, type TargetId } from "./steps";

/** Targets that are one of many alike; the first one on screen is used. */
const MANY: ReadonlySet<TargetId> = new Set<TargetId>(["asset-file", "asset-folder"]);

const toRect = (r: DOMRect): Rect => ({
  left: r.left,
  top: r.top,
  width: r.width,
  height: r.height,
});

const clips = (style: CSSStyleDeclaration) =>
  style.overflowX !== "visible" || style.overflowY !== "visible";

const scrolls = (style: CSSStyleDeclaration) =>
  style.overflowY === "auto" || style.overflowY === "scroll";

export function browserTutorialEnv(): TutorialEnv {
  let gesture: RulerGesture = IDLE_RULER;

  let countedTimeline: Timeline | null = null;
  let counts = { elements: 0, texts: 0 };

  /** Ancestors that clip their content, nearest first. */
  const clippers = new WeakMap<Element, Element[]>();
  /** The tile last chosen for each many-of-a-kind target. */
  const lastPicked = new Map<TargetId, Element>();

  const clippingAncestors = (element: Element): Element[] => {
    let list = clippers.get(element);
    if (list) return list;

    list = [];
    for (let at = element.parentElement; at; at = at.parentElement) {
      if (clips(getComputedStyle(at))) list.push(at);
    }
    clippers.set(element, list);
    return list;
  };

  /**
   * The part of `element` that can be seen: its box cut by every ancestor that
   * clips, then by the window. A tab pane that is not active is
   * `display: none`, so everything in it measures 0x0 and is reported as gone,
   * which is what sends a step to its fallback.
   */
  const visiblePart = (element: Element): TargetProbe => {
    if (!element.isConnected) return null;

    const box = toRect(element.getBoundingClientRect());
    if (!(box.width > 0 && box.height > 0)) return null;

    let seen: Rect | null = box;
    for (const ancestor of clippingAncestors(element)) {
      seen = intersectRects(seen, toRect(ancestor.getBoundingClientRect()));
      if (!seen) return null;
    }

    seen = intersectRects(seen, {
      left: 0,
      top: 0,
      width: window.innerWidth,
      height: window.innerHeight,
    });
    if (!seen) return null;

    // A sliver is as good as hidden: the ring would outline a line.
    if (seen.width < 4 || seen.height < 4) return null;

    const clipped = seen.width < box.width - 1 || seen.height < box.height - 1;
    return { rect: seen, clipped };
  };

  const find = (target: TargetId): Element | null => {
    const selector = TARGET_SELECTORS[target];
    if (!MANY.has(target)) return document.querySelector(selector);

    // A folder can hold thousands of tiles. Keep the one chosen last frame
    // while it is still on screen, and only scan when it is not.
    const last = lastPicked.get(target);
    if (last && visiblePart(last)) return last;

    for (const element of document.querySelectorAll(selector)) {
      if (visiblePart(element)) {
        lastPicked.set(target, element);
        return element;
      }
    }
    lastPicked.delete(target);
    return null;
  };

  const countTimeline = () => {
    const timeline = useTimelineStore.getState().timeline;
    if (timeline === countedTimeline) return counts;

    let elements = 0;
    let texts = 0;
    for (const key in timeline) {
      elements += 1;
      if (timeline[key]?.filetype === "text") texts += 1;
    }

    countedTimeline = timeline;
    counts = { elements, texts };
    return counts;
  };

  const activeSidebarTab = (): string | null => {
    const target = document
      .querySelector("#sidebar .btn-nav.active")
      ?.getAttribute("data-bs-target");
    return target ? target.replace(/^#nav-/, "") : null;
  };

  return {
    snapshot() {
      const { elements, texts } = countTimeline();
      return {
        durationSec: renderOptionStore.getState().options.duration,
        hasDirectory: assetStore.getState().nowDirectory !== "",
        elementCount: elements,
        textCount: texts,
        activeSidebarTab: activeSidebarTab(),
        rulerMoves: gesture.moves,
      };
    },

    probe(target) {
      const element = find(target);
      return element ? visiblePart(element) : null;
    },

    playheadX() {
      const ruler = document.querySelector(TARGET_SELECTORS["timeline-ruler"]);
      if (!ruler) return null;

      const { cursor, range, scroll } = useTimelineStore.getState();
      return playheadClientX(
        ruler.getBoundingClientRect().left,
        cursor,
        range,
        scroll,
      );
    },

    reveal(target) {
      const element = find(target);
      if (!element) return;

      for (let at = element.parentElement; at; at = at.parentElement) {
        if (!scrolls(getComputedStyle(at)) || at.scrollHeight <= at.clientHeight) {
          continue;
        }
        const delta = revealDelta(
          toRect(element.getBoundingClientRect()),
          toRect(at.getBoundingClientRect()),
        );
        if (delta !== 0) at.scrollTop += delta;
        return;
      }
    },

    viewport() {
      const bar = document.querySelector(".top-bar");
      return {
        w: window.innerWidth,
        h: window.innerHeight,
        insetTop: bar ? Math.max(0, bar.getBoundingClientRect().bottom) : 0,
      };
    },

    suspended() {
      // A Bootstrap modal's backdrop sits at z-index 1040, under the card; the
      // tour's scrim is the tour still on screen.
      return (
        document.body.classList.contains("modal-open") ||
        document.querySelector(".onboarding-scrim") !== null
      );
    },

    watch() {
      // Capture, on `window`: the ruler stops its own mousedown from
      // propagating, and this has to read the cursor before the ruler's
      // handler moves it.
      const down = (event: MouseEvent) => {
        if (event.button !== 0) return;
        const target = event.target as Element | null;
        if (!target?.closest?.("element-timeline-ruler")) return;
        gesture = pressRuler(gesture, useTimelineStore.getState().cursor);
      };
      const up = () => {
        gesture = releaseRuler(gesture, useTimelineStore.getState().cursor);
      };

      window.addEventListener("mousedown", down, true);
      window.addEventListener("mouseup", up, true);

      return () => {
        window.removeEventListener("mousedown", down, true);
        window.removeEventListener("mouseup", up, true);
        gesture = IDLE_RULER;
      };
    },
  };
}
