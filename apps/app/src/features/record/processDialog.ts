/**
 * The dialog that shows while a finished recording is being processed.
 *
 * A dark overlay of its own rather than a Bootstrap modal, for the reason
 * `features/subtitle/importDialog.ts` and `apps/automatic-caption/src/clipPicker.ts`
 * both give: the vendored Bootstrap is 5.0.2, which has no `data-bs-theme`, and
 * `devent-designsystem.css` styles `.modal-content` light, so a Bootstrap dialog
 * comes up white over a dark editor.
 *
 * **Every decision is in `processPhase.ts`.** This file paints. There is no DOM test
 * environment in this repo, so a rule written in here is a rule nothing can check.
 *
 * Four house rules it has to keep:
 *
 * - `createRenderRoot` returns `this`. The global stylesheet does not cross a shadow
 *   boundary, and 70 of 70 components in this app do the same.
 * - Every handler is an **arrow property**. Lit binds a listener's `this` to the
 *   component whose template rendered it, so a method would bind to whatever host
 *   ends up rendering this.
 * - No backticks inside the style block: it sits in an html template literal and one
 *   would end it. And no `header` element: the design system gives every one a 30px
 *   top margin.
 * - **No `.btn`.** Both `style.scss` and `devent-designsystem.css` declare its
 *   padding `!important`, so a button built on it cannot be sized here.
 *
 * On blocking the editor at all: the export progress modal was deleted on purpose,
 * because "the modal's backdrop was the only thing stopping them" editing during a
 * render. This one is defensible on different facts: it lasts seconds rather than
 * minutes, and it ends by putting a clip and several hundred keyframes into the
 * document, which is not a good moment to also be dragging one. If it ever turns out
 * to sit there for a minute on a long take, `backgroundTaskStore` already has a row
 * component and is the right home instead.
 */

import { LitElement, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { recordProcessStore } from "../../states/recordProcessStore";
import { processView, type ProcessState } from "./processPhase";

@customElement("recording-process-dialog")
export class RecordingProcessDialog extends LitElement {
  @state() private phase: ProcessState = recordProcessStore.getState();

  private unsubscribe: (() => void) | null = null;

  createRenderRoot() {
    // Subscribing here rather than in `connectedCallback` matches
    // `features/export/exportButton.ts`: the store may already have moved by the
    // time a component mounts, and this runs before the first render either way.
    this.unsubscribe = recordProcessStore.subscribe((state) => {
      this.phase = { stage: state.stage, message: state.message };
    });
    return this;
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private onCancel = () => {
    recordProcessStore.getState().cancel();
  };

  private onDismiss = () => {
    recordProcessStore.getState().clear();
  };

  render() {
    const view = processView(this.phase);

    if (!view.open) {
      return nothing;
    }

    return html`
      <style>
        .record-process-scrim {
          position: fixed;
          inset: 0;
          /* Above the subtitle dialog's 8600, below toasts at 9000: a toast about
             the recording has to be readable over this. */
          z-index: 8700;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 1rem;
          background: rgba(0, 0, 0, 0.72);
          animation: record-process-fade 140ms ease-out;
        }
        .record-process {
          width: min(24rem, 92vw);
          background: #19181a;
          color: #fff;
          border: 1px solid #26262b;
          border-radius: 12px;
          box-shadow: 0 1.5rem 3rem rgba(0, 0, 0, 0.55);
          padding: 1.15rem 1.25rem 1.1rem;
          animation: record-process-rise 140ms ease-out;
        }
        @keyframes record-process-fade {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes record-process-rise {
          from { transform: scale(0.98); }
          to { transform: none; }
        }
        .record-process-title {
          font-size: 0.9rem;
          font-weight: 600;
          color: #f1f3f5;
          margin: 0 0 0.3rem;
        }
        .record-process-detail {
          font-size: 0.78rem;
          color: #7f878f;
          margin: 0 0 0.95rem;
          min-height: 1.1rem;
        }
        .record-process-track {
          height: 4px;
          border-radius: 2px;
          background: #2c3035;
          overflow: hidden;
        }
        .record-process-bar {
          height: 100%;
          background: #3d7eff;
          border-radius: 2px;
          transition: width 140ms ease-out;
        }
        .record-process-bar.is-waiting {
          width: 35%;
          animation: record-process-slide 1.1s ease-in-out infinite;
        }
        @keyframes record-process-slide {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(340%); }
        }
        .record-process-foot {
          display: flex;
          justify-content: flex-end;
          margin-top: 0.95rem;
          /* Tall enough to hold a button whether or not there is one. The stages
             advance in front of the user, and two of the five carry an action; a
             foot that collapsed between them would twitch the whole panel by the
             height of a button every time. Measured at 26px. */
          min-height: 1.7rem;
        }
        /* Not .btn: both stylesheets declare its padding !important, so its glyph
           cannot be centred in a box this size. */
        .record-process-action {
          appearance: none;
          background: transparent;
          border: 1px solid #2a3036;
          border-radius: 7px;
          color: #c3c9cf;
          font-size: 0.75rem;
          padding: 0.22rem 0.7rem;
          cursor: pointer;
          transition: background 140ms ease-out, color 140ms ease-out;
        }
        .record-process-action:hover {
          background: #2a3036;
          color: #f1f3f5;
        }
        @media (prefers-reduced-motion: reduce) {
          .record-process-scrim,
          .record-process,
          .record-process-bar,
          .record-process-bar.is-waiting {
            animation-duration: 1ms;
            transition-duration: 1ms;
          }
        }
      </style>

      <div class="record-process-scrim" data-keeps-selection>
        <div
          class="record-process"
          role="dialog"
          aria-modal="true"
          aria-label="Processing the recording"
        >
          <p class="record-process-title">${view.title}</p>
          <p class="record-process-detail">${view.detail}</p>

          <div
            class="record-process-track"
            role="progressbar"
            aria-valuemin="0"
            aria-valuemax="100"
            aria-valuenow=${view.percent ?? nothing}
          >
            <div
              class="record-process-bar ${view.percent == null ? "is-waiting" : ""}"
              style=${view.percent == null ? "" : `width: ${view.percent}%`}
            ></div>
          </div>

          <div class="record-process-foot">
            ${view.failed
              ? html`<button
                  class="record-process-action"
                  type="button"
                  @click=${this.onDismiss}
                >
                  Close
                </button>`
              : view.cancellable
                ? html`<button
                    class="record-process-action"
                    type="button"
                    @click=${this.onCancel}
                  >
                    Skip the zoom
                  </button>`
                : nothing}
          </div>
        </div>
      </div>
    `;
  }
}
