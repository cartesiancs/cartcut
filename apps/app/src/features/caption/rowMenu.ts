/**
 * The per-line menu in the auto-caption panel's transcript, and where it opens.
 *
 * The two actions used to be two icon buttons on every row, sitting beside the
 * text input and visible on all of them at once. With a merge button, a cut
 * button and a full-width input on every line, a row was tall enough that only
 * a handful fitted in the panel, and a transcript of any length cost more to
 * scroll than to read. They are one `more_vert` button now, and the menu is
 * what finally carries the words the two icons never had.
 *
 * Here rather than in the panel for the reason `silenceButton.ts` gives:
 * `apps/automatic-caption/` is outside every vitest include pattern, so a rule
 * written there is a rule nothing can assert about. The placement half is the
 * part that earns it. The transcript scrolls inside `overflow-y: auto`, so the
 * menu has to be `position: fixed` to escape the clip, and a fixed menu is
 * placed against the viewport rather than by the layout: get it wrong near the
 * bottom of the screen and the menu opens off-screen, which looks exactly like
 * a button that does nothing.
 */

export type CaptionRowAction = "merge" | "remove" | "restore";

export type CaptionRowMenuItem = {
  action: CaptionRowAction;
  /** A material-symbols ligature. */
  icon: string;
  /** The words the icons never had. Never empty. */
  label: string;
  /** The keystroke that does the same thing, if there is one. */
  hint?: string;
  disabled: boolean;
};

export type CaptionRowMenuInput = {
  /** The line's index in the transcript. */
  index: number;
  /** Whether the line is struck out, and its footage cut. */
  removed: boolean;
};

/**
 * What the menu offers for one line. Always two entries, one of them a toggle.
 *
 * Disabled rather than absent, both times. A menu whose entries move depending
 * on the row is a menu nobody can aim at, and the first line's missing Merge
 * would silently shift Delete up under the pointer.
 */
export function captionRowMenu(
  input: CaptionRowMenuInput,
): CaptionRowMenuItem[] {
  return [
    {
      action: "merge",
      icon: "merge",
      label: "Merge into the line above",
      // Its own field rather than part of the label, so the menu can set it
      // apart and stay narrow: the panel is a docked window a few hundred
      // pixels wide, and a menu wider than its host reads as a misplacement.
      hint: "Backspace",
      // The first line has nothing above it. A struck-out line is refused for a
      // different reason: merging it would fold text that is cut out of the
      // video into a line that is not.
      disabled: input.index === 0 || input.removed,
    },
    input.removed
      ? {
          action: "restore",
          icon: "undo",
          label: "Keep this line, and its footage",
          disabled: false,
        }
      : {
          action: "remove",
          icon: "content_cut",
          label: "Delete this line, and cut its footage",
          disabled: false,
        },
  ];
}

/** A `DOMRect`, in viewport pixels, with nothing of the DOM in the type. */
export type MenuAnchor = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type MenuSize = { width: number; height: number };
export type MenuViewport = { width: number; height: number };
export type MenuPoint = { x: number; y: number };

/** Between the button and the menu, so the two do not read as one box. */
const GAP = 4;

/** The closest the menu comes to an edge of the viewport. */
const MARGIN = 8;

/**
 * Where to put the menu, in viewport pixels, for `position: fixed`.
 *
 * Below the button and left-aligned with it by default; above when below would
 * run off the bottom, which is the common case, because the row whose menu is
 * hardest to reach is the one at the end of a scrolled transcript.
 *
 * Clamped rather than flipped when neither side has room: a menu overlapping
 * its own button is usable, and one whose first entry is above the top of the
 * screen is not.
 */
export function rowMenuPlacement(
  anchor: MenuAnchor,
  menu: MenuSize,
  viewport: MenuViewport,
): MenuPoint {
  const below = anchor.y + anchor.height + GAP;
  const above = anchor.y - GAP - menu.height;
  const lowest = viewport.height - MARGIN - menu.height;

  // Preferred, then clamped into the band that is actually on screen. The
  // clamp is not redundant with the flip: `above` runs off the top whenever the
  // menu is taller than the room above the button, and both run off when the
  // viewport is shorter than the menu.
  const preferred = below <= lowest ? below : above;
  const y = Math.min(Math.max(preferred, MARGIN), Math.max(MARGIN, lowest));

  // `Math.max` last, so a menu wider than the viewport starts at the left edge
  // rather than at a negative x.
  const rightmost = viewport.width - MARGIN - menu.width;
  const x = Math.max(MARGIN, Math.min(anchor.x, rightmost));

  return { x, y };
}
