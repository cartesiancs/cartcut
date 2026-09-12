/**
 * A progress modal that survives finishing too quickly.
 *
 * Bootstrap's `Modal.hide()` returns without doing anything while the modal is
 * still running its show transition. Measured in this app: `show()` followed
 * immediately by `hide()` leaves the modal on screen **permanently** — a second
 * `hide()` once the transition has ended is what closes it.
 *
 * That is not a corner case for a progress modal. The auto-caption panel showed
 * "Extracting audio…" and then hid it when transcription returned, and a
 * transcription served from the disk cache returns in about a millisecond. The
 * modal stayed up, invisible underneath the fullscreen editing panel, and was
 * revealed the moment the user dismissed that panel — so finishing an edit
 * appeared to reopen "Extracting audio…".
 *
 * Two rules, and the first is the one that matters for how it feels:
 *
 * - **Nothing is shown until the work has lasted `delayMs`.** Work that
 *   finishes sooner never flashes a dialog at all, which is what a cache is
 *   for.
 * - **A close is honoured even if it lands mid-transition**, by hiding again on
 *   `shown.bs.modal`.
 *
 * Bootstrap is reached only through `ModalLike` and `ModalEvents`, so this runs
 * under `environment: "node"` against a fake.
 */

/** The part of `bootstrap.Modal` this needs. */
export type ModalLike = {
  show(): void;
  hide(): void;
};

/** The modal's DOM element, which is where Bootstrap fires its lifecycle events. */
export type ModalEvents = {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
};

/**
 * Long enough that a cached result never flashes a dialog, short enough that
 * real work does not look unacknowledged.
 */
export const DEFAULT_SHOW_DELAY_MS = 180;

export class TransientModal {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private shown = false;
  private pendingHide: (() => void) | null = null;

  constructor(
    private readonly modal: ModalLike,
    private readonly element: ModalEvents,
    private readonly delayMs: number = DEFAULT_SHOW_DELAY_MS,
  ) {}

  /** True once the modal has actually been shown. For tests and assertions. */
  get isShown(): boolean {
    return this.shown;
  }

  /** True while a show is armed but has not fired. */
  get isPending(): boolean {
    return this.timer != null;
  }

  /** Arm the modal. It appears only if `close` has not come first. */
  open(): void {
    if (this.shown || this.timer != null) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.shown = true;
      this.modal.show();
    }, this.delayMs);
  }

  /** Close it, whether it is armed, mid-transition, or settled. */
  close(): void {
    if (this.timer != null) {
      clearTimeout(this.timer);
      this.timer = null;
      return;
    }
    if (!this.shown) {
      return;
    }
    this.shown = false;

    // Hide now in case the transition has already finished, and again on
    // `shown` in case it has not — Bootstrap drops the first one silently.
    this.armHideOnShown();
    this.modal.hide();
  }

  /** Drop any listener this holds. Call from `disconnectedCallback`. */
  dispose(): void {
    if (this.timer != null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.clearPendingHide();
  }

  private armHideOnShown(): void {
    this.clearPendingHide();

    const onShown = () => {
      this.clearPendingHide();
      // Unless `open` was called again while the transition was running, in
      // which case the modal is wanted after all.
      if (!this.shown) {
        this.modal.hide();
      }
    };
    // If the immediate `hide` did land, the modal ends up hidden and no `shown`
    // is coming — this is what stops the listener outliving the gesture.
    const onHidden = () => this.clearPendingHide();

    this.pendingHide = () => {
      this.element.removeEventListener("shown.bs.modal", onShown);
      this.element.removeEventListener("hidden.bs.modal", onHidden);
    };
    this.element.addEventListener("shown.bs.modal", onShown);
    this.element.addEventListener("hidden.bs.modal", onHidden);
  }

  private clearPendingHide(): void {
    const remove = this.pendingHide;
    this.pendingHide = null;
    remove?.();
  }
}
