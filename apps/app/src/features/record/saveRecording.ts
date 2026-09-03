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
): Promise<string[]> {
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
