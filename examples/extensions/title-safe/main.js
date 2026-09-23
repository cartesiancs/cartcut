/**
 * Title Safe: keep captions away from the edge of the frame.
 *
 * A worked example of a Cartcut extension. Everything here is something an
 * editor actually wants, so the API calls sit where a real extension would
 * put them rather than being a tour.
 *
 * The three parts worth copying:
 *
 *  - **One undo step for a whole pass.** Moving forty captions is forty
 *    edits, and `commands.batch` makes it one thing to reject. An extension
 *    that made forty undo steps would be one nobody dared run.
 *  - **Remembering what it changed.** Each clip it moves gets the original
 *    position stored in its own per-clip data, so "put everything back" is
 *    exact rather than approximate, and survives saving and reopening the
 *    project.
 *  - **Asking before an export, and taking no for an answer.** The veto is
 *    off by default, because an extension that silently blocked exports would
 *    be uninstalled the first time it was wrong.
 */

const cartcut = require("cartcut");

/** Where a clip's own data lives. Only this extension can read or write it. */
const MOVED_KEY = "movedFrom";

function emptyReport() {
  return { frame: null, margin: 0, checked: 0, offenders: [], movable: 0 };
}

// --------------------------------------------------------------- geometry

/**
 * The rectangle a title has to stay inside.
 *
 * A percentage of the frame rather than a pixel inset, because the number
 * that matters is the same on a 1080p timeline and a 4K one.
 */
function safeArea(frame, marginPercent) {
  const insetX = (frame.width * marginPercent) / 100;
  const insetY = (frame.height * marginPercent) / 100;
  return {
    left: insetX,
    top: insetY,
    right: frame.width - insetX,
    bottom: frame.height - insetY,
  };
}

/**
 * How far outside the safe area a box sits, per edge.
 *
 * Zero on every edge means it is inside. Reported per edge rather than as one
 * distance so the panel can say "12px past the left" instead of "12px out",
 * which is the difference between a message an editor can act on and one they
 * have to go and look at.
 */
function overflow(box, safe) {
  return {
    left: Math.max(0, safe.left - box.x),
    top: Math.max(0, safe.top - box.y),
    right: Math.max(0, box.x + box.width - safe.right),
    bottom: Math.max(0, box.y + box.height - safe.bottom),
  };
}

function isOutside(over) {
  return over.left > 0 || over.top > 0 || over.right > 0 || over.bottom > 0;
}

/**
 * Where the box should move to, or null when it cannot fit.
 *
 * A clip wider than the safe area is centred rather than clamped: pushing it
 * right until its left edge is inside would only push its right edge further
 * out. It is reported as unfixable, because the honest answer is that the
 * caption needs to be smaller and this extension is not going to decide that.
 */
function clampInside(box, safe) {
  const safeWidth = safe.right - safe.left;
  const safeHeight = safe.bottom - safe.top;

  const x =
    box.width > safeWidth
      ? safe.left + (safeWidth - box.width) / 2
      : Math.min(Math.max(box.x, safe.left), safe.right - box.width);
  const y =
    box.height > safeHeight
      ? safe.top + (safeHeight - box.height) / 2
      : Math.min(Math.max(box.y, safe.top), safe.bottom - box.height);

  const fits = box.width <= safeWidth && box.height <= safeHeight;
  return { x: Math.round(x), y: Math.round(y), fits };
}

// ----------------------------------------------------------------- reading

async function marginPercent() {
  const value = await cartcut.config.get("titleSafe.marginPercent");
  return typeof value === "number" ? value : 10;
}

/**
 * Every text clip, measured.
 *
 * `listClips` answers a summary that does not carry a box, so each clip is
 * asked for in full. That is one call per caption; a project with hundreds
 * would want paging, and the `truncated` flag is what says so.
 */
async function scan() {
  const overview = await cartcut.timeline.overview();
  const frame = overview && overview.resolution;
  if (frame == null || !(frame.width > 0) || !(frame.height > 0)) {
    return emptyReport();
  }

  const margin = await marginPercent();
  const safe = safeArea(frame, margin);
  const page = await cartcut.timeline.listClips({ filetype: "text", limit: 200 });
  const clips = (page && page.clips) || [];

  const offenders = [];
  let movable = 0;

  for (const row of clips) {
    const clip = await cartcut.timeline.getClip(row.id);
    const box = {
      x: (clip.location && clip.location.x) || 0,
      y: (clip.location && clip.location.y) || 0,
      width: clip.width || 0,
      height: clip.height || 0,
    };
    const over = overflow(box, safe);
    if (!isOutside(over)) {
      continue;
    }

    const target = clampInside(box, safe);
    if (target.fits) {
      movable += 1;
    }
    offenders.push({
      id: row.id,
      text: clip.text || row.text || "(no text)",
      startMs: row.start,
      box,
      over,
      target,
      alreadyMoved: (await cartcut.timeline.getElementData(row.id)) != null,
    });
  }

  return {
    frame,
    margin,
    checked: clips.length,
    truncated: Boolean(page && page.truncated),
    offenders,
    movable,
  };
}

// ----------------------------------------------------------------- writing

/**
 * Move everything that can be moved, as one edit.
 *
 * Each clip contributes two steps: the move, and a note of where it came
 * from. Both are in the same batch, so the note can never outlive the move it
 * describes, and Cmd+Z takes the whole pass back.
 */
async function fixAll() {
  const report = await scan();
  const steps = [];

  for (const offender of report.offenders) {
    if (!offender.target.fits) {
      continue;
    }
    steps.push({
      name: "update_clip",
      params: {
        elementId: offender.id,
        patch: { location: { x: offender.target.x, y: offender.target.y } },
      },
    });
    // Only the first move is recorded. Running the pass twice must not
    // overwrite where the caption originally sat with where this extension
    // last put it, or "put everything back" would put it back to its own work.
    if (!offender.alreadyMoved) {
      steps.push({
        name: "ext_set_element_data",
        params: {
          elementId: offender.id,
          value: { [MOVED_KEY]: { x: offender.box.x, y: offender.box.y } },
        },
      });
    }
  }

  if (steps.length === 0) {
    await cartcut.window.showMessage(
      report.offenders.length === 0
        ? "Everything is already inside the safe area."
        : "Those captions are wider than the safe area. Make them smaller first.",
    );
    return { moved: 0 };
  }

  const result = await cartcut.commands.batch(steps);
  await refresh();
  await cartcut.window.showMessage(
    result.ok
      ? "Moved " + report.movable + " inside the safe area. One undo puts them all back."
      : "Nothing moved: " + (result.reason || "the edit was declined"),
  );
  return { moved: result.ok ? report.movable : 0 };
}

/**
 * Put every clip this extension moved back where it was.
 *
 * Also one batch, and it clears the stored position as it goes: a clip that
 * is back where it started is not a clip this extension has moved, and
 * leaving the note behind would make the next revert a no-op that claimed to
 * have done something.
 */
async function revertAll() {
  const page = await cartcut.timeline.listClips({ filetype: "text", limit: 200 });
  const steps = [];

  for (const row of (page && page.clips) || []) {
    const stored = await cartcut.timeline.getElementData(row.id);
    const from = stored && stored[MOVED_KEY];
    if (from == null) {
      continue;
    }
    steps.push({
      name: "update_clip",
      params: { elementId: row.id, patch: { location: { x: from.x, y: from.y } } },
    });
    steps.push({ name: "ext_set_element_data", params: { elementId: row.id, value: null } });
  }

  if (steps.length === 0) {
    await cartcut.window.showMessage("This extension has not moved anything.");
    return { reverted: 0 };
  }

  const result = await cartcut.commands.batch(steps);
  await refresh();
  await cartcut.window.showMessage(
    result.ok ? "Put " + steps.length / 2 + " back." : "Nothing changed: " + (result.reason || ""),
  );
  return { reverted: result.ok ? steps.length / 2 : 0 };
}

// -------------------------------------------------------------- reporting

async function refresh() {
  const report = await scan();
  const outside = report.offenders.length;

  await cartcut.window.setStatusItem({
    id: "titleSafe.status",
    text: outside === 0 ? "Title safe" : "Title safe: " + outside,
    tooltip:
      outside === 0
        ? "Every caption is inside the " + report.margin + "% safe area."
        : outside + " outside the " + report.margin + "% safe area. Click to fix.",
    command: outside === 0 ? undefined : "titleSafe.fixAll",
  });

  await cartcut.ui.postMessageToView("titleSafe.panel", report);
  return report;
}

// ------------------------------------------------------------------ setup

async function activate(ctx) {
  ctx.subscriptions.push(
    cartcut.commands.registerCommand("titleSafe.check", async () => {
      const report = await refresh();
      await cartcut.window.showPanel("titleSafe.panel");
      return report;
    }),
  );

  ctx.subscriptions.push(cartcut.commands.registerCommand("titleSafe.fixAll", fixAll));
  ctx.subscriptions.push(cartcut.commands.registerCommand("titleSafe.revertAll", revertAll));

  // The panel asks when it mounts, because a view is handed no state: it is
  // its own page in its own process and has to start the conversation.
  ctx.subscriptions.push(
    cartcut.ui.onViewMessage("titleSafe.panel", async (message) => {
      if (message && message.want === "report") {
        await refresh();
        return;
      }
      if (message && message.select) {
        await cartcut.selection.set([message.select]);
        if (typeof message.atMs === "number") {
          await cartcut.playback.setPlayhead(message.atMs);
        }
        return;
      }
      // The panel's buttons call in rather than running a command themselves.
      // A view has no way to invoke one, deliberately: it is the least
      // trusted process here, and everything it asks for goes through the
      // extension that owns it.
      if (message && message.run === "titleSafe.fixAll") {
        await fixAll();
        return;
      }
      if (message && message.run === "titleSafe.revertAll") {
        await revertAll();
      }
    }),
  );

  // Recount when the document changes, which is once per undo step rather
  // than once per frame of a drag: the event is coalesced for exactly this.
  ctx.subscriptions.push(cartcut.timeline.onDidChange(() => void refresh()));
  ctx.subscriptions.push(cartcut.project.onDidOpen(() => void refresh()));
  ctx.subscriptions.push(cartcut.config.onDidChange(() => void refresh()));

  /*
   * The veto, off unless the user asked for it.
   *
   * An extension that silently blocked exports would be uninstalled the first
   * time it was wrong, and it will be wrong: a caption deliberately bled off
   * the edge is a real choice. So the default is to say nothing, and the
   * setting is what turns a warning into a refusal.
   */
  ctx.subscriptions.push(
    cartcut.exports.onWillExport(async (event) => {
      const blocking = (await cartcut.config.get("titleSafe.blockExport")) === true;
      if (!blocking) {
        return;
      }
      const report = await scan();
      if (report.offenders.length > 0) {
        event.veto(
          report.offenders.length +
            " caption(s) sit outside the title-safe area. Run Title Safe, or turn off blocking in its settings.",
        );
      }
    }),
  );

  ctx.subscriptions.push(
    cartcut.ai.registerTool({
      name: "check_title_safe",
      description: "List text clips outside the broadcast title-safe area. Read only.",
      inputSchema: { type: "object", properties: {} },
      handler: async () => {
        const report = await scan();
        return {
          frame: report.frame,
          marginPercent: report.margin,
          checked: report.checked,
          outside: report.offenders.map((offender) => ({
            elementId: offender.id,
            text: String(offender.text).slice(0, 60),
            startMs: offender.startMs,
            past: offender.over,
            canBeMoved: offender.target.fits,
          })),
        };
      },
    }),
  );

  await refresh();
  ctx.log.info("title-safe ready");
}

function deactivate() {
  // Nothing to tear down by hand: every handle this extension made went into
  // `ctx.subscriptions`, which the host disposes in reverse order.
}

module.exports = { activate, deactivate };
