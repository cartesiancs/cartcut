/**
 * Renderer end of the MCP bridge: receive a command, run it, answer.
 *
 * Importing this module is what connects the editor to Claude Code; the side
 * effect is the point, which is why `index.ts` imports it for effect only.
 *
 * Every path answers exactly once. A command that throws becomes an error
 * *response*, not an unhandled rejection — the tool layer in main turns that
 * into `isError` content so Claude Code sees what went wrong and can correct
 * itself, rather than watching the call time out with no explanation.
 */

import { getLocationEnv } from "../../functions/getLocationEnv";
import { getCommand, commandNames } from "./registry";

/** Registers the command tables. Import order matters only in that these must
 * run before the first request can arrive, which the IPC listener below
 * guarantees by being installed last. */
import "./commands/read";
import "./commands/edit";
import "./commands/text";
import "./commands/meta";

let installed = false;

export function installAgentBridge() {
  if (installed) {
    return;
  }

  // The bridge is Electron-only: in web/demo mode `ipcWrapper` stubs most of
  // `electronAPI` out, and there is no main process to talk to.
  if (getLocationEnv() !== "electron") {
    return;
  }

  const api = window.electronAPI?.res?.agent;
  if (api == null) {
    // An older preload. Better to run without the agent than to crash the app.
    console.warn("[agent] preload has no agent channel; MCP bridge disabled");
    return;
  }

  installed = true;

  api.onRequest(async (_event, id: string, command: string, params: any) => {
    try {
      const fn = getCommand(command);
      if (fn == null) {
        throw new Error(
          `Unknown editor command "${command}". Known: ${commandNames().join(", ")}`,
        );
      }

      const result = await fn(params ?? {});
      window.electronAPI.req.agent.respond(id, { ok: true, result });
    } catch (error) {
      window.electronAPI.req.agent.respond(id, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

installAgentBridge();
