/**
 * Opening, closing, focusing and re-placing a window.
 *
 * Pure transforms over the window list, and they **decline by returning their
 * input by identity** when they would change nothing. That is the convention
 * `withCheckpoint` rests on for the timeline and `applyCaptionEdit` rests on in
 * the caption panel, and here it buys the same thing one layer down: the store
 * compares before it writes, so a decline costs no subscriber notification and
 * no Lit re-render. It matters more than it looks, because the splitter's
 * `mousemove` runs at the display rate and `useTimelineStore` has no
 * `subscribeWithSelector` to soften a write that changed nothing.
 *
 * Host sizes are deliberately not in here. They are a *measurement* taken by a
 * `ResizeObserver`, not state anybody edits, and folding them in would mean
 * every op had to carry a field none of them reads.
 */

import type { DockSide, Rect, Size, WindowPlacement, WindowState } from "./windowLayout";

/** What a caller has to say to open a window. Everything else has a default. */
export type WindowSpec = {
  id: string;
  hostId: string;
  placement: WindowPlacement;
  minSize?: Size;
  resizable?: boolean;
  closable?: boolean;
};

const DEFAULT_MIN: Size = { width: 280, height: 200 };

const nextZ = (windows: WindowState[]): number =>
  windows.reduce((top, win) => Math.max(top, win.z), 0) + 1;

const samePlacement = (a: WindowPlacement, b: WindowPlacement): boolean => {
  if (a.mode !== b.mode) {
    return false;
  }
  if (a.mode === "docked" && b.mode === "docked") {
    return a.side === b.side && a.sizePct === b.sizePct;
  }
  if (a.mode === "floating" && b.mode === "floating") {
    return (
      a.rect.x === b.rect.x &&
      a.rect.y === b.rect.y &&
      a.rect.width === b.rect.width &&
      a.rect.height === b.rect.height
    );
  }
  return false;
};

/** Every window in one host, in the order they were opened. */
export function windowsOfHost(windows: WindowState[], hostId: string): WindowState[] {
  return windows.filter((win) => win.hostId === hostId);
}

export function findWindow(windows: WindowState[], id: string): WindowState | undefined {
  return windows.find((win) => win.id === id);
}

export function isOpen(windows: WindowState[], id: string): boolean {
  return windows.some((win) => win.id === id);
}

/**
 * Open a window, or focus the one already open under that id.
 *
 * The same rule `controlPanelStore.openPanel` states for its tabs: pressing a
 * button that shows you something is a "show me this", never a "make me
 * another". A second entry under one id would also break `layoutHost`, which
 * keys its output by id.
 */
export function openWindow(windows: WindowState[], spec: WindowSpec): WindowState[] {
  const existing = findWindow(windows, spec.id);
  if (existing != null) {
    return focusWindow(windows, spec.id);
  }

  return [
    ...windows,
    {
      id: spec.id,
      hostId: spec.hostId,
      placement: spec.placement,
      minSize: spec.minSize ?? DEFAULT_MIN,
      resizable: spec.resizable ?? true,
      closable: spec.closable ?? true,
      z: nextZ(windows),
    },
  ];
}

export function closeWindow(windows: WindowState[], id: string): WindowState[] {
  return isOpen(windows, id) ? windows.filter((win) => win.id !== id) : windows;
}

/**
 * Raise a window to the top of its host.
 *
 * Declines when it is already there, which is what stops a click on a focused
 * title bar from renumbering the whole list and re-laying out every sibling.
 * Focus is per host, not global: a window on top of the preview region says
 * nothing about one docked somewhere else.
 */
export function focusWindow(windows: WindowState[], id: string): WindowState[] {
  const target = findWindow(windows, id);
  if (target == null) {
    return windows;
  }

  const siblings = windowsOfHost(windows, target.hostId);
  const top = siblings.reduce((highest, win) => Math.max(highest, win.z), 0);
  if (target.z === top) {
    return windows;
  }

  return windows.map((win) =>
    win.id === id ? { ...win, z: nextZ(windows) } : win,
  );
}

export function setPlacement(
  windows: WindowState[],
  id: string,
  placement: WindowPlacement,
): WindowState[] {
  const target = findWindow(windows, id);
  if (target == null || samePlacement(target.placement, placement)) {
    return windows;
  }

  return windows.map((win) => (win.id === id ? { ...win, placement } : win));
}

/**
 * Dock a window to a side, keeping the share it had if it was already docked.
 *
 * A window moved from the right edge to the bottom keeps its percentage, which
 * is the behaviour that makes the two look like one window that turned rather
 * than one that was closed and another opened. `DEFAULT_DOCK_PCT` only applies
 * to a window arriving from floating, where there is no share to carry.
 */
export const DEFAULT_DOCK_PCT = 46;

export function dockWindow(
  windows: WindowState[],
  id: string,
  side: DockSide,
): WindowState[] {
  const target = findWindow(windows, id);
  if (target == null) {
    return windows;
  }

  const sizePct =
    target.placement.mode === "docked" ? target.placement.sizePct : DEFAULT_DOCK_PCT;

  return setPlacement(windows, id, { mode: "docked", side, sizePct });
}

export function floatWindow(windows: WindowState[], id: string, rect: Rect): WindowState[] {
  return setPlacement(windows, id, { mode: "floating", rect });
}
