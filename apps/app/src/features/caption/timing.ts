/**
 * Turning a caption's source-file timing into timeline timing.
 *
 * A transcript timestamps the *source file*. A clip on the timeline is a window
 * into that file, possibly trimmed and possibly not playing at 1x, so a caption
 * at source-time 12s does not appear at timeline-time 12s. `timelineTimeAt` is
 * the conversion, and `geometry.ts` is the only place that knows it.
 *
 * This used to be inlined in `Control._handleComplateAutoCaption`, which is
 * fine while auto-caption is the only producer of captions. It no longer is —
 * the MCP `add_subtitles` tool is a second one — and two copies of a conversion
 * this easy to get subtly wrong is one too many. Before it was done at all,
 * captions carried a `parentKey` and were re-resolved at draw time, which
 * amounted to the same conversion done forever and only correct for an
 * untrimmed 1x clip.
 */

import type { TimelineElement } from "../../@types/timeline";
import { isDynamicElement, timelineTimeAt } from "../timeline/geometry";

export type SourceTimedCaption = {
  startTime: number;
  duration: number;
};

export type TimelineTimedCaption = {
  startTime: number;
  duration: number;
};

/**
 * Map one caption from source ms onto the timeline.
 *
 * Both edges are converted and the duration recomputed from them rather than
 * scaled directly: on a sped-up clip the two are not the same, and the ends
 * are what have to line up with the words.
 *
 * A `source` that is not a dynamic element has no source window to speak of,
 * so its timings are already timeline times and only get rounded and clamped.
 */
export function captionToTimeline(
  caption: SourceTimedCaption,
  source: TimelineElement | undefined,
): TimelineTimedCaption {
  if (source == null || !isDynamicElement(source)) {
    return {
      startTime: Math.max(0, Math.round(caption.startTime)),
      duration: Math.max(1, Math.round(caption.duration)),
    };
  }

  const start = timelineTimeAt(source, caption.startTime);
  const end = timelineTimeAt(source, caption.startTime + caption.duration);

  return {
    startTime: Math.max(0, Math.round(start)),
    duration: Math.max(1, Math.round(end - start)),
  };
}
