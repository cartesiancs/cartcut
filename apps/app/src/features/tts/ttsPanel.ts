/**
 * The Text to Speech window: write a line, get a clip at the playhead.
 *
 * Renders into the light DOM like every other component here, because the
 * global stylesheet does not cross a shadow boundary.
 *
 * **Every handler is an arrow property.** `Control` builds this panel's
 * template and `<app-window>` renders it, so Lit's listener host is the window
 * and a plain method would bind `this` to the wrong component. CLAUDE.md
 * records `changeCursorType` dying silently that way.
 *
 * What the panel draws is decided in `ttsPhase.ts` rather than here, so the
 * copy and the spinner-or-bar question can be checked by a suite.
 */

import { LitElement, html, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
// `live()` for the text inputs, whose value the user also writes to.
//
// The selects below deliberately do **not** use `.value` at all. Lit commits
// parts in document order, so a `.value` on the element is written before the
// `<option>` children exist; the assignment finds no matching option and is
// dropped, and the browser then selects the first option once they arrive. The
// component says M1 and the box says F1, and the user hears a voice they did
// not pick. Marking the chosen `<option>` is order-independent.
import { live } from "lit/directives/live.js";

import { speak } from "./ttsSession";
import { ttsBridge, type TtsAvailabilityReply, type TtsPort } from "./ttsPort";
import { downloadPrompt, ttsPhaseView, type TtsPhaseName } from "./ttsPhase";

/** Denoising steps. Four never clips; two does, on a handful of samples. */
const QUALITY = [
  { label: "Balanced", steps: 4 },
  { label: "Best", steps: 8 },
] as const;

const LANGUAGES = [
  { code: "ko", label: "한국어" },
  { code: "en", label: "English" },
  { code: "ja", label: "日本語" },
  { code: "zh", label: "中文" },
  { code: "es", label: "Español" },
  { code: "fr", label: "Français" },
  { code: "de", label: "Deutsch" },
  { code: "na", label: "Other" },
] as const;

@customElement("tts-panel")
export class TtsPanel extends LitElement {
  @state() private phase: TtsPhaseName = "checking";
  @state() private info: TtsAvailabilityReply | null = null;
  @state() private fraction: number | null = null;
  @state() private stage = "";
  @state() private message = "";

  @state() private text = "";
  @state() private voice = "M1";
  /**
   * Named `language` and not `lang`.
   *
   * `HTMLElement` already has a public `lang`, and redeclaring it private here
   * makes the class no longer assignable to its own base, which surfaces as an
   * unresolvable `@customElement` decorator several lines away.
   */
  @state() private language = "ko";
  @state() private speed = 1.05;
  @state() private steps: number = QUALITY[0].steps;

  /** The download's job id while one is running, so it can be cancelled. */
  private downloadJob: string | null = null;

  createRenderRoot() {
    return this;
  }

  connectedCallback(): void {
    super.connectedCallback();
    void this.refresh();
  }

  private port(): TtsPort | null {
    return ttsBridge();
  }

  private refresh = async (): Promise<void> => {
    const port = this.port();
    if (port == null) {
      this.phase = "failed";
      this.message = "Speech synthesis is only available in the desktop app.";
      return;
    }
    try {
      const info = await port.availability();
      this.info = info;
      if (info.voices.length > 0 && !info.voices.includes(this.voice)) {
        this.voice = info.voices[0];
      }
      this.phase = info.ok ? "ready" : "needsModel";
    } catch (error) {
      this.phase = "failed";
      this.message = error instanceof Error ? error.message : String(error);
    }
  };

  private handleDownload = async (): Promise<void> => {
    const port = this.port();
    if (port == null || this.downloadJob != null) {
      return;
    }
    // Minted here so Cancel works while the first bytes are still in flight.
    const jobId = `tts-download-${Date.now()}`;
    this.downloadJob = jobId;
    this.phase = "downloading";
    this.fraction = 0;

    const stop = port.onProgress((payload) => {
      if (payload.jobId === jobId) {
        this.fraction = payload.fraction;
      }
    });

    try {
      const result = await port.download(jobId);
      if (result.ok) {
        await this.refresh();
        return;
      }
      if (result.cancelled === true) {
        // Back to the prompt, which now offers to resume: the files that did
        // land are kept and counted.
        await this.refresh();
        return;
      }
      this.phase = "failed";
      this.message = result.error ?? "The download failed.";
    } catch (error) {
      this.phase = "failed";
      this.message = error instanceof Error ? error.message : String(error);
    } finally {
      stop();
      this.downloadJob = null;
    }
  };

  private handleCancelDownload = (): void => {
    const job = this.downloadJob;
    if (job != null) {
      void this.port()?.cancelDownload(job);
    }
  };

  /** The job in flight, so the progress screen's Cancel has something to stop. */
  private speakJob: string | null = null;

  private handleSpeak = async (): Promise<void> => {
    const port = this.port();
    if (port == null || this.text.trim().length === 0) {
      return;
    }
    this.phase = "speaking";
    this.stage = "loading";
    this.fraction = 0;

    const outcome = await speak(
      {
        text: this.text,
        voice: this.voice,
        lang: this.language,
        speed: this.speed,
        steps: this.steps,
      },
      {
        port,
        mintId: () => {
          const id = `tts-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
          this.speakJob = id;
          return id;
        },
        onProgress: (fraction, stage) => {
          this.fraction = fraction;
          this.stage = stage;
        },
      },
    );

    this.speakJob = null;

    if (outcome.kind === "failed") {
      this.phase = "failed";
      this.message = outcome.message;
      return;
    }
    // A placed clip and a cancelled job both return the panel to its form. The
    // clip is on the timeline where the user can see it, so saying so again
    // here would be noise.
    this.phase = "ready";
  };

  private handleCancelSpeak = (): void => {
    const job = this.speakJob;
    if (job != null) {
      void this.port()?.cancel(job);
    }
  };

  private handleRetry = (): void => {
    this.message = "";
    void this.refresh();
  };

  private renderPhase(): TemplateResult | "" {
    const view = ttsPhaseView({
      phase: this.phase,
      fraction: this.fraction,
      stage: this.stage,
      totalBytes: this.info?.totalBytes,
      message: this.message,
    });
    if (view == null) {
      return "";
    }

    const onCancel =
      this.phase === "downloading"
        ? this.handleCancelDownload
        : this.handleCancelSpeak;

    return html`
      <div class="p-3 text-center">
        <p class="text-light mb-1">${view.title}</p>
        ${view.note
          ? html`<p class="text-secondary" style="font-size: 0.75rem;">
              ${view.note}
            </p>`
          : ""}
        ${view.percent == null
          ? html`<span
              class="material-symbols-outlined text-secondary tts-spin"
              aria-hidden="true"
              >progress_activity</span
            >`
          : html`<div class="progress" style="height: 4px;">
              <div
                class="progress-bar"
                role="progressbar"
                aria-valuenow=${view.percent}
                aria-valuemin="0"
                aria-valuemax="100"
                style="width: ${view.percent}%"
              ></div>
            </div>`}
        ${view.cancellable
          ? html`<button
              class="btn btn-sm btn-secondary mt-3"
              @click=${onCancel}
            >
              Cancel
            </button>`
          : ""}
        ${view.failed
          ? html`<button
              class="btn btn-sm btn-secondary mt-3"
              @click=${this.handleRetry}
            >
              Try again
            </button>`
          : ""}
      </div>
    `;
  }

  private renderNeedsModel(): TemplateResult {
    const info = this.info;
    return html`
      <div class="p-3">
        <p class="text-light mb-1">Voices are not installed yet</p>
        <p class="text-secondary" style="font-size: 0.75rem;">
          ${downloadPrompt(info?.totalBytes ?? 0, info?.presentBytes ?? 0)}
        </p>
        <button
          class="btn btn-sm btn-primary"
          aria-event="tts-download"
          @click=${this.handleDownload}
        >
          Download voices
        </button>
        <p class="text-secondary mt-3" style="font-size: 0.7rem;">
          Model ${info?.repo ?? ""}, licensed ${info?.license ?? ""}. It is
          downloaded from Hugging Face and never leaves this computer
          afterwards.
        </p>
      </div>
    `;
  }

  private renderForm(): TemplateResult {
    const voices = this.info?.voices ?? [];
    const empty = this.text.trim().length === 0;

    return html`
      <div class="p-3 d-flex flex-column gap-2">
        <textarea
          class="form-control bg-dark text-light"
          rows="6"
          style="font-size: 0.85rem; resize: vertical;"
          placeholder="Type the narration to speak."
          aria-label="Narration text"
          .value=${live(this.text)}
          @input=${(event: Event) => {
            this.text = (event.target as HTMLTextAreaElement).value;
          }}
        ></textarea>

        <div class="d-flex gap-2">
          <label class="flex-fill">
            <span class="text-secondary" style="font-size: 0.7rem;">Voice</span>
            <select
              class="form-select form-select-sm bg-dark text-light"
              @change=${(event: Event) => {
                this.voice = (event.target as HTMLSelectElement).value;
              }}
            >
              ${voices.map(
                (voice) =>
                  html`<option value=${voice} .selected=${voice === this.voice}>
                    ${voice}
                  </option>`,
              )}
            </select>
          </label>

          <label class="flex-fill">
            <span class="text-secondary" style="font-size: 0.7rem;"
              >Language</span
            >
            <select
              class="form-select form-select-sm bg-dark text-light"
              @change=${(event: Event) => {
                this.language = (event.target as HTMLSelectElement).value;
              }}
            >
              ${LANGUAGES.map(
                (entry) =>
                  html`<option
                    value=${entry.code}
                    .selected=${entry.code === this.language}
                  >
                    ${entry.label}
                  </option>`,
              )}
            </select>
          </label>
        </div>

        <div class="d-flex gap-2">
          <label class="flex-fill">
            <span class="text-secondary" style="font-size: 0.7rem;"
              >Speed ${this.speed.toFixed(2)}x</span
            >
            <input
              type="range"
              class="form-range"
              min="0.5"
              max="2"
              step="0.05"
              .value=${live(String(this.speed))}
              @input=${(event: Event) => {
                this.speed = Number((event.target as HTMLInputElement).value);
              }}
            />
          </label>

          <label class="flex-fill">
            <span class="text-secondary" style="font-size: 0.7rem;"
              >Quality</span
            >
            <select
              class="form-select form-select-sm bg-dark text-light"
              @change=${(event: Event) => {
                this.steps = Number((event.target as HTMLSelectElement).value);
              }}
            >
              ${QUALITY.map(
                (entry) =>
                  html`<option
                    value=${String(entry.steps)}
                    .selected=${entry.steps === this.steps}
                  >
                    ${entry.label}
                  </option>`,
              )}
            </select>
          </label>
        </div>

        <button
          class="btn btn-sm btn-primary"
          aria-event="tts-speak"
          ?disabled=${empty}
          @click=${this.handleSpeak}
        >
          Generate
        </button>
      </div>
    `;
  }

  render() {
    if (this.phase === "needsModel") {
      return this.renderNeedsModel();
    }
    const phase = this.renderPhase();
    return phase === "" ? this.renderForm() : phase;
  }
}
