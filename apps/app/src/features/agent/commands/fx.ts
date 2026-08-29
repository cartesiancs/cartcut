/**
 * Transitions and effects, finally reachable.
 *
 * Both have been complete for a long time — a real element type, a full set of
 * ops, repair-on-normalize, the WebGL compositor, and the export path all
 * finished and shipping 37 transition presets and 39 effect presets. What was
 * missing was the agent surface: no tool created one, `FILETYPES` named neither,
 * and `add_track`'s enum had no `"effect"`, so an agent could not even make the
 * row an effect needs. `CLAUDE.md` said transitions did not exist at all, which
 * is how a well-behaved agent came to tell users a cross-dissolve was
 * impossible.
 *
 * So this file is deliberately thin. Every op it calls already exists; nothing
 * here decides anything the editor had not already decided.
 *
 * ## Why a transition is addressed by its cut and not by a time
 *
 * A transition is a **binary operator on two rendered frames**, not an
 * animation on a clip: it needs to know which clip is outgoing and which is
 * incoming. `transitionOps.ts` says so at length. A caller naming a moment
 * would have to be told "there is no cut there" often enough to be annoying, so
 * `add_transition` takes the two clip ids and `list_cuts` is how you find them.
 */

import { v4 as uuidv4 } from "uuid";
import { effectOf } from "../../timeline/effectOps";
import {
  addEffect,
  addEffectTrack,
  setEffectBlend,
  setEffectIntensity,
  setEffectParams,
  setEffectPreset,
} from "../../timeline/effectOps";
import {
  addTransition,
  cutPointsOn,
  removeTransition,
  setTransitionAlignment,
  setTransitionDuration,
  setTransitionParams,
  setTransitionPreset,
  transitionAtCut,
} from "../../timeline/transitionOps";
import {
  DEFAULT_TRANSITION_MS,
  maxTransitionMs,
  realFootageMs,
  windowOf,
} from "../../timeline/transitionGeometry";
import type { TimelineDocument } from "../../timeline/tracks";
import { tracksOfKind } from "../../timeline/tracks";
import { commit } from "../commit";
import { currentDoc, requireElement, requireTrack } from "../context";
import { registerCommands } from "../registry";

type Alignment = "center" | "start" | "end";

/** Most cuts one call reports, so a long timeline cannot blow the output cap. */
const MAX_CUTS = 200;

function requireTransition(doc: TimelineDocument, elementId: string) {
  const element = requireElement(doc, elementId) as any;
  if (element.filetype !== "transition") {
    throw new Error(
      `Clip "${elementId}" is a ${element.filetype} clip, not a transition.`,
    );
  }
  return element;
}

function requireEffect(doc: TimelineDocument, elementId: string) {
  const element = requireElement(doc, elementId) as any;
  if (element.filetype !== "effect") {
    throw new Error(
      `Clip "${elementId}" is a ${element.filetype} clip, not an effect.`,
    );
  }
  return element;
}

registerCommands({
  /**
   * Every place on a track where one clip meets the next.
   *
   * The list a caller needs before it can place a transition: which pairs are
   * adjacent, when they meet, whether something is already there, and two
   * lengths that are easy to confuse.
   *
   * `maxDurationMs` is the longest window the two clips can hold, set by their
   * lengths. `realFootageMs` is how much of a centred window would be **real
   * frames rather than held ones** — a clip trimmed to its last frame has no
   * footage outside the trim, so a dissolve there freezes. That is reported,
   * not prevented: `transitionGeometry.ts` is explicit that refusing it was a
   * bug, since two imports dropped end to end have no handles at all and a
   * held frame across a short dissolve is what every editor does. A caller that
   * cares about it can trim for room; one that does not gets its dissolve.
   */
  list_cuts: (params: { trackId?: string }) => {
    const doc = currentDoc();

    const trackIds =
      params.trackId != null
        ? [requireTrack(doc, params.trackId).id]
        : tracksOfKind(doc, "video").map((track) => track.id);

    const names = new Map(doc.tracks.map((t) => [t.id, t.name]));
    const cuts: unknown[] = [];

    for (const trackId of trackIds) {
      for (const cut of cutPointsOn(doc, trackId)) {
        cuts.push({
          track: names.get(trackId),
          trackId,
          fromId: cut.fromId,
          toId: cut.toId,
          atMs: Math.round(cut.atMs),
          transitionId: cut.transitionId,
          // Both at the default alignment, which is the one a caller who has
          // not thought about it will get.
          maxDurationMs: Math.round(
            maxTransitionMs(
              doc.elements[cut.fromId],
              doc.elements[cut.toId],
              "center",
            ),
          ),
          realFootageMs: Math.round(
            realFootageMs(
              doc.elements[cut.fromId],
              doc.elements[cut.toId],
              "center",
            ),
          ),
        });
      }
    }

    return {
      count: cuts.length,
      truncated: cuts.length > MAX_CUTS,
      cuts: cuts.slice(0, MAX_CUTS),
    };
  },

  add_transition: (params: {
    fromId: string;
    toId: string;
    presetId: string;
    durationMs?: number;
    alignment?: Alignment;
    params?: Record<string, unknown>;
  }) => {
    const doc = currentDoc();
    requireElement(doc, params.fromId);
    requireElement(doc, params.toId);

    if (!params.presetId) {
      throw new Error(
        "add_transition needs a `presetId`. list_transition_presets has them.",
      );
    }
    const existing = transitionAtCut(doc, params.fromId, params.toId);
    if (existing != null) {
      throw new Error(
        `That cut already has a transition ("${existing}"). Use set_transition, or remove it first.`,
      );
    }

    const elementId = uuidv4();
    return commit(
      (d: TimelineDocument) =>
        addTransition(
          d,
          elementId,
          params.fromId,
          params.toId,
          params.presetId,
          params.durationMs ?? DEFAULT_TRANSITION_MS,
          params.alignment ?? "center",
          (params.params ?? {}) as any,
        ),
      "Those two clips are not adjacent on one track, or there is no room for a transition between them. " +
        "list_cuts reports both.",
    );
  },

  set_transition: (params: {
    elementId: string;
    presetId?: string;
    durationMs?: number;
    alignment?: Alignment;
    params?: Record<string, unknown>;
  }) => {
    const doc = currentDoc();
    requireTransition(doc, params.elementId);

    return commit((d: TimelineDocument) => {
      let next = d;
      if (params.presetId != null) {
        next = setTransitionPreset(
          next,
          params.elementId,
          params.presetId,
          (params.params ?? {}) as any,
        );
      } else if (params.params != null) {
        // Only when the preset did not change: `setTransitionPreset` already
        // takes the params, and applying them twice would fight its own reset
        // of the ones the old preset owned.
        next = setTransitionParams(next, params.elementId, params.params as any);
      }
      if (params.durationMs != null) {
        next = setTransitionDuration(next, params.elementId, params.durationMs);
      }
      if (params.alignment != null) {
        next = setTransitionAlignment(next, params.elementId, params.alignment);
      }
      return next;
    }, "Nothing about that transition changed.");
  },

  remove_transition: (params: { elementId: string }) => {
    const doc = currentDoc();
    requireTransition(doc, params.elementId);
    return commit(
      (d: TimelineDocument) => removeTransition(d, params.elementId),
      "That transition is already gone.",
    );
  },

  /**
   * Add a whole-frame effect.
   *
   * An effect applies to everything painted *beneath* it, so where its row sits
   * is the feature rather than a detail. With no effect track yet, one is made
   * at the very top — `addEffectTrack`'s own reasoning — because an effect at
   * the bottom of the stack would composite under every clip and touch nothing.
   */
  add_effect: (params: {
    presetId: string;
    startMs: number;
    durationMs: number;
    intensity?: number;
    params?: Record<string, unknown>;
    trackId?: string;
  }) => {
    const doc = currentDoc();
    if (!params.presetId) {
      throw new Error(
        "add_effect needs a `presetId`. list_effect_presets has them.",
      );
    }
    if (!(params.durationMs > 0)) {
      throw new Error("add_effect needs a positive `durationMs`.");
    }
    if (params.trackId != null) {
      const track = requireTrack(doc, params.trackId);
      if (track.kind !== "effect") {
        throw new Error(
          `Track "${track.name}" holds ${track.kind} clips, not effects.`,
        );
      }
    }

    const elementId = uuidv4();
    const newTrackId = uuidv4();

    return commit((d: TimelineDocument) => {
      // The first effect track goes at index 0 explicitly rather than through
      // the placement fallback, because "applies to everything" is what an
      // adjustment layer is for and the user narrows it by dragging it down.
      const withTrack =
        params.trackId != null || tracksOfKind(d, "effect").length > 0
          ? d
          : addEffectTrack(d, newTrackId);

      return addEffect(
        withTrack,
        elementId,
        params.presetId,
        Math.max(0, params.startMs),
        params.durationMs,
        uuidv4(),
        (params.params ?? {}) as any,
        {
          intensity: params.intensity,
          preferredTrackId:
            params.trackId ??
            (tracksOfKind(withTrack, "effect")[0]?.id as string | undefined),
        },
      );
    }, "The effect could not be placed — another one may already cover that moment on every effect row.");
  },

  set_effect: (params: {
    elementId: string;
    presetId?: string;
    intensity?: number;
    blend?: string | null;
    params?: Record<string, unknown>;
  }) => {
    const doc = currentDoc();
    requireEffect(doc, params.elementId);

    return commit((d: TimelineDocument) => {
      let next = d;
      if (params.presetId != null) {
        next = setEffectPreset(
          next,
          params.elementId,
          params.presetId,
          (params.params ?? {}) as any,
        );
      } else if (params.params != null) {
        next = setEffectParams(next, params.elementId, params.params as any);
      }
      if (params.intensity != null) {
        next = setEffectIntensity(next, params.elementId, params.intensity);
      }
      if (params.blend !== undefined) {
        next = setEffectBlend(next, params.elementId, params.blend as any);
      }
      return next;
    }, "Nothing about that effect changed.");
  },

  /** One transition or effect in full, since `list_clips` cannot describe them. */
  get_fx: (params: { elementId: string }) => {
    const doc = currentDoc();
    const element = requireElement(doc, params.elementId) as any;

    if (element.filetype === "transition") {
      const window = windowOf(element);
      return {
        id: params.elementId,
        type: "transition",
        presetId: element.presetId,
        params: element.params ?? {},
        fromId: element.fromId,
        toId: element.toId,
        alignment: element.alignment,
        startMs: Math.round(window.start),
        endMs: Math.round(window.end),
        durationMs: Math.round(window.end - window.start),
        requestedDurationMs: element.requestedDuration,
      };
    }

    if (element.filetype === "effect") {
      const effect = effectOf(element);
      return {
        id: params.elementId,
        type: "effect",
        presetId: effect?.presetId,
        params: effect?.params ?? {},
        intensity: effect?.intensity,
        blend: element.blend ?? null,
        startMs: Math.round(element.startTime),
        endMs: Math.round(element.startTime + element.duration),
        trackId: element.trackId,
      };
    }

    throw new Error(
      `Clip "${params.elementId}" is a ${element.filetype} clip. get_fx is for transitions and effects; use get_clip.`,
    );
  },
});
