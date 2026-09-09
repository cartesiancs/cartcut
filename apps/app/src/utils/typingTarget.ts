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
  /** Present when the target is a custom element that renders into shadow DOM. */
  shadowRoot?: { activeElement?: unknown } | null;
}

/** The part of a `KeyboardEvent` this module reads. */
export interface KeyEventLike {
  target?: unknown;
  composedPath?: () => unknown[];
}

/** The part of `document` `isTypingFocus` reads. */
export interface ActiveElementRootLike {
  activeElement?: unknown;
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

/**
 * The same question, asked of an event rather than a bare target.
 *
 * Use this for any listener bound to `window` or `document`. Shadow DOM
 * retargets `event.target` to the *host* element as the event crosses the
 * boundary, so a keystroke typed into `number-input`'s inner `<input>` arrives
 * at a window listener as `<number-input>` — which is not a text field by any
 * test, so `isTypingTarget` alone waves it through. That is the exact bug this
 * module exists to prevent, reintroduced by a component boundary: Backspace
 * while correcting a digit in the opacity spinner deleted the selected clip.
 *
 * `composedPath()[0]` is the element the user is actually typing in, whatever
 * shadow roots lie between it and the listener.
 */
export function isTypingEvent(event: KeyEventLike | null | undefined): boolean {
  if (event == null) {
    return false;
  }

  const path = typeof event.composedPath === "function" ? event.composedPath() : [];
  if (path.length > 0 && isTypingTarget(path[0])) {
    return true;
  }

  if (isTypingTarget(event.target)) {
    return true;
  }

  // Last resort for engines without `composedPath`: ask the host's shadow root
  // what has focus inside it.
  const host = event.target as KeyEventTargetLike | null;
  return isTypingTarget(host?.shadowRoot?.activeElement);
}

/**
 * The same question with no event to ask it of: is the caret in a text field
 * *right now*?
 *
 * This is what a command arriving from the application menu has to use. A menu
 * item is chosen with the mouse, so there is no keystroke and no target — but
 * choosing Edit → Copy while a caption is being typed still means the text, and
 * `runMenuCommand` has only the focus to tell it so.
 *
 * `document.activeElement` stops at a shadow host, so the descent is the same
 * retargeting `isTypingEvent` undoes with `composedPath`, walked the other way.
 * Bounded rather than `while (true)`: a component that made itself its own
 * `activeElement` would otherwise hang the app on a keystroke.
 */
export function isTypingFocus(
  root: ActiveElementRootLike | null | undefined,
): boolean {
  let node = root?.activeElement as KeyEventTargetLike | null | undefined;

  for (let depth = 0; depth < 16 && node != null; depth += 1) {
    const inner = node.shadowRoot?.activeElement as
      | KeyEventTargetLike
      | null
      | undefined;
    if (inner == null || inner === node) {
      break;
    }
    node = inner;
  }

  return isTypingTarget(node);
}
