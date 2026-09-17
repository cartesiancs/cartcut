import { describe, expect, it } from "vitest";
import {
  TRAY_IDLE,
  pickerKeyIntent,
  reduceTrayDrag,
  trayDropIndex,
  trayShift,
  type PickerKey,
  type TrayDrag,
  type TrayEvent,
} from "./clipTray";

/** Four chips, 60px apart. */
const CENTERS = [30, 90, 150, 210];

function run(events: TrayEvent[]) {
  let state: TrayDrag = TRAY_IDLE;
  let commit: { from: number; to: number } | undefined;
  for (const event of events) {
    const step = reduceTrayDrag(state, event);
    state = step.state;
    commit = step.commit ?? commit;
  }
  return { state, commit };
}

const move = (x: number): TrayEvent => ({ kind: "move", x, centers: CENTERS });

describe("reduceTrayDrag", () => {
  // A click that wobbles is still a click, and a click on a chip moves nothing.
  it("treats a press released inside the dead zone as a click", () => {
    const { state, commit } = run([
      { kind: "press", index: 1, x: 90 },
      move(93),
      { kind: "release" },
    ]);
    expect(state).toEqual(TRAY_IDLE);
    expect(commit).toBeUndefined();
  });

  it("declines by identity for a move inside the dead zone", () => {
    const pressed = reduceTrayDrag(TRAY_IDLE, { kind: "press", index: 1, x: 90 }).state;
    expect(reduceTrayDrag(pressed, move(94)).state).toBe(pressed);
  });

  it("becomes a drag past the dead zone and follows the pointer", () => {
    const { state } = run([{ kind: "press", index: 0, x: 30 }, move(40)]);
    expect(state).toEqual({ kind: "dragging", from: 0, to: 0, dx: 10, x0: 30 });
  });

  it("commits a move forwards once the chip passes a neighbour's centre", () => {
    const { commit } = run([
      { kind: "press", index: 0, x: 30 },
      move(100),
      move(160),
      { kind: "release" },
    ]);
    expect(commit).toEqual({ from: 0, to: 2 });
  });

  it("commits a move backwards", () => {
    const { commit } = run([
      { kind: "press", index: 3, x: 210 },
      move(80),
      { kind: "release" },
    ]);
    expect(commit).toEqual({ from: 3, to: 1 });
  });

  it("commits nothing when the chip is dropped back where it was", () => {
    const { commit } = run([
      { kind: "press", index: 1, x: 90 },
      move(150),
      move(95),
      { kind: "release" },
    ]);
    expect(commit).toBeUndefined();
  });

  it("drops everything on cancel", () => {
    const { state, commit } = run([
      { kind: "press", index: 0, x: 30 },
      move(200),
      { kind: "cancel" },
      { kind: "release" },
    ]);
    expect(state).toEqual(TRAY_IDLE);
    expect(commit).toBeUndefined();
  });

  it("declines by identity for a move or release with nothing pressed", () => {
    expect(reduceTrayDrag(TRAY_IDLE, move(50)).state).toBe(TRAY_IDLE);
    expect(reduceTrayDrag(TRAY_IDLE, { kind: "release" }).state).toBe(TRAY_IDLE);
  });

  it("gives up if the chip it was dragging is gone", () => {
    const { state } = run([
      { kind: "press", index: 9, x: 30 },
      move(100),
    ]);
    expect(state).toEqual(TRAY_IDLE);
  });
});

describe("trayDropIndex", () => {
  it("counts the other chips the dragged centre has passed", () => {
    expect(trayDropIndex(CENTERS, 0, 20)).toBe(0);
    expect(trayDropIndex(CENTERS, 0, 95)).toBe(1);
    expect(trayDropIndex(CENTERS, 0, 999)).toBe(3);
    expect(trayDropIndex(CENTERS, 3, 85)).toBe(1);
    expect(trayDropIndex(CENTERS, 3, -50)).toBe(0);
  });
});

describe("trayShift", () => {
  it("slides the chips between the two places towards the gap", () => {
    // 0 moving to 2: chips 1 and 2 step left.
    expect([0, 1, 2, 3].map((i) => trayShift(i, 0, 2, 60))).toEqual([0, -60, -60, 0]);
    // 3 moving to 1: chips 1 and 2 step right.
    expect([0, 1, 2, 3].map((i) => trayShift(i, 3, 1, 60))).toEqual([0, 60, 60, 0]);
  });

  it("moves nothing when the chip has not left its place", () => {
    expect([0, 1, 2].map((i) => trayShift(i, 1, 1, 60))).toEqual([0, 0, 0]);
  });
});

describe("pickerKeyIntent", () => {
  const key = (k: string, over: Partial<PickerKey> = {}): PickerKey => ({ key: k, ...over });

  it("closes on Escape wherever the focus is", () => {
    for (const zone of ["tile", "chip", "other"] as const) {
      expect(pickerKeyIntent(key("Escape"), zone, true)).toBe("close");
    }
  });

  it("selects all with Cmd+A on a Mac and Ctrl+A elsewhere, and not the other way", () => {
    expect(pickerKeyIntent(key("a", { metaKey: true }), "tile", true)).toBe("selectAll");
    expect(pickerKeyIntent(key("a", { ctrlKey: true }), "tile", false)).toBe("selectAll");
    expect(pickerKeyIntent(key("a", { ctrlKey: true }), "tile", true)).toBe("none");
    expect(pickerKeyIntent(key("a", { metaKey: true }), "tile", false)).toBe("none");
  });

  // Enter on a tile is the browser's click, which is the toggle.
  it("leaves Enter on a tile to the button, and starts from anywhere else", () => {
    expect(pickerKeyIntent(key("Enter"), "tile", true)).toBe("none");
    expect(pickerKeyIntent(key("Enter"), "chip", true)).toBe("start");
    expect(pickerKeyIntent(key("Enter"), "other", true)).toBe("start");
    expect(pickerKeyIntent(key("Enter", { metaKey: true }), "tile", true)).toBe("start");
  });

  it("moves the focus along the tray, and carries the chip with Option or Cmd", () => {
    expect(pickerKeyIntent(key("ArrowLeft"), "chip", true)).toBe("focusPrev");
    expect(pickerKeyIntent(key("ArrowRight"), "chip", true)).toBe("focusNext");
    expect(pickerKeyIntent(key("ArrowLeft", { altKey: true }), "chip", true)).toBe("moveBack");
    expect(pickerKeyIntent(key("ArrowRight", { altKey: true }), "chip", false)).toBe(
      "moveForward",
    );
    expect(pickerKeyIntent(key("ArrowRight", { metaKey: true }), "chip", true)).toBe(
      "moveForward",
    );
    expect(pickerKeyIntent(key("Home"), "chip", true)).toBe("focusFirst");
    expect(pickerKeyIntent(key("End"), "chip", true)).toBe("focusLast");
  });

  // AltGr is Ctrl+Alt on many layouts; it carries nothing.
  it("does not read Ctrl+Alt as Option on Windows", () => {
    expect(
      pickerKeyIntent(key("ArrowLeft", { altKey: true, ctrlKey: true }), "chip", false),
    ).toBe("focusPrev");
  });

  it("removes a chip with Backspace or Delete, and never a tile", () => {
    expect(pickerKeyIntent(key("Backspace"), "chip", true)).toBe("remove");
    expect(pickerKeyIntent(key("Delete"), "chip", true)).toBe("remove");
    expect(pickerKeyIntent(key("Backspace"), "tile", true)).toBe("none");
  });

  it("moves along the grid with the arrows", () => {
    expect(pickerKeyIntent(key("ArrowLeft"), "tile", true)).toBe("focusPrev");
    expect(pickerKeyIntent(key("ArrowRight"), "tile", true)).toBe("focusNext");
    expect(pickerKeyIntent(key("ArrowRight"), "other", true)).toBe("none");
  });

  it("leaves every key to an IME that is composing", () => {
    expect(pickerKeyIntent(key("Enter", { isComposing: true }), "other", true)).toBe("none");
    expect(pickerKeyIntent(key("Escape", { keyCode: 229 }), "chip", true)).toBe("none");
  });
});
