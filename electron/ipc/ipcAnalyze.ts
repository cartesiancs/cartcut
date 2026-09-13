/**
 * The renderer's view of audio analysis: silences, at a threshold it chooses.
 *
 * The auto-caption panel's "remove silence" needs to know where a take goes
 * quiet, and until now that measurement existed only behind the MCP
 * `analyze_audio` tool. This is the same `analyzeSilences` the tool reaches,
 * with no agent in the middle.
 *
 * Deliberately smaller than `ipcTranscribe.ts`, which it otherwise mirrors. No
 * job id, no progress, no cancel, and no queue:
 *
 * - there is nothing to report progress *through* — one ffmpeg decode with no
 *   intermediate output, unlike a recogniser that downloads a model first;
 * - `analyzeFile` holds an in-flight map keyed the same way its cache is, so a
 *   second call during a decode waits on the first instead of starting another,
 *   which is what a queue would have been for;
 * - and the result is cached on disk by file identity, so every call after the
 *   first is effectively free.
 *
 * A failure comes back as `{ ok: false }` rather than a rejection. The panel
 * treats the sweep as an offer that can decline: a clip with no audio track, a
 * file that has moved, an ffmpeg that will not start. None of those should
 * surface as an unhandled rejection in a renderer that is otherwise working.
 */

import type { IpcMainInvokeEvent } from "electron";
import { analyzeSilences } from "../mcp/analyze";
import type { Range } from "../mcp/analysis/signal";

export type AnalyzeSilencesRequest = {
  /** A clip's `localpath`, a `file://` URL. `analyzeFile` converts it. */
  source: string;
  /** dBFS. Louder admits more as silence. `silentRanges` defaults to -40. */
  thresholdDb?: number;
  /** The shortest run worth reporting. `silentRanges` defaults to 300. */
  minMs?: number;
};

export type AnalyzeSilencesResult =
  | {
      ok: true;
      /**
       * The **file's** length, not the clip's.
       *
       * The caller needs it to know where the trailing silence ends, and a
       * clip's own duration is the length of its trim window.
       */
      durationMs: number;
      /** Source-file milliseconds. */
      silences: Range[];
    }
  | { ok: false; error: string };

export const ipcAnalyze = {
  silences: async (
    _event: IpcMainInvokeEvent,
    request: AnalyzeSilencesRequest,
  ): Promise<AnalyzeSilencesResult> => {
    try {
      const { durationMs, silences } = await analyzeSilences(request.source, {
        thresholdDb: request.thresholdDb,
        minMs: request.minMs,
      });
      return { ok: true, durationMs, silences };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
};
