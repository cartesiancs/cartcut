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
 */

import { LitElement, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { useTimelineStore } from "../../states/timelineStore";
import { selectionStore } from "../../states/selectionStore";
import {
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

    return this;
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.unsubscribeSelection?.();
    this.unsubscribeTimeline?.();
  }

  private sync() {
    this.caps = capabilities();
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
          class="material-symbols-outlined icon-sm ${enabled
            ? "icon-white"
            : "text-secondary"}"
          >${spec.icon}</span
        >
      </button>
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
      </style>

      <div class="timeline-toolbar">
        ${BUTTONS.map((spec) => this.button(spec))}
      </div>
    `;
  }
}
