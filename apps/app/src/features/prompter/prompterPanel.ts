/**
 * The Prompter window: type a script, press Next, read it off the screen.
 *
 * Two pages and nothing else. The script page is an input and a Next button;
 * the prompter page is the script in large type moving up past a reading line,
 * with Exit and a speed control under it. Exit goes back to the script page
 * with the text still there, so a take can be fixed and read again.
 *
 * Renders into the light DOM like every other component here, because the
 * global stylesheet does not cross a shadow boundary.
 *
 * **Every handler is an arrow property.** `Control` builds this panel's
 * template and `<app-window>` renders it, so Lit's listener host is the window
 * and a plain method would bind `this` to the wrong component. CLAUDE.md
 * records `changeCursorType` dying silently that way.
 *
 * The loop and its arithmetic are `prompterSession.ts` and `prompterScroll.ts`;
 * this file measures the stage, paints one transform, and draws the chrome.
 */

import { LitElement, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { live } from "lit/directives/live.js";

import { windowScheduler } from "../caption/previewLoop";
import {
  browserPrompterStorage,
  loadPrompterSpeed,
  savePrompterSpeed,
} from "./prompterPref";
import { stepSpeed } from "./prompterScroll";
import { PrompterSession, type PrompterMeasure } from "./prompterSession";

/**
 * The script, kept beside the element rather than in it.
 *
 * Closing the window unmounts the panel, and Text to Speech loses what was
 * typed into it that way. A script is longer and more tedious to retype, so it
 * outlives the element for the rest of the app session. It is not written to
 * disk: the project is the place for anything that should survive a restart.
 */
let draft = "";

type Page = "script" | "prompter";

@customElement("prompter-panel")
export class PrompterPanel extends LitElement {
  @state() private page: Page = "script";
  @state() private script = draft;
  @state() private speed = loadPrompterSpeed(browserPrompterStorage);
  @state() private paused = false;
  @state() private finished = false;

  /** Set by Next, consumed by `updated` once the stage exists to measure. */
  private startPending = false;

  private session = new PrompterSession({
    scheduler: windowScheduler(),
    now: () => performance.now(),
    measure: () => this.measure(),
    apply: (offset) => {
      const text = this.querySelector<HTMLElement>(".prompter-text");
      if (text != null) {
        text.style.transform = `translate3d(0, ${-offset}px, 0)`;
      }
    },
    onState: (next) => {
      this.paused = next.paused;
      this.finished = next.finished;
    },
  });

  /**
   * The splitter, a second tab docking beside this one, the app window: any of
   * them resizes the stage while the script may be paused, when no frame runs
   * to notice. The host fills the pane, so its box changes whenever the
   * stage's does.
   */
  private resizeObserver: ResizeObserver | null = null;

  createRenderRoot() {
    return this;
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.resizeObserver = new ResizeObserver(() => this.session.relayout());
    this.resizeObserver.observe(this);
  }

  /**
   * Closing the window lands here, and so would any re-parenting of the pane.
   * A loop left running would keep painting into a detached element, and a
   * reattached panel on the prompter page with no loop would read as frozen,
   * so the panel goes back to its first page instead.
   */
  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.session.stop();
    this.page = "script";
  }

  protected updated(): void {
    if (this.startPending) {
      this.startPending = false;
      this.session.start(this.speed);
    }
  }

  private measure(): PrompterMeasure {
    const stage = this.querySelector<HTMLElement>(".prompter-stage");
    const text = this.querySelector<HTMLElement>(".prompter-text");
    if (stage == null || text == null) {
      return { content: 0, viewport: 0, line: 0 };
    }
    return {
      // `offsetHeight` is the laid-out box, which the transform does not
      // change, so reading it does not feed back into the next frame.
      content: text.offsetHeight,
      viewport: stage.clientHeight,
      // Chromium resolves a unitless `line-height` to pixels here.
      line: Number.parseFloat(getComputedStyle(text).lineHeight) || 0,
    };
  }

  private handleInput = (event: Event): void => {
    this.script = (event.target as HTMLTextAreaElement).value;
    draft = this.script;
  };

  private handleNext = (): void => {
    if (this.script.trim().length === 0) {
      return;
    }
    this.page = "prompter";
    this.startPending = true;
  };

  private handleExit = (): void => {
    this.session.stop();
    this.page = "script";
  };

  private handleStageClick = (): void => {
    this.session.togglePause();
  };

  /**
   * Passive, as a listener object: the stage has nothing to scroll natively,
   * so there is no default to prevent, and a non-passive wheel listener makes
   * Chromium wait on it before every scroll it composites.
   */
  private wheelListener = {
    handleEvent: (event: WheelEvent): void => {
      this.session.nudge(event.deltaY);
    },
    passive: true,
  };

  private changeSpeed(direction: -1 | 1): void {
    const next = stepSpeed(this.speed, direction);
    if (next === this.speed) {
      return;
    }
    this.speed = next;
    this.session.setSpeed(next);
    savePrompterSpeed(browserPrompterStorage, next);
  }

  private handleSlower = (): void => this.changeSpeed(-1);
  private handleFaster = (): void => this.changeSpeed(1);

  private renderScript() {
    const empty = this.script.trim().length === 0;
    return html`
      <div class="prompter-body">
        <textarea
          class="prompter-input"
          spellcheck="false"
          placeholder="Type or paste the script to read."
          aria-label="Script"
          .value=${live(this.script)}
          @input=${this.handleInput}
        ></textarea>
      </div>
      <div class="prompter-bar">
        <button
          type="button"
          class="prompter-btn is-primary is-trailing"
          aria-event="prompter-next"
          ?disabled=${empty}
          @click=${this.handleNext}
        >
          Next
          <span class="material-symbols-outlined" aria-hidden="true"
            >arrow_forward</span
          >
        </button>
      </div>
    `;
  }

  private renderHint() {
    if (!this.paused && !this.finished) {
      return nothing;
    }
    const [icon, label] = this.finished
      ? ["replay", "End. Click to start over."]
      : ["pause", "Paused. Click to resume."];
    return html`<div class="prompter-hint">
      <span class="material-symbols-outlined" aria-hidden="true">${icon}</span>
      ${label}
    </div>`;
  }

  private renderPrompter() {
    // Trimmed so the first line, not a blank one, starts on the reading line.
    // The text node sits flush against both tags: the column is `pre-wrap`,
    // so any whitespace in the template here would be drawn.
    const text = this.script.trim();
    return html`
      <div
        class="prompter-stage"
        aria-event="prompter-stage"
        @click=${this.handleStageClick}
        @wheel=${this.wheelListener}
      >
        <div class="prompter-viewport">
          <div class="prompter-text">${text}</div>
        </div>
        <span class="material-symbols-outlined prompter-mark" aria-hidden="true"
          >play_arrow</span
        >
        ${this.renderHint()}
      </div>
      <div class="prompter-bar is-split">
        <button
          type="button"
          class="prompter-btn"
          aria-event="prompter-exit"
          @click=${this.handleExit}
        >
          <span class="material-symbols-outlined" aria-hidden="true">close</span>
          Exit
        </button>
        <div class="prompter-speed" role="group" aria-label="Scroll speed">
          <button
            type="button"
            class="opt-icon-btn"
            title="Slower"
            aria-label="Slower"
            ?disabled=${stepSpeed(this.speed, -1) === this.speed}
            @click=${this.handleSlower}
          >
            <span class="material-symbols-outlined">remove</span>
          </button>
          <span class="opt-value prompter-speed-value"
            >${this.speed.toFixed(1)}x</span
          >
          <button
            type="button"
            class="opt-icon-btn"
            title="Faster"
            aria-label="Faster"
            ?disabled=${stepSpeed(this.speed, 1) === this.speed}
            @click=${this.handleFaster}
          >
            <span class="material-symbols-outlined">add</span>
          </button>
        </div>
      </div>
    `;
  }

  render() {
    return html`<div class="prompter-panel">
      ${this.page === "script" ? this.renderScript() : this.renderPrompter()}
    </div>`;
  }
}
