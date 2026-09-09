/**
 * The per-filetype renderer table an export runs with.
 *
 * This lived inline inside `ControlRender.handleClickRenderV2Button`, which
 * made it unreachable to anything else — including anything that wants to
 * reproduce an export's output frame for frame. The E2E frame-parity test does
 * exactly that: it re-runs `renderTimelineAtTime` with this table and compares
 * the result against the decoded video file. A copy of the table would be a
 * copy that silently drifts, and the comparison would then be measuring the
 * copy rather than the app (the failure mode `exportSettings.ts` was written to
 * avoid on the main-process side).
 *
 * The distinction that matters here is `renderVideoWithWait`: the export awaits
 * `seeked` before drawing, while the preview (`renderVideoWithoutWait`) draws
 * whatever frame the `<video>` currently holds. Anything reproducing an export
 * must use this table, not the preview's.
 */

import { renderImage } from "../renderer/image";
import { renderVideoWithWait } from "../renderer/video";
import { renderGif } from "../renderer/gif";
import { renderText } from "../renderer/text";
import { renderShape } from "../renderer/shape";
import { renderTemplate } from "../renderer/template";
import type { TimelineRenderers } from "../renderer/timeline";

export const exportElementRenderers: TimelineRenderers = {
  image: renderImage,
  video: renderVideoWithWait,
  gif: renderGif,
  text: renderText,
  shape: renderShape,
  // A template composites its own document into a layer and blits it, and the
  // table it renders that document with is whichever one was installed on the
  // resolver — this one, during an export. So a template's contents are drawn
  // by `renderVideoWithWait` here and by `renderVideoWithoutWait` in the
  // preview, exactly as a top-level clip is.
  template: renderTemplate,
};
