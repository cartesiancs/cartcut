/**
 * The tutorial, running: the reducer in `session.ts`, driven once a frame
 * against the editor, with the card told where to go.
 *
 * Everything it touches is a port, so the whole of it runs in the node suite
 * against fakes. `browserEnv.ts` is the real editor behind `TutorialEnv`, and
 * `<tutorial-coachmark>` is the real card behind `TutorialView`.
 *
 * One frame does four things, in this order:
 *
 * 1. Compare the editor against the snapshot taken as the step began, and mark
 *    the step done if the user has done it.
 * 2. Let the clock end a finished step's check-mark flash.
 * 3. Find what to point at: the first of the step's targets on screen. A
 *    better one is taken at once; a worse one only once it has lasted
 *    `FALLBACK_SETTLE_MS`, so a tab pane's fade does not throw the card across
 *    the window and back.
 * 4. Tell the view, but only what changed. Nothing is re-rendered or re-placed
 *    on a frame where nothing moved.
 */

import type { FrameScheduler } from "../caption/previewLoop";
import type { Size } from "../menu/menuPlacement";
import type { OnboardingFlagPort } from "../onboarding/onboardingFlag";
import { isStepSatisfied, type TutorialSnapshot } from "./completion";
import { FALLBACK_SETTLE_MS } from "./motion";
import {
  floatingPlacement,
  placeCoachmark,
  ringRect,
  type CoachmarkPlacement,
  type Rect,
} from "./placement";
import {
  IDLE,
  reduceTutorial,
  type TutorialAction,
  type TutorialState,
} from "./session";
import { TUTORIAL_STEPS, type TargetCandidate, type TargetId } from "./steps";
import { isTutorialComplete, markTutorialComplete } from "./tutorialFlag";

/** Where a target is, as much of it as can be seen, or null when none of it can. */
export type TargetProbe = { rect: Rect; clipped: boolean } | null;

/** The editor, as the tutorial sees it. */
export type TutorialEnv = {
  snapshot(): TutorialSnapshot;
  probe(target: TargetId): TargetProbe;
  /** The playhead's x in the window, for the ruler step's arrow. */
  playheadX(): number | null;
  /** Scroll a partly hidden target into its panel. */
  reveal(target: TargetId): void;
  viewport(): { w: number; h: number; insetTop: number };
  /**
   * Something is in front of the editor (a modal, the tour): hide the card and
   * judge nothing until it is gone.
   */
  suspended(): boolean;
  /** Start listening for what `snapshot` cannot read afterwards; returns the teardown. */
  watch(): () => void;
};

export type CardModel = {
  step: number;
  phase: "showing" | "done";
  /** A fallback's reason, when the card is pointing at a prerequisite. */
  hintKey: string | null;
  hidden: boolean;
};

export type CardLayout = { ring: Rect | null; card: CoachmarkPlacement };

export type TutorialView = {
  /** null takes the card away entirely. */
  show(model: CardModel | null): void;
  cardSize(): Size | null;
  place(layout: CardLayout | null): void;
};

export type TutorialPorts = {
  env: TutorialEnv;
  view: TutorialView;
  flag: OnboardingFlagPort;
  scheduler: FrameScheduler;
  now(): number;
};

export type TutorialRunner = {
  readonly state: TutorialState;
  /** Starts from the first step unless the tutorial was finished or skipped before. */
  startIfNew(): Promise<boolean>;
  /** Starts from the first step whatever happened before. */
  restart(): void;
  /**
   * Takes the card away and forgets the run, recording nothing, so the next
   * `startIfNew` begins from the first step. For the tour being reset.
   */
  reset(): void;
  next(): void;
  skip(): void;
  /** Measure the card and place it; the view calls this after it re-renders. */
  layout(): void;
  dispose(): void;
};

/** What the card is pointing at, by its index in the step's list. */
type Pointed = {
  /** `targets.length` when nothing in the list is on screen. */
  index: number;
  candidate: TargetCandidate | null;
  rect: Rect | null;
};

export function createTutorialRunner(ports: TutorialPorts): TutorialRunner {
  const { env, view, flag, scheduler } = ports;

  let state: TutorialState = IDLE;
  // Read through this after a dispatch: TypeScript keeps a narrowing of
  // `state` across a call that reassigned it.
  const current = (): TutorialState => state;

  /** The editor as the current step began. */
  let baseline: TutorialSnapshot | null = null;
  /**
   * The editor at the moment the current step was done, which becomes the
   * next step's baseline. Taking it at the next step's *start* instead would
   * lose whatever the user did during the check-mark flash: open the Text
   * tab and click the Text tile straight away, and the tile's text would land
   * before the "add a text" step began and never count.
   */
  let carried: TutorialSnapshot | null = null;

  let frame: number | null = null;
  let unwatch: (() => void) | null = null;
  let pointed: Pointed | null = null;
  let pending: { index: number; since: number } | null = null;
  let revealed = new Set<TargetId>();
  let hidden = false;
  let modelKey = "";
  let layoutKey = "";
  let disposed = false;

  const dispatch = (action: TutorialAction) => {
    if (disposed) return;

    const prev = state;
    const next = reduceTutorial(prev, action);
    if (next === prev) return;
    state = next;

    if (next.kind === "finished") {
      // Never rejects: see `onboardingFlag.ts#bothOf`.
      void markTutorialComplete(flag);
      stop();
      return;
    }

    if (next.kind === "idle") {
      stop();
      return;
    }

    if (prev.kind !== "running") unwatch = env.watch();

    if (next.phase === "done") {
      carried = env.snapshot();
    } else {
      // Every way into `showing` is the start of a step.
      if (action.type === "start" || action.type === "restart") carried = null;
      enterStep();
    }

    refresh(ports.now());
    schedule();
  };

  const enterStep = () => {
    baseline = carried ?? env.snapshot();
    carried = null;
    pointed = null;
    pending = null;
    revealed = new Set();
  };

  const stop = () => {
    if (frame !== null) scheduler.cancel(frame);
    frame = null;
    unwatch?.();
    unwatch = null;
    baseline = null;
    carried = null;
    pointed = null;
    pending = null;
    modelKey = "";
    layoutKey = "";
    view.show(null);
    view.place(null);
  };

  const schedule = () => {
    if (frame !== null || disposed || current().kind !== "running") return;
    frame = scheduler.request(onFrame);
  };

  const onFrame = () => {
    frame = null;
    const now = ports.now();

    const before = current();
    if (before.kind !== "running") return;

    if (!env.suspended()) {
      if (
        before.phase === "showing" &&
        baseline !== null &&
        isStepSatisfied(
          TUTORIAL_STEPS[before.step].completion,
          baseline,
          env.snapshot(),
        )
      ) {
        dispatch({ type: "satisfied", step: before.step, now });
      }
      dispatch({ type: "tick", now });
    }

    if (current().kind !== "running") return;
    refresh(now);
    schedule();
  };

  /** Hidden or not, then what to point at, then the view. */
  const refresh = (now: number) => {
    hidden = env.suspended();
    if (!hidden) resolve(now);
    publish();
    layout();
  };

  const resolve = (now: number) => {
    const s = current();
    if (s.kind !== "running") return;

    const { targets } = TUTORIAL_STEPS[s.step];
    let found: Pointed = { index: targets.length, candidate: null, rect: null };
    let clipped = false;

    for (let i = 0; i < targets.length; i++) {
      const probe = env.probe(targets[i].target);
      if (probe) {
        found = { index: i, candidate: targets[i], rect: probe.rect };
        clipped = probe.clipped;
        break;
      }
    }

    if (pointed === null || found.index <= pointed.index) {
      pointed = found;
      pending = null;
    } else if (pending === null || pending.index !== found.index) {
      // Worse than what the card shows: start the clock, and keep pointing
      // where the better target was last seen.
      pending = { index: found.index, since: now };
    } else if (now - pending.since >= FALLBACK_SETTLE_MS) {
      pointed = found;
      pending = null;
    }

    const target = found.candidate?.target;
    if (
      target !== undefined &&
      clipped &&
      pointed.index === found.index &&
      !revealed.has(target)
    ) {
      // Once per target per step: after that, a user scrolling the panel is
      // scrolling it on purpose.
      revealed.add(target);
      env.reveal(target);
    }
  };

  const publish = () => {
    const s = current();
    if (s.kind !== "running") return;

    const model: CardModel = {
      step: s.step,
      phase: s.phase,
      hintKey: pointed?.candidate?.hintKey ?? null,
      hidden,
    };
    const key = `${model.step}|${model.phase}|${model.hintKey}|${model.hidden}`;
    if (key === modelKey) return;

    modelKey = key;
    view.show(model);
  };

  const layout = () => {
    const s = current();
    if (s.kind !== "running") return;

    if (hidden) {
      placeIfChanged(null);
      return;
    }

    const size = view.cardSize();
    if (size === null || !(size.w > 0) || !(size.h > 0)) return;

    const viewport = env.viewport();
    const step = TUTORIAL_STEPS[s.step];

    if (pointed?.rect) {
      const x = step.anchor === "playhead" ? env.playheadX() : null;
      placeIfChanged({
        ring: ringRect(pointed.rect, viewport),
        card: placeCoachmark(pointed.rect, size, viewport, {
          side: step.side,
          anchor: x === null ? undefined : { x },
          insetTop: viewport.insetTop,
        }),
      });
      return;
    }

    placeIfChanged({
      ring: null,
      card: floatingPlacement(size, viewport, viewport.insetTop),
    });
  };

  const placeIfChanged = (next: CardLayout | null) => {
    const key = next === null ? "none" : layoutKeyOf(next);
    if (key === layoutKey) return;

    layoutKey = key;
    view.place(next);
  };

  return {
    get state() {
      return state;
    },

    async startIfNew() {
      if (disposed || current().kind === "running") return false;
      if (await isTutorialComplete(flag)) return false;
      // The flag is IPC; the world may have moved on while it answered.
      if (disposed || current().kind === "running") return false;

      dispatch({ type: "start" });
      return true;
    },

    restart: () => dispatch({ type: "restart" }),
    reset: () => dispatch({ type: "reset" }),
    next: () => dispatch({ type: "next" }),
    skip: () => dispatch({ type: "skip" }),
    layout,

    dispose() {
      if (disposed) return;
      stop();
      disposed = true;
    },
  };
}

/** Whole pixels: a sub-pixel wobble in a measurement is not a move. */
function layoutKeyOf({ ring, card }: CardLayout): string {
  const r = Math.round;
  const ringKey = ring
    ? `${r(ring.left)},${r(ring.top)},${r(ring.width)},${r(ring.height)}`
    : "-";
  return `${ringKey}|${r(card.left)},${r(card.top)},${card.side},${r(card.arrow)},${card.overlaps}`;
}
