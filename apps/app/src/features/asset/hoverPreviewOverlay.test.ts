/**
 * Which file the hover preview decodes.
 *
 * The pure half of `hoverPreviewOverlay.ts`. The overlay's DOM is untestable
 * here — there is no DOM test environment — but this is the part that can be
 * wrong without looking wrong: a preview that silently decodes a 3600x2338
 * 120fps original instead of its proxy plays badly rather than not at all, and
 * one handed a bare OS path shows nothing with no error anywhere.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { proxyStore } from "../../states/proxyStore";
import { previewSrcFor } from "./hoverPreviewOverlay";

/** The form `AssetFile.fileUrl` produces, which is the store's own key. */
const SOURCE = "file:///Users/me/Screen Recording.mov";
/** What main reports: an OS path, not a URL. */
const PROXY = "/Users/me/Library/Application Support/cartcut-app/proxies/ab.mp4";

function entry() {
  return {
    [SOURCE]: { source: SOURCE, proxy: PROXY, width: 960, height: 624, fps: 60 },
  };
}

describe("previewSrcFor", () => {
  beforeEach(() => {
    proxyStore.setState({ mode: "prefer", bySource: {}, progress: null });
  });

  it("returns the source untouched when there is no proxy", () => {
    expect(previewSrcFor(SOURCE)).toBe(SOURCE);
  });

  it("returns the source untouched when proxies are switched off", () => {
    proxyStore.getState().setEntries(entry());
    proxyStore.getState().setMode("off");

    expect(previewSrcFor(SOURCE)).toBe(SOURCE);
  });

  it("gives the proxy back as a URL, because the store holds it as an OS path", () => {
    // `proxyBridge` converts `entry.source` on the way in and leaves
    // `entry.proxy` alone, so the substituted value is not loadable as-is: a
    // `<video>` would resolve it against the page.
    proxyStore.getState().setEntries(entry());

    expect(previewSrcFor(SOURCE)).toBe(`file://${PROXY}`);
  });

  it("does not double-wrap a path that is already a URL", () => {
    // The trap in `toLocalPath(playbackPathFor(x))`: applied to the unsubstituted
    // case it re-wraps a path that is already in its final form. Harmless for a
    // `file://` URL, which passes through, and not for the web build's
    // `/api/file?path=` form, which does not.
    const webForm = "/api/file?path=/Users/me/a.mov";

    expect(previewSrcFor(webForm)).toBe(webForm);
  });

  it("escapes nothing and decodes nothing on the way through", () => {
    // `localpath` is not percent-encoded beyond `#`, so a general-purpose
    // encoder would corrupt these two names. Both are real: the second is what
    // macOS calls a screen recording.
    const hash = "file:///Users/me/100%.mp4";
    const query = "file:///Users/me/a?b.mp4";

    expect(previewSrcFor(hash)).toBe(hash);
    expect(previewSrcFor(query)).toBe(query);
  });
});
