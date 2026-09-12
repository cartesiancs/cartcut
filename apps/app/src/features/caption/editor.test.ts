import { describe, expect, it } from "vitest";
import {
  UNDO_LIMIT,
  applyCaptionEdit,
  capturesKey,
  captionKeyIntent,
  editText,
  editorFrom,
  undoEdit,
  type CaptionEditor,
  type CaptionField,
  type CaptionKeyEvent,
} from "./editor";
import { linesFromWordGroups, type CaptionWord } from "./lines";

/**
 * The keystroke matrix and the undo stack.
 *
 * `penSession.test.ts` is the model: the value is in the *conflict* cases, not
 * the happy path. Every assertion about a decline uses `toBe` on the input,
 * because identity is how the panel knows to skip a repaint.
 */

/** "hello there world", one second each. */
const WORDS: CaptionWord[] = [
  { word: "hello", start: 0, end: 1 },
  { word: "there", start: 1, end: 2 },
  { word: "world", start: 2, end: 3 },
];

/** Two lines, so merges have somewhere to go. */
const twoLines = () =>
  linesFromWordGroups([
    WORDS,
    [
      { word: "and", start: 3, end: 4 },
      { word: "again", start: 4, end: 5 },
    ],
  ]);

const editor = (): CaptionEditor => editorFrom(twoLines());

/** A collapsed caret at `at`, in a field `valueLength` long. */
const caret = (at: number, valueLength = 17): CaptionField => ({
  selectionStart: at,
  selectionEnd: at,
  valueLength,
});

const key = (over: Partial<CaptionKeyEvent> & { key: string }): CaptionKeyEvent => over;

const intentOf = (
  event: CaptionKeyEvent,
  field: CaptionField,
  index = 0,
  lineCount = 2,
) => captionKeyIntent(event, field, index, lineCount);

// --------------------------------------------------------------- the keymap

describe("captionKeyIntent: Enter", () => {
  it("splits at the caret", () => {
    expect(intentOf(key({ key: "Enter" }), caret(6))).toEqual({
      kind: "split",
      index: 0,
      caretOffset: 6,
    });
  });

  it("splits the line it was pressed in, not the first one", () => {
    expect(intentOf(key({ key: "Enter" }), caret(3), 1)).toMatchObject({
      kind: "split",
      index: 1,
    });
  });

  it("treats a null caret as offset zero", () => {
    // `selectionStart ?? 0`. The split will then decline on the empty head, but
    // the intent is still a split — the asymmetry with Backspace below is real.
    expect(
      intentOf(key({ key: "Enter" }), { selectionStart: null, selectionEnd: null, valueLength: 17 }),
    ).toEqual({ kind: "split", index: 0, caretOffset: 0 });
  });

  it("splits from inside a selection, at its start", () => {
    expect(
      intentOf(key({ key: "Enter" }), { selectionStart: 6, selectionEnd: 11, valueLength: 17 }),
    ).toMatchObject({ kind: "split", caretOffset: 6 });
  });
});

describe("captionKeyIntent: Backspace", () => {
  it("merges upward from a collapsed caret at the start", () => {
    expect(intentOf(key({ key: "Backspace" }), caret(0), 1)).toEqual({
      kind: "merge",
      index: 1,
    });
  });

  it("does nothing anywhere else in the line", () => {
    for (const at of [1, 5, 17]) {
      expect(intentOf(key({ key: "Backspace" }), caret(at), 1)).toEqual({ kind: "none" });
    }
  });

  it("does nothing for a selection that merely reaches the start", () => {
    // A range the user means to replace, not a request to join two lines.
    expect(
      intentOf(
        key({ key: "Backspace" }),
        { selectionStart: 0, selectionEnd: 5, valueLength: 17 },
        1,
      ),
    ).toEqual({ kind: "none" });
  });

  it("does nothing for a null caret", () => {
    // Strictly `=== 0`, unlike Enter's `?? 0`. Pinned because the asymmetry is
    // invisible and a tidy-up would unify them in one direction or the other.
    expect(
      intentOf(
        key({ key: "Backspace" }),
        { selectionStart: null, selectionEnd: null, valueLength: 17 },
        1,
      ),
    ).toEqual({ kind: "none" });
  });

  it("still asks to merge the first line, which the reducer then declines", () => {
    // The keymap does not know where the line sits; `mergeLineWithPrevious`
    // declines at index 0. Splitting the judgement would put the same rule in
    // two places.
    expect(intentOf(key({ key: "Backspace" }), caret(0), 0)).toEqual({
      kind: "merge",
      index: 0,
    });
  });
});

describe("captionKeyIntent: Delete", () => {
  it("merges the NEXT line up, from a collapsed caret at the end", () => {
    expect(intentOf(key({ key: "Delete" }), caret(17), 0)).toEqual({
      kind: "merge",
      index: 1,
    });
  });

  it("does nothing on the last line, which has nothing below it", () => {
    expect(intentOf(key({ key: "Delete" }), caret(17), 1, 2)).toEqual({ kind: "none" });
  });

  it("does nothing anywhere but the end", () => {
    for (const at of [0, 9, 16]) {
      expect(intentOf(key({ key: "Delete" }), caret(at), 0)).toEqual({ kind: "none" });
    }
  });

  it("does nothing for a selection ending at the end", () => {
    expect(
      intentOf(
        key({ key: "Delete" }),
        { selectionStart: 12, selectionEnd: 17, valueLength: 17 },
        0,
      ),
    ).toEqual({ kind: "none" });
  });

  it("merges from an empty line, where start and end are both zero", () => {
    // An emptied line has valueLength 0, so the caret is at both edges at once.
    // Delete wins, because it is tested before nothing else matches.
    expect(intentOf(key({ key: "Delete" }), caret(0, 0), 0)).toEqual({
      kind: "merge",
      index: 1,
    });
  });
});

describe("captionKeyIntent: undo", () => {
  it("answers undo for Cmd+Z and for Ctrl+Z", () => {
    expect(intentOf(key({ key: "z", metaKey: true }), caret(5))).toEqual({ kind: "undo" });
    expect(intentOf(key({ key: "z", ctrlKey: true }), caret(5))).toEqual({ kind: "undo" });
  });

  it("ignores an unmodified z, which is a letter", () => {
    expect(intentOf(key({ key: "z" }), caret(5))).toEqual({ kind: "none" });
  });

  it("does NOT redo on Cmd+Shift+Z", () => {
    // Shift makes `key` "Z", and the comparison is lower case only. There is no
    // redo in this panel; pinned so the gap is recorded rather than assumed.
    expect(intentOf(key({ key: "Z", metaKey: true, shiftKey: true } as any), caret(5)))
      .toEqual({ kind: "none" });
  });

  it("does NOT undo with Caps Lock on", () => {
    // The same omission from another angle: Caps Lock also reports "Z", so a
    // user with it on has no undo at all.
    expect(intentOf(key({ key: "Z", metaKey: true }), caret(5))).toEqual({ kind: "none" });
  });
});

describe("captionKeyIntent: the IME guard", () => {
  it("suppresses Enter while a composition is active", () => {
    // A Korean IME fires Enter to commit. Splitting on it would cut the line in
    // half every time someone finished a word.
    expect(intentOf(key({ key: "Enter", isComposing: true }), caret(6)))
      .toEqual({ kind: "none" });
  });

  it("suppresses Enter for browsers that report only keyCode 229", () => {
    expect(intentOf(key({ key: "Enter", keyCode: 229 }), caret(6)))
      .toEqual({ kind: "none" });
  });

  it("suppresses every other key too, undo included", () => {
    // The guard returns before anything else is tested. Cmd+Z mid-composition
    // does nothing, which is the behaviour today.
    const composing = [
      key({ key: "Backspace", isComposing: true }),
      key({ key: "Delete", isComposing: true }),
      key({ key: "z", metaKey: true, isComposing: true }),
      key({ key: "z", ctrlKey: true, keyCode: 229 }),
    ];
    for (const event of composing) {
      expect(intentOf(event, caret(0, 0))).toEqual({ kind: "none" });
    }
  });
});

describe("captionKeyIntent: the order the keys are tested in", () => {
  it("merges rather than deleting to end on Cmd+Delete", () => {
    // Cmd+Z is tested last, so a modifier does not stop Delete matching first.
    // macOS would delete to the end of the line; here it merges the next line up.
    expect(intentOf(key({ key: "Delete", metaKey: true }), caret(17), 0)).toEqual({
      kind: "merge",
      index: 1,
    });
  });

  it("splits on Cmd+Enter", () => {
    expect(intentOf(key({ key: "Enter", metaKey: true }), caret(6))).toMatchObject({
      kind: "split",
    });
  });

  it("merges upward on Cmd+Backspace at the start", () => {
    expect(intentOf(key({ key: "Backspace", metaKey: true }), caret(0), 1)).toEqual({
      kind: "merge",
      index: 1,
    });
  });

  it("ignores keys it has no opinion about", () => {
    for (const k of ["a", "ArrowLeft", "Tab", "Escape", "Home", "End", " "]) {
      expect(intentOf(key({ key: k }), caret(0, 0))).toEqual({ kind: "none" });
    }
  });
});

describe("capturesKey", () => {
  it("cancels the keystroke for everything that acts", () => {
    expect(capturesKey({ kind: "split", index: 0, caretOffset: 0 })).toBe(true);
    expect(capturesKey({ kind: "merge", index: 1 })).toBe(true);
    expect(capturesKey({ kind: "undo" })).toBe(true);
  });

  it("lets the keystroke through when nothing happens, so typing works", () => {
    expect(capturesKey({ kind: "none" })).toBe(false);
  });
});

// -------------------------------------------------------------- the reducer

describe("applyCaptionEdit: split", () => {
  it("splits the line and puts the caret at the start of the new one", () => {
    const { editor: next, focus } = applyCaptionEdit(editor(), {
      kind: "split",
      index: 0,
      caretOffset: 6,
    });

    expect(next.lines.map((l) => l.text)).toEqual(["hello", "there world", "and again"]);
    expect(focus).toEqual({ index: 1, caretOffset: 0 });
  });

  it("records one undo step", () => {
    const before = editor();
    const { editor: next } = applyCaptionEdit(before, {
      kind: "split",
      index: 0,
      caretOffset: 6,
    });

    expect(next.undo).toHaveLength(1);
    expect(next.undo[0]).toBe(before.lines);
  });

  it("declines by identity at the end of a line, and moves no caret", () => {
    // Enter at the end would leave an empty tail, so `splitLineAt` declines. The
    // undo stack must not gain a state identical to the one before it.
    const before = editor();
    const result = applyCaptionEdit(before, {
      kind: "split",
      index: 0,
      caretOffset: before.lines[0].text.length,
    });

    expect(result.editor).toBe(before);
    expect(result.focus).toBeNull();
  });

  it("declines by identity at the start of a line", () => {
    const before = editor();
    expect(applyCaptionEdit(before, { kind: "split", index: 0, caretOffset: 0 }).editor)
      .toBe(before);
  });

  it("declines by identity on a line that is not there", () => {
    const before = editor();
    expect(applyCaptionEdit(before, { kind: "split", index: 9, caretOffset: 2 }).editor)
      .toBe(before);
  });
});

describe("applyCaptionEdit: merge", () => {
  it("merges into the line above and puts the caret at the join", () => {
    const before = editor();
    const { editor: next, focus } = applyCaptionEdit(before, { kind: "merge", index: 1 });

    expect(next.lines.map((l) => l.text)).toEqual(["hello there world and again"]);
    expect(focus).toEqual({ index: 0, caretOffset: "hello there world".length });
  });

  it("reads the caret from the list BEFORE the merge", () => {
    // After the merge the previous line no longer exists on its own, so its
    // length has to be taken first. Getting this wrong puts the caret at the end
    // of the joined line instead of where the text was cut.
    const before = editor();
    const { focus } = applyCaptionEdit(before, { kind: "merge", index: 1 });

    expect(focus?.caretOffset).toBe(before.lines[0].text.length);
    expect(focus?.caretOffset).not.toBe(
      before.lines[0].text.length + before.lines[1].text.length,
    );
  });

  it("records one undo step", () => {
    const before = editor();
    const { editor: next } = applyCaptionEdit(before, { kind: "merge", index: 1 });

    expect(next.undo).toEqual([before.lines]);
  });

  it("declines by identity at the top of the list", () => {
    const before = editor();
    const result = applyCaptionEdit(before, { kind: "merge", index: 0 });

    expect(result.editor).toBe(before);
    expect(result.focus).toBeNull();
  });

  it("declines by identity past the end of the list", () => {
    const before = editor();
    expect(applyCaptionEdit(before, { kind: "merge", index: 5 }).editor).toBe(before);
  });
});

describe("applyCaptionEdit: undo and none", () => {
  it("walks back one split", () => {
    const before = editor();
    const { editor: split } = applyCaptionEdit(before, {
      kind: "split",
      index: 0,
      caretOffset: 6,
    });
    const { editor: back } = applyCaptionEdit(split, { kind: "undo" });

    expect(back.lines).toBe(before.lines);
    expect(back.undo).toEqual([]);
  });

  it("moves no caret on undo", () => {
    // Nothing in the original restored a caret here, and guessing one would
    // steal focus from whatever the user was typing in.
    const { editor: split } = applyCaptionEdit(editor(), {
      kind: "split",
      index: 0,
      caretOffset: 6,
    });
    expect(applyCaptionEdit(split, { kind: "undo" }).focus).toBeNull();
  });

  it("declines by identity on an empty stack", () => {
    const before = editor();
    expect(applyCaptionEdit(before, { kind: "undo" }).editor).toBe(before);
  });

  it("does nothing at all for none", () => {
    const before = editor();
    const result = applyCaptionEdit(before, { kind: "none" });

    expect(result.editor).toBe(before);
    expect(result.focus).toBeNull();
  });

  it("walks back several steps in order, most recent first", () => {
    let state = editor();
    const snapshots = [state.lines];
    for (const caretOffset of [6, 3, 2]) {
      state = applyCaptionEdit(state, { kind: "split", index: 0, caretOffset }).editor;
      snapshots.push(state.lines);
    }

    for (let i = snapshots.length - 1; i > 0; i -= 1) {
      expect(state.lines).toBe(snapshots[i]);
      state = applyCaptionEdit(state, { kind: "undo" }).editor;
    }
    expect(state.lines).toBe(snapshots[0]);
  });
});

describe("the undo stack's cap", () => {
  /** Split repeatedly, each time on the first line, to bank N snapshots. */
  function bank(steps: number): CaptionEditor {
    let state = editorFrom(
      linesFromWordGroups([
        Array.from({ length: steps + 2 }, (_, i) => ({
          word: `w${i}`,
          start: i,
          end: i + 1,
        })),
      ]),
    );
    for (let i = 0; i < steps; i += 1) {
      const next = applyCaptionEdit(state, {
        kind: "split",
        index: i,
        caretOffset: state.lines[i].text.indexOf(" "),
      });
      expect(next.editor).not.toBe(state);
      state = next.editor;
    }
    return state;
  }

  it("holds exactly UNDO_LIMIT steps", () => {
    expect(bank(UNDO_LIMIT).undo).toHaveLength(UNDO_LIMIT);
  });

  it("drops the oldest once full, not the newest", () => {
    const fifty = bank(UNDO_LIMIT);
    const oldest = fifty.undo[0];
    const state = bank(UNDO_LIMIT + 1);

    expect(state.undo).toHaveLength(UNDO_LIMIT);
    expect(state.undo[0]).not.toBe(oldest);
    // The most recent snapshot is still the one undo will restore.
    expect(applyCaptionEdit(state, { kind: "undo" }).editor.lines)
      .toBe(state.undo[state.undo.length - 1]);
  });

  it("stays at the cap however many edits follow", () => {
    expect(bank(UNDO_LIMIT + 10).undo).toHaveLength(UNDO_LIMIT);
  });

  it("never mutates an editor it was given", () => {
    const before = editor();
    const frozenUndo = before.undo;
    applyCaptionEdit(before, { kind: "split", index: 0, caretOffset: 6 });

    expect(before.undo).toBe(frozenUndo);
    expect(before.undo).toHaveLength(0);
    expect(before.lines.map((l) => l.text)).toEqual(["hello there world", "and again"]);
  });
});

describe("editText", () => {
  it("replaces a line's text", () => {
    const next = editText(editor(), 0, "corrected");
    expect(next.lines[0].text).toBe("corrected");
  });

  it("leaves the line's timing alone", () => {
    const before = editor();
    const next = editText(before, 0, "corrected");

    expect(next.lines[0].start).toBe(before.lines[0].start);
    expect(next.lines[0].end).toBe(before.lines[0].end);
    expect(next.lines[0].words).toBe(before.lines[0].words);
  });

  it("records NO undo step", () => {
    // A snapshot per keystroke would bury the structural edits the stack is for
    // under hundreds of character states.
    const next = editText(editor(), 0, "corrected");
    expect(next.undo).toEqual([]);
  });

  it("keeps the existing stack untouched", () => {
    const { editor: split } = applyCaptionEdit(editor(), {
      kind: "split",
      index: 0,
      caretOffset: 6,
    });
    const typed = editText(split, 0, "edited");

    expect(typed.undo).toBe(split.undo);
  });

  it("declines by identity when the value did not change", () => {
    const before = editor();
    expect(editText(before, 0, before.lines[0].text)).toBe(before);
  });

  it("declines by identity on a line that is not there", () => {
    const before = editor();
    expect(editText(before, 9, "anything")).toBe(before);
  });

  it("accepts an emptied line, which captionRows then drops", () => {
    const next = editText(editor(), 0, "");
    expect(next.lines[0].text).toBe("");
    expect(next.lines).toHaveLength(2);
  });
});

describe("keystroke to result, end to end", () => {
  /** What the panel does: ask, then act. */
  function press(
    state: CaptionEditor,
    event: CaptionKeyEvent,
    field: CaptionField,
    index: number,
  ) {
    const intent = captionKeyIntent(event, field, index, state.lines.length);
    return { ...applyCaptionEdit(state, intent), captured: capturesKey(intent) };
  }

  it("Backspace at the start of line 2 merges it up and lands the caret at the join", () => {
    const before = editor();
    const { editor: next, focus, captured } = press(
      before,
      key({ key: "Backspace" }),
      caret(0, before.lines[1].text.length),
      1,
    );

    expect(captured).toBe(true);
    expect(next.lines.map((l) => l.text)).toEqual(["hello there world and again"]);
    expect(focus).toEqual({ index: 0, caretOffset: 17 });
  });

  it("Enter mid-line splits and lands the caret on the new line", () => {
    const { editor: next, focus, captured } = press(
      editor(),
      key({ key: "Enter" }),
      caret(6),
      0,
    );

    expect(captured).toBe(true);
    expect(next.lines.map((l) => l.text)).toEqual(["hello", "there world", "and again"]);
    expect(focus).toEqual({ index: 1, caretOffset: 0 });
  });

  it("Enter at the end of a line costs nothing at all", () => {
    const before = editor();
    const result = press(before, key({ key: "Enter" }), caret(17), 0);

    // The keystroke is still cancelled — the intent was a split — but nothing
    // changed, so the panel repaints nothing and the stack stays empty.
    expect(result.captured).toBe(true);
    expect(result.editor).toBe(before);
    expect(result.focus).toBeNull();
  });

  it("a Korean IME's Enter types instead of splitting", () => {
    const before = editor();
    const result = press(before, key({ key: "Enter", isComposing: true }), caret(6), 0);

    expect(result.captured).toBe(false);
    expect(result.editor).toBe(before);
  });

  it("split then Cmd+Z returns to exactly the list we started with", () => {
    const before = editor();
    const split = press(before, key({ key: "Enter" }), caret(6), 0);
    const back = press(split.editor, key({ key: "z", metaKey: true }), caret(0), 1);

    expect(back.captured).toBe(true);
    expect(back.editor.lines).toBe(before.lines);
  });

  it("typing is not undoable, so Cmd+Z after a split-then-type loses the typing", () => {
    // The defect recorded in the findings, as a test: `editText` does not
    // snapshot, so undo restores the pre-split lines and the characters typed
    // since are gone. Pinned, not fixed.
    const before = editor();
    const split = press(before, key({ key: "Enter" }), caret(6), 0).editor;
    const typed = editText(split, 0, "hello!!");
    expect(typed.lines[0].text).toBe("hello!!");

    const back = press(typed, key({ key: "z", metaKey: true }), caret(0), 0);
    expect(back.editor.lines).toBe(before.lines);
    expect(back.editor.lines[0].text).toBe("hello there world");
  });

  it("Cmd+Z with nothing banked cancels the keystroke and does nothing", () => {
    // Which is why the input's own native undo is unreachable: the panel calls
    // preventDefault for any intent that is not "none". Findings F1b.
    const before = editor();
    const result = press(before, key({ key: "z", metaKey: true }), caret(3), 0);

    expect(result.captured).toBe(true);
    expect(result.editor).toBe(before);
  });
});
