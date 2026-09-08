/**
 * How loud the project is at the playhead.
 *
 * The preview mixes nothing: `syncPlayback` hands N independent
 * `HTMLMediaElement`s their `volume` and lets the OS mixer add them up, so
 * there is no master bus in the renderer to tap. Rather than build one — a
 * `createMediaElementSource` per handle is irreversible, silences the clip if
 * the graph is ever left unconnected, and cannot be reached by a suite in a
 * repo with no DOM test environment — the level is *derived* from the same two
 * things the preview itself reads: the decoded waveform of each file and the
 * clip's own `volumeDb`.
 *
 * That makes it pure and node-testable — it answers for a cursor rather than
 * for a moment, so a suite can ask it about the middle of a clip without a
 * clock, a decoder or a speaker.
 *
 * It says what *would* be heard at a cursor, not what is. Whether that is the
 * same thing is the caller's question: `previewBottomBar` asks only while
 * `isPlay`, because `playback.ts#intentFor` gives a handle
 * `playing: isPlaying && inWindow` and a scrub therefore moves the playhead
 * over a clip in silence.
 *
 * Audibility is asked of `audio.ts#isAudibleElement`, the *same function*
 * `playback.ts#intentFor` uses to decide `muted`. The meter and the sound
 * therefore cannot disagree about which clips are contributing — a detached
 * video's picture handle is excluded here for exactly the reason it is silenced
 * there.
 *
 * Pure and DOM-free.
 */

import type { Timeline, TimelineElement } from "../../@types/timeline";
import { isTimeInRange } from "../../utils/time";
import { gainOf, isAudibleElement } from "./audio";
import { isDynamicElement, sourceTimeAt, spanOf } from "./geometry";
import type { PeakData } from "./strip/peaks";

/**
 * The bottom of the meter's scale, in dBFS.
 *
 * The same floor `audio.ts#MIN_VOLUME_DB` puts under the fader, deliberately:
 * a clip pulled to the bottom of its fader should land at the bottom of the
 * meter, not somewhere partway up a scale with a different zero.
 *
 * Not `analysis/signal.ts#FLOOR_DB` (-100). That envelope is analysed material
 * an agent reasons about, where the extra 40 dB of near-silence carries
 * information; this is a strip a few pixels tall, where it would spend most of
 * its length on levels nobody can hear.
 */
export const METER_FLOOR_DB = -60;

/**
 * Amplitude (0..1) as dBFS, floored rather than allowed to reach -Infinity.
 *
 * The renderer-side twin of `electron/mcp/analysis/signal.ts#amplitudeToDb`,
 * same `20 * log10` convention and same "floor, do not throw" contract — kept
 * separate only because `electron/` may not import from `apps/app/src`. The
 * floors differ on purpose; see `METER_FLOOR_DB`.
 */
export function amplitudeToDb(amplitude: number): number {
  if (!(amplitude > 0)) {
    return METER_FLOOR_DB;
  }
  return Math.max(METER_FLOOR_DB, Math.min(0, 20 * Math.log10(amplitude)));
}

/** Where a level sits on the meter, 0..1, linear in dB. */
export function meterFractionOf(db: number): number {
  if (!Number.isFinite(db)) {
    return 0;
  }
  const clamped = Math.max(METER_FLOOR_DB, Math.min(0, db));
  return (clamped - METER_FLOOR_DB) / -METER_FLOOR_DB;
}

/**
 * Decoded peaks for a file, or null when there are none to be had.
 *
 * `null` covers "not decoded yet", "has no audio track" and "failed to decode"
 * alike, and all three read as silence — the contract a missing LUT already
 * has. The alternative is a meter that reports on how much decoding has
 * finished, which is not a thing anyone wants to watch.
 */
export type PeakLookup = (localpath: string) => PeakData | null;

/**
 * The loudest excursion in the bucket covering `sourceMs`.
 *
 * `peaks` is interleaved `[min, max, ...]` per bucket, both in -1..1, so the
 * amplitude is the wider of the two magnitudes.
 *
 * Out of range answers 0 rather than clamping onto the first or last bucket.
 * `planWaveform` states the same rule for the same reason: pinning a cursor
 * past the end of the file onto its final bucket paints a level where there is
 * no sound at all.
 */
export function bucketPeakAt(data: PeakData, sourceMs: number): number {
  if (!(data.bucketMs > 0) || !(sourceMs >= 0)) {
    return 0;
  }

  const bucket = Math.floor(sourceMs / data.bucketMs);
  const bucketCount = Math.floor(data.peaks.length / 2);
  if (bucket < 0 || bucket >= bucketCount) {
    return 0;
  }

  const min = data.peaks[bucket * 2];
  const max = data.peaks[bucket * 2 + 1];
  return Math.max(Math.abs(min), Math.abs(max));
}

/** Whether this clip is making a sound at `cursorMs`. */
function contributesAt(element: TimelineElement, cursorMs: number): boolean {
  if (!isAudibleElement(element)) {
    return false;
  }
  const { start, end } = spanOf(element);
  return isTimeInRange(cursorMs, start, end);
}

/**
 * The files that need decoding for the meter to be honest at `cursorMs`.
 *
 * The caller feeds these to the peak provider. Without it the meter would only
 * ever know about clips the *timeline* happened to have drawn, so a project
 * scrolled away from the playhead would meter as silence.
 *
 * Deduplicated: a video and its detached audio twin share a `localpath`, and
 * asking twice is one wasted decode request per frame.
 */
export function audiblePathsAt(
  elements: Timeline,
  cursorMs: number,
): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();

  for (const element of Object.values(elements) as TimelineElement[]) {
    if (element == null || !contributesAt(element, cursorMs)) {
      continue;
    }
    const localpath = (element as { localpath?: unknown }).localpath;
    if (typeof localpath !== "string" || localpath === "" || seen.has(localpath)) {
      continue;
    }
    seen.add(localpath);
    paths.push(localpath);
  }

  return paths;
}

/**
 * Everything audible at `cursorMs`, summed, as an amplitude in 0..1.
 *
 * **Summed by power, not by amplitude.** These are independent sources arriving
 * at one pair of speakers, and uncorrelated signals add as `sqrt(Σ aᵢ²)` — two
 * clips at 0.6 and 0.8 make 1.0, not 1.4. Adding the amplitudes instead would
 * put the meter in the red on any two clips that overlap.
 *
 * It models the **preview**, not the export. `buildFFmpegArgs` mixes with
 * `amix`, whose `normalize=1` divides by the number of inputs; the preview does
 * no such thing, because nothing in the renderer ever sees the sum. The meter
 * reports what the user is hearing right now, so it follows the preview.
 *
 * Clamped at 1: past unity the output is clipping, and a meter that read 1.4
 * would be describing headroom that does not exist.
 */
export function compositeLevel(
  elements: Timeline,
  cursorMs: number,
  peaks: PeakLookup,
): number {
  let power = 0;

  for (const element of Object.values(elements) as TimelineElement[]) {
    if (element == null || !contributesAt(element, cursorMs)) {
      continue;
    }

    const gain = gainOf(element);
    if (gain <= 0) {
      continue;
    }

    const localpath = (element as { localpath?: unknown }).localpath;
    if (typeof localpath !== "string" || localpath === "") {
      continue;
    }

    const data = peaks(localpath);
    if (data == null) {
      continue;
    }

    // Every audible filetype is dynamic — `isAudibleElement` admits only
    // `audio` and `video` — but ask rather than assume, so a future silent
    // filetype cannot reach `sourceTimeAt` with no `trim` on it.
    if (!isDynamicElement(element)) {
      continue;
    }

    const amplitude = bucketPeakAt(data, sourceTimeAt(element, cursorMs)) * gain;
    power += amplitude * amplitude;
  }

  return Math.min(1, Math.sqrt(power));
}
