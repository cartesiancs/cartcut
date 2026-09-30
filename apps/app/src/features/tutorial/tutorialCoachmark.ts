import { LitElement, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { LocaleController } from "../../controllers/locale";
import { windowScheduler } from "../caption/previewLoop";
import { ONBOARDING_COMPLETE_EVENT } from "../onboarding/onboardingFlag";
import { browserTutorialEnv } from "./browserEnv";
import { TUTORIAL_MOTION, tutorialMotionStyle } from "./motion";
import {
  createTutorialRunner,
  type CardLayout,
  type CardModel,
  type TutorialRunner,
} from "./runner";
import { TUTORIAL_STEPS, counterLabel, isLastStep } from "./steps";
import {
  TUTORIAL_RESTART_EVENT,
  browserTutorialFlagPort,
} from "./tutorialFlag";

/** Which way the card travels as it arrives: towards its target. */
const ENTER_FROM: Record<string, (px: number) => string> = {
  right: (px) => `${px}px 0`,
  left: (px) => `${-px}px 0`,
  top: (px) => `0 ${-px}px`,
  bottom: (px) => `0 ${px}px`,
  none: (px) => `0 ${px}px`,
};

/**
 * The tutorial's card and the ring around what it points at.
 *
 * Only a view: `runner.ts` decides what to show and where, and this renders the
 * words and writes the position. The position is written straight onto the
 * two elements' styles rather than through the template, so a card following
 * a panel being resized never re-renders.
 *
 * It listens for two things on `window`: the tour finishing, which starts the
 * tutorial for someone who has not seen it, and Help ▸ Show Tutorial, which
 * starts it for anyone.
 *
 * Nothing here captures keys. The tour is modal and swallows every keystroke
 * while it is up; this one is the opposite, because the user has to use the
 * editor to do what it asks.
 */
@customElement("tutorial-coachmark")
export class TutorialCoachmark extends LitElement {
  private lc = new LocaleController(this);

  @state()
  private model: CardModel | null = null;

  private runner: TutorialRunner | null = null;

  /** The last position the runner asked for, re-applied after a render. */
  private layoutNow: CardLayout | null = null;

  /** The step whose entrance has played, so it plays once per step. */
  private enteredStep: number | null = null;

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    this.setAttribute("style", tutorialMotionStyle());

    this.runner = createTutorialRunner({
      env: browserTutorialEnv(),
      view: {
        show: (model) => {
          this.model = model;
          if (model === null) this.enteredStep = null;
        },
        cardSize: () => {
          const card = this.card();
          return card ? { w: card.offsetWidth, h: card.offsetHeight } : null;
        },
        place: (layout) => {
          this.layoutNow = layout;
          this.applyLayout();
        },
      },
      flag: browserTutorialFlagPort,
      scheduler: windowScheduler(),
      now: () => performance.now(),
    });

    window.addEventListener(ONBOARDING_COMPLETE_EVENT, this.handleTourDone);
    window.addEventListener(TUTORIAL_RESTART_EVENT, this.handleRestart);
  }

  disconnectedCallback() {
    window.removeEventListener(ONBOARDING_COMPLETE_EVENT, this.handleTourDone);
    window.removeEventListener(TUTORIAL_RESTART_EVENT, this.handleRestart);
    this.runner?.dispose();
    this.runner = null;
    super.disconnectedCallback();
  }

  // Arrow properties: `removeEventListener` needs the reference it was given.
  private handleTourDone = () => {
    void this.runner?.startIfNew();
  };

  private handleRestart = () => {
    this.runner?.restart();
  };

  private handleNext = (event: MouseEvent) => {
    this.releaseFocus(event);
    this.runner?.next();
  };

  private handleSkip = (event: MouseEvent) => {
    this.releaseFocus(event);
    this.runner?.skip();
  };

  /**
   * A button clicked with the mouse keeps the focus, and the next Space the
   * user presses (to play what they just added) would press it again. A
   * button pressed from the keyboard keeps its focus, so the keyboard user
   * can carry on from it.
   */
  private releaseFocus(event: MouseEvent) {
    if (event.detail > 0) (event.currentTarget as HTMLElement | null)?.blur();
  }

  /**
   * Keys pressed inside the card are the card's. Escape skips, and nothing
   * the card handles reaches the editor's shortcuts, where Space would start
   * playback and Enter could commit something.
   */
  private handleKeydown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.runner?.skip();
      return;
    }
    if (event.key === " " || event.key === "Enter") event.stopPropagation();
  };

  private card(): HTMLElement | null {
    return this.querySelector<HTMLElement>(".tutorial-card");
  }

  private ring(): HTMLElement | null {
    return this.querySelector<HTMLElement>(".tutorial-ring");
  }

  private applyLayout() {
    const card = this.card();
    const ring = this.ring();
    if (!card || !ring) return;

    const layout = this.layoutNow;
    if (layout === null) {
      card.removeAttribute("data-placed");
      ring.removeAttribute("data-placed");
      return;
    }

    const { card: at, ring: around } = layout;
    card.style.transform = `translate3d(${at.left}px, ${at.top}px, 0)`;
    card.style.setProperty("--tutorial-arrow", `${at.arrow}px`);
    card.dataset.side = at.overlaps ? "none" : at.side;
    card.dataset.placed = "";

    if (around) {
      ring.style.transform = `translate3d(${around.left}px, ${around.top}px, 0)`;
      ring.style.width = `${around.width}px`;
      ring.style.height = `${around.height}px`;
      ring.dataset.placed = "";
    } else {
      ring.removeAttribute("data-placed");
    }
  }

  /**
   * Runs before the browser paints, so a card whose words just changed is
   * measured and moved before anyone sees it at its old size.
   */
  protected updated() {
    this.applyLayout();
    this.runner?.layout();

    const model = this.model;
    const card = this.card();
    if (!model || model.hidden || !card || this.enteredStep === model.step) {
      return;
    }
    this.enteredStep = model.step;

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const from = ENTER_FROM[card.dataset.side ?? "none"] ?? ENTER_FROM.none;
    // The independent `translate` property, so the entrance composes with the
    // `transform` that places the card instead of fighting it.
    card.animate(
      [
        { opacity: 0, translate: from(TUTORIAL_MOTION.enterFromPx) },
        { opacity: 1, translate: "0 0" },
      ],
      { duration: TUTORIAL_MOTION.enterMs, easing: TUTORIAL_MOTION.enterEase },
    );
  }

  render() {
    const model = this.model;
    if (!model) return nothing;

    const step = TUTORIAL_STEPS[model.step];
    const done = model.phase === "done";
    const last = isLastStep(model.step);

    return html`
      <div
        class="tutorial-ring ${done ? "is-done" : ""}"
        ?hidden=${model.hidden}
        aria-hidden="true"
      ></div>

      <!-- data-keeps-selection: pressing Next must not deselect the clip the
           user just added, which a mousedown anywhere else in the document
           does. -->
      <div
        class="tutorial-card ${done ? "is-done" : ""}"
        ?hidden=${model.hidden}
        role="dialog"
        aria-modal="false"
        aria-labelledby="tutorial-title"
        data-keeps-selection
        @keydown=${this.handleKeydown}
      >
        <span class="tutorial-arrow" aria-hidden="true"></span>

        <div class="tutorial-head">
          <span class="tutorial-count">${counterLabel(model.step)}</span>
          <span class="tutorial-check" aria-hidden=${done ? "false" : "true"}>
            <span class="material-symbols-outlined">check</span>
            ${this.lc.t("tutorial.done")}
          </span>
        </div>

        <div class="tutorial-content" aria-live="polite">
          <div id="tutorial-title" class="tutorial-title">
            ${this.lc.t(step.titleKey)}
          </div>
          <p class="tutorial-body">${this.lc.t(step.bodyKey)}</p>
          ${model.hintKey
            ? html`<p class="tutorial-hint">
                <span class="material-symbols-outlined">info</span>
                <span>${this.lc.t(model.hintKey)}</span>
              </p>`
            : nothing}
        </div>

        <div class="tutorial-actions">
          <button type="button" class="tutorial-skip" @click=${this.handleSkip}>
            ${this.lc.t("tutorial.skip")}
          </button>
          <button type="button" class="tutorial-next" @click=${this.handleNext}>
            ${this.lc.t(last ? "tutorial.finish" : "tutorial.next")}
            <span class="material-symbols-outlined" aria-hidden="true">
              ${last ? "check" : "arrow_forward"}
            </span>
          </button>
        </div>
      </div>
    `;
  }
}
