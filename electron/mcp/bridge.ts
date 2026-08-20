/**
 * The main <-> renderer channel the MCP tools run on.
 *
 * Every editing primitive this app has — `clipOps`, `placement`, `tracks`,
 * `withCheckpoint` — lives in `apps/app/src`, and `.tsconfig` pins `rootDir` to
 * `electron/` precisely so that tree can never be imported from here (one such
 * import relocates the whole build from `main/` to `main/electron/` and
 * `package.json` stops finding its entry point). So a tool cannot edit the
 * timeline itself; it asks the renderer to, and the renderer answers.
 *
 * `ipcTimeline.get` already does a round trip of this shape and gets it wrong
 * in three ways worth naming, because they are the reasons this file exists:
 * it registers a fresh `ipcMain.on("return:timeline:get")` listener on every
 * single call and never removes one, it has no request id — so with two calls
 * in flight the first reply resolves both — and it has no timeout, so a
 * renderer that never answers leaves the caller hanging forever. An MCP server
 * is exactly the caller that makes all three fire: it is long-lived, and
 * Claude Code will happily run tool calls concurrently.
 */

import { ipcMain, WebContents } from "electron";
import { randomUUID } from "crypto";

/** What the renderer sends back. Errors travel as data, not as exceptions. */
export type BridgeResponse =
  | { ok: true; result: unknown }
  | { ok: false; error: string };

type Pending = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
};

const pending = new Map<string, Pending>();

/**
 * Long enough for a real edit on a large project, short enough that a wedged
 * renderer surfaces as a tool error rather than a hung Claude Code session.
 * Transcription does not come through here — it runs entirely in main.
 */
export const DEFAULT_TIMEOUT_MS = 20_000;

/** Set once the main window exists; see `attachBridge`. */
let target: WebContents | null = null;

/**
 * Point the bridge at a renderer and install the single reply handler.
 *
 * Idempotent: `ipcMain.handle` throws on a duplicate channel, and this is
 * called from window creation, which can happen again on macOS `activate`.
 */
export function attachBridge(webContents: WebContents) {
  target = webContents;

  webContents.once("destroyed", () => {
    // Only if this is still *the* window. A window that was already replaced
    // has no claim on the requests now in flight, and failing them because an
    // old window finally went away would be a lie.
    if (target !== webContents) {
      return;
    }
    target = null;

    // Nothing will ever answer these now.
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error("Editor window closed before the request completed"));
      pending.delete(id);
    }
  });

  if (ipcMain.listenerCount("agent:response") > 0) {
    return;
  }

  ipcMain.on("agent:response", (_event, id: string, response: BridgeResponse) => {
    const entry = pending.get(id);
    if (entry == null) {
      // A reply that arrived after its own timeout. Dropping it is correct —
      // the caller already got an error and moved on.
      return;
    }

    pending.delete(id);
    clearTimeout(entry.timer);

    if (response?.ok) {
      entry.resolve(response.result);
    } else {
      entry.reject(new Error(response?.error ?? "Unknown editor error"));
    }
  });
}

export function isBridgeReady(): boolean {
  return target != null && !target.isDestroyed();
}

/**
 * Run one command in the renderer and wait for its result.
 *
 * Rejects rather than returning an error shape: the MCP tool layer turns a
 * rejection into `isError` content, which is what Claude Code needs to see.
 */
export function requestEditor(
  command: string,
  params: unknown = {},
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<unknown> {
  if (target == null || target.isDestroyed()) {
    return Promise.reject(
      new Error(
        "Cartcut's editor window is not available. Is the app running and past its splash screen?",
      ),
    );
  }

  const id = randomUUID();
  const webContents = target;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(
        new Error(
          `Editor did not respond to "${command}" within ${timeoutMs}ms`,
        ),
      );
    }, timeoutMs);

    pending.set(id, { resolve, reject, timer });
    webContents.send("agent:request", id, command, params);
  });
}
