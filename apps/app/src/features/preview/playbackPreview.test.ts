import { describe, expect, it } from "vitest";
import {
  CANVAS_BG,
  EDITING,
  PRESENTATION_BG,
  chromeFor,
  enterPlaybackPreview,
  exitPlaybackPreview,
  togglePlaybackPreview,
} from "./playbackPreview";
import { FIT_PADDING_PX, fitViewport, type Viewport } from "./viewport";

/** Somewhere the user got to by hand, so a restore is visibly a restore. */
const ARRANGED: Viewport = { zoom: 437, center: { x: 1234, y: -56 } };

describe("chromeFor", () => {
  it("draws the editing preview as it always did", () => {
    const chrome = chromeFor(false);
    expect(chrome).toEqual({
      frameGuide: true,
      dimOutside: true,
      selection: true,
      background: CANVAS_BG,
      fitPadding: FIT_PADDING_PX,
      pointerInput: true,
    });
  });

  it("turns every piece of chrome off at once for the presentation", () => {
    const chrome = chromeFor(true);
    expect(chrome).toEqual({
      frameGuide: false,
      dimOutside: false,
      selection: false,
      background: PRESENTATION_BG,
      fitPadding: 0,
      pointerInput: false,
    });
  });

  /**
   * The letterbox must not read as a panel edge, which a near-black beside the
   * picture's own black is exactly what does.
   */
  it("presents against true black, not the editing plane's grey", () => {
    expect(PRESENTATION_BG).toBe("#000000");
    expect(chromeFor(true).background).not.toBe(chromeFor(false).background);
  });
});

describe("togglePlaybackPreview", () => {
  it("enters with the frame fitted dead centre", () => {
    const { state, viewport } = togglePlaybackPreview(
      EDITING,
      ARRANGED,
      1920,
      1080,
    );

    expect(state.active).toBe(true);
    expect(viewport).toEqual(fitViewport(1920, 1080));
    expect(viewport.zoom).toBe(100);
    expect(viewport.center).toEqual({ x: 960, y: 540 });
  });

  it("keeps the viewport it was handed, to give back later", () => {
    const { state } = togglePlaybackPreview(EDITING, ARRANGED, 1920, 1080);
    expect(state.restore).toEqual(ARRANGED);
  });

  it("gives the zoom and pan back exactly on the way out", () => {
    const entered = togglePlaybackPreview(EDITING, ARRANGED, 1920, 1080);
    const left = togglePlaybackPreview(
      entered.state,
      entered.viewport,
      1920,
      1080,
    );

    expect(left.state).toBe(EDITING);
    expect(left.viewport).toEqual(ARRANGED);
  });

  /**
   * The reason this module exists.
   *
   * A second enter would write the *presentation* viewport into `restore`, and
   * the zoom and pan the user arranged would be gone for good — with nothing on
   * screen to say so, since the presentation looks identical either way. The
   * store is shared and the button is not the only thing that can ask, so the
   * guard belongs here rather than at the caller.
   */
  it("declines a second enter by identity, keeping the saved viewport", () => {
    const entered = togglePlaybackPreview(EDITING, ARRANGED, 1920, 1080);
    const again = enterPlaybackPreview(
      entered.state,
      entered.viewport,
      1920,
      1080,
    );

    expect(again.state).toBe(entered.state);
    expect(again.state.restore).toEqual(ARRANGED);

    // And leaving after the declined enter still lands back where we were.
    expect(exitPlaybackPreview(again.state, again.viewport).viewport).toEqual(
      ARRANGED,
    );
  });

  it("declines an exit that has nothing to leave", () => {
    const left = exitPlaybackPreview(EDITING, ARRANGED);
    expect(left.state).toBe(EDITING);
    expect(left.viewport).toBe(ARRANGED);
  });

  it("survives a round trip at any resolution", () => {
    for (const [w, h] of [
      [1920, 1080],
      [1080, 1920],
      [640, 640],
    ]) {
      const entered = togglePlaybackPreview(EDITING, ARRANGED, w, h);
      expect(entered.viewport.center).toEqual({ x: w / 2, y: h / 2 });
      expect(
        togglePlaybackPreview(entered.state, entered.viewport, w, h).viewport,
      ).toEqual(ARRANGED);
    }
  });

  /**
   * `restore` cannot be null while active by any path through this module, but
   * it can arrive that way from a hand-edited store or a later caller. Leaving
   * the user where they are beats dropping them somewhere arbitrary.
   */
  it("stays put rather than jumping when there is nothing saved", () => {
    const left = togglePlaybackPreview(
      { active: true, restore: null },
      ARRANGED,
      1920,
      1080,
    );
    expect(left.viewport).toBe(ARRANGED);
    expect(left.state).toBe(EDITING);
  });

  it("never mutates the state it was given", () => {
    const before = { ...EDITING };
    togglePlaybackPreview(EDITING, ARRANGED, 1920, 1080);
    expect(EDITING).toEqual(before);
  });
});
