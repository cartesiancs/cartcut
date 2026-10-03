/**
 * The playhead as a phone editor shows it: `mm:ss`, or `mm:ss.ff` with the
 * frame inside the second when `withFrames` is set.
 *
 * The desktop readout's `HH:MM:SS:FF` is 11 characters per side, which is two
 * of them, `current / duration`, wider than a phone's transport row. Minutes
 * run past 59 rather than rolling into hours: no phone edit is an hour long,
 * and a field that appears at an hour would move the play button.
 */
export function phoneTimecode(
  ms: number,
  fps: number,
  withFrames: boolean,
): string {
  const safeMs = Number.isFinite(ms) && ms > 0 ? ms : 0;
  const safeFps = Number.isFinite(fps) && fps >= 1 ? Math.round(fps) : 1;
  // Whole frames first, so the readout never shows a frame the grid does not
  // have (2999ms at 60fps is frame 179, second 2, frame 59, not 60).
  const frames = Math.floor((safeMs * safeFps) / 1000 + 1e-9);
  const totalSeconds = Math.floor(frames / safeFps);
  const frame = frames - totalSeconds * safeFps;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds - minutes * 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  const base = `${pad(minutes)}:${pad(seconds)}`;
  return withFrames ? `${base}.${pad(frame)}` : base;
}
