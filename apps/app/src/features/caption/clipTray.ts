/**
 * The picker's tray: dragging a chosen clip to a new place, and the keyboard.
 *
 * A reducer over plain numbers, with no DOM in it. The picker measures the
 * chips' centres and feeds pointer positions in; this decides when a press
 * becomes a drag, where the dragged chip would land, how far each other chip
 * slides aside to show it, and whether letting go changes anything. Kept out of
 * the Lit class for the reason CLAUDE.md gives for every such rule: there is no
 * DOM test environment here, so a rule inside the component is a rule nothing
 * can check.
 */

import { DRAG } from "../timeline/dragMachine";
import { hasEditorModifier } from "../../utils/platform";

export type TrayDrag =
  | { kind: "idle" }
  /** Down on a chip, not yet far enough to be a drag. A release is a click. */
  | { kind: "pressed"; from: number; x0: number }
  | { kind: "dragging"; from: number; to: number; dx: number; x0: number };

export type TrayEvent =
  | { kind: "press"; index: number; x: number }
  /** `centers` are the chips' resting centres, in the same space as `x`. */
  | { kind: "move"; x: number; centers: readonly number[] }
  | { kind: "release" }
  | { kind: "cancel" };

export type TrayStep = {
  state: TrayDrag;
  /** Present only when letting go moved a chip. */
  commit?: { from: number; to: number };
};

export const TRAY_IDLE: TrayDrag = { kind: "idle" };

/**
 * One pointer event.
 *
 * Returns `state` by identity when the event changes nothing, so the picker can
 * skip a repaint for a pointer that is still inside the dead zone.
 */
export function reduceTrayDrag(state: TrayDrag, event: TrayEvent): TrayStep {
  switch (event.kind) {
    case "press":
      return { state: { kind: "pressed", from: event.index, x0: event.x } };

    case "move": {
      if (state.kind === "idle") {
        return { state };
      }
      const dx = event.x - state.x0;
      // The same dead zone the timeline gives a clip, so a click that wobbles
      // by a pixel or two is still a click.
      if (state.kind === "pressed" && Math.abs(dx) <= DRAG.MOVE_CANCEL_PX) {
        return { state };
      }
      const centre = event.centers[state.from];
      if (centre == null) {
        return { state: TRAY_IDLE };
      }
      const to = trayDropIndex(event.centers, state.from, centre + dx);
      if (state.kind === "dragging" && state.dx === dx && state.to === to) {
        return { state };
      }
      return {
        state: { kind: "dragging", from: state.from, to, dx, x0: state.x0 },
      };
    }

    case "release":
      if (state.kind === "dragging" && state.to !== state.from) {
        return {
          state: TRAY_IDLE,
          commit: { from: state.from, to: state.to },
        };
      }
      return { state: state.kind === "idle" ? state : TRAY_IDLE };

    case "cancel":
      return { state: state.kind === "idle" ? state : TRAY_IDLE };
  }
}

/**
 * Where the chip at `from` would land with its centre at `x`.
 *
 * Counted over the *other* chips: the answer is how many of them it has passed,
 * which is the index it takes once it is lifted out, and exactly what
 * `clipPick.ts#movePick` expects as `to`.
 */
export function trayDropIndex(
  centers: readonly number[],
  from: number,
  x: number,
): number {
  let passed = 0;
  centers.forEach((centre, index) => {
    if (index !== from && centre < x) {
      passed += 1;
    }
  });
  return passed;
}

/**
 * How far the chip at `index` slides to open the gap, in px.
 *
 * Zero for the dragged chip itself, which follows the pointer instead, and for
 * every chip outside the stretch between `from` and `to`.
 */
export function trayShift(
  index: number,
  from: number,
  to: number,
  pitch: number,
): number {
  if (index === from) {
    return 0;
  }
  if (from < to && index > from && index <= to) {
    return -pitch;
  }
  if (to < from && index >= to && index < from) {
    return pitch;
  }
  return 0;
}

/** The part of a `KeyboardEvent` the picker reads. Named, never spread. */
export type PickerKey = {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
};

/** What has focus: a tile in the grid, a chip in the tray, or anything else. */
export type PickerZone = "tile" | "chip" | "other";

export type PickerKeyIntent =
  | "close"
  | "start"
  | "selectAll"
  | "focusPrev"
  | "focusNext"
  | "focusFirst"
  | "focusLast"
  | "moveBack"
  | "moveForward"
  | "remove"
  | "none";

/**
 * What a keystroke means while the picker is open.
 *
 * `none` does not mean the key reaches the editor. The picker is modal and
 * swallows every keystroke, because Backspace on the timeline deletes the
 * selected clip, and that is the clip the user is choosing.
 *
 * Enter and Space on a tile are `none` because the tile is a button and the
 * browser already turns them into a click, which is the toggle.
 */
export function pickerKeyIntent(
  event: PickerKey,
  zone: PickerZone,
  isMac: boolean,
): PickerKeyIntent {
  // An IME composing a character owns Enter and the arrows.
  if (event.isComposing === true || event.keyCode === 229) {
    return "none";
  }

  const editor = hasEditorModifier(event, isMac);
  const key = event.key;

  if (key === "Escape") {
    return "close";
  }
  if (editor && (key === "a" || key === "A")) {
    return "selectAll";
  }
  if (key === "Enter") {
    if (editor) {
      return "start";
    }
    return zone === "tile" ? "none" : "start";
  }

  if (zone === "chip") {
    // Option alone, or the editor modifier, carries the chip with the focus.
    const carry =
      editor ||
      (event.altKey === true && event.metaKey !== true && event.ctrlKey !== true);
    switch (key) {
      case "ArrowLeft":
        return carry ? "moveBack" : "focusPrev";
      case "ArrowRight":
        return carry ? "moveForward" : "focusNext";
      case "Home":
        return "focusFirst";
      case "End":
        return "focusLast";
      case "Backspace":
      case "Delete":
        return "remove";
    }
    return "none";
  }

  if (zone === "tile") {
    switch (key) {
      case "ArrowLeft":
        return "focusPrev";
      case "ArrowRight":
        return "focusNext";
      case "Home":
        return "focusFirst";
      case "End":
        return "focusLast";
    }
  }

  return "none";
}
