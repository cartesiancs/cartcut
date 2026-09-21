import { LitElement, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { LocaleController } from "../../controllers/locale";
import { ONBOARDING_STEPS, nextStep } from "./steps";
import {
  ONBOARDING_RESTART_EVENT,
  browserOnboardingFlagPort,
  isOnboardingComplete,
  markOnboardingComplete,
} from "./onboardingFlag";
import { FADE_MS, ONBOARDING_MOTION, onboardingMotionStyle } from "./motion";

/**
 * Every duration and curve is `motion.ts`, handed to the stylesheet as custom
 * properties on the scrim. Nothing here hardcodes a time that CSS also knows:
 * the transitions and the timers that wait for them cannot drift apart.
 */
const MOTION_STYLE = onboardingMotionStyle();

/**
 * The first-run tour: five cards over a dimmed editor, shown once and then
 * remembered.
 *
 * Light DOM, like the rest of the app's components — the styles live in
 * `sass/style/_onboarding.scss` so they can reach the element the same way
 * every other rule in the sheet does.
 */
@customElement("onboarding-overlay")
export class OnboardingOverlay extends LitElement {
  private lc = new LocaleController(this);

  @state()
  private visible = false;

  @state()
  private stepIndex = 0;

  /** Set while the card's contents are faded out, between two steps. */
  @state()
  private swapping = false;

  /** Set while the whole overlay is fading out, just before it unmounts. */
  @state()
  private leaving = false;

  /**
   * Set for one step's worth of arrival, which is what puts the art's entrance
   * animation on it.
   *
   * A CSS animation restarts when the class carrying it is taken off and put
   * back, so this has to be false between steps rather than simply true on
   * every one. `_goTo` clears it as the outgoing card starts to fade, which is
   * both far enough ahead of the next render to count as a separate frame and
   * behind a fade that is already underway.
   */
  @state()
  private entering = false;

  private swapTimer: number | null = null;
  private leaveTimer: number | null = null;
  private enterTimer: number | null = null;

  private boundKeydown = this._handleKeydown.bind(this);

  /**
   * Puts the tour back from the first card, whatever it was doing.
   *
   * Settings ▸ Reset onboarding clears the flag and fires this; the two are
   * separate so neither has to know the other happened, and firing it on a
   * build where the flag could not be cleared still shows the tour.
   *
   * An arrow property, not a method: `removeEventListener` needs the same
   * reference `addEventListener` was given.
   */
  private handleRestart = () => {
    this._clearTimers();
    this.swapping = false;
    this.leaving = false;
    this.entering = false;
    this.stepIndex = 0;
    // From false, this re-inserts the scrim, which is what re-runs its
    // fade-in animation.
    this.visible = true;
    this._beginEntrance();
  };

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    // Captured on `window` so it runs ahead of the editor's own shortcuts,
    // which all listen in the bubble phase (`previewCanvas`, `keyframeEditor`,
    // `elementTimelineCanvas`, `Timeline`). While the tour is up, space must
    // not start playback behind it.
    window.addEventListener("keydown", this.boundKeydown, true);
    window.addEventListener(ONBOARDING_RESTART_EVENT, this.handleRestart);
    this._decideVisibility();
  }

  disconnectedCallback() {
    window.removeEventListener("keydown", this.boundKeydown, true);
    window.removeEventListener(ONBOARDING_RESTART_EVENT, this.handleRestart);
    this._clearTimers();
    super.disconnectedCallback();
  }

  private _clearTimers() {
    if (this.swapTimer !== null) window.clearTimeout(this.swapTimer);
    if (this.leaveTimer !== null) window.clearTimeout(this.leaveTimer);
    if (this.enterTimer !== null) window.clearTimeout(this.enterTimer);
    this.swapTimer = null;
    this.leaveTimer = null;
    this.enterTimer = null;
  }

  /**
   * Arms the arriving card's entrance for exactly as long as it runs.
   *
   * One timer for all three directions: `enterMs` is the longest of them, and
   * the class only has to outlast whichever animation is actually playing.
   */
  private _beginEntrance() {
    if (this.enterTimer !== null) window.clearTimeout(this.enterTimer);

    this.entering = true;
    this.enterTimer = window.setTimeout(() => {
      this.entering = false;
      this.enterTimer = null;
    }, ONBOARDING_MOTION.enterMs);
  }

  /** Where the flag lives, and what a refused store means, is `onboardingFlag.ts`. */
  private async _decideVisibility() {
    if (await isOnboardingComplete(browserOnboardingFlagPort)) return;

    // The scrim fades itself in: it carries a CSS animation that runs the
    // moment it is inserted, which is right now.
    this.visible = true;
    this._beginEntrance();
  }

  /**
   * Fades the card's contents out, swaps the step underneath, and lets them
   * fade back in. Re-entrant clicks are dropped rather than queued — a fast
   * double-click on Next should not skip a card.
   */
  private _goTo(index: number) {
    if (this.swapping || this.leaving || index === this.stepIndex) return;

    this.swapping = true;
    // Cleared here, not on arrival: see the field's note.
    this.entering = false;
    this.swapTimer = window.setTimeout(() => {
      this.stepIndex = index;
      this.swapping = false;
      this.swapTimer = null;
      this._beginEntrance();
    }, FADE_MS);
  }

  /**
   * The flag is written straight away; only the unmount waits for the fade, so
   * a close that races a quit still records itself.
   */
  private _complete() {
    if (this.leaving) return;

    // Never rejects, so there is nothing here to catch.
    void markOnboardingComplete(browserOnboardingFlagPort);
    this.leaving = true;
    this.leaveTimer = window.setTimeout(() => {
      this.visible = false;
      this.leaving = false;
      this.leaveTimer = null;
    }, FADE_MS);
  }

  private _handleNext() {
    if (ONBOARDING_STEPS[this.stepIndex].isLast) {
      this._complete();
      return;
    }
    this._goTo(nextStep(this.stepIndex));
  }

  private _handleKeydown(event: KeyboardEvent) {
    if (!this.visible) return;

    // The tour is modal: nothing behind it should see a key at all.
    event.stopImmediatePropagation();
    event.preventDefault();

    if (event.key === "Escape") {
      this._complete();
      return;
    }

    if (event.key === "Enter") {
      this._handleNext();
    }
  }

  render() {
    if (!this.visible) return nothing;

    const step = ONBOARDING_STEPS[this.stepIndex];
    const isLast = step.isLast;

    return html`
      <div
        class="onboarding-scrim ${this.leaving ? "is-leaving" : ""}"
        style=${MOTION_STYLE}
      >
        <div
          class="onboarding-card"
          role="dialog"
          aria-modal="true"
          aria-label="CartCut onboarding"
        >
          <!-- Drawn in the order the design stacks them: the art first, the
               gradient that sinks it into the card over that, and the words on
               top of both. -->
          <div
            class="onboarding-content ${this.swapping ? "is-swapping" : ""}"
          >
            <img
              class="onboarding-art ${step.art.left === undefined
                ? ""
                : "onboarding-art--placed"} ${step.art.enter
                ? `onboarding-art--from-${step.art.enter}`
                : ""} ${this.entering ? "is-entering" : ""}"
              style="top: ${step.art.top}px;${step.art.left === undefined
                ? ""
                : ` left: ${step.art.left}px;`}"
              src="${step.art.src}"
              width="${step.art.width}"
              height="${step.art.height}"
              alt=""
              draggable="false"
            />

            ${step.scrim
              ? html`<div
                  class="onboarding-art-fade"
                  style="top: ${step.scrim.top}px; --onboarding-art-fade-from: ${step
                    .scrim.fadeFrom}%;"
                ></div>`
              : nothing}
            ${step.titleKey
              ? html`<h2 class="onboarding-title">
                  ${this.lc.t(step.titleKey)}
                </h2>`
              : nothing}
            ${step.subtitleKey
              ? html`<p class="onboarding-subtitle">
                  ${this.lc.t(step.subtitleKey)}
                </p>`
              : nothing}
          </div>

          <!--
            Outside the crossfading content on purpose: the buttons hold still
            while what is above them is swapped.

            Both buttons and both labels are always rendered, and the last card
            only changes their classes. That is what lets the pair *become* the
            Finish button rather than being replaced by it: Lit keeps the same
            elements, so Skip has an opacity to fade, Next has a width to
            spring open, and its two labels have something to cross-fade
            between. Rendering one branch or the other would swap the DOM out
            and there would be nothing left to animate.
          -->
          <div class="onboarding-actions">
            <button
              class="onboarding-secondary ${isLast ? "is-gone" : ""}"
              tabindex=${isLast ? -1 : 0}
              aria-hidden=${isLast ? "true" : "false"}
              @click=${this._complete}
            >
              ${this.lc.t("onboarding.skip")}
            </button>

            <button
              class="onboarding-next ${isLast ? "onboarding-next--wide" : ""}"
              @click=${this._handleNext}
            >
              <span class="onboarding-next-label ${isLast ? "is-hidden" : ""}">
                ${this.lc.t("onboarding.next")}
              </span>
              <span class="onboarding-next-label ${isLast ? "" : "is-hidden"}">
                ${this.lc.t("onboarding.finish")}
              </span>
            </button>
          </div>
        </div>
      </div>
    `;
  }
}
