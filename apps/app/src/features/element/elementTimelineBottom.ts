import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { ITimelineStore, useTimelineStore } from "../../states/timelineStore";
import { IUIStore, uiStore } from "../../states/uiStore";
import {
  IRenderOptionStore,
  renderOptionStore,
} from "../../states/renderOptionStore";
import { getLocationEnv } from "../../functions/getLocationEnv";
import { IMediaLoadStore, mediaLoadStore } from "../../states/mediaLoadStore";

type AiTab = "claude" | "codex" | "openai";

type CopyTarget = "claude-mcp" | "claude-skill" | "codex-config" | "codex-skill";

const AI_TABS: { id: AiTab; label: string }[] = [
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "openai", label: "OpenAI API" },
];

@customElement("element-timeline-bottom")
export class ElementTimelineBottomScroll extends LitElement {
  @property({ attribute: false })
  isRunSelfhosted = false;
  isRunMcp = false;

  openaiKey: string;

  @property({ attribute: false })
  fps: number = renderOptionStore.getInitialState().options.fps;

  /** Media probes in flight — the progress bar beside the bolt icon. */
  @property({ attribute: false })
  mediaLoading: number = 0;

  /** The `claude mcp add …` line, token included, for the user to paste. */
  mcpCommand = "";
  /** The `npx skills add …` line. No secret in it, but main owns it too. */
  skillCommand = "";
  /** The `~/.codex/config.toml` entry, token included. */
  codexConfig = "";
  codexSkillCommand = "";
  mcpError = "";
  /** Which option of the ⚡ panel is showing. */
  aiTab: AiTab = "claude";
  /** Which Copy button last copied, so only that one says so. */
  copied: CopyTarget | null = null;

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
        this.skillCommand = result.skillCommand ?? "";
        this.codexConfig = result.codexConfig ?? "";
        this.codexSkillCommand = result.codexSkillCommand ?? "";
        this.requestUpdate();
      }
    });
  }

  runMcpServer() {
    window.electronAPI.req.ai.runMcpServer().then((result) => {
      this.isRunMcp = result.status == 1;
      this.mcpCommand = result.command ?? "";
      this.skillCommand = result.skillCommand ?? this.skillCommand;
      this.codexConfig = result.codexConfig ?? this.codexConfig;
      this.codexSkillCommand =
        result.codexSkillCommand ?? this.codexSkillCommand;
      this.mcpError = result.error ?? "";
      this.requestUpdate();
    });
  }

  _copy(which: CopyTarget, text: string) {
    navigator.clipboard.writeText(text).then(() => {
      this.copied = which;
      this.requestUpdate();
      setTimeout(() => {
        // A later copy of the other line owns the label now.
        if (this.copied === which) {
          this.copied = null;
          this.requestUpdate();
        }
      }, 1500);
    });
  }

  _selectAiTab(tab: AiTab) {
    this.aiTab = tab;
    this.requestUpdate();
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

        .timeline-bottom-load {
          display: flex;
          align-items: center;
          gap: 0.35rem;
        }

        /*
         * Indeterminate on purpose: neither the <video> element nor ffprobe
         * reports how far through a file it is, so a filling bar would be a
         * number nobody measured. This says "still working" and nothing more.
         */
        .timeline-bottom-load-track {
          width: 60px;
          height: 3px;
          border-radius: 2px;
          background-color: #3a3f44;
          overflow: hidden;
        }

        .timeline-bottom-load-bar {
          width: 40%;
          height: 100%;
          border-radius: 2px;
          background-color: #0d6efd;
          animation: timeline-bottom-load-slide 1.1s ease-in-out infinite;
        }

        @keyframes timeline-bottom-load-slide {
          from {
            transform: translateX(-100%);
          }
          to {
            transform: translateX(250%);
          }
        }

        .connect-steps {
          display: flex;
          flex-direction: column;
          gap: 1.25rem;
          margin-top: 1.25rem;
        }

        /* Badge in the first column, everything else lined up in the second. */
        .connect-step {
          position: relative;
          display: grid;
          grid-template-columns: 26px minmax(0, 1fr);
          column-gap: 0.75rem;
          row-gap: 0.5rem;
        }

        /* The rail from one badge down to the next. */
        .connect-step:not(:last-child)::before {
          content: "";
          position: absolute;
          left: 12.5px;
          top: 32px;
          bottom: -14px;
          width: 1px;
          background-color: #3a3f44;
        }

        .connect-step-num {
          width: 26px;
          height: 26px;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 13px;
          font-weight: 600;
          color: #0f1012;
          background-color: #ffffff;
        }

        .connect-step-title {
          align-self: center;
          font-size: 15px;
          font-weight: 600;
          color: #f1f3f5;
        }

        .connect-step-body {
          grid-column: 2;
          display: flex;
          flex-direction: column;
          gap: 0.5rem;
        }

        .connect-step-body > .btn {
          align-self: flex-start;
        }

        .ai-tabs {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 4px;
          padding: 4px;
          margin-bottom: 1rem;
          border-radius: 10px;
          background-color: #1c1f23;
        }

        .ai-tab {
          border: 0;
          border-radius: 7px;
          padding: 7px 0;
          font-size: 13px;
          font-weight: 600;
          color: #b7b8c0;
          background-color: transparent;
          transition:
            background-color 0.15s,
            color 0.15s;
        }

        .ai-tab:hover {
          color: #f1f3f5;
        }

        .ai-tab.active {
          color: #0f1012;
          background-color: #ffffff;
        }

        /* A multi-line snippet with its Copy button, shaped like an input-group. */
        .connect-code {
          display: flex;
          border-radius: 6px;
          overflow: hidden;
          background-color: #1c1f23;
        }

        /* Wrapped rather than scrolled: Copy takes the exact text either way. */
        .connect-code pre {
          flex: 1;
          min-width: 0;
          margin: 0;
          padding: 8px 10px;
          white-space: pre-wrap;
          overflow-wrap: anywhere;
          font-size: 11px;
          line-height: 1.6;
          color: #f1f3f5;
          background: transparent;
          border: 0;
          border-radius: 0;
          /* vendor/devent-designsystem.css forces a scrollbar on every pre. */
          overflow-x: hidden !important;
        }

        .connect-code .btn {
          border-radius: 0;
        }

        .connect-note {
          font-size: 12px;
          color: #8b8f96;
        }

        .connect-note code {
          font-size: 11px;
          color: #d7dade;
        }
      </style>

      <div class="timeline-bottom">
        <div class="timeline-bottom-grid-start">
          <span class="bottom-text">${this.fps}fps</span>
        </div>
        <div class="timeline-bottom-grid-end">
          ${this.mediaLoading > 0
            ? html`<div
                class="timeline-bottom-load"
                title="Reading media metadata"
              >
                <span class="bottom-text"
                  >Loading${this.mediaLoading > 1
                    ? html` ${this.mediaLoading}`
                    : ""}</span
                >
                <div class="timeline-bottom-load-track">
                  <div class="timeline-bottom-load-bar"></div>
                </div>
              </div>`
            : ""}

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
                CartCut Info
              </h6>
              <span
                @click=${() =>
                  window.electronAPI.req.url.openUrl(
                    "https://github.com/cartesiancs/cartcut",
                  )}
                class="text-secondary"
                style="font-size: 13px; cursor: pointer;"
                >GitHub: https://github.com/cartesiancs/cartcut</span
              >
              <br />
              <span
                @click=${() =>
                  window.electronAPI.req.url.openUrl(
                    "https://github.com/cartesiancs/cartcut/issues",
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
              <h6 class="modal-title text-light font-weight-lg mb-3">
                Connect AI
              </h6>

              <div class="ai-tabs" role="tablist">
                ${AI_TABS.map(
                  (tab) =>
                    html`<button
                      type="button"
                      role="tab"
                      class="ai-tab ${this.aiTab === tab.id ? "active" : ""}"
                      aria-selected=${this.aiTab === tab.id}
                      @click=${() => this._selectAiTab(tab.id)}
                    >
                      ${tab.label}
                    </button>`,
                )}
              </div>

              ${this.aiTab === "claude"
                ? this.renderClaudeTab()
                : this.aiTab === "codex"
                  ? this.renderCodexTab()
                  : this.renderOpenAiTab()}
            </div>
          </div>
        </div>
      </div>
    `;
  }

  renderClaudeTab() {
    return html`
      <span class="text-secondary" style="font-size: 13px;">
        ${this.isRunMcp
          ? html`CartCut is listening. Run these once in your terminal, from
            any folder, then ask Claude Code to edit.`
          : html`The editor bridge is not running.`}
      </span>

      <div class="connect-steps">
        ${this.renderStep(
          1,
          "Connect the bridge",
          this.isRunMcp
            ? this.renderCommand("claude-mcp", this.mcpCommand)
            : this.renderStartBridge(),
        )}
        ${this.renderStep(
          2,
          "Install the editing skill",
          this.renderCommand("claude-skill", this.skillCommand),
        )}
      </div>
    `;
  }

  renderCodexTab() {
    return html`
      <span class="text-secondary" style="font-size: 13px;">
        ${this.isRunMcp
          ? html`CartCut is listening. Add it to Codex once, then ask Codex to
            edit.`
          : html`The editor bridge is not running.`}
      </span>

      <div class="connect-steps">
        ${this.renderStep(
          1,
          "Add the bridge to config.toml",
          this.isRunMcp
            ? html`${this.renderCode("codex-config", this.codexConfig)}
                <span class="connect-note">
                  Paste into <code>~/.codex/config.toml</code>, replacing any
                  earlier <code>[mcp_servers.cartcut]</code> entry. The CLI,
                  the IDE extension and the desktop app all read this file.
                </span>`
            : this.renderStartBridge(),
        )}
        ${this.renderStep(
          2,
          "Install the editing skill",
          this.renderCommand("codex-skill", this.codexSkillCommand),
        )}
      </div>
    `;
  }

  renderOpenAiTab() {
    return html`
      <span class="text-secondary" style="font-size: 13px;">
        Transcribes speech for captions and the transcript tool when on-device
        recognition is not available. The key is stored on this computer.
      </span>

      <div class="input-group mb-1 mt-3">
        <span class="input-group-text bg-default text-light">OpenAI Key</span>
        <input
          type="password"
          class="form-control bg-default text-light"
          placeholder="openai key"
          .value=${this.openaiKey}
          @change=${this._handleSetOpenAIKey}
          @input=${this._handleSetOpenAIKey}
        />
      </div>
    `;
  }

  renderStep(n: number, title: string, body: unknown) {
    return html`<div class="connect-step">
      <span class="connect-step-num">${n}</span>
      <span class="connect-step-title">${title}</span>
      <div class="connect-step-body">${body}</div>
    </div>`;
  }

  renderCommand(target: CopyTarget, text: string) {
    return html`<div class="input-group">
      <input
        type="text"
        class="form-control bg-default text-light"
        style="font-family: monospace; font-size: 11px;"
        readonly
        .value=${text}
      />
      <button
        class="btn btn-primary btn-sm"
        @click=${() => this._copy(target, text)}
      >
        ${this.copied === target ? "Copied" : "Copy"}
      </button>
    </div>`;
  }

  renderCode(target: CopyTarget, text: string) {
    return html`<div class="connect-code">
      <pre>${text}</pre>
      <button
        class="btn btn-primary btn-sm"
        @click=${() => this._copy(target, text)}
      >
        ${this.copied === target ? "Copied" : "Copy"}
      </button>
    </div>`;
  }

  /** Shown in place of step 1 while the bridge is down, on either agent's tab. */
  renderStartBridge() {
    return html`<span
        class="text-danger ${this.mcpError ? "" : "d-none"}"
        style="font-size: 12px;"
        >${this.mcpError}</span
      >
      <button class="btn btn-primary btn-sm" @click=${this.runMcpServer}>
        Start bridge
      </button>`;
  }

  runSelfhosted() {
    window.electronAPI.req.selfhosted.run();
    this.isRunSelfhosted = true;
  }

  createRenderRoot() {
    renderOptionStore.subscribe((state: IRenderOptionStore) => {
      this.fps = state.options.fps;
    });

    mediaLoadStore.subscribe((state: IMediaLoadStore) => {
      this.mediaLoading = state.pending;
    });

    return this;
  }
}
