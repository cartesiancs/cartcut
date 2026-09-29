/**
 * Show Info: what a video, photo, GIF or sound file is, in a dark dialog.
 *
 * A dark overlay of its own rather than a Bootstrap modal, for the reason
 * `features/subtitle/importDialog.ts` gives: the vendored Bootstrap is 5.0.2,
 * which has no `data-bs-theme`, and `devent-designsystem.css` styles
 * `.modal-content` light, so a Bootstrap dialog comes up white over a dark
 * editor. The shell and its colours are that dialog's.
 *
 * **Every decision is in `mediaInfoView.ts`**, and every edge (the probe, the
 * clipboard, Reveal) is behind `mediaInfoSession.ts`'s port. This file paints
 * an `InfoView` and routes three buttons.
 *
 * House rules it keeps, each for the reason importDialog states: light DOM,
 * every handler an arrow property, no backticks inside the style block, no
 * `header` element. And no `.btn`: both stylesheets declare its padding
 * `!important`, which breaks a small button (processDialog, the same).
 */

import { LitElement, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import {
  PENDING,
  buildInfoView,
  infoAsText,
  revealLabel,
  type InfoKind,
  type InfoRow,
  type InfoSection,
  type InfoTarget,
  type InfoView,
} from "./mediaInfoView";
import {
  electronMediaInfoPort,
  loadMediaInfo,
  type MediaInfoPort,
} from "./mediaInfoSession";

const ICONS: Record<InfoKind, string> = {
  video: "movie",
  image: "image",
  gif: "gif_box",
  audio: "music_note",
};

/** How long a Copy button says "Copied" before going back to its label. */
const COPIED_MS = 1_500;

@customElement("media-info-dialog")
export class MediaInfoDialog extends LitElement {
  @state() private view: InfoView | null = null;
  @state() private copied: "path" | "all" | null = null;

  private target: InfoTarget | null = null;
  /**
   * Bumped by every open and close. A probe answers seconds later for a slow
   * disk, and without this the answer for the previous file would overwrite
   * the dialog now showing another.
   */
  private generation = 0;
  private returnFocus: HTMLElement | null = null;
  private copiedTimer = 0;
  private readonly port: MediaInfoPort = electronMediaInfoPort();
  private readonly revealText = revealLabel(navigator.userAgent);

  createRenderRoot() {
    return this;
  }

  /** Open on `target`. A second call replaces what is showing. */
  open(target: InfoTarget): void {
    if (this.view == null) {
      this.returnFocus =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      window.addEventListener("keydown", this.onKeydown, true);
    }

    const generation = ++this.generation;
    this.target = target;
    this.copied = null;
    this.view = buildInfoView(target, null);

    void loadMediaInfo(this.port, target).then((loaded) => {
      if (generation === this.generation) {
        this.view = buildInfoView(target, loaded);
      }
    });
    void this.updateComplete.then(() => {
      this.querySelector<HTMLElement>(".media-info-close")?.focus();
    });
  }

  disconnectedCallback(): void {
    this.close();
    super.disconnectedCallback();
  }

  private close(): void {
    if (this.view == null) {
      return;
    }
    this.generation++;
    window.removeEventListener("keydown", this.onKeydown, true);
    window.clearTimeout(this.copiedTimer);
    this.view = null;
    this.target = null;
    this.copied = null;

    const focus = this.returnFocus;
    this.returnFocus = null;
    focus?.focus();
  }

  /**
   * Capture phase on `window`, ahead of the timeline's own handler. Escape
   * closes. Every other key stops here: behind the dialog, Delete would remove
   * the clip being inspected and Space would start playback. Default actions
   * are left alone, so Enter still presses the focused button and Tab still
   * moves between them.
   */
  private onKeydown = (event: KeyboardEvent): void => {
    if (this.view == null) {
      return;
    }
    event.stopImmediatePropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      this.close();
    }
  };

  private onScrimDown = (event: PointerEvent): void => {
    // Only a press that starts on the scrim itself. A drag that selects a path
    // inside the card and is released over the scrim must not close it.
    if (event.target === event.currentTarget) {
      this.close();
    }
  };

  private onClose = (): void => {
    this.close();
  };

  private onReveal = (): void => {
    if (this.target != null) {
      this.port.reveal(this.target.fsPath);
    }
  };

  private onCopyPath = (): void => {
    if (this.target != null) {
      this.copy(this.target.fsPath, "path");
    }
  };

  private onCopyAll = (): void => {
    if (this.view != null) {
      this.copy(infoAsText(this.view), "all");
    }
  };

  private copy(text: string, which: "path" | "all"): void {
    const generation = this.generation;
    this.port.copy(text).then(
      () => {
        if (generation !== this.generation) {
          return;
        }
        window.clearTimeout(this.copiedTimer);
        this.copied = which;
        this.copiedTimer = window.setTimeout(() => {
          this.copied = null;
        }, COPIED_MS);
      },
      // A refused clipboard leaves the label as it was; the path is still
      // on screen and selectable.
      () => {},
    );
  }

  private renderRows(rows: InfoRow[]) {
    return rows.map(
      ({ label, value }) => html`
        <span class="media-info-label">${label}</span>
        <span class=${value === PENDING ? "media-info-value is-pending" : "media-info-value"}
          >${value}</span
        >
      `,
    );
  }

  private renderSection(section: InfoSection) {
    return html`
      <div class="media-info-section">
        <div class="media-info-section-title">${section.title}</div>
        <div class="media-info-rows">${this.renderRows(section.rows)}</div>
      </div>
    `;
  }

  private renderLocation(view: InfoView) {
    return html`
      <span class="media-info-label">Location</span>
      <div class="media-info-location">
        <span class="media-info-path">${view.location}</span>
        <div class="media-info-actions">
          <button type="button" class="media-info-action" @click=${this.onCopyPath}>
            <span class="material-symbols-outlined" aria-hidden="true">content_copy</span>
            <span>${this.copied === "path" ? "Copied" : "Copy path"}</span>
          </button>
          ${view.canReveal
            ? html`
                <button type="button" class="media-info-action" @click=${this.onReveal}>
                  <span class="material-symbols-outlined" aria-hidden="true">folder_open</span>
                  <span>${this.revealText}</span>
                </button>
              `
            : nothing}
        </div>
        ${view.reversedCopy != null
          ? html`
              <span class="media-info-note">
                This clip plays a reversed copy:
                <span class="media-info-path">${view.reversedCopy}</span>
              </span>
            `
          : nothing}
      </div>
    `;
  }

  render() {
    const view = this.view;
    if (view == null) {
      return nothing;
    }

    return html`
      <style>
        .media-info-scrim {
          position: fixed;
          inset: 0;
          z-index: 8600;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 1rem;
          background: rgba(0, 0, 0, 0.72);
          animation: media-info-fade 140ms ease-out;
        }

        .media-info {
          display: flex;
          flex-direction: column;
          width: min(32rem, 92vw);
          max-height: min(82vh, 40rem);
          background: #19181a;
          color: #ffffff;
          border: 1px solid #26262b;
          border-radius: 12px;
          box-shadow: 0 1.5rem 3rem rgba(0, 0, 0, 0.55);
          overflow: hidden;
          animation: media-info-rise 140ms ease-out;
        }

        @keyframes media-info-fade {
          from { opacity: 0; }
          to { opacity: 1; }
        }

        @keyframes media-info-rise {
          from { opacity: 0; transform: scale(0.98); }
          to { opacity: 1; transform: none; }
        }

        .media-info .material-symbols-outlined {
          font-size: 1.1rem;
          line-height: 1;
        }

        .media-info-head {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          padding: 0.6rem 0.6rem 0.6rem 0.9rem;
          border-bottom: 1px solid #26262b;
          user-select: none;
        }

        .media-info-name {
          min-width: 0;
          font-weight: 600;
          font-size: 0.9rem;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .media-info-kind {
          margin-left: auto;
          flex: 0 0 auto;
          padding: 0.1rem 0.45rem;
          border-radius: 999px;
          background: #26262b;
          color: #c9c9d1;
          font-size: 0.7rem;
          letter-spacing: 0.04em;
          text-transform: uppercase;
        }

        .media-info-close {
          appearance: none;
          flex: 0 0 auto;
          display: flex;
          align-items: center;
          justify-content: center;
          width: 1.75rem;
          height: 1.75rem;
          padding: 0;
          border: 0;
          border-radius: 6px;
          background: transparent;
          color: #8a8a94;
          cursor: pointer;
        }

        .media-info-close:hover {
          background: #232329;
          color: #ffffff;
        }

        .media-info-body {
          flex: 1 1 auto;
          min-height: 0;
          overflow-y: auto;
          padding: 0.3rem 0.9rem 0.9rem;
        }

        .media-info-section {
          padding-top: 0.75rem;
        }

        .media-info-section-title {
          margin-bottom: 0.4rem;
          color: #8a8a94;
          font-size: 0.68rem;
          font-weight: 600;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          user-select: none;
        }

        .media-info-rows {
          display: grid;
          grid-template-columns: 7.5rem minmax(0, 1fr);
          gap: 0.35rem 0.9rem;
          align-items: baseline;
          font-size: 0.78rem;
        }

        .media-info-label {
          color: #8a8a94;
          user-select: none;
        }

        .media-info-value {
          color: #e8e8ec;
          font-variant-numeric: tabular-nums;
          overflow-wrap: anywhere;
          user-select: text;
        }

        .media-info-value.is-pending {
          color: #5a5a62;
        }

        .media-info-location {
          display: flex;
          flex-direction: column;
          align-items: flex-start;
          gap: 0.4rem;
          min-width: 0;
        }

        .media-info-path {
          color: #e8e8ec;
          font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
          font-size: 0.74rem;
          overflow-wrap: anywhere;
          user-select: text;
        }

        .media-info-note {
          color: #8a8a94;
          font-size: 0.72rem;
          overflow-wrap: anywhere;
        }

        .media-info-note .media-info-path {
          color: #8a8a94;
        }

        .media-info-actions {
          display: flex;
          flex-wrap: wrap;
          gap: 0.35rem;
        }

        .media-info-action {
          appearance: none;
          display: inline-flex;
          align-items: center;
          gap: 0.3rem;
          background: transparent;
          border: 1px solid #2a3036;
          border-radius: 7px;
          color: #c3c9cf;
          font-size: 0.75rem;
          padding: 0.22rem 0.6rem;
          cursor: pointer;
          transition: background 140ms ease-out, color 140ms ease-out;
        }

        .media-info-action:hover:not(:disabled) {
          background: #2a3036;
          color: #f1f3f5;
        }

        .media-info-action:disabled {
          opacity: 0.4;
          cursor: default;
        }

        .media-info .media-info-action .material-symbols-outlined {
          font-size: 0.95rem;
        }

        .media-info-action:focus-visible,
        .media-info-close:focus-visible {
          outline: 2px solid #3d7eff;
          outline-offset: 1px;
        }

        .media-info-failure {
          display: flex;
          align-items: flex-start;
          gap: 0.5rem;
          margin-top: 0.8rem;
          padding: 0.55rem 0.7rem;
          border: 1px solid #4a2a2e;
          border-radius: 8px;
          background: #2a1a1c;
          color: #f0b8bd;
          font-size: 0.78rem;
        }

        .media-info-foot {
          display: flex;
          align-items: center;
          gap: 0.4rem;
          padding: 0.6rem 0.9rem;
          border-top: 1px solid #26262b;
        }

        .media-info-foot .media-info-done {
          margin-left: auto;
        }

        @media (prefers-reduced-motion: reduce) {
          .media-info-scrim,
          .media-info,
          .media-info-action {
            animation-duration: 1ms;
            transition-duration: 1ms;
          }
        }
      </style>

      <div
        class="media-info-scrim"
        role="presentation"
        data-keeps-selection
        @pointerdown=${this.onScrimDown}
      >
        <div
          class="media-info"
          role="dialog"
          aria-modal="true"
          aria-labelledby="media-info-title"
        >
          <div class="media-info-head">
            <span class="material-symbols-outlined" aria-hidden="true">${ICONS[view.kind]}</span>
            <span class="media-info-name" id="media-info-title" title=${view.title}
              >${view.title}</span
            >
            <span class="media-info-kind">${view.kindLabel}</span>
            <button
              type="button"
              class="media-info-close"
              aria-label="Close"
              @click=${this.onClose}
            >
              <span class="material-symbols-outlined" aria-hidden="true">close</span>
            </button>
          </div>

          <div class="media-info-body">
            <div class="media-info-section">
              <div class="media-info-section-title">General</div>
              <div class="media-info-rows">
                ${this.renderRows(view.general)} ${this.renderLocation(view)}
              </div>
            </div>

            ${view.failure != null
              ? html`
                  <div class="media-info-failure" role="alert">
                    <span class="material-symbols-outlined" aria-hidden="true">error</span>
                    <span>${view.failure}</span>
                  </div>
                `
              : nothing}
            ${view.sections.map((section) => this.renderSection(section))}
          </div>

          <div class="media-info-foot">
            <button
              type="button"
              class="media-info-action"
              ?disabled=${view.status === "loading"}
              @click=${this.onCopyAll}
            >
              <span class="material-symbols-outlined" aria-hidden="true">content_copy</span>
              <span>${this.copied === "all" ? "Copied" : "Copy all"}</span>
            </button>
            <button type="button" class="media-info-action media-info-done" @click=${this.onClose}>
              Close
            </button>
          </div>
        </div>
      </div>
    `;
  }
}
