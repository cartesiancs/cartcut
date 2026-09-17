/**
 * The caption editor: what a keystroke means, and what it does to the list.
 *
 * Both halves live here for the reason `mask/penSession.ts` keeps `penKey`
 * beside its own reducer — the keymap's output *is* the reducer's input, and the
 * behaviour worth testing is the chain. "Backspace at the start of line 2 merges
 * it upward and leaves the caret at the join" is one claim, and split across two
 * modules it would have to be made twice, weakly, or once with both imported
 * anyway.
 *
 * It is here rather than in the panel because `apps/automatic-caption/` is
 * outside every vitest include pattern, and this is the densest logic in that
 * file: an IME guard, four keys, three caret positions and an undo stack whose
 * correctness rests on reference identity. `penSession.ts` states the general
 * case — a state machine inside a Lit component is untestable, because this
 * codebase has no DOM test environment.
 *
 * ## Nothing here touches the DOM
 *
 * The ports are plain records, not `KeyboardEvent`, `InputEvent` and
 * `HTMLTextAreaElement`. Those types resolve under `environment: "node"` but
 * cannot be *constructed* there, so typing against them would make the suite
 * unwritable. `ui/transientModal.ts` narrows `bootstrap.Modal` the same way.
 *
 * ## One gesture, at most one undo step
 *
 * `applyCaptionEdit` records a snapshot only when the operation actually changed
 * something, which it knows because every op in `lines.ts` **declines by
 * returning its input by identity**. Pressing Enter at the end of a line must
 * not fill the undo stack with states identical to the one before it.
 */

import {
  mergeCaretOffset,
  mergeLineWithPrevious,
  mintLineId,
  removeLine,
  restoreLine,
  setLineText,
  splitLineAt,
  type CaptionLine,
} from "./lines";

/** How many split/merge steps the panel's own Cmd+Z can walk back. */
export const UNDO_LIMIT = 50;

/**
 * The part of a `KeyboardEvent` the editor reads.
 *
 * `keyCode` is here only for the IME guard; it is deprecated everywhere else.
 */
export type CaptionKeyEvent = {
  key: string;
  isComposing?: boolean;
  keyCode?: number;
  metaKey?: boolean;
  ctrlKey?: boolean;
};

/** The part of the `<textarea>` the editor reads. A collapsed caret has both equal. */
export type CaptionField = {
  selectionStart: number | null;
  selectionEnd: number | null;
  valueLength: number;
};

/**
 * What the panel should do next.
 *
 * `"none"` is distinct from "did nothing" on purpose: the panel calls
 * `preventDefault()` for every other kind and must *not* for this one, so the
 * keystroke reaches the field and types a character. That is the whole
 * difference between an editor and a dead text box.
 */
export type CaptionKeyIntent =
  | { kind: "none" }
  | { kind: "split"; index: number; caretOffset: number }
  /** The line to merge **into the one above it** — already resolved. */
  | { kind: "merge"; index: number }
  | { kind: "undo" };

export type CaptionEditor = {
  lines: CaptionLine[];
  /** Most recent last. Capped at `UNDO_LIMIT`. */
  undo: CaptionLine[][];
};

/** Where the caret belongs once Lit has re-rendered. */
export type CaptionFocus = { index: number; caretOffset: number };

export type CaptionEditResult = {
  editor: CaptionEditor;
  /** Null when nothing moved, so the panel does not steal focus for no reason. */
  focus: CaptionFocus | null;
};

export function editorFrom(lines: CaptionLine[]): CaptionEditor {
  return { lines, undo: [] };
}

/**
 * Whether the panel should cancel the keystroke.
 *
 * Derived rather than carried, because it is exactly "this intent does
 * something": all four acting branches cancelled in the original and the
 * fall-through did not.
 */
export function capturesKey(intent: CaptionKeyIntent): boolean {
  return intent.kind !== "none";
}

/**
 * What a keystroke in a caption's field means.
 *
 * Order matters and is preserved from the original, which has two consequences
 * nobody would choose but which are the behaviour today: the IME guard
 * short-circuits **everything**, Cmd+Z included; and Cmd+Z is tested **last**,
 * so Cmd+Delete at the end of a line merges the next line up instead of
 * deleting to the end of the line, and Cmd+Enter splits.
 *
 * The comparison is `key === "z"`, lower case only. So Cmd+Shift+Z is not a
 * redo — there is none — and neither is Cmd+Z with Caps Lock on, which reports
 * `"Z"`. Both are the same omission seen from two angles.
 */
export function captionKeyIntent(
  event: CaptionKeyEvent,
  field: CaptionField,
  index: number,
  lineCount: number,
): CaptionKeyIntent {
  // A Korean IME fires Enter to commit a composition. Splitting on it would cut
  // the line in half every time someone finished typing a word, which is why the
  // panel uses a plain text field and not a contenteditable. The keystroke is let
  // through, and `rejectsCaptionInput` stops the line break it would type.
  // `keyCode === 229` is the same event as seen by browsers that do not set
  // `isComposing`.
  if (event.isComposing === true || event.keyCode === 229) {
    return { kind: "none" };
  }

  if (event.key === "Enter") {
    return { kind: "split", index, caretOffset: field.selectionStart ?? 0 };
  }

  // A collapsed caret against the left edge. A *selection* reaching the start is
  // a range the user means to replace, not a request to join two lines.
  if (
    event.key === "Backspace" &&
    field.selectionStart === 0 &&
    field.selectionEnd === 0
  ) {
    return { kind: "merge", index };
  }

  // Forward delete at the right edge pulls the *next* line up into this one, so
  // the line being merged is `index + 1` and there has to be one.
  if (
    event.key === "Delete" &&
    field.selectionStart === field.valueLength &&
    field.selectionEnd === field.valueLength &&
    index + 1 < lineCount
  ) {
    return { kind: "merge", index: index + 1 };
  }

  if ((event.metaKey === true || event.ctrlKey === true) && event.key === "z") {
    return { kind: "undo" };
  }

  return { kind: "none" };
}

/**
 * Whether the field cancels an edit before it lands, by `InputEvent.inputType`.
 *
 * Enter is already a split, cancelled in `keydown`. This catches the Enter the
 * IME guard lets through: a textarea's default action for it is a line break,
 * and a caption committed from a Korean composition would gain one every time.
 */
export function rejectsCaptionInput(inputType: string): boolean {
  return inputType === "insertLineBreak" || inputType === "insertParagraph";
}

/** The part of the `<textarea>` `flattenCaptionField` reads and hands back. */
export type CaptionFieldText = {
  value: string;
  selectionStart: number | null;
  selectionEnd: number | null;
};

// Not global: a global pattern's `test` keeps `lastIndex` between calls and
// would miss a break in the next value it is asked about.
const HAS_LINE_BREAK = /[\r\n]/;
const LINE_BREAK_RUN = /(?:\r\n?|\n)+/g;

/**
 * Keep a caption on one line.
 *
 * `rejectsCaptionInput` stops a typed break, but a paste or a drop still brings
 * one in, and `text/lines.ts` would draw it as a second line of the caption. Each
 * run of breaks becomes one space.
 *
 * Returns its input **by identity** when there is no break, so the panel knows
 * the field needs no write. Each end of the selection is mapped by flattening
 * the text before it, which keeps the caret after the same character.
 */
export function flattenCaptionField(field: CaptionFieldText): CaptionFieldText {
  if (!HAS_LINE_BREAK.test(field.value)) {
    return field;
  }

  const flatten = (text: string) => text.replace(LINE_BREAK_RUN, " ");
  const offsetOf = (offset: number | null) =>
    offset == null ? null : flatten(field.value.slice(0, offset)).length;

  return {
    value: flatten(field.value),
    selectionStart: offsetOf(field.selectionStart),
    selectionEnd: offsetOf(field.selectionEnd),
  };
}

/**
 * Carry out an intent.
 *
 * Returns the editor **by identity** when nothing happened, so the panel can
 * skip its repaint and its re-render — the convention `features/timeline/`
 * states, here because a declining gesture should cost the user nothing.
 *
 * `mintId` names the line a split creates. It is drawn unconditionally, before
 * the op has had its say, so a declined split still consumes one: an id is
 * cheap and the alternative is deciding here what `splitLineAt` decides, which
 * is the kind of duplicate rule that drifts.
 */
export function applyCaptionEdit(
  editor: CaptionEditor,
  intent: CaptionKeyIntent,
  mintId: () => string = mintLineId,
): CaptionEditResult {
  switch (intent.kind) {
    case "split": {
      const next = splitLineAt(
        editor.lines,
        intent.index,
        intent.caretOffset,
        mintId(),
      );
      // The caret belongs at the start of the new line, as in any editor.
      return commit(editor, next, { index: intent.index + 1, caretOffset: 0 });
    }
    case "merge": {
      // Read **before** the merge: the join point is the previous line's length
      // as it stands now, so that Backspace-then-typing continues where the text
      // was cut. After the merge that line is gone.
      const caretOffset = mergeCaretOffset(editor.lines, intent.index);
      const next = mergeLineWithPrevious(editor.lines, intent.index);
      return commit(editor, next, { index: intent.index - 1, caretOffset });
    }
    case "undo":
      return { editor: undoEdit(editor), focus: null };
    case "none":
      return { editor, focus: null };
  }
}

/**
 * Strike a line out, or put it back.
 *
 * Deliberately **not** a `CaptionKeyIntent`. That union is documented as what a
 * *keystroke* means, and `capturesKey` is derived from it for one purpose: to
 * decide whether the panel cancels the key event. A button press has no key
 * event to cancel, so a `deleteLine` member would force `capturesKey` to answer
 * a question about something that never happened.
 *
 * It shares the undo stack with split and merge, through the same private
 * `commit`, because it is a structural edit of the same kind: Cmd+Z after a
 * delete should put the line back, and after a delete *and* a split should walk
 * back through both. Typing stays off that stack for the reason `editText`
 * gives.
 *
 * Declines by identity when the underlying op does, so a second click on an
 * already struck-out line records nothing.
 */
export function applyLineRemoval(
  editor: CaptionEditor,
  index: number,
  removed: boolean,
): CaptionEditor {
  const lines = removed
    ? removeLine(editor.lines, index)
    : restoreLine(editor.lines, index);

  // The caret is discarded: the row's field is disabled while the line is
  // struck out, so there is nowhere to put it and stealing focus would move it
  // off whatever the user was actually typing in.
  return commit(editor, lines, { index, caretOffset: 0 }).editor;
}

/**
 * Undo one split or merge.
 *
 * Typing is not on this stack — see `editText`. Declines by identity on an empty
 * stack, which is also what the panel's Cmd+Z does today: it cancels the
 * keystroke either way, so the field's own native undo is never reached. That is
 * a defect, and it is preserved; the panel is where the `preventDefault` lives.
 */
export function undoEdit(editor: CaptionEditor): CaptionEditor {
  if (editor.undo.length === 0) {
    return editor;
  }
  const undo = editor.undo.slice(0, -1);
  return { lines: editor.undo[editor.undo.length - 1], undo };
}

/**
 * Replace a line's text.
 *
 * **No snapshot, deliberately.** A state per keystroke would bury the structural
 * edits the stack is for under hundreds of character states, which is the
 * opposite of useful. Declines by identity when `setLineText` does — an `input`
 * event that did not change the value.
 */
export function editText(
  editor: CaptionEditor,
  index: number,
  text: string,
): CaptionEditor {
  const lines = setLineText(editor.lines, index, text);
  return lines === editor.lines ? editor : { ...editor, lines };
}

function commit(
  editor: CaptionEditor,
  next: CaptionLine[],
  focus: CaptionFocus,
): CaptionEditResult {
  // Identity means the pure op declined, so there is nothing to record and
  // nowhere to put the caret.
  if (next === editor.lines) {
    return { editor, focus: null };
  }

  const undo = [...editor.undo, editor.lines];
  // Oldest out, as a shift would. The cap is on how far back Cmd+Z reaches, not
  // on how many edits a session may contain.
  return {
    editor: {
      lines: next,
      undo: undo.length > UNDO_LIMIT ? undo.slice(undo.length - UNDO_LIMIT) : undo,
    },
    focus,
  };
}
