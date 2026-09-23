/**
 * Messages between an extension's webview page and its extension.
 *
 * The route is guest to **main** to host, and the editor renderer is not in
 * it. That is deliberate and it is the whole reason this file exists: a panel
 * that posts a message every animation frame would otherwise spend the
 * editor's main thread on JSON it has no use for, in the one process that also
 * has to composite the preview.
 *
 * Main is the only process that can map a `webContents` to an extension,
 * because main is where the guest attached. A message that claimed its own
 * extension id would be a message any page could forge.
 */

import { ipcMain, type WebContents } from "electron";

import { MAX_VIEW_MESSAGE_BYTES } from "./protocol";

export const VIEW_CHANNEL = "ext:view:message";

/** How many messages one view may send per second before the rest are dropped. */
export const VIEW_MESSAGE_RATE = 200;

type Attached = { extId: string; viewId: string; contents: WebContents };

const attached = new Map<number, Attached>();
const counters = new Map<number, { windowStartedAt: number; count: number; reported: boolean }>();

/**
 * A fixed window rather than a token bucket.
 *
 * The thing being defended against is a loop, not a burst, and a loop trips a
 * fixed window just as reliably for a fraction of the bookkeeping. The
 * `reported` flag means a runaway page logs once rather than two hundred times
 * a second, which is the failure mode of the naive version.
 */
function withinRate(id: number, now: number): boolean {
  const counter = counters.get(id) ?? { windowStartedAt: now, count: 0, reported: false };
  if (now - counter.windowStartedAt >= 1_000) {
    counter.windowStartedAt = now;
    counter.count = 0;
    counter.reported = false;
  }
  counter.count += 1;
  counters.set(id, counter);

  if (counter.count <= VIEW_MESSAGE_RATE) {
    return true;
  }
  if (!counter.reported) {
    counter.reported = true;
    const owner = attached.get(id);
    console.warn(
      "[extension] dropping messages from " + (owner?.extId ?? "a view") + ": over " + VIEW_MESSAGE_RATE + " per second",
    );
  }
  return false;
}

export function registerExtensionView(contents: WebContents, extId: string, viewId: string): void {
  if (extId === "") {
    return;
  }
  attached.set(contents.id, { extId, viewId, contents });
  contents.once("destroyed", () => {
    attached.delete(contents.id);
    counters.delete(contents.id);
  });
}

/**
 * Install the one listener.
 *
 * One, registered at startup and never removed. Registering per view is the
 * defect `mcp/bridge.ts` was written to replace, and a view is created and
 * destroyed every time a panel is opened and closed.
 */
export function installViewBridge(forward: (extId: string, viewId: string, message: unknown) => void): void {
  if (ipcMain.listenerCount(VIEW_CHANNEL) > 0) {
    return;
  }

  ipcMain.on(VIEW_CHANNEL, (event, payload: unknown) => {
    const owner = attached.get(event.sender.id);
    if (owner == null) {
      // A page that is not a registered view. Nothing else in this app posts
      // on this channel, so this is either a race with teardown or something
      // that has no business here; either way there is no extension to
      // deliver it to.
      return;
    }
    if (!withinRate(event.sender.id, Date.now())) {
      return;
    }

    let size = 0;
    try {
      size = JSON.stringify(payload)?.length ?? 0;
    } catch {
      return;
    }
    if (size > MAX_VIEW_MESSAGE_BYTES) {
      console.warn("[extension] dropping a " + size + " byte message from " + owner.extId);
      return;
    }

    forward(owner.extId, owner.viewId, payload);
  });
}

/** Deliver a message from an extension to one of its own views. */
export function postToView(extId: string, viewId: string, message: unknown): void {
  for (const owner of attached.values()) {
    if (owner.extId !== extId) {
      continue;
    }
    // An empty `viewId` addresses every view the extension has open, which is
    // what a broadcast from `postMessageToView` with no target means.
    if (viewId !== "" && owner.viewId !== viewId) {
      continue;
    }
    if (!owner.contents.isDestroyed()) {
      owner.contents.send(VIEW_CHANNEL, message);
    }
  }
}

/** Which views are open, so the host can be told one became visible. */
export function openViews(): Array<{ extId: string; viewId: string }> {
  return [...attached.values()].map((owner) => ({ extId: owner.extId, viewId: owner.viewId }));
}
