/**
 * The auto-caption panel's two menus, and where either of them opens.
 *
 * Both replaced rows of always-visible buttons, and for the same reason. Every
 * line carried a merge button and a cut button beside its text input, which
 * made a row tall enough that a transcript of any length cost more to scroll
 * than to read; the two placement buttons sat in a bar of their own under the
 * transcript, spending a strip of a docked panel on a choice made once. They
 * are two icon buttons now, and the menus carry the words the icons never had.
 *
 * Here rather than in the panel for the reason `silenceButton.ts` gives:
 * `apps/automatic-caption/` is outside every vitest include pattern, so a rule
 * written there is a rule nothing can assert about. `menuPlacement` is the part
 * that earns it most. The transcript scrolls inside `overflow-y: auto`, so a
 * menu has to be `position: fixed` to escape the clip, and a fixed menu is
 * placed against the viewport rather than by the layout: get it wrong near the
 * bottom of the screen and the menu opens off-screen, which looks exactly like
 * a button that does nothing.
 */

import type { CaptionPlacement } from "./layout";

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
  /**
   * Whether the line is the first of its clip. The line above belongs to
   * another file, and `lines.ts#mergeLineWithPrevious` refuses that merge.
   */
  startsClip?: boolean;
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
      // The first line of a clip is refused for a third: the line above it was
      // spoken in another file, on another clock.
      disabled: input.index === 0 || input.removed || input.startsClip === true,
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
 * Where to put a menu, in viewport pixels, for `position: fixed`.
 *
 * Below the button and left-aligned with it by default; above when below would
 * run off the bottom. That is not the rare case: the line menu's trigger sits
 * at the end of a scrolled transcript and the footer's sits at the bottom of
 * the panel, so the flip is what the footer's menu does every time.
 *
 * Clamped rather than flipped when neither side has room: a menu overlapping
 * its own button is usable, and one whose first entry is above the top of the
 * screen is not.
 */
export function menuPlacement(
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

/**
 * Where the captions sit in the frame, as a menu entry each.
 *
 * It was two buttons in a sticky bar under the transcript, the current one
 * lit blue. A menu has no room for that trick, so the choice is carried by a
 * check on the entry and by the trigger's own glyph; `captionPlacementButton`
 * is the other half and the two have to agree, which is why they are here
 * together rather than one in a template.
 */
export type CaptionPlacementMenuItem = {
  placement: CaptionPlacement;
  /** A material-symbols ligature. */
  icon: string;
  label: string;
  /** Whether this is where the captions are now. Exactly one entry is. */
  selected: boolean;
};

/**
 * The glyph for each placement. The trigger and the menu read from one table.
 *
 * `align_vertical_*` and not `vertical_align_*`: the latter pair is the text
 * cursor's, and its bottom variant is an arrow onto a line, which at 17px in a
 * footer beside Apply reads as a download button. These two draw blocks resting
 * on a line and blocks centred on one, which is what the setting does.
 */
const PLACEMENT_ICON: Record<CaptionPlacement, string> = {
  center: "align_vertical_center",
  lowerThird: "align_vertical_bottom",
};

const PLACEMENT_LABEL: Record<CaptionPlacement, string> = {
  center: "Centre of the frame",
  lowerThird: "Lower third",
};

export function captionPlacementMenu(
  current: CaptionPlacement,
): CaptionPlacementMenuItem[] {
  // Order fixed, and not by which one is selected: an entry that moves under
  // the pointer between two openings is an entry nobody can aim at twice.
  return (["center", "lowerThird"] as const).map((placement) => ({
    placement,
    icon: PLACEMENT_ICON[placement],
    label: PLACEMENT_LABEL[placement],
    selected: placement === current,
  }));
}

/**
 * The footer button that opens that menu. Icon and tooltip, nothing else.
 *
 * The glyph is the *current* placement rather than a fixed one, because the
 * bar this replaced showed the answer without being asked: the selected button
 * was lit, and a stable icon would have made the panel stop saying where the
 * captions are. The tooltip says it in words, which for an icon-only button is
 * the only name it has.
 */
export function captionPlacementButton(current: CaptionPlacement): {
  icon: string;
  label: string;
} {
  return {
    icon: PLACEMENT_ICON[current],
    label: `Caption placement: ${PLACEMENT_LABEL[current].toLowerCase()}`,
  };
}
