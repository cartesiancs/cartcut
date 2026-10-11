/**
 * Where the level meter's blocks light, as opposed to how it moves
 * (`meterBallistics.ts`) or what it reads (`timeline/audioLevel.ts`).
 *
 * Pure and DOM-free.
 */

/**
 * The reading, in dBFS, at which each block lights, left to right.
 *
 * Spaced like a hardware LED ladder, with the steps narrowing towards the top,
 * because the top is where a peak meter has something to say. Six equal 10 dB
 * blocks over -60 to 0 put the red one at -10 dBFS, where ordinary speech
 * peaks, so a clip at a normal level lit red and the warning stopped meaning
 * anything.
 *
 * Red is 0 dBFS and nothing below it: the level `compositeLevel` clamps at,
 * which is clipping, the one thing a peak meter can state as a fact. Amber is
 * the last 6 dB of headroom. The bottom block starts at -48 rather than at
 * `METER_FLOOR_DB`, so a microphone's noise floor does not keep it lit.
 */
export const METER_SEGMENT_DB = [-48, -36, -24, -12, -6, 0] as const;

/**
 * How many blocks a reading lights, counting from the left.
 *
 * `NaN` lights nothing: `db >= threshold` is false for it, so the loop stops at
 * the first block.
 */
export function litSegmentsAt(db: number): number {
  let lit = 0;
  for (const threshold of METER_SEGMENT_DB) {
    if (!(db >= threshold)) {
      break;
    }
    lit++;
  }
  return lit;
}
