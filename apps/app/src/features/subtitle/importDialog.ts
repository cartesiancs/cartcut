/**
 * The dialog that asks which clock a subtitle file counts in.
 *
 * A dark overlay of its own rather than a Bootstrap modal, for the reason
 * `apps/automatic-caption/src/clipPicker.ts` gives: the vendored Bootstrap is
 * 5.0.2, which has no `data-bs-theme`, and `devent-designsystem.css` styles
 * `.modal-content` light, so a Bootstrap dialog comes up white over a dark
 * editor.
 *
 * **Every decision is in `importChoice.ts`.** This file measures, paints and
 * resolves a promise. There is no DOM test environment in this repo, so a rule
 * written in here is a rule nothing can check.
 *
 * Three house rules it has to keep:
 *
 * - `createRenderRoot` returns `this`. The global stylesheet does not cross a
 *   shadow boundary, and 70 of 70 components in this app do the same.
 * - Every handler is an **arrow property**. Lit binds a listener's `this` to
 *   the component whose template rendered it, so a method would bind to
 *   whatever host ends up rendering this.
 * - No backticks inside the style block: it sits in an html template literal
 *   and one would end it. And no `header` element: the design system gives
 *   every one a 30px top margin.
 */

import { LitElement, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import {
  DEFAULT_TIME_BASE,
  resolveTimeBase,
  timeBaseOptions,
  type SubtitleTimeBase,
  type TimeBaseOption,
} from "./importChoice";
import type { SubtitleFilePreview } from "./importSubtitleFile";

export type SubtitleImportAsk = {
  files: readonly SubtitleFilePreview[];
  selectedClip: { key: string; name: string } | null;
};

@customElement("subtitle-import-dialog")
export class SubtitleImportDialog extends LitElement {
  @state() private ask: SubtitleImportAsk | null = null;
  @state() private choice: SubtitleTimeBase = DEFAULT_TIME_BASE;

  /** Resolves with the chosen base, or null when the user backed out. */
  private settle: ((base: SubtitleTimeBase | null) => void) | null = null;

  createRenderRoot() {
    return this;
  }

  /**
   * Open, and answer when the user decides.
   *
   * A second call while one is open closes the first with null rather than
   * stacking. Two of these on screen would both be reading the same selection
   * and only one could be acted on.
   */
  open(ask: SubtitleImportAsk): Promise<SubtitleTimeBase | null> {
    this.close(null);
    this.ask = ask;
    this.choice = DEFAULT_TIME_BASE;
    document.addEventListener("keydown", this.onKeydown, true);
    return new Promise((resolve) => {
      this.settle = resolve;
    });
  }

  disconnectedCallback(): void {
    this.close(null);
    super.disconnectedCallback();
  }

  private close(base: SubtitleTimeBase | null): void {
    document.removeEventListener("keydown", this.onKeydown, true);
    const settle = this.settle;
    this.settle = null;
    this.ask = null;
    settle?.(base);
  }

  private onKeydown = (event: KeyboardEvent): void => {
    if (this.ask == null) {
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      // Capture phase, so Escape here does not also reach a shortcut that would
      // clear the selection the dialog is asking about.
      event.stopPropagation();
      this.close(null);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      this.confirm();
    }
  };

  private onPick = (option: TimeBaseOption): void => {
    if (option.disabled) {
      return;
    }
    this.choice = option.base;
  };

  private onCancel = (): void => {
    this.close(null);
  };

  private onConfirm = (): void => {
    this.confirm();
  };

  private onScrimDown = (event: PointerEvent): void => {
    // Only a press that both starts and ends on the scrim dismisses. Without
    // the target check, releasing a drag that began inside the dialog over the
    // scrim would throw the choice away.
    if (event.target === event.currentTarget) {
      this.close(null);
    }
  };

  private confirm(): void {
    const ask = this.ask;
    if (ask == null) {
      return;
    }
    // Resolved rather than read straight off `choice`: the selection can change
    // while the dialog is open, and what runs must be what was shown.
    this.close(
      resolveTimeBase({ selectedClip: ask.selectedClip, current: this.choice }),
    );
  }

  render() {
    const ask = this.ask;
    if (ask == null) {
      return nothing;
    }

    const options = timeBaseOptions({
      selectedClip: ask.selectedClip,
      current: this.choice,
    });
    const cues = ask.files.reduce((total, file) => total + file.cues.length, 0);
    const name =
      ask.files.length === 1 ? ask.files[0].name : `${ask.files.length} files`;

    return html`
      <style>
        .subtitle-import-scrim {
          position: fixed;
          inset: 0;
          z-index: 8600;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 1rem;
          background: rgba(0, 0, 0, 0.72);
          animation: subtitle-import-fade 140ms ease-out;
        }

        .subtitle-import {
          display: flex;
          flex-direction: column;
          width: min(26rem, 92vw);
          background: #19181a;
          color: #ffffff;
          border: 1px solid #26262b;
          border-radius: 12px;
          box-shadow: 0 1.5rem 3rem rgba(0, 0, 0, 0.55);
          overflow: hidden;
          animation: subtitle-import-rise 140ms ease-out;
        }

        @keyframes subtitle-import-fade {
          from { opacity: 0; }
          to { opacity: 1; }
        }

        @keyframes subtitle-import-rise {
          from { opacity: 0; transform: scale(0.98); }
          to { opacity: 1; transform: none; }
        }

        .subtitle-import .material-symbols-outlined {
          font-size: 1.1rem;
          line-height: 1;
        }

        .subtitle-import-head {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          padding: 0.7rem 0.9rem;
          border-bottom: 1px solid #26262b;
          user-select: none;
        }

        .subtitle-import-name {
          font-weight: 600;
          font-size: 0.9rem;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .subtitle-import-count {
          margin-left: auto;
          flex: 0 0 auto;
          padding: 0.1rem 0.45rem;
          border-radius: 999px;
          background: #26262b;
          color: #c9c9d1;
          font-size: 0.75rem;
          font-variant-numeric: tabular-nums;
        }

        .subtitle-import-options {
          display: flex;
          flex-direction: column;
          gap: 0.3rem;
          padding: 0.6rem;
        }

        .subtitle-import-option {
          display: flex;
          align-items: center;
          gap: 0.6rem;
          width: 100%;
          padding: 0.55rem 0.7rem !important;
          border: 1px solid transparent;
          border-radius: 8px;
          background: transparent;
          color: #ffffff;
          text-align: left;
          cursor: pointer;
        }

        .subtitle-import-option:hover:not(:disabled) {
          background: #232329;
        }

        .subtitle-import-option[aria-checked="true"] {
          border-color: #3b8fb3;
          background: #1d2a31;
        }

        .subtitle-import-option:disabled {
          opacity: 0.4;
          cursor: default;
        }

        .subtitle-import-label {
          font-size: 0.85rem;
        }

        .subtitle-import-detail {
          margin-left: auto;
          max-width: 55%;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          color: #8a8a94;
          font-size: 0.75rem;
        }

        .subtitle-import-foot {
          display: flex;
          justify-content: flex-end;
          gap: 0.4rem;
          padding: 0.6rem;
          border-top: 1px solid #26262b;
        }

        .subtitle-import-foot .btn {
          display: inline-flex !important;
          align-items: center;
          gap: 0.35rem;
          padding: 0.4rem 0.7rem !important;
          font-size: 0.85rem;
        }
      </style>

      <div
        class="subtitle-import-scrim"
        @pointerdown=${this.onScrimDown}
        role="presentation"
      >
        <div
          class="subtitle-import"
          role="dialog"
          aria-modal="true"
          aria-label="Import subtitles"
        >
          <div class="subtitle-import-head">
            <span class="material-symbols-outlined" aria-hidden="true">
              subtitles
            </span>
            <span class="subtitle-import-name" title=${name}>${name}</span>
            <span class="subtitle-import-count">${cues}</span>
          </div>

          <div class="subtitle-import-options" role="radiogroup">
            ${options.map((option) => this.renderOption(option))}
          </div>

          <div class="subtitle-import-foot">
            <button
              class="btn btn-sm btn-default text-light"
              @click=${this.onCancel}
            >
              <span class="material-symbols-outlined" aria-hidden="true">
                close
              </span>
              <span>Cancel</span>
            </button>
            <button class="btn btn-sm btn-primary" @click=${this.onConfirm}>
              <span class="material-symbols-outlined" aria-hidden="true">
                download
              </span>
              <span>Import</span>
            </button>
          </div>
        </div>
      </div>
    `;
  }

  private renderOption(option: TimeBaseOption) {
    return html`
      <button
        class="subtitle-import-option"
        role="radio"
        aria-checked=${option.selected ? "true" : "false"}
        ?disabled=${option.disabled}
        @click=${() => this.onPick(option)}
      >
        <span class="material-symbols-outlined" aria-hidden="true">
          ${option.icon}
        </span>
        <span class="subtitle-import-label">${option.label}</span>
        ${option.detail === ""
          ? nothing
          : html`<span class="subtitle-import-detail" title=${option.detail}>
              ${option.detail}
            </span>`}
      </button>
    `;
  }
}

/**
 * Ask, using the one dialog mounted in `App.ts`.
 *
 * Answers `DEFAULT_TIME_BASE` with no dialog at all when the element is not
 * mounted, which is the web build. Refusing the import there would be a worse
 * answer than importing against the timeline, which is the default anyway.
 */
export function askTimeBase(
  ask: SubtitleImportAsk,
): Promise<SubtitleTimeBase | null> {
  const dialog = document.querySelector("subtitle-import-dialog") as
    | SubtitleImportDialog
    | null;
  if (dialog == null) {
    return Promise.resolve(DEFAULT_TIME_BASE);
  }
  return dialog.open(ask);
}
