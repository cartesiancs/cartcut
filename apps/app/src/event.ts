// The subpath, not the barrel: this is the only lodash call left in the
// renderer, and `import _ from "lodash"` would pull the whole library into the
// bundle for one function. It used to be a global from a CDN <script>.
import cloneDeep from "lodash/cloneDeep";

import { rendererModal } from "./utils/modal";
import { exportProgress } from "./features/export/exportProgress";
import { exportStore } from "./states/exportStore";
import { clearCancelTimeout } from "./features/export/exportSession";
import { runMenuCommand } from "./features/editor/menuCommands";
import { installTextEditingShortcuts } from "./features/editor/textEditing";

// The legacy `PROCESSING` channel. Nothing in the renderer drives it any more
// (`render/renderMain.ts` is the unused fluent-ffmpeg path), but a number
// arriving here still belongs on the ring.
window.electronAPI.res.render.progressing((evt, prog) => {
  exportStore.getState().report(prog, null);
});

window.electronAPI.res.render.finish((evt, detail) => {
  // The end of the finalizing phase `exportSession` handed over — FFmpeg has
  // finished muxing, which nothing before this point can know.
  clearCancelTimeout();
  // Main is authoritative about the file it actually wrote; the value set when
  // the export began is only what we asked for. "Open Saved Folder" reads it.
  if (detail?.destination) {
    exportStore.getState().setDestination(detail.destination);
  }
  exportProgress.finish();
  rendererModal.progressFinish.show();
});

window.electronAPI.res.render.error((evt, errormsg) => {
  exportProgress.stop();
  rendererModal.progressError.show();

  document.querySelector("#progressErrorMsg").innerHTML = `${errormsg}`;
});

/**
 * A `render:v2` export that failed.
 *
 * FFmpeg encodes behind the frame loop, so a mux or codec failure can surface
 * after the last frame has been written and the loop has already resolved
 * happily. Nothing listened for that, and the old `close` handler reported
 * success whatever the exit code — so the user got a checkmark and a truncated
 * file.
 */
window.electronAPI.res.render.v2Error((evt, detail) => {
  clearCancelTimeout();
  exportProgress.stop();
  rendererModal.progressError.show();

  const message = detail?.message ?? "Export failed";
  const tail = detail?.stderrTail ? `\n\n${detail.stderrTail}` : "";
  const target = document.querySelector("#progressErrorMsg");
  if (target != null) {
    // `textContent`, not `innerHTML`: this carries raw FFmpeg stderr.
    target.textContent = `${message}${tail}`;
  }
  console.error("[render:v2]", message, detail?.stderrTail);
});

/**
 * The main process has reaped FFmpeg and deleted the partial file.
 *
 * This is what settles the `cancelling` phase. Until it arrives a new export
 * would be refused by `ipcRenderV2.start`, so the button stays a spinning ring
 * rather than offering something that cannot work.
 */
window.electronAPI.res.render.v2Cancelled(() => {
  clearCancelTimeout();
  exportProgress.stop();
});

window.electronAPI.res.app.forceClose((evt) => {
  let isTimelineChange = document
    .querySelector("element-timeline")
    .isTimelineChange();
  if (isTimelineChange == true) {
    rendererModal.whenClose.show();
  } else {
    window.electronAPI.req.app.forceClose();
  }
});

// The application menu, as one channel. `features/editor/menuCommands` holds
// the table; `electron/lib/menuCommands.ts` is the other end of it.
window.electronAPI.res.menu.command((evt, id) => {
  runMenuCommand(id);
});

// The Edit menu's items are the editor's own commands now, so a keystroke that
// belongs to a text field needs somewhere to go. See `features/editor/textEditing`.
installTextEditingShortcuts();

window.electronAPI.res.timeline.get((event) => {
  let timeline = cloneDeep(
    document.querySelector("element-timeline").timeline,
  );

  event.sender.send("return:timeline:get", timeline);
});

window.electronAPI.res.timeline.add(async (event, timeline) => {
  for (const timelineId in timeline) {
    if (Object.hasOwnProperty.call(timeline, timelineId)) {
      const element = timeline[timelineId];
      const elementTimeline = document.querySelector("element-timeline");

      Object.assign(elementTimeline.timeline, timeline);
      await elementTimeline.patchElementInTimeline({
        elementId: timelineId,
        element: element,
      });
    }
  }
});

window.addEventListener("load", (event) => {
  let toastElList = [].slice.call(document.querySelectorAll(".toast"));
  toastElList.map(function (toastEl) {
    return new bootstrap.Toast(toastEl);
  });
});

window.onresize = async function (event) {
  const elementControlComponent = document.querySelector("element-control");

  await elementControlComponent.resizeEvent();
};

// HTMLCanvasElement.prototype.render = function () {
//     cartcut.canvas.preview.render(this);
//   };

//   HTMLCanvasElement.prototype.clear = function () {
//     cartcut.canvas.preview.clear(this);
//   };
