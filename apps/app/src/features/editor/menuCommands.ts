/**
 * The application menu, run in the renderer.
 *
 * `electron/lib/menuCommands.ts` says what the menu offers and
 * `electron/lib/menu.ts` arranges it; this is the other end of that one IPC
 * channel — an id in, one command run. The ids are checked against that table
 * by `menuCommands.test.ts`, so a menu item with nothing behind it is a failing
 * test rather than a click that does nothing.
 *
 * Every entry below reaches for the same function the keyboard and the toolbar
 * reach for, which is the rule `features/editor/actions.ts` exists to state:
 * the menu item and the shortcut are one code path, and there is no second
 * implementation to drift. Where a command needs a component rather than a
 * store — the preview's zoom, the timeline's playhead — it calls a *public*
 * method on that component rather than restating what the component does.
 *
 * Two guards shape the whole table:
 *
 * - **A keystroke the renderer already binds never arrives here.** Those items
 *   carry `rendererOwnsKey` in the main-process table and send nothing when
 *   they were triggered by their accelerator, because the renderer's own
 *   `keydown` handler is running for the same press. What does arrive is the
 *   click, so the code below must work with no keyboard event in sight.
 * - **The caret wins over the timeline.** Edit → Copy with a caption being
 *   typed means the text, so the six commands that have a text meaning hand
 *   over to the native editing command when `isTypingFocus` says the focus is
 *   a field. That is the half Electron's `cut`/`copy`/`paste` roles used to
 *   serve before these items replaced them.
 */

import type { MenuCommandId } from "../../../../../electron/lib/menuCommands";
import { isTypingFocus } from "../../utils/typingTarget";
import { selectionStore } from "../../states/selectionStore";
import { useTimelineStore } from "../../states/timelineStore";
import { atPlayhead, importPathsAt } from "../asset/importDrop";
import { spanEnd } from "../timeline/geometry";
import { rendererModal } from "../../utils/modal";
import { startExport } from "../export/exportSession";
import {
  clearSelection,
  copySelection,
  cutSelection,
  deleteSelection,
  detachAudioFromSelection,
  groupClips,
  mergeSelection,
  pasteFromClipboard,
  redo,
  rotateSelection,
  selectAllClips,
  splitSelection,
  undo,
  ungroupClips,
} from "./actions";

/** The native editing command, for when the caret is in a text field. */
type NativeEditingCommand =
  | "undo"
  | "redo"
  | "cut"
  | "copy"
  | "paste"
  | "selectAll";

/**
 * Hand a command to the focused text field. Answers whether it went anywhere.
 *
 * Through the main process rather than `document.execCommand`, because
 * Chromium refuses that for `paste` — it is a clipboard *read* — and one path
 * for all six is worth more than five that work and a sixth that is different.
 *
 * The `false` answer is what keeps the web build honest: `functions/ipcWrapper`
 * stands in for the preload bridge there and has no main process behind it, so
 * a caller that cancelled the keystroke on the strength of this would leave the
 * browser's own copy and paste cancelled and nothing in their place.
 */
export function runNativeEditing(command: NativeEditingCommand): boolean {
  const editing = window.electronAPI?.req?.editing;
  if (editing?.run == null) {
    return false;
  }
  editing.run(command);
  return true;
}

/** Whether the caret is in a text field. Exported for `textEditing.ts`. */
export function typingNow(): boolean {
  return isTypingFocus(document);
}

/** Same one-liner `importDrop` uses; the toast box is a custom element. */
function toast(message: string) {
  const box: any = document.querySelector("toast-box");
  box?.showToast({ message, delay: "3000" });
}

function timelineCanvas(): any {
  return document.querySelector("element-timeline-canvas");
}

function previewCanvas(): any {
  return document.querySelector("preview-canvas");
}

function timelineUi(): any {
  return document.querySelector("timeline-ui");
}

/**
 * The end of the last clip.
 *
 * Not `renderOption.duration`: that is the *export* length, which a user may
 * have set to something shorter or longer than the edit, and "Go to End" means
 * the end of the material. Empty projects answer 0, which is where the
 * playhead already is.
 */
function endOfTimeline(): number {
  const elements = Object.values(
    useTimelineStore.getState().getDocument().elements,
  );
  return elements.reduce((latest, element) => {
    const end = spanEnd(element);
    return Number.isFinite(end) && end > latest ? end : latest;
  }, 0);
}

/**
 * Pick files and place them at the playhead.
 *
 * `importPathsAt` is the same function an OS file drop lands in, so the menu
 * inherits its probing, its skip toasts and its single undo step for a whole
 * batch.
 */
async function importMedia(): Promise<void> {
  const paths = await window.electronAPI.req.dialog.openFiles(["*"]);
  if (!Array.isArray(paths) || paths.length === 0) {
    return;
  }
  await importPathsAt(paths, atPlayhead());
}

/**
 * Save under a new name.
 *
 * `#projectFile` is where `functions/project.ts` remembers the path it last
 * wrote, and an empty one is what makes `save` ask. So "Save As" is "forget,
 * then save" — no second save path, and nothing to keep in step with the
 * first.
 */
function saveProjectAs(): void {
  const field = document.querySelector("#projectFile");
  if (field != null) {
    field.value = "";
  }
  CARTCUT.project.save();
}

/**
 * Every command, by id.
 *
 * `Record<MenuCommandId, …>` rather than a looser map on purpose: it is what
 * makes a menu item with nothing behind it a compile error instead of a click
 * that silently does nothing, and an id removed from the menu a compile error
 * instead of dead code. The renderer is type-checked by webpack, so both show
 * up in the build that would have shipped them.
 */
const COMMANDS: Record<MenuCommandId, () => void> = {
  // -------------------------------------------------------------------- File
  "file.open": () => CARTCUT.project.load(),
  "file.save": () => CARTCUT.project.save(),
  "file.saveAs": saveProjectAs,
  "file.importMedia": () => {
    void importMedia().catch((error) => {
      console.error("[menu] could not import media", error);
      toast("Those files could not be added.");
    });
  },
  "file.exportVideo": () => {
    // The same call the title bar's button makes. It used to reach into
    // `<control-ui-render>` and invoke a method on it, which only worked while
    // that panel was mounted.
    void startExport();
  },

  // -------------------------------------------------------------------- Edit
  "edit.undo": () => (typingNow() ? runNativeEditing("undo") : undo()),
  "edit.redo": () => (typingNow() ? runNativeEditing("redo") : redo()),
  "edit.cut": () => (typingNow() ? runNativeEditing("cut") : cutSelection()),
  "edit.copy": () => (typingNow() ? runNativeEditing("copy") : copySelection()),
  "edit.paste": () =>
    typingNow() ? runNativeEditing("paste") : pasteFromClipboard(),
  "edit.delete": () => {
    if (!typingNow()) {
      deleteSelection();
    }
  },
  "edit.selectAll": () =>
    typingNow() ? runNativeEditing("selectAll") : selectAllClips(),
  "edit.deselectAll": () => {
    if (!typingNow()) {
      clearSelection();
    }
  },

  // -------------------------------------------------------------------- Clip
  "clip.split": () => splitSelection(),
  "clip.merge": () => mergeSelection(),
  "clip.detachAudio": () => detachAudioFromSelection(),
  "clip.rotate": () => rotateSelection(90),
  "clip.group": () => groupClips(selectionStore.getState().ids),
  "clip.ungroup": () => ungroupClips(selectionStore.getState().ids),
  "clip.moveTrackUp": () => timelineCanvas()?.moveSelectionByTrack(-1),
  "clip.moveTrackDown": () => timelineCanvas()?.moveSelectionByTrack(1),

  // ---------------------------------------------------------------- Playback
  "playback.playPause": () => {
    const timeline = timelineUi();
    if (timeline == null) {
      return;
    }
    if (timeline.isPlay) {
      timeline.stop();
    } else {
      timeline.play();
    }
  },
  "playback.nextFrame": () => timelineCanvas()?.stepCursor(1),
  "playback.previousFrame": () => timelineCanvas()?.stepCursor(-1),
  "playback.goToStart": () => useTimelineStore.getState().setCursor(0),
  "playback.goToEnd": () =>
    useTimelineStore.getState().setCursor(endOfTimeline()),

  // -------------------------------------------------------------------- View
  "view.previewFit": () => previewCanvas()?.fitPreview(),
  "view.previewZoomIn": () => previewCanvas()?.zoomPreviewIn(),
  "view.previewZoomOut": () => previewCanvas()?.zoomPreviewOut(),

  // -------------------------------------------------------------------- Help
  "help.shortcuts": () => rendererModal.shortKey.show(),
};

/**
 * Run one command from the menu.
 *
 * An unknown id is logged rather than thrown: it can only mean a build where
 * `main/` is newer than the bundle, and a stale menu item should not take the
 * editor down with it.
 */
export function runMenuCommand(id: string): void {
  const command = COMMANDS[id as MenuCommandId];
  if (command == null) {
    console.warn(`[menu] no handler for ${id}`);
    return;
  }
  command();
}
