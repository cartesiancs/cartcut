import type {
  TimelineElement,
  VisualTimelineElement,
} from "../../@types/timeline";
import type { Backdrop } from "./backdrop";

/**
 * How one element paints itself.
 *
 * `backdrop` is the frame beneath the clip, and only `renderText` reads it — for
 * a frosted background band, the one property that is a function of what is
 * already on screen rather than of the element. It is optional because every
 * other renderer ignores it and because several callers legitimately have none:
 * `rasterizeText` draws onto an empty canvas, and a transition draws each half
 * into a cleared buffer. See `renderer/backdrop.ts` for why it is a parameter
 * rather than something read off `ctx`.
 */
export type ElementRenderFunction<T extends VisualTimelineElement> = (
  ctx: CanvasRenderingContext2D,
  elementId: string,
  element: T,
  timelineCursor: number,
  backdrop?: Backdrop | null,
) => void;
