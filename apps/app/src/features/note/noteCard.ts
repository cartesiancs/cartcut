/**
 * The card a timeline note opens into: its time, its text, and a way to keep
 * or delete it.
 *
 * One card for the whole app, hung where the pointer was when the note opened.
 * It edits a local draft and writes the store once, when it closes, so typing
 * costs no store writes and Escape has nothing to undo.
 *
 * Enter, the send button and a press anywhere outside keep the draft; Escape
 * drops it. A note that was never kept is removed when its card closes empty,
 * so opening one and walking away leaves no pin behind.
 */

import { LitElement, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";

import { noteStore, type OpenNote } from "../../states/noteStore";
import { renderOptionStore } from "../../states/renderOptionStore";
import { applyMenuPlacement } from "../menu/menuPlacement";
import { formatTimecode } from "../timeline/timecode";

/** How far the card sits from the pointer that opened it. */
const CARD_OFFSET_X = 24;
const CARD_OFFSET_Y = -10;

@customElement("timeline-note-card")
export class TimelineNoteCard extends LitElement {
  @state()
  private open: OpenNote | null = null;

  @state()
  private draft = "";

  /** The open the card was last placed and focused for. */
  private placedFor: OpenNote | null = null;

  createRenderRoot() {
    noteStore.subscribe((state) => {
      if (state.open === this.open) {
        return;
      }
      this.open = state.open;
      this.draft =
        state.open == null
          ? ""
          : (state.notes.find((note) => note.id === state.open!.id)?.text ?? "");
    });
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    // Capture, so the card is kept and closed before the press reaches the
    // timeline: a press on another pin then opens that one instead of being
    // undone by this card closing after it.
    window.addEventListener("mousedown", this.onWindowMouseDown, true);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("mousedown", this.onWindowMouseDown, true);
  }

  private onWindowMouseDown = (event: MouseEvent) => {
    if (this.open == null) {
      return;
    }
    const target = event.target;
    if (target instanceof Element && target.closest(".note-card") != null) {
      return;
    }
    this.keep();
  };

  private keep = () => {
    if (this.open == null) {
      return;
    }
    const notes = noteStore.getState();
    notes.setText(this.open.id, this.draft);
    notes.close();
  };

  private discard = () => {
    if (this.open == null) {
      return;
    }
    const notes = noteStore.getState();
    const note = notes.notes.find((each) => each.id === this.open!.id);
    if (note != null && note.text === "") {
      notes.remove(note.id);
    } else {
      notes.close();
    }
  };

  private delete = () => {
    if (this.open != null) {
      noteStore.getState().remove(this.open.id);
    }
  };

  private onInput = (event: Event) => {
    this.draft = (event.target as HTMLTextAreaElement).value;
  };

  private onKeyDown = (event: KeyboardEvent) => {
    // Enter while an IME is composing picks a candidate, as in Korean or
    // Japanese input; keeping the note there would cut the word in half.
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      event.stopPropagation();
      this.keep();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.discard();
    }
  };

  /**
   * Placed after Lit has rendered it, on a card that starts
   * `visibility: hidden`, for the reason `exportButton#updated` gives.
   */
  updated() {
    const open = this.open;
    if (open == null) {
      this.placedFor = null;
      return;
    }
    if (open === this.placedFor) {
      return;
    }
    const card = this.querySelector(".note-card") as HTMLElement | null;
    if (card == null) {
      return;
    }
    applyMenuPlacement(card, {
      x: open.x + CARD_OFFSET_X,
      y: open.y + CARD_OFFSET_Y,
    });
    card.style.visibility = "visible";
    this.placedFor = open;

    const input = card.querySelector("textarea");
    if (input != null) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }

  render() {
    const open = this.open;
    if (open == null) {
      return nothing;
    }
    const note = noteStore
      .getState()
      .notes.find((each) => each.id === open.id);
    if (note == null) {
      return nothing;
    }
    const time = formatTimecode(
      note.atMs,
      renderOptionStore.getState().options.fps,
    );

    return html`
      <div
        class="note-card"
        role="dialog"
        aria-label="Note"
        data-keeps-selection
        style="position: fixed; top: 0px; left: 0px; z-index: 6000; visibility: hidden;"
      >
        <div class="note-card-head">
          <span class="note-card-time">${time}</span>
          ${note.text === ""
            ? nothing
            : html`<button
                type="button"
                class="opt-icon-btn"
                title="Delete note"
                @click=${this.delete}
              >
                <span class="material-symbols-outlined">delete</span>
              </button>`}
        </div>
        <div class="note-card-field">
          <textarea
            class="opt-textarea note-card-input"
            rows="1"
            placeholder="Add a note"
            .value=${this.draft}
            @input=${this.onInput}
            @keydown=${this.onKeyDown}
          ></textarea>
          <button
            type="button"
            class="note-card-send"
            title="Save"
            ?disabled=${this.draft.trim() === ""}
            @click=${this.keep}
          >
            <span class="material-symbols-outlined">arrow_upward</span>
          </button>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "timeline-note-card": TimelineNoteCard;
  }
}
