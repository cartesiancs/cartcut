/**
 * Which clips the browser export's mix holds, and how each is placed.
 *
 * The twin of `electron/render/ffmpegArgs.ts#collectAudioInputs`, built from
 * the renderer's own originals (`isAudibleElement`, `speedOf`, `gainOf`) that
 * the desktop file mirrors by hand. `audioPlan.test.ts` builds both from the
 * same documents and requires them to agree field by field, so the two exports
 * mix the same clips at the same places and levels.
 *
 * Hidden rows are in here on purpose, the desktop rule: the eye hides picture,
 * never sound.
 */

import type { TimelineElement } from "../../../../@types/timeline";
import { gainOf, isAudibleElement } from "../../../timeline/audio";
import { speedOf } from "../../../timeline/geometry";
import {
  curveSpanLength,
  speedCurveOf,
  type SpeedCurve,
} from "../../../timeline/speedCurve";
import { envelopeFor, type EnvelopePoint } from "./shared";

export type AudioClipPlan = {
  readonly id: string;
  readonly localpath: string;
  /** Source window, in source seconds: `-ss` and `-t`. */
  readonly ssSec: number;
  readonly tSec: number;
  /** Where the clip's sound starts on the timeline: `adelay`. */
  readonly delayMs: number;
  /** The clip's mean rate. 1 plays the window as decoded. */
  readonly speed: number;
  /** A speed ramp, which retimes through `curveSourceAt` instead of `speed`. */
  readonly curve: SpeedCurve | null;
  readonly trimStartMs: number;
  /** How long the clip sounds on the timeline, in ms. */
  readonly spanMs: number;
  /** The static level, used only when there is no envelope. */
  readonly gain: number;
  /** The keyframed level, clip-local timeline ms, or `null`. */
  readonly envelope: readonly EnvelopePoint[] | null;
};

export function planAudio(timeline: Record<string, TimelineElement>): AudioClipPlan[] {
  const plans: AudioClipPlan[] = [];
  for (const id of Object.keys(timeline)) {
    const element = timeline[id] as any;
    if (!isAudibleElement(element)) {
      continue;
    }
    const curve = speedCurveOf(element);
    const speed = speedOf(element);
    const trimStartMs = element.trim.startTime;
    const spanMs =
      curve != null
        ? curveSpanLength(curve, trimStartMs, element.trim.endTime)
        : element.duration / speed;
    plans.push({
      id,
      localpath: element.localpath,
      ssSec: trimStartMs / 1000,
      tSec: element.duration / 1000,
      delayMs: Math.max(0, element.startTime),
      speed,
      curve,
      trimStartMs,
      spanMs,
      gain: gainOf(element),
      envelope: envelopeFor(element),
    });
  }
  return plans;
}

/** Whether a clip's sound has to be retimed rather than played as decoded. */
export function needsStretch(clip: AudioClipPlan): boolean {
  return clip.curve != null || clip.speed !== 1;
}
