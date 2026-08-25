import { LitElement, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { LocaleController } from "../../controllers/locale";
import {
  ONBOARDING_STEPS,
  ONBOARDING_STORE_KEY,
  nextStep,
  prevStep,
} from "./steps";

/**
 * How long a fade lasts, in ms.
 *
 * The stylesheet does not hardcode this: it is handed to the CSS as
 * `--onboarding-fade` on the scrim, so the transitions and the timers that
 * wait for them cannot drift apart.
 */
const FADE_MS = 200;

/**
 * The first-run tour: four cards over a dimmed editor, shown once and then
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

  private swapTimer: number | null = null;
  private leaveTimer: number | null = null;

  private boundKeydown = this._handleKeydown.bind(this);

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
    this._decideVisibility();
  }

  disconnectedCallback() {
    window.removeEventListener("keydown", this.boundKeydown, true);
    this._clearTimers();
    super.disconnectedCallback();
  }

  private _clearTimers() {
    if (this.swapTimer !== null) window.clearTimeout(this.swapTimer);
    if (this.leaveTimer !== null) window.clearTimeout(this.leaveTimer);
    this.swapTimer = null;
    this.leaveTimer = null;
  }

  /**
   * `electron-store` is the record that matters, but the web and demo builds
   * stub `store.get` out to a string, so the flag is mirrored into
   * `localStorage`. Either one saying "done" is enough; a browser that refuses
   * storage just means the tour shows again, never a crash.
   */
  private async _decideVisibility() {
    if (this._readLocalFlag()) return;

    try {
      const stored = await window.electronAPI.req.store.get(
        ONBOARDING_STORE_KEY,
      );
      if (stored?.value === true) return;
    } catch (error) {
      console.warn("onboarding: could not read the completion flag", error);
    }

    // The scrim fades itself in: it carries a CSS animation that runs the
    // moment it is inserted, which is right now.
    this.visible = true;
  }

  private _readLocalFlag(): boolean {
    try {
      return window.localStorage.getItem(ONBOARDING_STORE_KEY) === "true";
    } catch {
      return false;
    }
  }

  private _persist() {
    try {
      window.localStorage.setItem(ONBOARDING_STORE_KEY, "true");
    } catch {
      // A build without storage still gets a working tour, just not a
      // remembered one.
    }

    window.electronAPI.req.store
      .set(ONBOARDING_STORE_KEY, true)
      ?.catch?.((error) =>
        console.warn("onboarding: could not persist the completion flag", error),
      );
  }

  /**
   * Fades the card's contents out, swaps the step underneath, and lets them
   * fade back in. Re-entrant clicks are dropped rather than queued — a fast
   * double-click on Next should not skip a card.
   */
  private _goTo(index: number) {
    if (this.swapping || this.leaving || index === this.stepIndex) return;

    this.swapping = true;
    this.swapTimer = window.setTimeout(() => {
      this.stepIndex = index;
      this.swapping = false;
      this.swapTimer = null;
    }, FADE_MS);
  }

  /**
   * The flag is written straight away; only the unmount waits for the fade, so
   * a close that races a quit still records itself.
   */
  private _complete() {
    if (this.leaving) return;

    this._persist();
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

  private _handlePrev() {
    this._goTo(prevStep(this.stepIndex));
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

    return html`
      <div
        class="onboarding-scrim ${this.leaving ? "is-leaving" : ""}"
        style="--onboarding-fade: ${FADE_MS}ms;"
      >
        <div
          class="onboarding-card"
          role="dialog"
          aria-modal="true"
          aria-label="Cartcut onboarding"
        >
          <div
            class="onboarding-content ${this.swapping ? "is-swapping" : ""}"
          >
            ${step.titleKey
              ? html`<h2 class="onboarding-title">
                  ${this.lc.t(step.titleKey)}
                </h2>`
              : nothing}

            <img
              class="onboarding-art"
              style="top: ${step.art.top}px;"
              src="${step.art.src}"
              width="${step.art.width}"
              height="${step.art.height}"
              alt=""
              draggable="false"
            />

            ${step.subtitleKey
              ? html`<p class="onboarding-subtitle">
                  ${this.lc.t(step.subtitleKey)}
                </p>`
              : nothing}

            <div class="onboarding-actions">
              ${step.isLast
                ? html`<button
                    class="onboarding-next onboarding-next--wide"
                    @click=${this._handleNext}
                  >
                    ${this.lc.t("onboarding.finish")}
                  </button>`
                : html`
                    <!-- The first card has nothing to go back to, so it offers
                         the way out instead. -->
                    ${this.stepIndex === 0
                      ? html`<button
                          class="onboarding-secondary"
                          @click=${this._complete}
                        >
                          ${this.lc.t("onboarding.skip")}
                        </button>`
                      : html`<button
                          class="onboarding-secondary"
                          @click=${this._handlePrev}
                        >
                          ${this.lc.t("onboarding.prev")}
                        </button>`}
                    <button class="onboarding-next" @click=${this._handleNext}>
                      ${this.lc.t("onboarding.next")}
                    </button>
                  `}
            </div>
          </div>
        </div>
      </div>
    `;
  }
}
