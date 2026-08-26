/**
 * The glue between a drop and the timeline.
 *
 * Everything decidable lives in `importMedia.ts`, `droppedFiles.ts` and
 * `dropTarget.ts`, which are pure and tested. What is left here is the part
 * that cannot be: reaching the store, the preload bridge and the toast. Both
 * drop targets — the full-window curtain and the timeline canvas — come through
 * this one function, so a file dragged in from the OS and an asset dragged out
 * of the panel land by exactly the same rules.
 */

import { useTimelineStore } from "../../states/timelineStore";
import { normalizeFps } from "../timeline/frames";
import { renderOptionStore } from "../../states/renderOptionStore";
import { collectDroppedPaths } from "./droppedFiles";
import { planImport, placeImported } from "./importMedia";
import type { DropTarget } from "./dropTarget";
import { v4 as uuidv4 } from "uuid";

/** Where a drop lands when it did not land on the timeline itself. */
export function atPlayhead(): DropTarget {
  return {
    startMs: Math.max(0, Math.round(useTimelineStore.getState().cursor ?? 0)),
    trackId: null,
  };
}

function projectFps(): number {
  return normalizeFps(renderOptionStore.getState().options?.fps);
}

function toast(message: string) {
  const box: any = document.querySelector("toast-box");
  box?.showToast({ message, delay: "3000" });
}

/**
 * Read the paths out of an OS file drop.
 *
 * `webUtils.getPathForFile` has to be called synchronously here, with the real
 * `File` — it cannot cross IPC, and the `File` objects do not survive the
 * handler returning. This is the replacement for `File.path`, which Electron
 * removed in v32 and which this app read right up until it stopped working.
 */
export function pathsFromDataTransfer(dataTransfer: DataTransfer | null): string[] {
  const resolve = (window as any).electronAPI?.req?.webUtils?.getPathForFile;

  if (typeof resolve !== "function") {
    // The web build has no preload. Nothing to import, but say so rather than
    // failing the way the old handler did — silently.
    toast("Dropping files is only available in the desktop app.");
    return [];
  }

  const files = dataTransfer ? Array.from(dataTransfer.files) : [];
  const { paths, unresolved } = collectDroppedPaths(files as any, (f) =>
    resolve(f as unknown as File),
  );

  if (unresolved.length > 0) {
    toast(`Could not read ${unresolved.length} dropped item(s).`);
  }

  return paths;
}

/**
 * Probe every path and place the readable ones as one undo step.
 *
 * Awaits the probes before touching the store, so the transform stays pure and
 * the whole run lands in a single `withCheckpoint` — Cmd+Z takes a drop of ten
 * files away the way the user dropped them, together.
 */
export async function importPathsAt(
  paths: readonly string[],
  target: DropTarget,
): Promise<string[]> {
  if (paths.length === 0) {
    return [];
  }

  const plan = await planImport(paths);

  if (plan.skipped.length > 0) {
    const first = plan.skipped[0];
    toast(
      plan.skipped.length === 1
        ? first.reason
        : `Skipped ${plan.skipped.length} files. ${first.reason}`,
    );
  }

  if (plan.ready.length === 0) {
    return [];
  }

  let createdIds: string[] = [];

  useTimelineStore.getState().withCheckpoint((doc) => {
    const result = placeImported(doc, plan, {
      startMs: target.startMs,
      trackId: target.trackId,
      fps: projectFps(),
      newId: uuidv4,
    });
    createdIds = result.createdIds;
    return result.doc;
  });

  return createdIds;
}

/** An OS file drop, from the event to the placed clips. */
export async function importDroppedFiles(
  dataTransfer: DataTransfer | null,
  target: DropTarget,
): Promise<string[]> {
  try {
    return await importPathsAt(pathsFromDataTransfer(dataTransfer), target);
  } catch (error) {
    // The old handler had a bare `catch {}` here, which is why a drop that
    // stopped working took two Electron majors to notice.
    console.error("[drop] could not import dropped files", error);
    toast("Those files could not be added.");
    return [];
  }
}
