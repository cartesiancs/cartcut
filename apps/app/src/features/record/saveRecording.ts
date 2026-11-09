/**
 * What both recorders do after `MediaRecorder` stops: write the blob, then put
 * the file on the timeline.
 *
 * This used to be `AssetController.addVideoWithDuration` ->
 * `elementControl.addVideoWithDuration`, a second copy of the element builder
 * that committed from inside an `ipcRenderer.on("GET_METADATA")` callback. That
 * channel had been migrated to `invoke`, so nothing ever sent the event, the
 * callback never ran, and a screen recording saved to disk and then vanished.
 * Its audio twin only worked by skipping the probe entirely.
 *
 * So both go through `importPathsAt` now, the same path an OS file drop takes:
 * one probe, one `withCheckpoint`, one undo step, and a `file://` localpath
 * built in the one place that knows the rule.
 */

import { importPathsAt, atPlayhead } from "../asset/importDrop";
import { importedMediaStore } from "../asset/webMedia/importedMedia";
import { isBrowserBuild } from "../../functions/getLocationEnv";
import { recordProcessStore } from "../../states/recordProcessStore";
import { planAutoZoom, readInputLog } from "./applyAutoZoom";
import { loadRecordSettings } from "./recordSettingsBridge";

function toast(message: string) {
  const box: any = document.querySelector("toast-box");
  box?.showToast({ message, delay: "3000" });
}

/**
 * Save a finished recording and place it at the playhead.
 *
 * `wallClockMs` is the recorder's own `endTime - startTime`. It is the fallback
 * and not the answer: a `MediaRecorder` container states no length, but seeking
 * the saved file recovers the real one, and that beats a figure inflated by
 * start latency. See `mediaProbe.ts#resolveDurationMs`.
 *
 * Returns the created ids, or an empty array — which is also what a cancelled
 * save dialog gives, since that is not a failure and deserves no toast.
 */
export async function saveAndImportRecording(
  buffer: Buffer,
  kind: "video" | "audio",
  wallClockMs: number,
  mimeType = "",
): Promise<string[]> {
  if (isBrowserBuild()) {
    return importBrowserRecording(buffer, kind, wallClockMs, mimeType);
  }
  try {
    const stream = window.electronAPI.req.stream;
    const saved =
      kind === "video"
        ? await stream.saveBufferToVideo(buffer)
        : await stream.saveBufferToAudio(buffer);

    // The main handler returns `undefined` when the user cancels the save
    // dialog, so this cannot be a plain `saved.status` — that threw a
    // TypeError into an unhandled rejection nobody saw.
    if (saved?.status !== true || !saved.path) {
      return [];
    }

    return await importPathsAt(
      [{ path: saved.path, fallbackDurationMs: wallClockMs }],
      atPlayhead(),
    );
  } catch (error) {
    console.error("[record] could not save the recording", error);
    toast("That recording could not be added.");
    return [];
  }
}

/**
 * A finished overlay recording, arriving from the recorder.
 *
 * The editor's entire involvement in an overlay take. The recorder runs in its
 * own windows, captures and encodes and composites there, and reaches the
 * editor exactly once — here, with a path to a finished MP4 already on disk.
 *
 * No save dialog, unlike `saveAndImportRecording`: the recorder's Stop button
 * is in the menu bar, the editor may not even be the front window, and putting
 * a modal in front of somebody who has just finished talking to camera is the
 * wrong moment for a file browser. The file is already filed, under
 * `Videos/Cartcut Recordings`, and the tray can open that folder.
 *
 * No `fallbackDurationMs` either. The muxed container states its own length —
 * that is what `-movflags +faststart` and a real mux buy over the raw
 * `MediaRecorder` blob the in-panel recorders produce, and it is why
 * `mediaProbe.ts`'s seek-past-the-end trick has nothing to do here.
 */
export async function receiveOverlayRecording(
  filePath: string,
  inputPath: string | null = null,
): Promise<string[]> {
  const process = recordProcessStore.getState();

  try {
    process.enter("reading");

    // Read and plan *before* touching the document. The planning is the slow half
    // and it needs no document, so it happens while the dialog still says so; the
    // transform that lands inside `withCheckpoint` is then pure arithmetic.
    const log = await readInputLog(inputPath);
    const strength = (await loadRecordSettings())?.autoZoom ?? "on";

    process.enter("planning");
    const plan = planAutoZoom(log, strength);

    // The one place Cancel is read. Between here and the commit there is nothing to
    // abandon that would not leave half an edit, which is why `processView` stops
    // offering it at `placing`.
    const skipped = recordProcessStore.getState().cancelled;

    process.enter("placing");

    // The fit is not optional and the zoom is: `buildVideo` hands over a clip at its
    // native pixel size at (0,0), so a 3024-wide capture arrives a quarter visible
    // against the top left corner whether or not anything zooms. `planAutoZoom` with
    // no log still fits it, which is also what a skip wants.
    const transform = skipped ? planAutoZoom(null, "off").transform : plan.transform;

    const created = await importPathsAt([{ path: filePath }], atPlayhead(), transform);

    recordProcessStore.getState().clear();

    if (created.length > 0) {
      toast(
        skipped || plan.moves === 0
          ? "Recording added to the timeline."
          : `Recording added, with ${plan.moves} zoom${plan.moves === 1 ? "" : "s"}.`,
      );
    }

    return created;
  } catch (error) {
    console.error("[record] could not import the recording", error);
    recordProcessStore.getState().enter("failed", "The recording could not be added.");
    toast("That recording could not be added.");
    return [];
  }
}

/**
 * Listen for them. Called once, at startup.
 *
 * Guarded on the bridge existing rather than on the environment: the web build
 * has no recorder to hear from, and `ipcWrapper.ts`'s shim answers `"none"`
 * rather than subscribing.
 */
export function watchOverlayRecordings(): void {
  const on = (window as any).electronAPI?.res?.overlayRecord?.complete;

  if (typeof on !== "function") {
    return;
  }

  on((_event: unknown, payload: { path?: string; inputPath?: string | null }) => {
    if (typeof payload?.path === "string" && payload.path.length > 0) {
      void receiveOverlayRecording(
        payload.path,
        typeof payload.inputPath === "string" ? payload.inputPath : null,
      );
    }
  });

  // The mux is the slow half and it happens in main, before the editor knows a take
  // has even stopped. Without this notice the dialog would appear only once the file
  // was already written, which is the moment it is no longer needed.
  const onProcessing = (window as any).electronAPI?.res?.overlayRecord?.processing;
  if (typeof onProcessing === "function") {
    onProcessing(() => {
      recordProcessStore.getState().enter("finishing");
    });
  }
}

/**
 * The extension a browser recording is named with, from what the recorder
 * actually wrote: everything downstream decides a file's kind from its name
 * (`mediaElement.ts#mediaKindOf`), and Safari records MP4 where Chrome and
 * Firefox record WebM.
 */
export function recordingExtension(mimeType: string, kind: "video" | "audio"): string {
  const type = mimeType.toLowerCase();
  if (type.includes("mp4")) {
    return kind === "audio" ? "m4a" : "mp4";
  }
  if (type.includes("ogg")) {
    return kind === "audio" ? "weba" : "webm";
  }
  return kind === "audio" ? "weba" : "webm";
}

/**
 * A browser has no folder to save into and no save dialog to ask: the take
 * becomes a `File`, is listed in the asset panel as an import would be, and is
 * placed at the playhead, the same `importPathsAt` the desktop path ends in.
 */
async function importBrowserRecording(
  buffer: Buffer,
  kind: "video" | "audio",
  wallClockMs: number,
  mimeType: string,
): Promise<string[]> {
  try {
    const type = mimeType !== "" ? mimeType : kind === "audio" ? "audio/webm" : "video/webm";
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const file = new File([buffer], `Recording ${stamp}.${recordingExtension(type, kind)}`, {
      type,
      lastModified: Date.now(),
    });
    const [path] = importedMediaStore.getState().add([{ file }]);
    if (path == null) {
      return [];
    }
    return await importPathsAt([{ path, fallbackDurationMs: wallClockMs }], atPlayhead());
  } catch (error) {
    console.error("[record] could not add the recording", error);
    toast("That recording could not be added.");
    return [];
  }
}
