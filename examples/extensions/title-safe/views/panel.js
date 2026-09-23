/*
 * The panel.
 *
 * It holds no state of its own and computes nothing. The extension owns the
 * answer and pushes it here; this draws it and sends back what the user
 * clicked. Keeping the arithmetic on one side is what stops the panel and the
 * status bar ever disagreeing about how many captions are outside.
 */
const api = acquireCartcutApi();

const summary = document.getElementById("summary");
const list = document.getElementById("list");
const preview = document.getElementById("preview");
const boxes = document.getElementById("boxes");
const fix = document.getElementById("fix");
const revert = document.getElementById("revert");

fix.addEventListener("click", () => api.postMessage({ run: "titleSafe.fixAll" }));
revert.addEventListener("click", () => api.postMessage({ run: "titleSafe.revertAll" }));

api.onMessage((report) => {
  if (report == null || typeof report !== "object") {
    return;
  }
  // Remembered so the panel redraws the same thing if it is reopened, which
  // is the whole of what `setState` is for.
  api.setState(report);
  draw(report);
});

function draw(report) {
  const offenders = report.offenders || [];

  summary.textContent =
    offenders.length === 0
      ? "All " + (report.checked || 0) + " caption(s) are inside."
      : offenders.length + " of " + (report.checked || 0) + " sit outside the " + report.margin + "% safe area.";
  summary.classList.toggle("clear", offenders.length === 0);

  fix.disabled = report.movable === 0;
  fix.textContent = report.movable > 1 ? "Move " + report.movable + " inside" : "Move inside";

  drawFrame(report);
  drawList(offenders);
}

function drawFrame(report) {
  const frame = report.frame;
  if (frame == null) {
    preview.hidden = true;
    return;
  }
  preview.hidden = false;
  // The frame's own aspect, so a caption's position on this picture is where
  // it is in the project rather than where it is in a square.
  preview.style.aspectRatio = frame.width + " / " + frame.height;
  preview.querySelector(".safe").style.inset = report.margin + "%";

  boxes.textContent = "";
  for (const offender of report.offenders || []) {
    const node = document.createElement("div");
    node.className = "box";
    node.style.left = percent(offender.box.x, frame.width);
    node.style.top = percent(offender.box.y, frame.height);
    node.style.width = percent(offender.box.width, frame.width);
    node.style.height = percent(offender.box.height, frame.height);
    boxes.append(node);
  }
}

function percent(value, total) {
  return total > 0 ? (value / total) * 100 + "%" : "0%";
}

function drawList(offenders) {
  list.textContent = "";

  for (const offender of offenders) {
    const row = document.createElement("li");

    const label = document.createElement("span");
    label.className = "label";
    label.textContent = offender.text;

    const why = document.createElement("span");
    why.className = offender.target && offender.target.fits ? "why" : "why stuck";
    why.textContent = offender.target && offender.target.fits ? reason(offender.over) : "wider than the safe area";

    row.append(label, why);
    // Clicking a row selects the clip and parks the playhead on it, so the
    // preview shows the caption being complained about.
    row.addEventListener("click", () =>
      api.postMessage({ select: offender.id, atMs: offender.startMs }),
    );
    list.append(row);
  }
}

function reason(over) {
  const parts = [];
  if (over.left > 0) parts.push(Math.round(over.left) + "px past the left");
  if (over.right > 0) parts.push(Math.round(over.right) + "px past the right");
  if (over.top > 0) parts.push(Math.round(over.top) + "px above the top");
  if (over.bottom > 0) parts.push(Math.round(over.bottom) + "px below the bottom");
  return parts.join(", ");
}

const remembered = api.getState();
if (remembered != null) {
  draw(remembered);
}

api.postMessage({ want: "report" });
