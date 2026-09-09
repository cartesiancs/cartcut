/**
 * Putting an installed template on the timeline.
 *
 * One function behind three gestures — clicking a tile, dragging one onto a
 * track, and (later) an MCP tool — for the reason `element/nullElement.ts`
 * gives about its own factory: they must produce the *same* element, and the
 * only arrangement that guarantees it is having one place that builds it.
 *
 * The template has to be **read** before it can be placed, because its length
 * and its native size are in its document and the element carries both. That is
 * the one thing this cannot do synchronously, and it is why the tile's click
 * handler awaits.
 */

import { v4 as uuidv4 } from "uuid";
import { useTimelineStore } from "../../states/timelineStore";
import { renderOptionStore } from "../../states/renderOptionStore";
import { snapMsToFrame } from "../timeline/frames";
import { addTemplate, createTemplateElement } from "../timeline/templateOps";
import { loadTemplate, templateListing } from "./templateRegistry";

export type AddTemplateResult =
  | { ok: true; elementId: string }
  | { ok: false; message: string };

export type AddTemplateTarget = {
  startMs: number;
  trackId?: string | null;
};

/**
 * Read a template and place it, as one undo step.
 *
 * The start is frame-snapped like every other drop — a template is picture, and
 * the grid is a picture constraint (`frames.ts#isFrameLocked`).
 */
export async function addTemplateToTimeline(
  templateId: string,
  target: AddTemplateTarget,
): Promise<AddTemplateResult> {
  const listing = templateListing(templateId);
  if (listing == null) {
    return { ok: false, message: "That template is not installed." };
  }

  const data = await loadTemplate(templateId);
  if (data == null) {
    return {
      ok: false,
      message: `${listing.name} could not be read.`,
    };
  }

  const options = renderOptionStore.getState().options;
  const frame = options.previewSize ?? { w: 1920, h: 1080 };
  const fps = options.fps ?? 60;

  const element = createTemplateElement({
    templateId,
    name: data.name,
    durationMs: data.durationMs,
    size: data.size,
    frame: { w: frame.w, h: frame.h },
  });

  const elementId = uuidv4();
  const startMs = snapMsToFrame(Math.max(0, target.startMs), fps);

  useTimelineStore.getState().withCheckpoint((doc) =>
    addTemplate(
      doc,
      elementId,
      element,
      startMs,
      uuidv4(),
      target.trackId ?? undefined,
    ),
  );

  return { ok: true, elementId };
}
