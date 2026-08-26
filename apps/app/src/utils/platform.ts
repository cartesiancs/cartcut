/**
 * Which platform's keyboard conventions this window follows.
 *
 * Two things live here rather than at their call sites. The modifier
 * *predicate*, because "Cmd on macOS, Ctrl everywhere else" has to be the same
 * answer in every handler or a shortcut works in the timeline and not in the
 * preview. And the *formatter*, because the label a user reads has to describe
 * the key that actually fires — the toolbar used to print "Ctrl+⇧Z" on Windows,
 * half a Mac glyph inside a Windows word.
 *
 * Kept DOM-free on purpose, same as `typingTarget`: detection takes a
 * navigator-like object, and every exported function takes `isMac` as an
 * explicit last parameter, so the whole module runs under `environment: "node"`
 * without a jsdom. Tests must always pass `isMac` — Node exposes a real
 * `navigator.platform`, so a test that leans on the default passes on a Mac and
 * fails on Linux CI.
 */

export interface NavigatorLike {
  userAgent?: string;
  platform?: string;
  /** UA Client Hints. Not in TypeScript's DOM lib, hence the local shape. */
  userAgentData?: { platform?: string };
}

/**
 * Three signals, best first.
 *
 * `userAgentData.platform` is the only non-deprecated one and returns a clean
 * `"macOS"` rather than a string you have to substring-match. It needs a secure
 * context, though, and the app loads its page over `file://` — so the chain
 * falls through to `navigator.platform` (`"MacIntel"`) and finally to the user
 * agent string, which is last because it is the most spoofable and the most
 * likely to be reduced by the engine.
 */
export function detectIsMac(nav?: NavigatorLike | null): boolean {
  if (nav == null) {
    return false;
  }

  const hinted = nav.userAgentData?.platform;
  if (typeof hinted === "string" && hinted.length > 0) {
    return /^mac/i.test(hinted);
  }

  if (typeof nav.platform === "string" && nav.platform.length > 0) {
    return /^mac/i.test(nav.platform);
  }

  return /Mac OS X|Macintosh/i.test(nav.userAgent ?? "");
}

/** Resolved once at load. Callers that are not tests should use this. */
export const IS_MAC: boolean = detectIsMac(
  typeof navigator === "undefined" ? null : (navigator as NavigatorLike),
);

export interface ModifierEventLike {
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
}

/**
 * Does this keystroke carry the editor modifier for this platform?
 *
 * Strict in both directions. On macOS only Cmd fires an editor shortcut: Ctrl
 * is a real macOS modifier with meanings of its own (⌃F, ⌃Space), and claiming
 * it for "copy" is the Windows habit this function exists to unlearn. On
 * Windows and Linux only Ctrl, because Meta is the Super key and belongs to the
 * shell.
 *
 * `altKey` is refused on both. On many European layouts AltGr *is* Ctrl+Alt —
 * typing `@` or `{` sends `ctrlKey: true` — and `isTypingEvent` only covers
 * that inside a text field. On the bare timeline canvas AltGr+D would otherwise
 * split a clip. No binding here wants Alt, so refusing it costs nothing.
 *
 * Not for wheel events. macOS synthesises `ctrlKey` on a trackpad pinch, so the
 * two `_handleMouseWheel`/`_handleWheel` zoom gestures test that flag directly
 * and must keep doing so.
 */
export function hasEditorModifier(
  event: ModifierEventLike | null | undefined,
  isMac: boolean = IS_MAC,
): boolean {
  if (event == null || event.altKey === true) {
    return false;
  }

  return isMac
    ? event.metaKey === true && event.ctrlKey !== true
    : event.ctrlKey === true && event.metaKey !== true;
}

/**
 * One key of a binding. `"Mod"` is the placeholder for the platform modifier;
 * everything else is either another modifier name, a named key, or the
 * character itself.
 */
export type ShortcutToken = string;

const MAC_MODIFIERS: Record<string, string> = {
  Ctrl: "⌃",
  Alt: "⌥",
  Shift: "⇧",
  Mod: "⌘",
};

const PC_MODIFIERS: Record<string, string> = {
  Ctrl: "Ctrl",
  Alt: "Alt",
  Shift: "Shift",
  Mod: "Ctrl",
};

/**
 * Apple prints modifiers in a fixed order — ⌃⌥⇧⌘ — regardless of how you say
 * them, which is why redo is `⇧⌘Z` and not `⌘⇧Z`. Windows writes
 * Ctrl+Alt+Shift, and there `Mod` *is* Ctrl, so it has to sort first rather
 * than last or redo comes out "Shift+Ctrl+Z".
 *
 * Sorting by rank rather than rendering in author order means a registry entry
 * can list its keys in whatever order reads best and still come out right on
 * both platforms.
 */
const MAC_MODIFIER_RANK: Record<string, number> = {
  Ctrl: 0,
  Alt: 1,
  Shift: 2,
  Mod: 3,
};

const PC_MODIFIER_RANK: Record<string, number> = {
  Mod: 0,
  Ctrl: 1,
  Alt: 2,
  Shift: 3,
};

/**
 * Named keys that have a printed legend.
 *
 * macOS uses the glyphs because that is what its own menus show and what is on
 * the key; Windows uses words because Windows menus do. Arrows are glyphs on
 * both — "Up Arrow" is clunky and ↑ is unambiguous everywhere.
 */
const MAC_KEYS: Record<string, string> = {
  Backspace: "⌫",
  Delete: "⌦",
  Escape: "⎋",
  Enter: "↩",
  Space: "Space",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
};

const PC_KEYS: Record<string, string> = {
  Backspace: "Backspace",
  Delete: "Delete",
  Escape: "Esc",
  Enter: "Enter",
  Space: "Space",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
};

export function isModifierToken(token: ShortcutToken): boolean {
  return Object.prototype.hasOwnProperty.call(MAC_MODIFIER_RANK, token);
}

export function isNamedKeyToken(token: ShortcutToken): boolean {
  return Object.prototype.hasOwnProperty.call(PC_KEYS, token);
}

/** One display string per key, so a caller could render them as separate chips. */
export function shortcutParts(
  tokens: readonly ShortcutToken[],
  isMac: boolean = IS_MAC,
): string[] {
  const rank = isMac ? MAC_MODIFIER_RANK : PC_MODIFIER_RANK;
  const modifiers = tokens
    .filter(isModifierToken)
    .sort((a, b) => rank[a] - rank[b]);

  const keys = tokens.filter((token) => !isModifierToken(token));

  const modifierNames = isMac ? MAC_MODIFIERS : PC_MODIFIERS;
  const keyNames = isMac ? MAC_KEYS : PC_KEYS;

  return [
    ...modifiers.map((token) => modifierNames[token]),
    ...keys.map((token) => keyNames[token] ?? token.toUpperCase()),
  ];
}

/**
 * The whole binding as one string: `"⇧⌘Z"` on macOS, `"Ctrl+Shift+Z"` elsewhere.
 * Mac glyphs need no separator — they are already distinct marks — while the
 * Windows words would run together without one.
 */
export function formatShortcut(
  tokens: readonly ShortcutToken[],
  isMac: boolean = IS_MAC,
): string {
  return shortcutParts(tokens, isMac).join(isMac ? "" : "+");
}
