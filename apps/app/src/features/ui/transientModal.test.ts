import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SHOW_DELAY_MS,
  TransientModal,
  type ModalLike,
} from "./transientModal";

/**
 * A stand-in for `bootstrap.Modal` plus its element.
 *
 * It reproduces the one behaviour that matters: **`hide()` does nothing while
 * the show transition is running.** Measured against the vendored Bootstrap
 * 5.0.2 in this app — `show()` then `hide()` on the next tick leaves the modal
 * on screen permanently.
 */
function fakeBootstrapModal() {
  const element = new EventTarget();
  let state: "hidden" | "showing" | "shown" = "hidden";
  const calls: string[] = [];

  const modal: ModalLike = {
    show() {
      calls.push("show");
      if (state !== "hidden") {
        return;
      }
      state = "showing";
    },
    hide() {
      calls.push("hide");
      // The guard this whole module exists for.
      if (state !== "shown") {
        return;
      }
      state = "hidden";
      element.dispatchEvent(new Event("hidden.bs.modal"));
    },
  };

  return {
    modal,
    element,
    calls,
    /** Let the show transition finish, as Bootstrap does after ~300ms. */
    finishShowing() {
      if (state === "showing") {
        state = "shown";
        element.dispatchEvent(new Event("shown.bs.modal"));
      }
    },
    get visible() {
      return state !== "hidden";
    },
    get listenerCount() {
      // EventTarget gives no count, so probe by dispatching into a spy instead.
      return null;
    },
  };
}

describe("TransientModal", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("never shows for work that finishes inside the delay", () => {
    // A transcript served from the disk cache returns in about a millisecond.
    // Flashing a dialog for it is what a cache is meant to avoid.
    const bs = fakeBootstrapModal();
    const gate = new TransientModal(bs.modal, bs.element);

    gate.open();
    gate.close();
    vi.advanceTimersByTime(1000);

    expect(bs.calls).toEqual([]);
    expect(bs.visible).toBe(false);
    expect(gate.isShown).toBe(false);
  });

  it("shows once the work outlasts the delay", () => {
    const bs = fakeBootstrapModal();
    const gate = new TransientModal(bs.modal, bs.element);

    gate.open();
    expect(gate.isPending).toBe(true);
    vi.advanceTimersByTime(DEFAULT_SHOW_DELAY_MS);

    expect(bs.calls).toEqual(["show"]);
    expect(gate.isShown).toBe(true);
  });

  it("closes a modal asked to hide mid-transition", () => {
    // The reported bug: the modal stayed up, hidden behind the fullscreen
    // editing panel, and reappeared the moment that panel was dismissed.
    const bs = fakeBootstrapModal();
    const gate = new TransientModal(bs.modal, bs.element);

    gate.open();
    vi.advanceTimersByTime(DEFAULT_SHOW_DELAY_MS);
    gate.close();

    // Bootstrap dropped that hide, exactly as the real one does.
    expect(bs.visible).toBe(true);

    bs.finishShowing();
    expect(bs.visible).toBe(false);
  });

  it("closes immediately when the transition has already finished", () => {
    const bs = fakeBootstrapModal();
    const gate = new TransientModal(bs.modal, bs.element);

    gate.open();
    vi.advanceTimersByTime(DEFAULT_SHOW_DELAY_MS);
    bs.finishShowing();
    gate.close();

    expect(bs.visible).toBe(false);
  });

  it("stays open when reopened during the transition", () => {
    // A second piece of work starting before the first modal settled must not
    // be closed by the first one's deferred hide.
    const bs = fakeBootstrapModal();
    const gate = new TransientModal(bs.modal, bs.element);

    gate.open();
    vi.advanceTimersByTime(DEFAULT_SHOW_DELAY_MS);
    gate.close();
    gate.open();
    vi.advanceTimersByTime(DEFAULT_SHOW_DELAY_MS);

    bs.finishShowing();
    expect(bs.visible).toBe(true);
  });

  it("is idempotent", () => {
    const bs = fakeBootstrapModal();
    const gate = new TransientModal(bs.modal, bs.element);

    gate.open();
    gate.open();
    vi.advanceTimersByTime(DEFAULT_SHOW_DELAY_MS);
    expect(bs.calls.filter((c) => c === "show")).toHaveLength(1);

    bs.finishShowing();
    gate.close();
    gate.close();
    expect(bs.visible).toBe(false);
  });

  it("closing without opening does nothing", () => {
    const bs = fakeBootstrapModal();
    const gate = new TransientModal(bs.modal, bs.element);

    gate.close();
    vi.advanceTimersByTime(1000);
    expect(bs.calls).toEqual([]);
  });

  it("leaves no listener behind once the modal has hidden", () => {
    const bs = fakeBootstrapModal();
    const gate = new TransientModal(bs.modal, bs.element);

    gate.open();
    vi.advanceTimersByTime(DEFAULT_SHOW_DELAY_MS);
    bs.finishShowing();
    gate.close();

    // A later stray `shown` must not drive a hide on a modal nobody opened.
    bs.calls.length = 0;
    bs.element.dispatchEvent(new Event("shown.bs.modal"));
    expect(bs.calls).toEqual([]);
  });

  it("dispose cancels an armed show", () => {
    const bs = fakeBootstrapModal();
    const gate = new TransientModal(bs.modal, bs.element);

    gate.open();
    gate.dispose();
    vi.advanceTimersByTime(1000);

    expect(bs.calls).toEqual([]);
  });

  it("honours a custom delay", () => {
    const bs = fakeBootstrapModal();
    const gate = new TransientModal(bs.modal, bs.element, 500);

    gate.open();
    vi.advanceTimersByTime(499);
    expect(bs.calls).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(bs.calls).toEqual(["show"]);
  });
});
