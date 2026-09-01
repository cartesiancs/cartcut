/**
 * Every keyboard binding the editor implements, in one list.
 *
 * Two surfaces show shortcuts to the user — the tooltips on `timelineToolbar`
 * and the `#shortKey` help modal — and until this module existed they were
 * unrelated hardcoded strings. The modal said "Control C" on a Mac, never
 * mentioned undo, and still carried a typo; the toolbar had its own platform
 * sniff. Both now render from here, so they cannot describe the same action
 * differently, in the same spirit as `actions.ts` making the button and the
 * shortcut the same code path.
 *
 * What this is *not* is a dispatcher. The `switch` statements in
 * `elementTimelineCanvas._handleKeydown`, `previewCanvas._handleKeydown` and
 * `Timeline._handleKeydown` still own the bindings; this table describes them.
 * The `implemented at` column below is the link, and it is worth keeping true —
 * add a binding here when you add one there.
 *
 * Deliberately absent: ctrl+wheel zoom on the timeline and preview canvases.
 * Those are pointer gestures, not keyboard bindings — macOS synthesises
 * `ctrlKey` on a trackpad pinch — and listing them in something called
 * "shortcuts" is the most likely way someone later routes them through
 * `hasEditorModifier` and breaks pinch-to-zoom on a Mac.
 *
 * Not localised, matching the toolbar (commit 0735596) and the modal table it
 * replaces. If that changes, the hook is one field: swap `description` for a
 * `descriptionKey` and resolve it through `lc.t()` in the modal only.
 */

import {
  IS_MAC,
  formatShortcut,
  type ShortcutToken,
} from "../../utils/platform";

export type ShortcutId =
  | "undo"
  | "redo"
  | "cut"
  | "copy"
  | "paste"
  | "split"
  | "delete"
  | "save"
  | "open"
  | "playPause"
  | "stepForward"
  | "stepBack"
  | "moveTrackUp"
  | "moveTrackDown"
  | "cancel"
  | "previewFit"
  | "previewZoomIn"
  | "previewZoomOut"
  | "maskClosePath"
  | "maskRemoveNode"
  | "maskCancel";

export type ShortcutGroup =
  | "edit"
  | "file"
  | "playback"
  | "arrange"
  | "preview"
  | "mask";

export interface Shortcut {
  id: ShortcutId;
  /** Matches the toolbar button's label where there is one. */
  label: string;
  /** One line, for the help modal. */
  description: string;
  group: ShortcutGroup;
  /** Primary binding. `"Mod"` renders ⌘ on macOS and Ctrl elsewhere. */
  keys: readonly ShortcutToken[];
  /** Other bindings the handler also accepts; shown after a "/". */
  alternates?: readonly (readonly ShortcutToken[])[];
}

export const SHORTCUTS: readonly Shortcut[] = [
  // Editing — `elementTimelineCanvas._handleKeydown`, via `features/editor/actions`.
  {
    id: "undo",
    label: "Undo",
    description: "Undo the last edit",
    group: "edit",
    keys: ["Mod", "Z"],
  },
  {
    id: "redo",
    label: "Redo",
    description: "Redo the last undone edit",
    group: "edit",
    keys: ["Mod", "Shift", "Z"],
  },
  {
    id: "cut",
    label: "Cut",
    description: "Copy the selected clips and remove them",
    group: "edit",
    keys: ["Mod", "X"],
  },
  {
    id: "copy",
    label: "Copy",
    description: "Copy the selected clips",
    group: "edit",
    keys: ["Mod", "C"],
  },
  {
    id: "paste",
    label: "Paste",
    description: "Paste the copied clips onto the timeline",
    group: "edit",
    keys: ["Mod", "V"],
  },
  {
    id: "split",
    label: "Split at playhead",
    description: "Split the selected clip at the playhead",
    group: "edit",
    keys: ["Mod", "D"],
  },
  {
    id: "delete",
    label: "Delete",
    description: "Remove the selected clips",
    group: "edit",
    keys: ["Delete"],
    alternates: [["Backspace"]],
  },

  // Project — Electron menu accelerators, via IPC to `src/event.ts`.
  {
    id: "save",
    label: "Save project",
    description: "Save the project file",
    group: "file",
    keys: ["Mod", "S"],
  },
  {
    id: "open",
    label: "Open project",
    description: "Load a project file",
    group: "file",
    keys: ["Mod", "O"],
  },

  // Playback — Space in `ui/timeline/Timeline`, arrows in the timeline canvas.
  {
    id: "playPause",
    label: "Play / pause",
    description: "Start or stop preview playback",
    group: "playback",
    keys: ["Space"],
  },
  {
    id: "stepForward",
    label: "Next frame",
    description: "Move the playhead one frame forward",
    group: "playback",
    keys: ["ArrowRight"],
  },
  {
    id: "stepBack",
    label: "Previous frame",
    description: "Move the playhead one frame back",
    group: "playback",
    keys: ["ArrowLeft"],
  },

  // Arranging — `elementTimelineCanvas._handleKeydown`.
  {
    id: "moveTrackUp",
    label: "Move up a track",
    description: "Move the selected clips to the track above",
    group: "arrange",
    keys: ["ArrowUp"],
  },
  {
    id: "moveTrackDown",
    label: "Move down a track",
    description: "Move the selected clips to the track below",
    group: "arrange",
    keys: ["ArrowDown"],
  },
  {
    id: "cancel",
    label: "Cancel",
    description: "Cancel the drag in progress",
    group: "arrange",
    keys: ["Escape"],
  },

  // Preview — `previewCanvas._handleKeydown`.
  {
    id: "previewFit",
    label: "Fit preview",
    description: "Fit the preview to the window",
    group: "preview",
    keys: ["Mod", "0"],
  },
  {
    id: "previewZoomIn",
    label: "Zoom in",
    description: "Zoom in on the preview",
    group: "preview",
    keys: ["Mod", "+"],
    alternates: [["Mod", "="]],
  },
  {
    id: "previewZoomOut",
    label: "Zoom out",
    description: "Zoom out of the preview",
    group: "preview",
    keys: ["Mod", "-"],
  },

  // Mask pen — `previewCanvas._handlePenKeydown`, and unlike every other entry
  // in this table those bindings are **capture-phase and live only while a
  // stroke is in progress**. That is what lets Backspace mean "remove the last
  // node" here and "delete the selected clip" everywhere else without the two
  // contradicting each other; listing them says so, which a reader comparing
  // this row against the `delete` row above will otherwise have to guess.
  {
    id: "maskClosePath",
    label: "Close mask path",
    description: "Finish the mask being drawn, while the pen is active",
    group: "mask",
    keys: ["Enter"],
  },
  {
    id: "maskRemoveNode",
    label: "Remove last point",
    description: "Undo the last point of the mask being drawn",
    group: "mask",
    keys: ["Backspace"],
    alternates: [["Delete"]],
  },
  {
    id: "maskCancel",
    label: "Discard mask",
    description: "Abandon the mask being drawn",
    group: "mask",
    keys: ["Escape"],
  },
];

export const GROUP_TITLES: Record<ShortcutGroup, string> = {
  edit: "Editing",
  file: "Project",
  playback: "Playback",
  arrange: "Arrange",
  preview: "Preview",
  mask: "Mask pen",
};

/** The order groups appear in the help modal. */
const GROUP_ORDER: readonly ShortcutGroup[] = [
  "edit",
  "file",
  "playback",
  "arrange",
  "preview",
  "mask",
];

const BY_ID = new Map<ShortcutId, Shortcut>(
  SHORTCUTS.map((spec) => [spec.id, spec]),
);

/**
 * Throws rather than returning `undefined`: the ids are a closed union, so a
 * miss means the registry and the type have drifted, and a tooltip reading
 * "Undo (undefined)" is a worse way to find that out than a stack trace.
 */
export function shortcut(id: ShortcutId): Shortcut {
  const spec = BY_ID.get(id);
  if (spec == null) {
    throw new Error(`Unknown shortcut id: ${id}`);
  }
  return spec;
}

/** The primary binding, rendered for this platform. */
export function shortcutLabel(id: ShortcutId, isMac: boolean = IS_MAC): string {
  return formatShortcut(shortcut(id).keys, isMac);
}

/** Primary plus alternates, e.g. `"⌦ / ⌫"`. For the help modal. */
export function shortcutLabelWithAlternates(
  id: ShortcutId,
  isMac: boolean = IS_MAC,
): string {
  const spec = shortcut(id);
  return [spec.keys, ...(spec.alternates ?? [])]
    .map((keys) => formatShortcut(keys, isMac))
    .join(" / ");
}

export interface ShortcutSection {
  group: ShortcutGroup;
  title: string;
  items: Shortcut[];
}

/**
 * The registry sliced for display. Grouped because the list is long enough
 * that eighteen unrelated rows in one run is harder to scan than the ten-row
 * table it replaces.
 */
export function shortcutsByGroup(): ShortcutSection[] {
  return GROUP_ORDER.map((group) => ({
    group,
    title: GROUP_TITLES[group],
    items: SHORTCUTS.filter((spec) => spec.group === group),
  })).filter((section) => section.items.length > 0);
}
