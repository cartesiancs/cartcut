/**
 * Reversing clips: the one code path the context menu and the option panel
 * both call, the rule `features/editor/actions.ts` states for the toolbar.
 *
 * A reversal is two halves at two speeds. The slow half runs in main
 * (`electron/lib/reverse.ts`) and makes a file; this module starts it, shows it
 * in the tray through `backgroundTaskStore`, and when the file lands applies
 * the instant half — `reverseOps.applyReverse` — as **one undo step**.
 *
 * The clip the user started on may have changed by then; reversing heavy
 * footage takes minutes and editing goes on meanwhile. `applyReverse` checks
 * the clip still covers the window the file was cut from and declines by
 * identity if not, and this module says so in a toast rather than applying a
 * file of the wrong footage.
 *
 * Un-reversing needs no file and no job: `reversed` on the element holds the
 * way back.
 */

import { v4 as uuidv4 } from "uuid";
import { useTimelineStore } from "../../states/timelineStore";
import { backgroundTaskStore, taskFor } from "../../states/backgroundTaskStore";
import {
  applyReverse,
  reverseSnapshotOf,
  unreverseMany,
  type ReverseSnapshot,
} from "../timeline/reverseOps";
import { toLocalPathKey, toOsPath } from "../proxy/proxyPath";

const KIND = "reverse";

type ReverseBridge = {
  start: (
    jobId: string,
    request: { source: string; fromMs: number; toMs: number },
  ) => Promise<
    | { ok: true; path: string; durationMs: number; hasAudio: boolean }
    | { ok: false; cancelled?: boolean; error?: string }
  >;
  cancel: (jobId: string) => Promise<unknown>;
  onProgress: (
    handler: (payload: {
      jobId: string;
      fraction: number | null;
      stage: string;
    }) => void,
  ) => () => void;
};

/** The preload bridge, or `null` in the web build, which has no main process. */
function bridge(): ReverseBridge | null {
  return (window as any).electronAPI?.req?.reverse ?? null;
}

/** Whether reversal is available at all. The menu and panel hide it if not. */
export function canReverseHere(): boolean {
  return bridge() != null;
}

/** Whether `elementId` is being reversed, or waiting to be. */
export function isReversePending(elementId: string): boolean {
  return taskFor(KIND, elementId) != null;
}

let listening = false;

/** One listener for every job, installed on first use. */
function listen(api: ReverseBridge): void {
  if (listening) {
    return;
  }
  listening = true;
  api.onProgress(({ jobId, fraction, stage }) => {
    backgroundTaskStore.getState().progress(jobId, fraction, stage);
  });
}

/**
 * Start reversing every clip in `elementIds` that can be. Returns at once; each
 * clip lands separately, as its own undo step, when its file is made.
 */
export function reverseClips(elementIds: readonly string[]): void {
  const api = bridge();
  if (api == null) {
    return;
  }
  listen(api);

  const doc = useTimelineStore.getState().getDocument();
  for (const elementId of new Set(elementIds)) {
    if (isReversePending(elementId)) {
      continue;
    }
    const snapshot = reverseSnapshotOf(doc.elements[elementId]);
    if (snapshot == null) {
      continue;
    }
    void run(api, elementId, snapshot);
  }
}

/** Put the clips back on their forward sources, as one undo step. */
export function unreverseClips(elementIds: readonly string[]): void {
  const ids = [...elementIds];
  useTimelineStore.getState().withCheckpoint((doc) => unreverseMany(doc, ids));
}

async function run(
  api: ReverseBridge,
  elementId: string,
  snapshot: ReverseSnapshot,
): Promise<void> {
  const jobId = uuidv4();
  const name = fileName(snapshot.localpath);
  backgroundTaskStore.getState().add({
    id: jobId,
    kind: KIND,
    subject: elementId,
    label: `Reversing ${name}`,
    icon: "fast_rewind",
    fraction: 0,
    stage: "split",
    cancel: () => void api.cancel(jobId),
  });

  try {
    const result = await api.start(jobId, {
      source: toOsPath(snapshot.localpath),
      fromMs: snapshot.trim.startTime,
      toMs: snapshot.trim.endTime,
    });

    if (result.ok) {
      const localpath = sameShape(snapshot.localpath, result.path);
      let applied = false;
      useTimelineStore.getState().withCheckpoint((doc) => {
        const next = applyReverse(doc, elementId, snapshot, {
          localpath,
          durationMs: result.durationMs,
          hasAudio: result.hasAudio,
        });
        applied = next !== doc;
        return next;
      });
      if (!applied) {
        toast(
          `${name} changed while it was being reversed, so it was left as it is.`,
        );
      }
    } else if (result.cancelled !== true) {
      toast(`Could not reverse ${name}: ${firstLine(result.error)}`);
    }
  } catch (error) {
    toast(
      `Could not reverse ${name}: ${firstLine(
        error instanceof Error ? error.message : String(error),
      )}`,
    );
  } finally {
    backgroundTaskStore.getState().remove(jobId);
  }
}

/**
 * The reversed file's path in the same spelling as the source's.
 *
 * Nearly every clip carries a `file://` form minted by `mediaProbe`, and the
 * screen recorder's carry a bare path. Matching the source keeps one file from
 * having two spellings, which `mergeOps` would read as two different files.
 */
function sameShape(sourceLocalpath: string, osPath: string): string {
  return sourceLocalpath.startsWith("file://")
    ? toLocalPathKey(osPath)
    : osPath;
}

function fileName(localpath: string): string {
  const os = toOsPath(localpath);
  return os.split(/[\\/]/).pop() || os;
}

function firstLine(text: string | undefined): string {
  return (text ?? "unknown error").split("\n")[0].slice(0, 200);
}

function toast(message: string): void {
  (document.querySelector("toast-box") as any)?.showToast({
    message,
    delay: "5000",
  });
}
