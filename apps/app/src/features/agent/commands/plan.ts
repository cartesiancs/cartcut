/**
 * A whole edit, applied as one undo step.
 *
 * This is the thing neither `video-use` nor Remotion can offer. Both re-render
 * files; Cartcut edits the live timeline the user is watching, and because
 * every op here is a pure `(TimelineDocument) => TimelineDocument`, a plan with
 * forty cuts, twelve captions, six punch-ins and three transitions composes
 * into **one** `withCheckpoint`. A user who dislikes the result gets back to
 * where they were with a single Cmd+Z rather than sixty.
 *
 * That is the whole reason this file exists. Running the same steps through the
 * individual commands would produce the same timeline and sixty history
 * entries, and an agent whose work takes sixty undos to reject may as well not
 * have undo.
 *
 * ## The intelligence is not here
 *
 * Nothing in this file decides what makes a good edit. It has no heuristic for
 * which take is best or where a punch-in belongs, because a model is better at
 * that than any rule I could write, and a rule would quietly override its
 * judgement. What this owns is the mechanics: order the steps so they do not
 * fight each other, mint ids where they must be stable, and put the whole thing
 * behind one checkpoint.
 *
 * ## Order matters, and it is fixed here rather than left to the caller
 *
 * Cuts first, because every later step is addressed in timeline time and a
 * ripple delete moves everything after it. Then motion and appearance on the
 * clips that survived, then things laid on top. A caller that had to know this
 * would get it wrong on the plan where it mattered.
 */

import { v4 as uuidv4 } from "uuid";
import { renderOptionStore } from "../../../states/renderOptionStore";
import { createTextElement } from "../../element/textElement";
import { placeNewElement } from "../../timeline/placement";
import { removeRanges } from "../../timeline/clipOps";
import { addTransition } from "../../timeline/transitionOps";
import { addEffect, addEffectTrack } from "../../timeline/effectOps";
import { tracksOfKind, type TimelineDocument } from "../../timeline/tracks";
import { applyPreset, presetDefaultMs, type PresetName } from "../../animation/presets";
import { bakeRateFor } from "../../animation/keyframes";
import { commit } from "../commit";
import { currentDoc } from "../context";
import { registerCommands } from "../registry";

type Range = { startMs: number; endMs: number };

type CaptionStyle = {
  fontsize?: number;
  textcolor?: string;
  align?: "left" | "center" | "right";
  background?: boolean;
  locationX?: number;
  locationY?: number;
  width?: number;
  height?: number;
};

type Plan = {
  cuts?: Array<{ elementId: string; ranges: Range[]; ripple?: boolean }>;
  motion?: Array<{
    elementIds: string[];
    preset: PresetName;
    durationMs?: number;
    focus?: { x: number; y: number };
  }>;
  captions?: Array<{ text: string; startMs: number; durationMs: number }>;
  captionStyle?: CaptionStyle;
  titles?: Array<{
    text: string;
    startMs: number;
    durationMs: number;
    style?: CaptionStyle;
  }>;
  transitions?: Array<{
    fromId: string;
    toId: string;
    presetId: string;
    durationMs?: number;
    alignment?: "center" | "start" | "end";
  }>;
  effects?: Array<{
    presetId: string;
    startMs: number;
    durationMs: number;
    intensity?: number;
  }>;
};

/**
 * Where a caption sits when the plan does not say.
 *
 * The same lower third `commands/text.ts` computes, derived from the project's
 * own resolution rather than assuming 1080p — so a vertical project does not
 * put its captions off the bottom of the frame.
 */
function defaultLayout(style: CaptionStyle) {
  const { w, h } = renderOptionStore.getState().options.previewSize;
  const fontsize = style.fontsize ?? Math.round(h / 20);
  const height = style.height ?? Math.round(fontsize * 1.3);
  const bottomPadding = Math.round(h / 10);

  return {
    fontsize,
    height,
    width: style.width ?? w,
    locationX: style.locationX ?? 0,
    locationY: style.locationY ?? h - bottomPadding - fontsize,
  };
}

function textElementFrom(
  text: string,
  startMs: number,
  durationMs: number,
  style: CaptionStyle,
) {
  return createTextElement({
    ...defaultLayout(style),
    text,
    textcolor: style.textcolor ?? "#ffffff",
    optionsAlign: style.align ?? "center",
    backgroundEnable: style.background === true,
    startTime: startMs,
    duration: durationMs,
  });
}

/** How many steps a plan holds, for the summary and for refusing an empty one. */
function stepCount(plan: Plan): number {
  return (
    (plan.cuts?.length ?? 0) +
    (plan.motion?.length ?? 0) +
    (plan.captions?.length ?? 0) +
    (plan.titles?.length ?? 0) +
    (plan.transitions?.length ?? 0) +
    (plan.effects?.length ?? 0)
  );
}

registerCommands({
  apply_edit_plan: (params: { plan?: Plan }) => {
    const plan = params.plan ?? {};
    const steps = stepCount(plan);
    if (steps === 0) {
      throw new Error(
        "apply_edit_plan needs a plan with something in it: cuts, motion, captions, titles, transitions or effects.",
      );
    }

    const doc = currentDoc();
    for (const cut of plan.cuts ?? []) {
      if (doc.elements[cut.elementId] == null) {
        throw new Error(
          `No clip with id "${cut.elementId}" to cut. Nothing has been applied.`,
        );
      }
    }

    const bakeHz = bakeRateFor(renderOptionStore.getState().options.fps);

    // Ids are minted here, not inside the transform. `commit` runs the
    // transform twice — once to probe whether it declines — and ids generated
    // inside would differ between the two runs, so the ids reported back would
    // not be the ones in the document.
    const captionIds = (plan.captions ?? []).map(() => ({
      element: uuidv4(),
      track: uuidv4(),
    }));
    const titleIds = (plan.titles ?? []).map(() => ({
      element: uuidv4(),
      track: uuidv4(),
    }));
    const transitionIds = (plan.transitions ?? []).map(() => uuidv4());
    const effectIds = (plan.effects ?? []).map(() => ({
      element: uuidv4(),
      track: uuidv4(),
    }));
    const effectTrackId = uuidv4();
    // `removeRanges` mints an id per piece a cut splits off. Pre-generating a
    // pool keeps that stable across the probe too; it is drawn from in order.
    const splitIds = (plan.cuts ?? []).map((cut) =>
      cut.ranges.map(() => uuidv4()),
    );

    return commit((d: TimelineDocument) => {
      let next = d;

      // 1. Cuts. First, because a ripple moves everything after it and every
      // later step is addressed in timeline time.
      (plan.cuts ?? []).forEach((cut, index) => {
        const pool = [...splitIds[index]];
        let drawn = 0;
        next = removeRanges(
          next,
          cut.elementId,
          cut.ranges,
          cut.ripple !== false,
          () => pool[drawn++] ?? uuidv4(),
        );
      });

      // 2. Motion, on the clips that survived the cuts.
      for (const move of plan.motion ?? []) {
        const durationMs = move.durationMs ?? presetDefaultMs(move.preset);
        for (const id of move.elementIds) {
          if (next.elements[id] == null) {
            // A clip the cuts removed. Skipping is right: the plan was written
            // against the timeline as it was, and failing the whole edit over
            // one stale id would be worse than doing the rest.
            continue;
          }
          next = applyPreset(next, id, move.preset, durationMs, bakeHz, {
            focus: move.focus,
          });
        }
      }

      // 3. Transitions, once the clips either side are in their final places.
      (plan.transitions ?? []).forEach((transition, index) => {
        next = addTransition(
          next,
          transitionIds[index],
          transition.fromId,
          transition.toId,
          transition.presetId,
          transition.durationMs ?? 500,
          transition.alignment ?? "center",
          {},
        );
      });

      // 4. Captions and titles, laid on top.
      const captionStyle = plan.captionStyle ?? {};
      (plan.captions ?? []).forEach((caption, index) => {
        const element = textElementFrom(
          caption.text,
          caption.startMs,
          caption.durationMs,
          captionStyle,
        );
        next = placeNewElement(
          next,
          captionIds[index].element,
          element,
          caption.startMs,
          captionIds[index].track,
        );
      });

      (plan.titles ?? []).forEach((title, index) => {
        const element = textElementFrom(
          title.text,
          title.startMs,
          title.durationMs,
          title.style ?? {},
        );
        next = placeNewElement(
          next,
          titleIds[index].element,
          element,
          title.startMs,
          titleIds[index].track,
        );
      });

      // 5. Effects last, on a row above everything, because that is what an
      // adjustment layer applying to the whole composite means.
      if ((plan.effects ?? []).length > 0) {
        if (tracksOfKind(next, "effect").length === 0) {
          next = addEffectTrack(next, effectTrackId);
        }
        const row = tracksOfKind(next, "effect")[0]?.id;

        (plan.effects ?? []).forEach((effect, index) => {
          next = addEffect(
            next,
            effectIds[index].element,
            effect.presetId,
            Math.max(0, effect.startMs),
            effect.durationMs,
            effectIds[index].track,
            {},
            { intensity: effect.intensity, preferredTrackId: row },
          );
        });
      }

      return next;
    }, "Nothing in that plan changed the timeline. The ids may be stale — read list_clips again.");
  },
});
