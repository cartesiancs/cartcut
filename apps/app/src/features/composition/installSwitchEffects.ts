/**
 * `switchEffects.ts` against the real stores and the real DOM.
 *
 * The only file that knows which component stops the playback loop and which
 * one owns the option column. Installed once at startup, beside Auto Save.
 */

import { keyframeStore } from "../../states/keyframeStore";
import { previewViewportStore } from "../../states/previewViewportStore";
import { renderOptionStore } from "../../states/renderOptionStore";
import { selectionStore } from "../../states/selectionStore";
import { textRangeSelectionStore } from "../../states/textRangeSelectionStore";
import { useTimelineStore } from "../../states/timelineStore";
import type { Viewport } from "../preview/viewport";
import { createSwitchEffects, type SwitchPort } from "./switchEffects";

const port: SwitchPort = {
  stopPlayback() {
    // The store already says it is not playing; this stops the frame loop
    // that would otherwise go on moving the playhead.
    (document.querySelector("element-control") as { stop?: () => void } | null)
      ?.stop?.();
  },

  clearSelection() {
    selectionStore.getState().clear();
    const target = keyframeStore.getState().target;
    if (target.elementId !== "" || target.isShow) {
      keyframeStore
        .getState()
        .update({ ...target, elementId: "", isShow: false });
    }
    textRangeSelectionStore.getState().clear();
    (
      document.querySelector("option-group") as {
        hideAllOptions?: () => void;
      } | null
    )?.hideAllOptions?.();
  },

  readFrame() {
    const { w, h } = renderOptionStore.getState().options.previewSize;
    return { w, h };
  },

  writeFrame(frame) {
    const options = renderOptionStore.getState().options;
    if (options.previewSize.w === frame.w && options.previewSize.h === frame.h) {
      return;
    }
    // A fresh object: `ControlSetting` edits the live `previewSize` in place
    // before calling `updateOptions`, and a composition's size must never be
    // the object it edits.
    renderOptionStore.getState().updateOptions({
      ...options,
      previewSize: { w: frame.w, h: frame.h },
    });
  },

  readViewport() {
    return previewViewportStore.getState().viewport;
  },

  writeViewport(viewport, frame) {
    if (viewport == null) {
      previewViewportStore.getState().fit(frame.w, frame.h);
    } else {
      previewViewportStore.getState().setViewport(viewport as Viewport);
    }
  },
};

export function installTimelineSwitchEffects(): () => void {
  const effects = createSwitchEffects(port, useTimelineStore.getState());
  return useTimelineStore.subscribe((state) => effects.observe(state));
}
