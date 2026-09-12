import { describe, expect, it } from "vitest";
import {
  captionLayout,
  captionStyle,
} from "./layout";
import { defaultTextHeight } from "../text/metrics";

const HD = { w: 1920, h: 1080 };
const VERTICAL = { w: 1080, h: 1920 };
const UHD = { w: 3840, h: 2160 };

describe("captionLayout", () => {
  it("reproduces the lower third add_subtitles already placed at 1080p", () => {
    // The numbers the previous `defaultLayout` produced. They must not move:
    // captions placed before this refactor and after it have to line up.
    expect(captionLayout(HD)).toEqual({
      fontsize: 54,
      height: defaultTextHeight(54),
      width: 1920,
      locationX: 0,
      locationY: 918,
    });
  });

  it("scales everything off the frame height, so a vertical project fits", () => {
    const layout = captionLayout(VERTICAL);

    expect(layout.fontsize).toBe(96);
    expect(layout.width).toBe(1080);
    // The whole box has to sit inside the frame — the bug this replaces put a
    // caption at a literal 1080 - 100 - 52 regardless of the project, which is
    // off the bottom of nothing and halfway up a vertical frame.
    expect(layout.locationY + layout.height).toBeLessThan(VERTICAL.h);
    expect(layout.locationY).toBeGreaterThan(VERTICAL.h / 2);
  });

  it("keeps the same proportions at 4K as at 1080p", () => {
    const hd = captionLayout(HD);
    const uhd = captionLayout(UHD);

    expect(uhd.fontsize).toBe(hd.fontsize * 2);
    expect(uhd.locationY).toBe(hd.locationY * 2);
  });

  it("centres the box, not the baseline", () => {
    const layout = captionLayout(HD, "center");
    const centre = layout.locationY + layout.height / 2;

    expect(Math.abs(centre - HD.h / 2)).toBeLessThanOrEqual(1);
  });

  it("lets a caller pin any field and derives the rest", () => {
    const layout = captionLayout(HD, "lowerThird", { fontsize: 30, locationX: 40 });

    expect(layout.fontsize).toBe(30);
    expect(layout.locationX).toBe(40);
    expect(layout.height).toBe(defaultTextHeight(30));
    // The pinned font size moves the derived Y with it.
    expect(layout.locationY).toBe(1080 - 108 - 30);
  });

  it("agrees with createTextElement's own height fallback", () => {
    // `createTextElement` falls back to `defaultTextHeight(fontsize)` when no
    // height is given. If this drifted, a caption's box would change size the
    // moment someone stopped passing `height` through.
    const layout = captionLayout(HD);
    expect(layout.height).toBe(defaultTextHeight(layout.fontsize));
  });

  it("falls back to 1080p rather than producing NaN", () => {
    // `previewSize` is read from a project file; a malformed one should give a
    // caption in the wrong place, not an element with NaN coordinates that
    // disappears from the canvas with no error anywhere.
    const layout = captionLayout({ w: 0, h: Number.NaN });

    expect(layout).toEqual(captionLayout(HD));
  });
});

describe("captionStyle", () => {
  const FRAME = { w: 1920, h: 1080 };

  it("is the layout plus the fixed look", () => {
    // Everything `captionLayout` answers, unchanged, and nothing else invented.
    expect(captionStyle(FRAME, "lowerThird")).toEqual({
      ...captionLayout(FRAME, "lowerThird"),
      textcolor: "#ffffff",
      optionsAlign: "center",
      backgroundEnable: true,
    });
  });

  it("carries the placement through", () => {
    expect(captionStyle(FRAME, "center").locationY).toBe(
      captionLayout(FRAME, "center").locationY,
    );
    expect(captionStyle(FRAME, "center").locationY).not.toBe(
      captionStyle(FRAME, "lowerThird").locationY,
    );
  });

  it("defaults to the lower third, as the panel does", () => {
    expect(captionStyle(FRAME)).toEqual(captionStyle(FRAME, "lowerThird"));
  });

  it("passes overrides down to the layout", () => {
    expect(captionStyle(FRAME, "lowerThird", { fontsize: 100, locationY: 7 }))
      .toMatchObject({ fontsize: 100, locationY: 7 });
  });

  it("does not depend on any line, so every caption gets the same box", () => {
    // The whole reason it takes no index: the panel used to pass the index of
    // the *filtered* caption list into a function that indexed the unfiltered
    // lines. Two calls with the same frame must be indistinguishable.
    expect(captionStyle(FRAME, "center")).toEqual(captionStyle(FRAME, "center"));
  });

  it("supplies no text, startTime or duration", () => {
    // Those three belong to the caption, not to the style, and `captionRows`
    // spreads them over this. A `text` here is what the old version produced —
    // from the wrong line — and it has to stay absent.
    const style = captionStyle(FRAME);
    expect("text" in style).toBe(false);
    expect("startTime" in style).toBe(false);
    expect("duration" in style).toBe(false);
  });

  it("keeps the frame fallback for a degenerate frame", () => {
    expect(captionStyle({ w: 0, h: NaN })).toEqual(
      captionStyle({ w: 1920, h: 1080 }),
    );
  });
});
