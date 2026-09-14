/**
 * Reading a media element's position back to the user.
 *
 * Here rather than in `utils/time.ts` for the reason that file's own
 * `formatRemaining` gives for not being folded into `formatSeconds`: the
 * contracts genuinely differ. `formatSeconds` answers `"2m 5s"`, which is
 * unpadded and so changes width every time it crosses a multiple of ten —
 * fine for a one-off label, wrong under a playhead that updates every second.
 * `formatRemaining` counts *down* and ceils. A scrubber wants neither.
 *
 * Paired with `seek.ts`, which is the other half of driving a media element by
 * hand.
 */

/** Seconds a media element reports before metadata arrives, or for a live stream. */
function usableSeconds(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

/**
 * A playhead position as `m:ss`, or `h:mm:ss` once there is an hour to show.
 *
 * Padded, and the hours bucket appears only when it is needed: a readout that
 * gains a digit as it passes ten seconds jitters, and one that always carries
 * `0:` for an hour nobody has is noise on a ten-second clip.
 */
export function formatPlayhead(seconds: number): string {
  const total = Math.max(0, Math.floor(usableSeconds(seconds) ?? 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (value: number) => String(value).padStart(2, "0");

  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(secs)}`
    : `${minutes}:${pad(secs)}`;
}


/** `0:06 / 0:12`, or just the position while the duration is unknown. */
export function playheadLabel(
  positionSec: number,
  durationSec: number,
): string {
  const duration = usableSeconds(durationSec);
  const position = formatPlayhead(positionSec);
  return duration == null || duration <= 0
    ? position
    : `${position} / ${formatPlayhead(duration)}`;
}

