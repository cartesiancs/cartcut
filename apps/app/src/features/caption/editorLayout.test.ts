import { describe, expect, it } from "vitest";

import {
  CAPTION_EDITOR_BREAKPOINT_PX,
  captionEditorLayout,
} from "./editorLayout";

describe("captionEditorLayout", () => {
  it("splits into two columns once there is room for both", () => {
    expect(captionEditorLayout({ width: 680, height: 400 }).columns).toBe("two");
  });

  it("stacks below the breakpoint", () => {
    expect(captionEditorLayout({ width: 360, height: 400 }).columns).toBe("one");
  });

  it("switches exactly at the breakpoint, inclusive", () => {
    expect(
      captionEditorLayout({ width: CAPTION_EDITOR_BREAKPOINT_PX, height: 400 }).columns,
    ).toBe("two");
    expect(
      captionEditorLayout({ width: CAPTION_EDITOR_BREAKPOINT_PX - 1, height: 400 }).columns,
    ).toBe("one");
  });

  it("gives the canvas less of the height when stacked than when beside the list", () => {
    const beside = captionEditorLayout({ width: 680, height: 400 });
    const stacked = captionEditorLayout({ width: 360, height: 400 });
    expect(stacked.canvasMaxHeightPx).toBeLessThan(beside.canvasMaxHeightPx);
  });

  it("never caps the canvas at nothing, however short the window", () => {
    for (const height of [0, 1, 40, 120, -30]) {
      expect(captionEditorLayout({ width: 680, height }).canvasMaxHeightPx).toBeGreaterThan(0);
    }
  });

  it("survives a window with no size, which is what the first frame measures", () => {
    const layout = captionEditorLayout({ width: 0, height: 0 });
    expect(layout.columns).toBe("one");
    expect(layout.canvasMaxHeightPx).toBeGreaterThan(0);
  });

  it("leaves the list the larger share of a two-column width", () => {
    const { previewShare } = captionEditorLayout({ width: 680, height: 400 });
    expect(previewShare).toBeGreaterThan(0);
    expect(previewShare).toBeLessThan(0.5);
  });

  it("keeps both columns above the minimums the breakpoint was derived from", () => {
    const { previewShare } = captionEditorLayout({
      width: CAPTION_EDITOR_BREAKPOINT_PX,
      height: 400,
    });
    const previewPx = CAPTION_EDITOR_BREAKPOINT_PX * previewShare;
    const listPx = CAPTION_EDITOR_BREAKPOINT_PX - previewPx - 16;

    expect(previewPx).toBeGreaterThanOrEqual(220);
    expect(listPx).toBeGreaterThanOrEqual(260);
  });
});
