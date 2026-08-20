import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { ITimelineStore, useTimelineStore } from "../../states/timelineStore";
import { IUIStore, uiStore } from "../../states/uiStore";
import {
  IRenderOptionStore,
  renderOptionStore,
} from "../../states/renderOptionStore";
import { getLocationEnv } from "../../functions/getLocationEnv";

@customElement("element-timeline-bottom")
export class ElementTimelineBottomScroll extends LitElement {
  @property({ attribute: false })
  isRunSelfhosted = false;
  isRunMcp = false;

  openaiKey: string;

  /** The `claude mcp add …` line, token included, for the user to paste. */
  mcpCommand = "";
  mcpError = "";
  copied = false;

  constructor() {
    super();
    this.openaiKey = "";

    this.getOpenAiKey();
    this.refreshMcpStatus();
  }

  getOpenAiKey() {
    window.electronAPI.req.ai.getKey().then((result) => {
      if (result.status == 1) {
        this.openaiKey = result.value;
        this.requestUpdate();
      }
    });
  }

  /**
   * The server now starts with the app, so this reports rather than launches.
   * The button below is only a retry for the case where the port was taken.
   */
  refreshMcpStatus() {
    window.electronAPI.req.agent?.getStatus?.().then((result) => {
      if (result?.status == 1) {
        this.isRunMcp = result.running;
        this.mcpCommand = result.command;
        this.requestUpdate();
      }
    });
  }

  runMcpServer() {
    window.electronAPI.req.ai.runMcpServer().then((result) => {
      this.isRunMcp = result.status == 1;
      this.mcpCommand = result.command ?? "";
      this.mcpError = result.error ?? "";
      this.requestUpdate();
    });
  }

  _handleCopyMcpCommand() {
    navigator.clipboard.writeText(this.mcpCommand).then(() => {
      this.copied = true;
      this.requestUpdate();
      setTimeout(() => {
        this.copied = false;
        this.requestUpdate();
      }, 1500);
    });
  }

  _handleSetOpenAIKey(e) {
    const key = e.target.value;
    window.electronAPI.req.ai.setKey(key);
  }

  render() {
    return html`
      <style>
        .timeline-bottom {
          width: 100%;
          height: 20px;
          background-color: #0f1012;
          position: fixed;
          bottom: 0;
          left: 0;
          display: flex;
          justify-content: space-between;
          border-top: 0.05rem #3a3f44 solid;
          align-items: center;
          z-index: 999;
        }

        .timeline-bottom-grid-start {
          display: flex;
          gap: 0.25rem;
          flex-direction: column;
          padding-left: 1rem;
        }

        .timeline-bottom-grid-end {
          display: flex;
          gap: 0.5rem;
          justify-content: end;
          padding-right: 1rem;
          align-items: center;
        }

        .bottom-text {
          color: #b7b8c0;
          font-size: 12px;
        }

        .timeline-bottom-question-icon {
          cursor: pointer;
        }
      </style>

      <div class="timeline-bottom">
        <div class="timeline-bottom-grid-start">
          <span class="bottom-text">60fps</span>
        </div>
        <div class="timeline-bottom-grid-end">
          <span
            class="material-symbols-outlined timeline-bottom-question-icon icon-xs ${getLocationEnv() ==
            "electron"
              ? ""
              : "d-none"}"
            data-bs-toggle="modal"
            data-bs-target="#settingAi"
          >
            bolt
          </span>

          <span
            class="d-flex justify-content-start align-items-center gap-1 ${getLocationEnv() ==
            "electron"
              ? ""
              : "d-none"} timeline-bottom-question-icon "
            data-bs-toggle="modal"
            data-bs-target="#runServerModal"
          >
            <span class="material-symbols-outlined icon-xs "> public </span>
            <span class="bottom-text">Public</span>
          </span>

          <span
            class="material-symbols-outlined timeline-bottom-question-icon icon-xs"
            data-bs-toggle="modal"
            data-bs-target="#informationModal"
          >
            question_mark
          </span>
        </div>
      </div>

      <div
        class="modal fade"
        id="informationModal"
        tabindex="-1"
        aria-hidden="true"
      >
        <div class="modal-dialog modal-dialog-dark modal-dialog-centered">
          <div class="modal-content modal-dark modal-darker">
            <div class="modal-body modal-body-dark">
              <h6 class="modal-title text-light font-weight-lg mb-2">
                Cartcut Info
              </h6>
              <span
                @click=${() =>
                  window.electronAPI.req.url.openUrl(
                    "https://github.com/cartesiancs/nugget-app",
                  )}
                class="text-secondary"
                style="font-size: 13px; cursor: pointer;"
                >GitHub: https://github.com/cartesiancs/nugget-app</span
              >
              <br />
              <span
                @click=${() =>
                  window.electronAPI.req.url.openUrl(
                    "https://github.com/cartesiancs/nugget-app/issues",
                  )}
                class="text-secondary"
                style="font-size: 13px; cursor: pointer;"
                >Report Bug</span
              >
            </div>
          </div>
        </div>
      </div>

      <div
        class="modal fade"
        id="runServerModal"
        tabindex="-1"
        aria-hidden="true"
      >
        <div class="modal-dialog modal-dialog-dark modal-dialog-centered">
          <div class="modal-content modal-dark modal-darker">
            <div class="modal-body modal-body-dark">
              <h6 class="modal-title text-light font-weight-lg mb-2">
                Run Self-Hosted Server
              </h6>

              <span class="text-secondary"
                >This self-host mode might be unstable.
              </span>

              <br />

              <span
                @click=${() =>
                  window.electronAPI.req.url.openUrl("http://localhost:9825/")}
                class="text-secondary ${this.isRunSelfhosted == true
                  ? ""
                  : "d-none"}"
                style="font-size: 13px; cursor: pointer; "
                >http://localhost:9825/</span
              >

              <br class="${this.isRunSelfhosted == true ? "" : "d-none"}" />
              <button
                class="btn btn-primary btn-sm mt-2"
                @click=${this.runSelfhosted}
              >
                Run
              </button>
            </div>
          </div>
        </div>
      </div>

      <div class="modal fade" id="settingAi" tabindex="-1" aria-hidden="true">
        <div class="modal-dialog modal-dialog-dark modal-dialog-centered">
          <div class="modal-content modal-dark modal-darker">
            <div class="modal-body modal-body-dark">
              <h6 class="modal-title text-light font-weight-lg mb-2">
                Connect Claude Code
              </h6>

              <span class="text-secondary" style="font-size: 13px;">
                ${this.isRunMcp
                  ? html`Cartcut is listening. Run this once in your terminal,
                      from any folder, then just ask Claude Code to edit.`
                  : html`The editor bridge is not running.`}
              </span>

              <div
                class="input-group mb-2 mt-2 ${this.isRunMcp ? "" : "d-none"}"
              >
                <input
                  type="text"
                  class="form-control bg-default text-light"
                  style="font-family: monospace; font-size: 11px;"
                  readonly
                  .value=${this.mcpCommand}
                />
                <button
                  class="btn btn-primary btn-sm"
                  @click=${this._handleCopyMcpCommand}
                >
                  ${this.copied ? "Copied" : "Copy"}
                </button>
              </div>

              <span
                class="text-secondary ${this.isRunMcp ? "" : "d-none"}"
                style="font-size: 12px;"
              >
                The command carries an access token. Anyone with it can edit
                this project, so keep it to yourself.
              </span>

              <span
                class="text-danger ${this.mcpError ? "" : "d-none"}"
                style="font-size: 12px;"
                >${this.mcpError}</span
              >

              <button
                class="btn btn-primary btn-sm mt-2 ${this.isRunMcp
                  ? "d-none"
                  : ""}"
                @click=${this.runMcpServer}
              >
                Start bridge
              </button>

              <hr class="text-secondary" />

              <span class="text-secondary" style="font-size: 13px;"
                >OpenAI API key — used for speech-to-text when no local
                transcription server is running.</span
              >

              <div class="input-group mb-1 mt-2">
                <span
                  class="input-group-text bg-default text-light"
                  id="basic-addon2"
                  >OpenAI Key</span
                >
                <input
                  type="password"
                  class="form-control bg-default text-light"
                  placeholder="openai key"
                  .value=${this.openaiKey}
                  @change=${this._handleSetOpenAIKey}
                  @input=${this._handleSetOpenAIKey}
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  runSelfhosted() {
    window.electronAPI.req.selfhosted.run();
    this.isRunSelfhosted = true;
  }

  createRenderRoot() {
    return this;
  }
}
