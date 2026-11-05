/**
 * The Utilities menu, run in the renderer.
 *
 * These were tiles in a sidebar tab; the application menu's Utilities submenu
 * reaches them now, through `menuCommands.ts`. Each function is what one tile
 * did when pressed, unchanged.
 *
 * Opening is idempotent everywhere here: `controlPanelStore.openPanel` dedupes
 * on the panel name and focuses its tab, and `windowStore.open` focuses an
 * existing window rather than opening a second, so choosing an item twice
 * shows the tool rather than stacking a copy of it.
 */

import { windowStore } from "../window/windowStore";
import { DEFAULT_DOCK_PCT } from "../window/windowOps";
import {
  controlPanelStore,
  type ActiveStringType,
} from "../../states/controlPanelStore";
import { renderOptionStore } from "../../states/renderOptionStore";
import { useTimelineStore } from "../../states/timelineStore";
import { serializeRenderOptions } from "../project/renderOptionsFile";
import { exportTemplate } from "../template/templateExport";
import { renderTemplateThumbnail } from "../template/templateThumbnail";
import { captionLaunch } from "../caption/captionLaunch";

function toast(message: string) {
  (document.querySelector("toast-box") as any)?.showToast({
    message,
    delay: "4000",
  });
}

/** Swap the preview area for one of the tool panels (a tab beside it). */
export function openToolPanel(panel: ActiveStringType): void {
  controlPanelStore.getState().openPanel(panel);
}

/**
 * Open the caption editor as a window docked beside the preview.
 *
 * A window rather than a panel tab, because captioning is work done while
 * watching the footage and a tab would replace the preview.
 */
export function openCaptionWindow(): void {
  windowStore.getState().open({
    id: "automaticCaption",
    hostId: "preview",
    placement: { mode: "docked", side: "right", sizePct: DEFAULT_DOCK_PCT },
    // Under this the caption row's two icon buttons and its text input stop
    // fitting on one line. `caption/editorLayout.ts` states the derivation.
    minSize: { width: 320, height: 240 },
  });
}

/**
 * Open the caption editor with these clips already chosen, on its setup
 * screen, where the language is picked and Start begins the run. The
 * timeline's context menu calls this.
 *
 * The request goes first: a panel that is already open takes it through its
 * subscription, and one that is not takes it when it mounts.
 */
export function openCaptionWindowFor(ids: readonly string[]): void {
  captionLaunch.request(ids);
  openCaptionWindow();
}

/**
 * Open Text to Speech as a window docked beside the preview, for the reason
 * captioning is one: narration is written while watching the footage.
 */
export function openTextToSpeechWindow(): void {
  windowStore.getState().open({
    id: "textToSpeech",
    hostId: "preview",
    placement: { mode: "docked", side: "right", sizePct: DEFAULT_DOCK_PCT },
    // Under this the voice and language selects stop sharing a line.
    minSize: { width: 320, height: 280 },
  });
}

/**
 * Open the Prompter as a window docked beside the preview: a script is read
 * while recording, and a tab that replaced the preview would hide the take.
 */
export function openPrompterWindow(): void {
  windowStore.getState().open({
    id: "prompter",
    hostId: "preview",
    placement: { mode: "docked", side: "right", sizePct: DEFAULT_DOCK_PCT },
    // The type bottoms out at 1.75rem, so at 280px a line holds eight Korean
    // syllables between its 1.75rem margins. Narrower reads a word at a time.
    minSize: { width: 280, height: 240 },
  });
}

/** Show the screen recorder's overlay, a window of its own in main. */
export function showScreenRecorder(): void {
  window.electronAPI.req.overlayRecord.show();
}

/**
 * Package the timeline showing as a `.cttpl`.
 *
 * Everything decidable is in `features/template/exportPlan.ts`; this reads
 * the two stores and reports the result. Any warning is shown rather than
 * swallowed: after the file is written is too late to be told nothing at all.
 *
 * In a template's own tab the stores hold that template, so this packages it.
 */
export async function exportProjectAsTemplate(): Promise<void> {
  const document_ = useTimelineStore.getState().getDocument();
  const options = renderOptionStore.getState().options;

  // No name prompt: `window.prompt` throws in Electron, and the save dialog
  // `exportTemplate` opens already asks for one. The file's name is the
  // template's name.
  //
  // Best effort on the thumbnail. A template without one gets an icon on its
  // tile, which beats an export refused because a canvas would not allocate,
  // so `renderTemplateThumbnail` answers null and never throws.
  const thumbnail = await renderTemplateThumbnail(
    useTimelineStore.getState().cursor,
  );

  const result = await exportTemplate({
    elements: document_.elements,
    tracks: document_.tracks,
    renderOptions: serializeRenderOptions(options, {
      previewRatio: 1,
      videoDestination: "",
    }),
    thumbnail,
  });

  if (result.ok) {
    toast(
      result.warnings.length > 0
        ? `${result.name}: ${result.warnings.join(" ")}`
        : result.name,
    );
    return;
  }
  // A cancelled dialog is not a failure and must not be reported as one.
  if ("cancelled" in result) {
    return;
  }
  toast(result.message);
}
