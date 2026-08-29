/**
 * The brief, and the plan.
 *
 * Two tools that bracket an edit. `get_edit_brief` is everything worth knowing
 * before proposing one; `apply_edit_plan` is the whole edit as a single undo
 * step.
 *
 * ## Why the brief does not plan
 *
 * It gathers and it chooses a style. It does not decide which take is better,
 * where a punch-in belongs, or what the piece is about — a model is better at
 * all of that than any heuristic worth writing, and a heuristic would quietly
 * override it. What the model lacks is not judgement, it is the discipline to
 * look before deciding and the numbers to be consistent once it has. So the
 * brief supplies both in one call, and the reasoning stays where it belongs.
 */

import { z } from "zod";
import { requestEditor } from "../bridge";
import { mutating, readOnly, tool, type Registrar } from "./define";

/**
 * Confidence at which a clip counts as a music bed.
 *
 * The same threshold `analyze.ts` uses to decide whether beats are worth
 * reporting at all. Measured: speech scores about 0.2 and music about 0.6.
 */
const MUSIC_CONFIDENCE = 0.4;

/** Shortest a clip can be and still be a bed rather than a sting. */
const MUSIC_MIN_MS = 15_000;

/** Most audio clips probed for a music bed, so a brief stays quick. */
const MAX_PROBES = 2;

export function registerPlanTools(define: Registrar) {
  define(
    "get_edit_brief",
    {
      title: "Everything you need before proposing an edit",
      description:
        "One call that gathers the project's shape and picks a **style profile** — the numbers an edit is made " +
        "of: how much air to leave around a cut, the shortest a shot may be, how often to push in and how " +
        "hard, which transitions this style reaches for, how long a caption line is. " +
        "Start here for anything bigger than a single tweak. " +
        "The profile is chosen from what the material actually is — aspect ratio, whether there is a music " +
        "bed, and how fast the speech runs if you pass `speechRatePerMin` — and it comes back with the " +
        "reasons, so the user can redirect it in one sentence. `styleId` overrides the choice. " +
        "**It does not plan.** It has no opinion on which take is better or where a move belongs; that is " +
        "yours. What it gives you is the material and the constraints, so your plan is consistent instead of " +
        "improvised clip by clip. " +
        "Then propose in plain English, wait, and put the approved edit through apply_edit_plan.",
      inputSchema: {
        styleId: z
          .string()
          .optional()
          .describe("Use this profile instead of the fitted one."),
        speechRatePerMin: z
          .number()
          .optional()
          .describe(
            "Words per minute, from get_transcript. Without it the style is chosen on the other signals.",
          ),
      },
      annotations: readOnly,
    },
    tool(async (args: any) => {
      const overview: any = await requestEditor("get_project_overview");
      const clips: any = await requestEditor("list_clips", { limit: 500 });

      const { aspectOf, chooseStyle } = await import("../analysis/style");
      const { loadStyles } = await import("../../lib/style");
      const { analyzeFile } = await import("../analyze");

      // A music bed is the strongest signal there is and the one an agent is
      // least likely to think of checking, so the brief checks it rather than
      // asking. Only the longest couple of audio clips: a decode is fast and
      // cached, but a project with forty stings should not pay for all of them.
      const audio = (clips.clips ?? [])
        .filter((clip: any) => clip.type === "audio" && clip.dur >= MUSIC_MIN_MS)
        .sort((a: any, b: any) => b.dur - a.dur)
        .slice(0, MAX_PROBES);

      let musicLed = false;
      const beds: unknown[] = [];
      for (const clip of audio) {
        try {
          const source: any = await requestEditor("get_transcript_source", {
            elementId: clip.id,
          });
          const analysis = await analyzeFile(source.localpath);
          if (
            analysis.tempo != null &&
            analysis.tempo.confidence >= MUSIC_CONFIDENCE
          ) {
            musicLed = true;
            beds.push({
              id: clip.id,
              src: clip.src,
              bpm: analysis.tempo.bpm,
              confidence: analysis.tempo.confidence,
            });
          }
        } catch {
          // An unreadable clip is not a reason to fail the brief; it just does
          // not vote on whether there is music.
        }
      }

      const { profiles, broken } = await loadStyles();
      const material = {
        aspect: aspectOf(
          overview.resolution?.width ?? 0,
          overview.resolution?.height ?? 0,
        ),
        speechRatePerMin: args.speechRatePerMin ?? null,
        musicLed,
      };

      const chosen = chooseStyle(profiles, material, args.styleId);

      return {
        project: {
          resolution: overview.resolution,
          fps: overview.fps,
          timelineDurationMs: overview.timelineDurationMs,
          clipCount: overview.clipCount,
          clipsByType: overview.clipsByType,
          tracks: overview.tracks,
        },
        material,
        musicBeds: beds,
        style: chosen.profile,
        styleChosenBecause: chosen.why,
        otherStyles: profiles
          .filter((p: any) => p.id !== chosen.profile?.id)
          .map((p: any) => ({ id: p.id, name: p.name, description: p.description })),
        ...(broken.length > 0 ? { brokenStyleFiles: broken } : {}),
        next: "Propose the edit in plain English, wait for the user, then apply_edit_plan.",
      };
    }),
  );

  define(
    "apply_edit_plan",
    {
      title: "Apply a whole edit at once",
      description:
        "Run a complete edit — cuts, motion, transitions, captions, titles, effects — as **one undo step**. " +
        "This is the tool to finish with: the same work done through the individual tools leaves a history " +
        "entry each, and an edit that takes sixty undos to reject is one the user cannot reject. " +
        "Steps are applied in a fixed order regardless of how you write them: cuts first (a ripple moves " +
        "everything after it, and every later time is a timeline time), then motion on the clips that " +
        "survived, then transitions, then captions and titles, then effects on top. " +
        "A clip id the cuts removed is skipped rather than failing the edit; an id that never existed is " +
        "refused before anything is applied, because half an edit is worse than none. " +
        "Times are timeline milliseconds throughout.",
      inputSchema: {
        plan: z
          .object({
            cuts: z
              .array(
                z.object({
                  elementId: z.string(),
                  ranges: z
                    .array(z.object({ startMs: z.number(), endMs: z.number() }))
                    .min(1),
                  ripple: z.boolean().optional(),
                }),
              )
              .optional(),
            motion: z
              .array(
                z.object({
                  elementIds: z.array(z.string()).min(1),
                  preset: z.string(),
                  durationMs: z.number().optional(),
                  focus: z
                    .object({ x: z.number(), y: z.number() })
                    .optional(),
                }),
              )
              .optional(),
            transitions: z
              .array(
                z.object({
                  fromId: z.string(),
                  toId: z.string(),
                  presetId: z.string(),
                  durationMs: z.number().optional(),
                  alignment: z.enum(["center", "start", "end"]).optional(),
                }),
              )
              .optional(),
            captions: z
              .array(
                z.object({
                  text: z.string(),
                  startMs: z.number(),
                  durationMs: z.number(),
                }),
              )
              .optional(),
            captionStyle: z.record(z.any()).optional(),
            titles: z
              .array(
                z.object({
                  text: z.string(),
                  startMs: z.number(),
                  durationMs: z.number(),
                  style: z.record(z.any()).optional(),
                }),
              )
              .optional(),
            effects: z
              .array(
                z.object({
                  presetId: z.string(),
                  startMs: z.number(),
                  durationMs: z.number(),
                  intensity: z.number().min(0).max(100).optional(),
                }),
              )
              .optional(),
          })
          .describe("Every part is optional; at least one must be present."),
      },
      annotations: mutating,
    },
    tool((args) => requestEditor("apply_edit_plan", args, 120_000)),
  );
}
