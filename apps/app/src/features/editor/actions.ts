/**
 * The editor's command surface: one function per thing the user can do to the
 * selection, and one place that decides whether they can do it.
 *
 * Before this, every command lived as a private method on
 * `element-timeline-canvas` and the only way to reach one was a keystroke. That
 * was fine while the keyboard was the only caller. It stops being fine the
 * moment a second surface — a toolbar, a menu — wants the same behaviour,
 * because the second copy is where the two drift apart: one snaps the playhead
 * to a frame and the other does not, one clears the selection after a delete
 * and the other leaves it pointing at clips that no longer exist.
 *
 * So the canvas keeps the parts that genuinely need a canvas (hit-testing,
 * dragging, painting) and hands the editing off to here. The toolbar calls the
 * same functions the keyboard does. There is no third implementation to keep in
 * sync, and no way for the button and the shortcut to disagree.
 *
 * This module is not in `features/timeline/` on purpose: that directory is
 * deliberately DOM-free *and* store-free, holding pure `(doc) => doc`
 * functions that are tested without an app around them. These are the
 * orchestration on top — read the stores, snap to a frame, hand a pure op to
 * `withCheckpoint`.
 */

import { v4 as uuidv4 } from "uuid";
import type { TimelineElement } from "../../@types/timeline";
import { selectionStore } from "../../states/selectionStore";
import { useTimelineStore } from "../../states/timelineStore";
import { renderOptionStore } from "../../states/renderOptionStore";
import { deleteClips, pasteClips, splitAtPlayhead } from "../timeline/clipOps";
import { canMergeClips, mergeClips } from "../timeline/mergeOps";
import { canRotateClips, rotateClips } from "../timeline/rotateOps";
import { canDetachAudio } from "../timeline/audio";
import { detachAudioFrom } from "../timeline/audioOps";
import { normalizeFps, snapMsToFrame } from "../timeline/frames";
import { spanEnd, spanStart } from "../timeline/geometry";
import {
  appendTrackOfKind,
  type TimelineDocument,
  type TrackKind,
} from "../timeline/tracks";

// ------------------------------------------------------------------ reading

function doc(): TimelineDocument {
  return useTimelineStore.getState().getDocument();
}

function selectedIds(): string[] {
  return selectionStore.getState().ids;
}

function fps(): number {
  return normalizeFps(renderOptionStore.getState().options?.fps);
}

/**
 * The playhead, on a frame boundary.
 *
 * The cursor is already aligned when it was scrubbed or stepped, but it also
 * tracks wall-clock time during playback — so a cut taken while playing would
 * otherwise land between frames, where nothing renders.
 */
function playheadMs(): number {
  return snapMsToFrame(useTimelineStore.getState().cursor, fps());
}

/** Apply a pure document transform and record one undo step. */
function commit(fn: (input: TimelineDocument) => TimelineDocument): void {
  useTimelineStore.getState().withCheckpoint(fn);
}

// ----------------------------------------------------------------- commands

/** Cut every selected clip that the playhead actually crosses. */
export function splitSelection(): void {
  const at = playheadMs();
  commit((input) => splitAtPlayhead(input, selectedIds(), at, uuidv4));
}

/** Fuse a selected run of adjacent clips back into one. */
export function mergeSelection(): void {
  const ids = selectedIds();
  commit((input) => mergeClips(input, ids));

  // Drop the ids the merge consumed, leaving the user selecting the clip they
  // are actually looking at. Filtering by what still exists rather than
  // branching on whether the merge went through means a *declined* merge leaves
  // the selection exactly as it was — every id is still there — so a button
  // press that did nothing also changes nothing.
  const after = doc();
  selectionStore
    .getState()
    .setIds(ids.filter((id) => after.elements[id] != null));
}

/** Turn the selection by `deltaDeg` — 90 for the toolbar's quarter turn. */
export function rotateSelection(deltaDeg: number): void {
  const at = useTimelineStore.getState().cursor;
  commit((input) => rotateClips(input, selectedIds(), deltaDeg, at));
}

export function deleteSelection(): void {
  const ids = selectedIds();
  commit((input) => deleteClips(input, ids));
  selectionStore.getState().clear();
}

/**
 * Copy the selection.
 *
 * Deep-cloned, so a later edit to the original does not reach back into what
 * was copied. Keyed by the clips' current ids because `pasteClips` uses those
 * keys to rebuild `parentId` links between clips copied together.
 */
export function copySelection(): void {
  const current = doc();
  const copied: Record<string, TimelineElement> = {};
  for (const id of selectedIds()) {
    const element = current.elements[id];
    if (element) {
      copied[id] = structuredClone(element);
    }
  }
  selectionStore.getState().setClipboard(copied);
}

/**
 * Copy the selection and remove it.
 *
 * One undo step, because only the delete touches the document — filling the
 * clipboard is not an edit and records nothing. So Cmd+Z takes the clips back
 * in a single press, which is what anyone who has ever used Cmd+X expects.
 */
export function cutSelection(): void {
  copySelection();
  deleteSelection();
}

/** Paste at the playhead, keeping the copied clips' spacing relative to each other. */
export function pasteFromClipboard(): void {
  const at = playheadMs();
  const clipboard = selectionStore.getState().clipboard;
  commit((input) => pasteClips(input, clipboard, at, uuidv4));
}

/** Split the selection's audio onto audio tracks of its own. */
export function detachAudioFromSelection(): void {
  const ids = selectedIds();
  commit((input) => detachAudioFrom(input, ids, uuidv4));
}

/**
 * Add an empty track of `kind`.
 *
 * The only command here that does not touch the selection, and the only one
 * that always applies: a row can be added to any document, including an empty
 * one, so there is no capability gating it.
 *
 * Where the row lands is `appendTrackOfKind`'s decision and not this
 * function's — directly above the topmost row of the same kind, or, for a kind
 * the project has none of yet, above everything ranked behind it. That is what
 * puts a first text row in front of the picture instead of underneath it, and
 * restating any of it here would be a second copy of a rule that already has
 * one.
 */
export function addTrack(kind: TrackKind): void {
  commit((input) => appendTrackOfKind(input, kind, uuidv4()));
}

export function undo(): void {
  useTimelineStore.getState().rollbackTimelineFromCheckPoint(-1);
}

export function redo(): void {
  useTimelineStore.getState().rollbackTimelineFromCheckPoint(1);
}

// ------------------------------------------------------------- capabilities

export type EditorCapabilities = {
  canSplit: boolean;
  canMerge: boolean;
  canRotate: boolean;
  canDelete: boolean;
  canCut: boolean;
  canCopy: boolean;
  canPaste: boolean;
  canDetachAudio: boolean;
  canUndo: boolean;
  canRedo: boolean;
};

/**
 * What the selection can currently be asked to do.
 *
 * Every one of these is cheap — a scan of the selection, a length, an index
 * comparison — because the toolbar recomputes them whenever the document or the
 * selection changes. Notably `canMerge` calls `canMergeClips` rather than
 * restating its rules: there is one definition of "these clips can be joined",
 * it lives with the op, and a button that lies about it would be worse than no
 * button.
 *
 * These gate the *buttons*, not the edits. The ops still decline by identity on
 * their own, so a stale capability costs a no-op, never a wrong edit.
 */
export function capabilities(): EditorCapabilities {
  const current = doc();
  const ids = selectedIds();
  const { clipboard } = selectionStore.getState();
  const { history } = useTimelineStore.getState();
  const at = playheadMs();

  const hasSelection = ids.length > 0;

  return {
    // A cut only lands where the playhead is strictly inside a clip; on either
    // edge it would produce a zero-length half, which `splitAt` refuses.
    canSplit: ids.some((id) => {
      const element = current.elements[id];
      return (
        element != null && spanStart(element) < at && at < spanEnd(element)
      );
    }),
    canMerge: canMergeClips(current, ids),
    canRotate: canRotateClips(current, ids),
    canDelete: hasSelection,
    canCut: hasSelection,
    canCopy: hasSelection,
    canPaste: Object.keys(clipboard).length > 0,
    canDetachAudio: ids.some((id) => canDetachAudio(current.elements[id])),
    // The same bounds check `rollbackTimelineFromCheckPoint` makes: it moves
    // `historyNow` by ±1 and refuses to leave the array.
    canUndo: history.historyNow - 1 >= 0,
    canRedo: history.historyNow + 1 < history.timelineHistory.length,
  };
}
