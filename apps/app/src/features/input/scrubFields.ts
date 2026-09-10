/**
 * What a drag means on each of the settings panel's number fields.
 *
 * Plain data, and a separate file from the panel, because the one thing that
 * cannot be derived is `sensitivity`: `projectFps` steps by 1 but has to sweep
 * 1..240, and `previewSizeW` steps by 2 but has to sweep 1920. Reading the
 * `step` attribute off the element and calling it the sensitivity would make
 * the frame rate twitchy and the resolution unusable in the same stroke.
 *
 * The bounds are the field's own, not the exporter's — they exist so the
 * accumulator stops where the number stops, rather than winding up past a
 * ceiling and having to be dragged all the way back.
 */

import type { ScrubOptions } from "./numberScrub";

export const SCRUB_FIELDS: Record<string, ScrubOptions> = {
  // Ten pixels a minute; a project is rarely more than a few.
  projectDurationMinute: { sensitivity: 0.1, step: 1, min: 0, decimals: 0 },
  projectDurationSecond: { sensitivity: 0.25, step: 1, min: 0, decimals: 0 },
  // Four pixels a frame, so the whole legal band is about a screen wide — and
  // a tenth of that with Shift held.
  projectFps: { sensitivity: 0.25, step: 1, min: 1, max: 240, decimals: 0 },
  // Even numbers only. Not a preference: H.264 in yuv420p cannot encode an odd
  // dimension, so a scrub that can produce one is a scrub that can produce a
  // project that will not export. Typing an odd number is still allowed.
  previewSizeW: { sensitivity: 2, step: 2, min: 2, decimals: 0 },
  previewSizeH: { sensitivity: 2, step: 2, min: 2, decimals: 0 },
  videoBitrate: { sensitivity: 100, step: 100, min: 100, decimals: 0 },
};
