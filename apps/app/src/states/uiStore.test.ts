import { beforeEach, describe, expect, it } from "vitest";
import {
  HORIZONTAL_LIMITS,
  TIMELINE_LEFT_OPTION_LIMITS,
  VERTICAL_LIMITS,
  uiStore,
} from "./uiStore";

const initial = uiStore.getInitialState().resize;
const reset = () =>
  uiStore.setState({ resize: JSON.parse(JSON.stringify(initial)) });

const horizontal = () => uiStore.getState().resize.horizontal;
const vertical = () => uiStore.getState().resize.vertical;
const leftOption = () => uiStore.getState().resize.timelineVertical.leftOption;

const dragPanel = (to: number) =>
  uiStore.getState().updateHorizontal(to, "panel");
const dragPreview = (to: number) =>
  uiStore.getState().updateHorizontal(to, "preview");

describe("uiStore column limits", () => {
  beforeEach(reset);

  it("keeps the three columns summing to 100 through any drag", () => {
    for (const to of [-500, -1, 0, 12, 37, 64, 99, 100, 640]) {
      dragPanel(to);
      const { panel, preview, option } = horizontal();
      expect(panel + preview + option).toBeCloseTo(100);

      dragPreview(to);
      const after = horizontal();
      expect(after.panel + after.preview + after.option).toBeCloseTo(100);
    }
  });

  it("pins the panel at its min when dragged off the left edge", () => {
    dragPanel(-40);

    expect(horizontal().panel).toBe(HORIZONTAL_LIMITS.panel.min);
  });

  it("stops the panel at its max, and before the preview's min", () => {
    dragPanel(95);

    expect(horizontal().panel).toBeLessThanOrEqual(
      HORIZONTAL_LIMITS.panel.max,
    );
    expect(horizontal().preview).toBeGreaterThanOrEqual(
      HORIZONTAL_LIMITS.preview.min,
    );
  });

  it("never lets the option column vanish or take over", () => {
    dragPreview(140);
    expect(horizontal().option).toBe(HORIZONTAL_LIMITS.option.min);

    dragPreview(-140);
    expect(horizontal().option).toBe(HORIZONTAL_LIMITS.option.max);
  });

  it("keeps the preview above its min from the right-hand divider too", () => {
    dragPanel(HORIZONTAL_LIMITS.panel.max);
    dragPreview(0);

    expect(horizontal().preview).toBeGreaterThanOrEqual(
      HORIZONTAL_LIMITS.preview.min,
    );
    expect(horizontal().panel).toBe(HORIZONTAL_LIMITS.panel.max);
  });
});

describe("uiStore vertical limits", () => {
  beforeEach(reset);

  it("clamps the timeline height at both ends and keeps the split at 100", () => {
    uiStore.getState().updateVertical(-30);
    expect(vertical().bottom).toBe(VERTICAL_LIMITS.bottom.min);
    expect(vertical().top + vertical().bottom).toBe(100);

    uiStore.getState().updateVertical(180);
    expect(vertical().bottom).toBe(VERTICAL_LIMITS.bottom.max);
    expect(vertical().top + vertical().bottom).toBe(100);
  });
});

describe("uiStore track-header width", () => {
  beforeEach(reset);

  it("clamps to the fixed px bounds", () => {
    uiStore.getState().updateTimelineVertical(-100);
    expect(leftOption()).toBe(TIMELINE_LEFT_OPTION_LIMITS.min);

    uiStore.getState().updateTimelineVertical(9000);
    expect(leftOption()).toBe(TIMELINE_LEFT_OPTION_LIMITS.max);
  });

  it("leaves room for the canvas on a narrow window", () => {
    uiStore.getState().updateTimelineVertical(9000, 500);

    expect(leftOption()).toBe(260);
  });

  it("still shows the headers when the window is narrower than they are", () => {
    uiStore.getState().updateTimelineVertical(9000, 200);

    expect(leftOption()).toBe(TIMELINE_LEFT_OPTION_LIMITS.min);
  });
});
