import { createContext } from "@lit/context";

/**
 * What the timeline's two columns have to agree on.
 *
 * Only the vertical scroll now. It also used to carry `panelOptions` — which
 * elements had their animation panel expanded — because an open panel stole
 * four extra *rows* from the timeline. That only worked while a row belonged to
 * one element; keyframes are edited in the bottom editor now, so nothing needs
 * to be shared about them.
 */
export type TimelineContentObject = {
  canvasVerticalScroll: number;
};

export const timelineContext =
  createContext<TimelineContentObject>("timelineCanvas");
