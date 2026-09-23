/**
 * Keyboard shortcuts an extension declares, and the ones it may never have.
 *
 * `features/editor/shortcuts.ts` opens by saying what it is not: a dispatcher.
 * The bindings live in three `_handleKeydown` switches and that table only
 * describes them. This is the missing half for extensions, and it is a real
 * registry because there is nowhere else a third party's binding could live.
 *
 * ## It can never shadow an app key
 *
 * Every chord the app already binds is refused at merge time, not at dispatch
 * time. That ordering matters: refusing late would mean an extension could
 * register ⌘Z, the seam would decline it on every press, and the user would
 * see a shortcut listed in an extension's documentation that silently does
 * nothing. Refusing early puts the error in front of the author instead.
 *
 * The reserved list is derived from `SHORTCUTS` rather than typed out, so a
 * shortcut added to the app is reserved from that moment without anybody
 * remembering this file.
 *
 * ## Not accelerators
 *
 * A menu accelerator is global to the window and fires while the user is
 * typing, which is why the app menu registers none for Space, the arrows or
 * Delete. An extension binding is dispatched from the editor's own keydown
 * handler, after its typing guard has run, so an extension cannot take a key
 * away from a caption field.
 */

import { SHORTCUTS } from "../editor/shortcuts";
import type { ContributedKeybinding } from "./contributions";

/** A chord, normalised. `mod` is Command on macOS and Control elsewhere. */
export type Chord = {
  mod: boolean;
  alt: boolean;
  shift: boolean;
  ctrl: boolean;
  /** A `KeyboardEvent.code`, e.g. `KeyZ`, `Digit1`, `Slash`. */
  code: string;
};

export type KeyEventLike = {
  code: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
};

const MODIFIER_WORDS: Record<string, keyof Omit<Chord, "code">> = {
  mod: "mod",
  cmd: "mod",
  command: "mod",
  meta: "mod",
  ctrl: "ctrl",
  control: "ctrl",
  alt: "alt",
  option: "alt",
  shift: "shift",
};

/**
 * `KeyboardEvent.code` for the key part of a chord.
 *
 * `code` rather than `key`, which is the same choice the timeline canvas made:
 * `key` is what the layout produced, so a binding on `z` is a different
 * physical key on an AZERTY keyboard and `Mod+Z` on a Dvorak layout reports a
 * letter that is not `z` at all.
 */
function codeFor(token: string): string | null {
  const value = token.trim();
  if (value === "") {
    return null;
  }
  if (/^[a-zA-Z]$/.test(value)) {
    return "Key" + value.toUpperCase();
  }
  if (/^[0-9]$/.test(value)) {
    return "Digit" + value;
  }
  const named: Record<string, string> = {
    space: "Space",
    enter: "Enter",
    return: "Enter",
    tab: "Tab",
    escape: "Escape",
    esc: "Escape",
    backspace: "Backspace",
    delete: "Delete",
    up: "ArrowUp",
    down: "ArrowDown",
    left: "ArrowLeft",
    right: "ArrowRight",
    comma: "Comma",
    period: "Period",
    slash: "Slash",
    backslash: "Backslash",
    semicolon: "Semicolon",
    quote: "Quote",
    bracketleft: "BracketLeft",
    bracketright: "BracketRight",
    minus: "Minus",
    equal: "Equal",
    backquote: "Backquote",
  };
  const lower = value.toLowerCase();
  if (named[lower] != null) {
    return named[lower];
  }
  // Already a `code`, e.g. `KeyZ` or `F5`. Accepted so an author who knows the
  // vocabulary can use it directly.
  return /^([A-Z][a-zA-Z0-9]*)$/.test(value) ? value : null;
}

export function parseChord(text: string): Chord | null {
  if (typeof text !== "string" || text.trim() === "") {
    return null;
  }
  const parts = text.split("+").map((part) => part.trim()).filter((part) => part !== "");
  if (parts.length === 0) {
    return null;
  }

  const chord: Chord = { mod: false, alt: false, shift: false, ctrl: false, code: "" };
  for (const part of parts.slice(0, -1)) {
    const modifier = MODIFIER_WORDS[part.toLowerCase()];
    if (modifier == null) {
      return null;
    }
    chord[modifier] = true;
  }

  const code = codeFor(parts[parts.length - 1]);
  if (code == null) {
    return null;
  }
  chord.code = code;
  return chord;
}

export function chordKey(chord: Chord): string {
  return [
    chord.mod ? "mod" : "",
    chord.ctrl ? "ctrl" : "",
    chord.alt ? "alt" : "",
    chord.shift ? "shift" : "",
    chord.code,
  ]
    .filter((part) => part !== "")
    .join("+");
}

export function matchesChord(chord: Chord, event: KeyEventLike, isMac: boolean): boolean {
  if (event.code !== chord.code) {
    return false;
  }
  const modPressed = isMac ? event.metaKey === true : event.ctrlKey === true;
  const ctrlPressed = isMac ? event.ctrlKey === true : false;

  return (
    modPressed === chord.mod &&
    ctrlPressed === chord.ctrl &&
    (event.altKey === true) === chord.alt &&
    (event.shiftKey === true) === chord.shift
  );
}

/**
 * Chords no extension may take.
 *
 * Three sources. The app's own table, so anything in the shortcuts help is
 * spoken for. The bare navigation keys, which the timeline canvas binds
 * without a modifier and which an extension taking would break scrubbing. And
 * Escape, which every modal and the mask pen use to get out of whatever the
 * user is in.
 */
export function reservedChords(): Set<string> {
  const reserved = new Set<string>();

  for (const shortcut of SHORTCUTS) {
    for (const binding of [shortcut.keys, ...(shortcut.alternates ?? [])]) {
      const chord = parseChord([...binding].join("+").replace(/\bMod\b/g, "mod"));
      if (chord != null) {
        reserved.add(chordKey(chord));
      }
    }
  }

  for (const bare of [
    "Space",
    "ArrowUp",
    "ArrowDown",
    "ArrowLeft",
    "ArrowRight",
    "Delete",
    "Backspace",
    "Escape",
    "Enter",
  ]) {
    reserved.add(bare);
  }

  return reserved;
}

export type ResolvedBinding = {
  chord: Chord;
  key: string;
  extId: string;
  commandId: string;
  when: string | null;
};

export type BindingProblem = { extId: string; key: string; reason: string };

/**
 * Turn declared bindings into a table, dropping the ones that cannot be had.
 *
 * Duplicates go to the first registrant, with the loser reported rather than
 * silently dropped: two extensions claiming the same chord is something the
 * user has to be able to find out about, and it is the same rule
 * `presetRegistry.ts` follows for a duplicate preset id.
 */
export function resolveBindings(
  declared: readonly ContributedKeybinding[],
  reserved: Set<string> = reservedChords(),
): { bindings: ResolvedBinding[]; problems: BindingProblem[] } {
  const bindings: ResolvedBinding[] = [];
  const problems: BindingProblem[] = [];
  const taken = new Map<string, string>();

  for (const entry of declared) {
    const chord = parseChord(entry.key);
    if (chord == null) {
      problems.push({ extId: entry.extId, key: entry.key, reason: "is not a chord this app can parse" });
      continue;
    }

    const key = chordKey(chord);
    if (reserved.has(key)) {
      problems.push({ extId: entry.extId, key: entry.key, reason: "is a shortcut this app already uses" });
      continue;
    }

    const owner = taken.get(key);
    if (owner != null) {
      problems.push({
        extId: entry.extId,
        key: entry.key,
        reason: "is already bound by " + owner,
      });
      continue;
    }

    taken.set(key, entry.extId);
    bindings.push({ chord, key, extId: entry.extId, commandId: entry.commandId, when: entry.when });
  }

  return { bindings, problems };
}

export type WhenContext = { selectionCount: number; selectionTypes: string[] };

/**
 * The `when` clause vocabulary. Small, and closed.
 *
 * Three forms, because three is what the surfaces actually need and every
 * addition is a parser an extension can probe. Anything unrecognised matches,
 * so a clause from a future version degrades to "always" rather than to
 * "never": a binding that does nothing is harder to diagnose than one that
 * fires when it should not.
 */
export function matchesWhen(when: string | null, context: WhenContext): boolean {
  if (when == null || when.trim() === "") {
    return true;
  }
  const clause = when.trim();

  if (clause === "selection") {
    return context.selectionCount > 0;
  }

  const type = /^selection\.type\s*==\s*([a-z]+)$/.exec(clause);
  if (type != null) {
    return context.selectionTypes.includes(type[1]);
  }

  const count = /^selection\.count\s*(>=|<=|==|>|<)\s*(\d+)$/.exec(clause);
  if (count != null) {
    const bound = Number(count[2]);
    switch (count[1]) {
      case ">=":
        return context.selectionCount >= bound;
      case "<=":
        return context.selectionCount <= bound;
      case "==":
        return context.selectionCount === bound;
      case ">":
        return context.selectionCount > bound;
      case "<":
        return context.selectionCount < bound;
      default:
        return true;
    }
  }

  return true;
}

/** The binding this event should run, or null. */
export function resolveKeybinding(
  bindings: readonly ResolvedBinding[],
  event: KeyEventLike,
  context: WhenContext,
  isMac: boolean,
): ResolvedBinding | null {
  for (const binding of bindings) {
    if (matchesChord(binding.chord, event, isMac) && matchesWhen(binding.when, context)) {
      return binding;
    }
  }
  return null;
}
