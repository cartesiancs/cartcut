import { describe, it, expect, vi, beforeEach } from "vitest";
import { scene, solid, pixel, imageElement } from "./testing";

/**
 * The renderer reads pixels out of the shared asset store, which in the app is
 * populated by loaders that need the DOM. Stubbing it keeps these tests about
 * the drawing itself.
 */
const store = {
  getImage: vi.fn<[string], unknown>(),
};

vi.mock("../asset/loadedAssetStore", () => ({
  loadedAssetStore: { getState: () => store },
}));

const { renderImage } = await import("./image");

beforeEach(() => {
  store.getImage.mockReset();
});

describe("renderImage", () => {
  it("draws the loaded bitmap over the element's local box", () => {
    store.getImage.mockReturnValue(solid(10, 10, "#ff0000"));
    const el = imageElement({ width: 80, height: 60 });

    const { canvas, ctx } = scene(100, 100, "#000000");
    renderImage(ctx, "i", el, 0);

    // stretched from its own 10x10 to the element's 80x60 at the origin
    expect(pixel(canvas, 1, 1)).toMatchObject({ r: 255, g: 0, b: 0 });
    expect(pixel(canvas, 78, 58)).toMatchObject({ r: 255, g: 0, b: 0 });
    expect(pixel(canvas, 82, 58)).toMatchObject({ r: 0, g: 0, b: 0 });
    expect(pixel(canvas, 78, 62)).toMatchObject({ r: 0, g: 0, b: 0 });
  });

  it("looks the asset up by its path", () => {
    store.getImage.mockReturnValue(solid(10, 10, "#ff0000"));
    const el = imageElement({ localpath: "/assets/logo.png" });

    const { ctx } = scene(100, 100);
    renderImage(ctx, "i", el, 0);

    expect(store.getImage).toHaveBeenCalledWith("/assets/logo.png");
  });

  it("draws nothing while the asset is still loading", () => {
    // A miss has to be survivable: the editor keeps painting frames the whole
    // time assets are arriving.
    store.getImage.mockReturnValue(null);

    const { canvas, ctx } = scene(100, 100, "#000000");
    expect(() => renderImage(ctx, "i", imageElement(), 0)).not.toThrow();
    expect(pixel(canvas, 50, 50)).toMatchObject({ r: 0, g: 0, b: 0 });
  });
});
