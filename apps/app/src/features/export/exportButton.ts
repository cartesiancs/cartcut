/**
 * The title bar's export control: a pill when idle, a progress ring when not.
 *
 * The export used to be a button inside the `#nav-output` settings panel, and
 * clicking it put a Bootstrap modal with a backdrop over the whole window until
 * the render finished. That backdrop was — incidentally, and load-bearingly —
 * the only thing preventing the user from editing during a render; see
 * `asset/videoScope.ts` for what had to happen before it could be removed.
 *
 * The settings themselves live in `ui/control/ControlSetting.ts`, under its
 * Export tab. This is the trigger only, and it drives `exportSession` exactly
 * as File → Export does.
 */

import { LitElement, html, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";

import { exportStore, type IExportStore } from "../../states/exportStore";
import { applyMenuPlacement } from "../menu/menuPlacement";
import { formatRemaining } from "../../utils/time";
import { cancelExport, startExport } from "./exportSession";
import { RING_RADIUS, RING_SIZE, RING_STROKE, ringDash } from "./exportRing";

/** How far the panel sits below the trigger. */
const POPOVER_GAP = 6;

@customElement("export-button")
export class ExportButton extends LitElement {
  @property({ attribute: false })
  exportState: IExportStore = exportStore.getInitialState();

  /** The open panel's anchor, in viewport coordinates, or null when closed. */
  @state()
  private panelAnchor: { x: number; y: number } | null = null;

  // Light DOM, and the place where the subscription is wired — the convention
  // every component in this codebase follows.
  createRenderRoot() {
    exportStore.subscribe((state) => {
      this.exportState = state;
      // An export that ends while the panel is open leaves a card describing
      // nothing. Closing it is also what returns focus to the pill.
      if (state.phase === "idle" && this.panelAnchor != null) {
        this.panelAnchor = null;
      }
    });
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("mousedown", this._handleWindowMouseDown, true);
    window.addEventListener("keydown", this._handleWindowKeyDown);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("mousedown", this._handleWindowMouseDown, true);
    window.removeEventListener("keydown", this._handleWindowKeyDown);
    // Deliberately does NOT stop the export. This component being unmounted
    // says nothing about whether FFmpeg is still writing a file.
  }

  /**
   * The exemption has to cover the panel as well as the trigger.
   *
   * Closing on `mousedown` over the panel would remove the Stop button before
   * the `click` that was meant to press it ever fired.
   */
  private _handleWindowMouseDown = (event: MouseEvent) => {
    if (this.panelAnchor == null) {
      return;
    }
    const target = event.target as HTMLElement | null;
    if (target?.closest(".export-trigger, .export-popover") != null) {
      return;
    }
    this.panelAnchor = null;
  };

  private _handleWindowKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape" && this.panelAnchor != null) {
      this.panelAnchor = null;
    }
  };

  private _handleClickTrigger(event: MouseEvent) {
    // Without this the window listener above sees the very press that opened
    // the panel and closes it again in the same gesture.
    event.stopPropagation();

    if (this.exportState.phase === "idle") {
      void startExport();
      return;
    }

    if (this.panelAnchor != null) {
      this.panelAnchor = null;
      return;
    }

    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    this.panelAnchor = { x: rect.right, y: rect.bottom + POPOVER_GAP };
  }

  /**
   * Placed after Lit has rendered it, on a panel that starts
   * `visibility: hidden` rather than `display: none` — `applyMenuPlacement`
   * measures `offsetWidth`/`offsetHeight`, and a display-none card measures
   * 0×0 and would be placed as though it fitted anywhere.
   */
  updated() {
    const open = this.panelAnchor;
    if (open == null) {
      return;
    }
    const panel = this.querySelector(".export-popover") as HTMLElement | null;
    if (panel == null) {
      return;
    }
    // `alignRight` hangs the panel's right edge on the anchor, which is what a
    // control in the top-right corner needs.
    applyMenuPlacement(panel, open, { alignRight: true });
    panel.style.visibility = "visible";
  }

  /** What the remaining-time line says, given the numbers in the store. */
  private get remainingLabel(): string {
    const { phase, remainingMs } = this.exportState;
    if (phase === "cancelling") return "Stopping…";
    if (phase === "finalizing") return "Finalizing…";
    if (remainingMs == null) return "Estimating…";
    return formatRemaining(remainingMs);
  }

  private renderRing(): TemplateResult {
    const { phase, percent } = this.exportState;
    // Neither `finalizing` nor `cancelling` has a number to show: the frame
    // loop is over and FFmpeg answers when it answers.
    const indeterminate = phase !== "running";
    const { array, offset } = ringDash(percent, RING_RADIUS);
    const centre = RING_SIZE / 2;

    return html`
      <svg
        class="export-ring ${indeterminate ? "is-spinning" : ""}"
        width=${RING_SIZE}
        height=${RING_SIZE}
        viewBox="0 0 ${RING_SIZE} ${RING_SIZE}"
        aria-hidden="true"
      >
        <circle
          cx=${centre}
          cy=${centre}
          r=${RING_RADIUS}
          fill="none"
          stroke="#2c3035"
          stroke-width=${RING_STROKE}
        />
        <circle
          cx=${centre}
          cy=${centre}
          r=${RING_RADIUS}
          fill="none"
          stroke="#3d7eff"
          stroke-width=${RING_STROKE}
          stroke-linecap="round"
          stroke-dasharray=${indeterminate
            ? `${array * 0.25} ${array * 0.75}`
            : array}
          stroke-dashoffset=${indeterminate ? 0 : offset}
          transform="rotate(-90 ${centre} ${centre})"
        />
      </svg>
    `;
  }

  private renderPopover(): TemplateResult | null {
    if (this.panelAnchor == null) {
      return null;
    }
    const { phase, percent } = this.exportState;

    return html`
      <div
        class="export-popover"
        role="dialog"
        aria-label="Export progress"
        style="position: fixed; top: 0px; left: 0px; z-index: 6000; visibility: hidden;"
      >
        <div class="export-progress">
          <div
            class="export-progress-bar"
            role="progressbar"
            style="width: ${Math.max(0, Math.min(100, percent))}%"
            aria-valuenow=${Math.round(percent)}
            aria-valuemin="0"
            aria-valuemax="100"
          ></div>
        </div>
        <div class="export-popover-foot">
          <span class="export-remaining">${this.remainingLabel}</span>
          <button
            class="export-stop"
            ?disabled=${phase === "cancelling"}
            title="Stop export"
            aria-label="Stop export"
            @click=${() => cancelExport()}
          >
            <span class="material-symbols-outlined">stop</span>
          </button>
        </div>
      </div>
    `;
  }

  render() {
    const idle = this.exportState.phase === "idle";

    return html`
      <style>
        /*
         * .top-bar is -webkit-app-region: drag, which eats clicks and not just
         * drags: without no-drag a press here moves the window and no click is
         * ever delivered, which looks exactly like a dead handler.
         */
        export-button {
          display: flex;
          align-items: center;
          -webkit-app-region: no-drag;
        }
        .export-trigger {
          -webkit-app-region: no-drag;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 4px;
          height: 20px;
          padding: 0 10px;
          border: 1px solid #3a3f44;
          border-radius: 999px;
          background-color: #1c1f23;
          color: #dedede;
          font-size: 11px;
          font-weight: 600;
          line-height: 1;
        }
        .export-trigger:hover {
          background-color: #2b2f36;
        }
        .export-trigger .export-icon {
          font-size: 13px;
          line-height: 1;
        }
        .export-trigger.is-ring {
          width: ${RING_SIZE}px;
          height: ${RING_SIZE}px;
          padding: 0;
          border: 0;
          border-radius: 50%;
          background-color: transparent;
        }
        .export-ring.is-spinning {
          animation: export-ring-spin 1.1s linear infinite;
          transform-origin: 50% 50%;
        }
        /*
         * The svg spins, never the circle - the arc carries its own
         * rotate(-90) to start at twelve o'clock, and animating the same
         * attribute would fight it.
         */
        @keyframes export-ring-spin {
          to {
            transform: rotate(360deg);
          }
        }
        @media (prefers-reduced-motion: reduce) {
          .export-ring.is-spinning {
            animation: none;
          }
        }

        .export-popover {
          -webkit-app-region: no-drag;
          width: 232px;
          padding: 0.75rem;
          border-radius: 14px;
          /* blur-background-color and blur-backdrop-filter, from sass/var.scss */
          background-color: #25262bba;
          -webkit-backdrop-filter: saturate(120%) blur(8px);
          backdrop-filter: saturate(120%) blur(8px);
          box-shadow: 0 0.5rem 1rem rgb(0 0 0 / 25%);
          color: #dedede;
          font-weight: 400;
        }
        .export-popover-title {
          display: block;
          margin-bottom: 0.6rem;
          font-size: 13px;
          font-weight: 700;
          color: #ffffff;
        }
        .export-progress {
          height: 4px;
          margin-bottom: 0.6rem;
          border-radius: 999px;
          background-color: #2c3035;
          overflow: hidden;
        }
        .export-progress-bar {
          height: 100%;
          border-radius: 999px;
          background-color: #3d7eff;
          transition: width 0.2s linear;
        }
        .export-popover-foot {
          display: flex;
          align-items: center;
          justify-content: space-between;
        }
        .export-remaining {
          font-size: 11px;
          color: #8b9096;
        }
        .export-stop {
          -webkit-app-region: no-drag;
          display: flex;
          align-items: center;
          justify-content: center;
          width: 22px;
          height: 22px;
          padding: 0;
          border: 1px solid #3a3f44;
          border-radius: 6px;
          background-color: #1c1f23;
        }
        .export-stop:hover:not(:disabled) {
          background-color: #2b2f36;
        }
        .export-stop:disabled {
          opacity: 0.45;
          cursor: default;
        }
        .export-stop .material-symbols-outlined {
          font-size: 13px;
          color: #e5484d;
        }
      </style>

      <button
        class="export-trigger ${idle ? "" : "is-ring"}"
        title=${idle ? "Export video" : "Export progress"}
        aria-label=${idle ? "Export video" : "Export progress"}
        @click=${this._handleClickTrigger}
      >
        ${idle
          ? html`<span class="material-symbols-outlined export-icon"
                >ios_share</span
              ><span>Export</span>`
          : this.renderRing()}
      </button>

      ${this.renderPopover()}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "export-button": ExportButton;
  }
}
