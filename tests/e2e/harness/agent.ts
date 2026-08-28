/**
 * Driving the editor's own command layer, over the channel it already has.
 *
 * `electron/mcp/bridge.ts` sends `agent:request` to the renderer and waits for
 * `agent:response`; `apps/app/src/features/agent/bridge.ts` answers it by
 * running a registered command through `commit()`. That is the same code path
 * an MCP tool call takes and — per CLAUDE.md — the same pure ops and the same
 * single undo step as the user's own mouse. So this is not a test backdoor: it
 * is the automation surface the app ships.
 *
 * Reached from the main process rather than over HTTP, which matters twice
 * over. The MCP server binds a fixed port (9826) and declines with `EADDRINUSE`
 * if the developer's own Cartcut already holds it; and it needs a bearer token
 * out of the user's store. Speaking IPC directly needs neither, so the suite
 * runs alongside a real editor without contending for anything.
 *
 * Adding a second `agent:response` listener is safe: the production bridge
 * looks the id up in its own `pending` map and drops what it does not
 * recognise (`bridge.ts`, "A reply that arrived after its own timeout"), and
 * this listener does the same in reverse.
 *
 * **UI first, this second.** Anything whose UI wiring is under test gets
 * clicked (see `ui.ts`). This is for bulk placement — twenty clips, three
 * hundred keyframes, a few dozen subtitle lines — where driving a mouse would
 * add flake without adding coverage.
 */

import type { AppSession } from "./launch";

/** `bridge.ts` uses 20s; media probing is the one command that needs longer. */
const DEFAULT_TIMEOUT_MS = 20_000;
const MEDIA_TIMEOUT_MS = 120_000;

const SLOW_COMMANDS = new Set(["add_media", "get_transcript_source", "rasterize_text"]);

export class AgentCommandError extends Error {
  constructor(readonly command: string, readonly params: unknown, message: string) {
    super(`agent "${command}" failed: ${message}`);
    this.name = "AgentCommandError";
  }
}

/**
 * Run one editor command and return its result.
 *
 * Rejects on the editor's own error rather than returning an error shape, so a
 * scenario step that cannot be applied stops the build instead of quietly
 * producing a timeline missing one clip — which would surface much later as an
 * inscrutable frame mismatch.
 */
export async function agent<T = unknown>(
  session: AppSession,
  command: string,
  params: Record<string, unknown> = {},
  timeoutMs?: number,
): Promise<T> {
  const budget = timeoutMs ?? (SLOW_COMMANDS.has(command) ? MEDIA_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);

  const outcome = await session.app.evaluate(
    async ({ ipcMain, BrowserWindow }, call) => {
      const editor = BrowserWindow.getAllWindows().find((w) =>
        w.webContents.getURL().endsWith("index.html"),
      );
      if (editor == null || editor.isDestroyed()) {
        return { ok: false, error: "editor window is gone" };
      }

      const id = `e2e-${call.seq}-${Math.random().toString(36).slice(2, 10)}`;

      return await new Promise<{ ok: boolean; result?: unknown; error?: string }>((resolve) => {
        const done = (value: { ok: boolean; result?: unknown; error?: string }) => {
          clearTimeout(timer);
          ipcMain.removeListener("agent:response", onResponse);
          resolve(value);
        };

        const onResponse = (_event: unknown, replyId: string, response: any) => {
          // Not ours: the production bridge has its own requests in flight and
          // both listeners see every reply.
          if (replyId !== id) return;
          done(
            response?.ok
              ? { ok: true, result: response.result }
              : { ok: false, error: String(response?.error ?? "unknown editor error") },
          );
        };

        const timer = setTimeout(
          () => done({ ok: false, error: `editor did not respond within ${call.timeoutMs}ms` }),
          call.timeoutMs,
        );

        ipcMain.on("agent:response", onResponse);
        editor.webContents.send("agent:request", id, call.command, call.params);
      });
    },
    { command, params, timeoutMs: budget, seq: nextSeq() },
  );

  if (!outcome.ok) {
    throw new AgentCommandError(command, params, outcome.error ?? "unknown");
  }
  return outcome.result as T;
}

let seq = 0;
function nextSeq(): number {
  return ++seq;
}

/**
 * Run commands in order, stopping at the first failure.
 *
 * Sequential on purpose. Every mutating command runs through
 * `withCheckpoint`, which reads the current document and writes a new one;
 * two in flight at once would race on that read and the loser's edit would be
 * silently dropped.
 */
export async function agentSequence(
  session: AppSession,
  calls: Array<{ command: string; params?: Record<string, unknown>; label?: string }>,
): Promise<unknown[]> {
  const results: unknown[] = [];
  for (const call of calls) {
    try {
      results.push(await agent(session, call.command, call.params ?? {}));
    } catch (error) {
      throw new Error(
        `scenario step ${results.length + 1}/${calls.length}` +
        `${call.label ? ` (${call.label})` : ""} failed:\n  ${(error as Error).message}`,
      );
    }
  }
  return results;
}

// ------------------------------------------------------- typed conveniences

/**
 * A row as `features/agent/serialize.ts#clipRow` projects it.
 *
 * The names are the projection's, not the element's: `type` rather than
 * `filetype`, and `dur`/`end` are spans on the *timeline*, which differ from
 * `element.duration` whenever `speed !== 1`. Times are in milliseconds.
 */
export type ClipRow = {
  id: string;
  type: string;
  start: number;
  dur: number;
  end: number;
  trackId: string;
  track?: string;
  parentId?: string;
  src?: string;
  speed?: number;
  volumeDb?: number;
  [key: string]: unknown;
};

export async function projectOverview(session: AppSession): Promise<any> {
  return agent(session, "get_project_overview");
}

export async function listClips(
  session: AppSession,
  params: Record<string, unknown> = {},
): Promise<{ clips: ClipRow[]; total: number }> {
  return agent(session, "list_clips", { limit: 500, ...params });
}

export async function getClip(session: AppSession, elementId: string): Promise<any> {
  return agent(session, "get_clip", { elementId });
}

export async function setPlayhead(session: AppSession, atMs: number): Promise<unknown> {
  return agent(session, "set_playhead", { atMs });
}

export async function selectClips(session: AppSession, ids: string[]): Promise<unknown> {
  return agent(session, "select_clips", { ids });
}

/**
 * Every element on the timeline, straight out of the store.
 *
 * `list_clips` runs through `serialize.ts`'s whitelist, which deliberately
 * omits `effect` and `transition` from `FILETYPES` — so the agent read tools
 * cannot see two of the nine element types at all. The scenario places both,
 * and the frame sampler needs their spans, so this reads the document itself.
 */
export async function timelineDocument(session: AppSession): Promise<Record<string, any>> {
  return session.page.evaluate(() => {
    const store = (globalThis as any).CARTCUT.useTimelineStore.getState();
    const doc = store.getDocument();
    // `animation.ax` holds up to 36,000 baked samples per lane and would make
    // this payload enormous for no gain — the sampler wants spans and ids.
    const out: Record<string, any> = {};
    for (const [id, element] of Object.entries<any>(doc.elements ?? store.timeline)) {
      const { animation, shape, blob, ...rest } = element;
      out[id] = {
        ...rest,
        hasAnimation: animation != null,
        animatedTracks: animation == null
          ? []
          : Object.entries<any>(animation)
              .filter(([, lane]) => lane?.isActivate)
              .map(([name]) => name),
      };
    }
    return out;
  });
}
