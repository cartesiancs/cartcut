/**
 * Is this keystroke meant for a text field rather than for the app?
 *
 * The timeline's shortcuts are bound to `window`, so they fire no matter where
 * the caret is. That is fine for a plain canvas, but the app also has real text
 * inputs, and without this guard Backspace in one of them deleted the *selected
 * clip* while the user was typing — silent data loss with no visible cause.
 * Space had the milder version of the same problem: typing a space in a field
 * toggled playback.
 *
 * Kept DOM-free on purpose: it reads only the three properties that decide the
 * question, so a plain object stands in for an element under `environment:
 * "node"`.
 */
export interface KeyEventTargetLike {
  tagName?: string;
  isContentEditable?: boolean;
  /** `readonly`/`disabled` fields take no text, so shortcuts still belong to the app. */
  readOnly?: boolean;
  disabled?: boolean;
  type?: string;
}

/** Input types that hold no text and so never swallow a shortcut. */
const NON_TEXT_INPUT_TYPES = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

export function isTypingTarget(target: unknown): boolean {
  if (target == null || typeof target !== "object") {
    return false;
  }

  const el = target as KeyEventTargetLike;

  if (el.isContentEditable === true) {
    return true;
  }

  const tag = el.tagName?.toUpperCase();
  if (tag !== "INPUT" && tag !== "TEXTAREA") {
    return false;
  }

  // A field that cannot be typed into is not competing for the keystroke.
  if (el.readOnly === true || el.disabled === true) {
    return false;
  }

  if (tag === "INPUT" && NON_TEXT_INPUT_TYPES.has((el.type ?? "text").toLowerCase())) {
    return false;
  }

  return true;
}
