/**
 * The edit toolbar above the timeline.
 *
 * It replaced the "Ask me anything" box, which sat in the most valuable strip
 * of space in the window driving a command parser that only ever implemented
 * `ADD TEXT`. What goes there now is the set of things people actually reach
 * for mid-edit — and, for most of them, the *only* way to reach them with a
 * mouse: split, copy, paste and cut were keyboard-only, detach-audio was buried
 * in a right-click menu, and undo/redo had no button at all.
 *
 * Every button calls `features/editor/actions`, which is also what the
 * keyboard handler in `elementTimelineCanvas` calls. This component contributes
 * no editing logic of its own; it decides what to draw and what to grey out,
 * and nothing else.
 *
 * The disabled states come from `capabilities()`, recomputed when the document
 * or the selection changes. They are a courtesy, not a safety net — the pure
 * ops still decline by identity, so a button that is wrongly enabled costs a
 * no-op rather than a bad edit.
 *
 * "Add track" is the one control here that opens a menu rather than acting on
 * the press, because a track has a kind and there is no sensible default: a
 * button that always made a video row would be wrong for the person who came
 * for an audio one, and five buttons would cost the row more space than the
 * rest of the toolbar. It is also the only control that needs no capability —
 * a row can be added to any document, including an empty one.
 */

import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { useTimelineStore } from "../../states/timelineStore";
import { selectionStore } from "../../states/selectionStore";
import { applyMenuPlacement } from "../menu/menuPlacement";
import type { TrackKind } from "../timeline/tracks";
import {
  TRACK_KINDS,
  TRACK_KIND_ICON,
  TRACK_KIND_LABEL,
} from "../timeline/trackKinds";
import {
  addTrack,
  capabilities,
  copySelection,
  cutSelection,
  deleteSelection,
  detachAudioFromSelection,
  mergeSelection,
  pasteFromClipboard,
  redo,
  rotateSelection,
  splitSelection,
  undo,
  type EditorCapabilities,
} from "./actions";
import { shortcutLabel, type ShortcutId } from "./shortcuts";

type ToolbarButton = {
  icon: string;
  label: string;
  /**
   * The registry entry whose binding to append to the tooltip. Rendered for
   * the platform there — ⌘ on macOS, Ctrl elsewhere — so this file no longer
   * spells the modifier itself.
   */
  shortcut?: ShortcutId;
  run: () => void;
  enabled: (caps: EditorCapabilities) => boolean;
};

function tooltip(spec: ToolbarButton): string {
  return spec.shortcut == null
    ? spec.label
    : `${spec.label} (${shortcutLabel(spec.shortcut)})`;
}

/**
 * The buttons, left to right.
 *
 * One flat list on one even rhythm. An earlier version grouped these with
 * vertical rules, which bought nothing — ten icons is short enough to scan
 * whole — and cost the row its regularity, since each rule carried its own
 * margin and left the gaps visibly unequal.
 */
const BUTTONS: ToolbarButton[] = [
  {
    icon: "undo",
    label: "Undo",
    shortcut: "undo",
    run: undo,
    enabled: (caps) => caps.canUndo,
  },
  {
    icon: "redo",
    label: "Redo",
    shortcut: "redo",
    run: redo,
    enabled: (caps) => caps.canRedo,
  },
  {
    // `content_cut` is the scissors, and clipboard-cut has the stronger claim
    // on it — so split and merge take the fork-and-join pair instead.
    icon: "call_split",
    label: "Split at playhead",
    shortcut: "split",
    run: splitSelection,
    enabled: (caps) => caps.canSplit,
  },
  {
    icon: "call_merge",
    label: "Merge clips",
    run: mergeSelection,
    enabled: (caps) => caps.canMerge,
  },
  {
    icon: "content_cut",
    label: "Cut",
    shortcut: "cut",
    run: cutSelection,
    enabled: (caps) => caps.canCut,
  },
  {
    icon: "content_copy",
    label: "Copy",
    shortcut: "copy",
    run: copySelection,
    enabled: (caps) => caps.canCopy,
  },
  {
    icon: "content_paste",
    label: "Paste",
    shortcut: "paste",
    run: pasteFromClipboard,
    enabled: (caps) => caps.canPaste,
  },
  {
    icon: "rotate_90_degrees_cw",
    label: "Rotate 90°",
    run: () => rotateSelection(90),
    enabled: (caps) => caps.canRotate,
  },
  {
    icon: "music_off",
    label: "Detach audio",
    run: detachAudioFromSelection,
    enabled: (caps) => caps.canDetachAudio,
  },
  {
    icon: "delete",
    label: "Delete",
    // No shortcut suffix: the handler binds both Delete and Backspace, and
    // "Delete (Delete)" is not a tooltip worth showing anyone.
    run: deleteSelection,
    enabled: (caps) => caps.canDelete,
  },
];

@customElement("timeline-toolbar")
export class TimelineToolbar extends LitElement {
  @property({ attribute: false })
  caps: EditorCapabilities = capabilities();

  /**
   * Where the open "Add track" menu hangs, or `null` when it is closed.
   *
   * The coordinates are captured from the button at click time and the menu is
   * positioned `fixed` against them, as the track header's `⋯` menu is: the
   * toolbar row scrolls horizontally and is only as tall as the play controls
   * beside it, so a menu nested in the row would be clipped on both axes.
   */
  @property({ attribute: false })
  trackMenu: { x: number; y: number } | null = null;

  private unsubscribeSelection?: () => void;
  private unsubscribeTimeline?: () => void;

  createRenderRoot() {
    // Every button here acts on the timeline selection, so pressing one must
    // not be treated as "the user clicked away". The canvas clears the
    // selection on any `mousedown` outside itself — which lands before the
    // click — and skips anything carrying this attribute.
    this.setAttribute("data-keeps-selection", "");

    this.unsubscribeSelection = selectionStore.subscribe(() => this.sync());

    this.unsubscribeTimeline = useTimelineStore.subscribe((state) => {
      // `canSplit` depends on the playhead, and during playback the playhead
      // moves every frame — so without this guard the whole toolbar would
      // recompute and re-render at 60fps for the length of a preview. The
      // buttons are frozen while playing, which is the right trade: nobody
      // reaches for "split" without first stopping to find the frame.
      if (state.control.isPlay) {
        return;
      }
      this.sync();
    });

    window.addEventListener("mousedown", this._handleDocumentMouseDown);
    window.addEventListener("keydown", this._handleMenuKeydown);

    return this;
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.unsubscribeSelection?.();
    this.unsubscribeTimeline?.();
    window.removeEventListener("mousedown", this._handleDocumentMouseDown);
    window.removeEventListener("keydown", this._handleMenuKeydown);
  }

  private sync() {
    this.caps = capabilities();
  }

  // -------------------------------------------------------- the track menu

  /**
   * Any press that is not on the menu or its button dismisses it.
   *
   * The menu has to be in that exemption and not only the button: a press
   * inside it would otherwise close the menu on `mousedown`, and Lit would then
   * have removed the item before the `click` that was meant to choose a kind
   * could reach it. `.add-track-menu` is a second class rather than a
   * descendant check because the menu is drawn outside the toolbar row.
   */
  private _handleDocumentMouseDown = (e: MouseEvent) => {
    if (this.trackMenu == null) {
      return;
    }
    const target = e.target as HTMLElement | null;
    if (target?.closest(".add-track, .add-track-menu") != null) {
      return;
    }
    this.closeTrackMenu();
  };

  private _handleMenuKeydown = (e: KeyboardEvent) => {
    // Escape only closes what is open, so the timeline's own handler keeps
    // every key it already owns: this listener is a no-op unless the menu is
    // showing, and it never stops the event.
    if (e.key === "Escape") {
      this.closeTrackMenu();
    }
  };

  private closeTrackMenu() {
    if (this.trackMenu != null) {
      this.trackMenu = null;
    }
  }

  private toggleTrackMenu(e: MouseEvent) {
    // The window-level dismisser sees this press too; without stopping it the
    // menu would close in the same gesture that opened it.
    e.stopPropagation();

    if (this.trackMenu != null) {
      this.closeTrackMenu();
      return;
    }

    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    this.trackMenu = { x: rect.left, y: rect.bottom + 2 };
  }

  private addTrackOfKind(kind: TrackKind) {
    this.closeTrackMenu();
    addTrack(kind);
  }

  /**
   * Place the open menu once Lit has rendered it.
   *
   * Runs on every update because the template re-emits the placeholder `top`
   * and `left` each time, so the measured values have to be written back after
   * each render — and only while a menu is open, which is one forced layout on
   * a five-item list.
   */
  protected updated() {
    const open = this.trackMenu;
    if (open == null) {
      return;
    }
    const menu = this.querySelector("ul.add-track-menu") as HTMLElement | null;
    if (menu == null) {
      return;
    }
    applyMenuPlacement(menu, open);
    menu.style.visibility = "visible";
  }

  private button(spec: ToolbarButton) {
    const enabled = spec.enabled(this.caps);
    // The tooltip carries the shortcut; the accessible name stays the bare
    // action, so a screen reader announces "Split at playhead" rather than
    // spelling out a key combination after every button.
    return html`
      <button
        class="btn btn-xs2 btn-transparent timeline-toolbar-button"
        title=${tooltip(spec)}
        aria-label=${spec.label}
        ?disabled=${!enabled}
        @click=${spec.run}
      >
        <span
          class="material-symbols-outlined icon-sm ${
            enabled ? "icon-white" : "text-secondary"
          }"
          >${spec.icon}</span
        >
      </button>
    `;
  }

  /**
   * The "Add track" trigger and its menu.
   *
   * Drawn with the same square box and the same gap as the rest of the row,
   * and not fenced off with a rule even though it is the one control that acts
   * on the document rather than on the selection — the rule that used to group
   * these buttons is gone for the reason `BUTTONS` gives, and re-introducing
   * one for a single icon would cost the whole row its rhythm to make a
   * distinction the user does not have to think about.
   */
  private addTrackControl() {
    const open = this.trackMenu != null;
    return html`
      <button
        class="btn btn-xs2 btn-transparent timeline-toolbar-button add-track"
        title="Add track"
        aria-label="Add track"
        aria-haspopup="menu"
        aria-expanded=${open}
        @click=${(e: MouseEvent) => this.toggleTrackMenu(e)}
      >
        <span class="material-symbols-outlined icon-sm icon-white"
          >playlist_add</span
        >
      </button>
    `;
  }

  /**
   * The menu itself, drawn outside the scrolling row.
   *
   * Positioned imperatively in `updated()`, not here: `left` and `top` depend
   * on the menu's measured size, which does not exist until this template has
   * rendered. It starts hidden for the same reason — a menu placed after the
   * fact would otherwise be visible at the wrong coordinates for one frame.
   */
  private renderTrackMenu() {
    if (this.trackMenu == null) {
      return null;
    }

    return html`
      <ul
        class="dropdown-menu show add-track-menu"
        role="menu"
        style="position: fixed; top: 0px; left: 0px; z-index: 6000;
               visibility: hidden;"
      >
        ${TRACK_KINDS.map(
          (kind) => html`
            <li>
              <button
                class="dropdown-item dropdown-item-sm dropdown-item-icon"
                role="menuitem"
                @click=${() => this.addTrackOfKind(kind)}
              >
                <span class="material-symbols-outlined icon-xs"
                  >${TRACK_KIND_ICON[kind]}</span
                >
                ${TRACK_KIND_LABEL[kind]}
              </button>
            </li>
          `,
        )}
      </ul>
    `;
  }

  render() {
    return html`
      <style>
        .timeline-toolbar {
          display: flex;
          flex-direction: row;
          align-items: center;
          gap: 0.75rem;
          /* The ruler below is positioned at a hard-coded top of 40px, so this
             row must not grow taller than the play controls beside it. */
          height: 100%;
          min-width: 0;
          flex-wrap: nowrap;
          overflow-x: auto;
          scrollbar-width: none;
        }

        .timeline-toolbar::-webkit-scrollbar {
          display: none;
        }

        /* Fixed square boxes, not shrink-to-fit ones.
           Material Symbols glyphs do not share an advance width — the trash can
           is visibly narrower than the paste clipboard — so buttons sized to
           their content leave even a constant gap looking irregular, because
           what the eye measures is the space between the *marks*, not between
           the boxes. Giving every button the same width and centring the glyph
           inside it puts the icons on a real grid. */
        .timeline-toolbar-button {
          border: none;
          flex: 0 0 auto;
          width: 1.6rem;
          height: 1.6rem;
          padding: 0;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .timeline-toolbar-button span {
          line-height: 1;
        }

        .timeline-toolbar-button:disabled {
          /* Bootstrap dims disabled buttons and then keeps the pointer cursor,
             which reads as "broken" rather than "not available yet". */
          opacity: 0.45;
          cursor: default;
        }

        /* The trigger stays lit while its menu is open, so the row says which
           button the thing hanging under it came from. */
        .timeline-toolbar-button.add-track[aria-expanded="true"] {
          background-color: #2b2f36;
          border-radius: 4px;
        }

        /* Layout and icon colour come from .dropdown-item-icon in
           _dropdown.scss, shared with the track header's ⋯ menu. What is left
           here is only what makes a button look like the anchor that Bootstrap
           styles. */
        ul.add-track-menu .dropdown-item {
          width: 100%;
          background: none;
          border: 0;
        }
      </style>

      <div class="timeline-toolbar">
        ${BUTTONS.map((spec) => this.button(spec))} ${this.addTrackControl()}
      </div>
      ${this.renderTrackMenu()}
    `;
  }
}
