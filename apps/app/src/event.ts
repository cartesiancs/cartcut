import { rendererModal } from "./utils/modal";
import { renderProgress } from "./ui/modal/renderProgress";

window.electronAPI.res.render.progressing((evt, prog) => {
  rendererModal.progressModal.show();
  document.querySelector("#progress").style.width = `${prog}%`;
  document.querySelector("#progress").innerHTML = `${Math.round(prog)}%`;
});

window.electronAPI.res.render.finish((evt) => {
  // The end of the finalizing phase `ControlRender` handed over — FFmpeg has
  // finished muxing, which nothing before this point can know.
  renderProgress.finish();
  rendererModal.progressModal.hide();
  rendererModal.progressFinish.show();

  document.querySelector("#progress").style.width = `100%`;
  document.querySelector("#progress").innerHTML = `100%`;

  const projectFolder = document.querySelector("#projectFolder").value;

  window.electronAPI.req.filesystem.emptyDirSync(
    `${projectFolder}/renderAnimation`,
  );
  window.electronAPI.req.filesystem.removeDirectory(
    `${projectFolder}/renderAnimation`,
  );
});

window.electronAPI.res.render.error((evt, errormsg) => {
  rendererModal.progressModal.hide();
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
  renderProgress.stop();
  rendererModal.progressModal.hide();
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

window.electronAPI.res.render.v2Cancelled(() => {
  renderProgress.stop();
  rendererModal.progressModal.hide();
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

window.electronAPI.res.shortcut.controlS((evt) => {
  CARTCUT.project.save();
});

window.electronAPI.res.shortcut.controlO((evt) => {
  CARTCUT.project.load();
});

window.electronAPI.res.timeline.get((event) => {
  let timeline = _.cloneDeep(
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
