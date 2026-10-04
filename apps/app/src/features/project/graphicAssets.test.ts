import { describe, expect, it } from "vitest";
import type { TimelineElement } from "../../@types/timeline";
import { graphicAssetRefsOf, withGraphicAssetRef } from "./assetsFile";

const graphic = {
  filetype: "graphic",
  params: {
    title: "/not/a/file at all",
    face: "/Users/me/Fonts/Brand.otf",
    photo: "/Users/me/Pictures/sky.jpg",
    other: "bundled:Anton-Regular.ttf",
  },
  program: { hash: "h", manifest: {}, sources: {}, assets: { "logo.png": "/Users/me/logo.png" } },
} as unknown as TimelineElement;

describe("graphicAssetRefsOf", () => {
  it("names font and image paths and program assets, and no text", () => {
    expect(graphicAssetRefsOf(graphic)).toEqual([
      { suffix: "#param:face", value: "/Users/me/Fonts/Brand.otf" },
      { suffix: "#param:photo", value: "/Users/me/Pictures/sky.jpg" },
      { suffix: "#asset:logo.png", value: "/Users/me/logo.png" },
    ]);
  });

  it("answers nothing for another filetype", () => {
    expect(graphicAssetRefsOf({ filetype: "image", params: { a: "/x.png" } } as any)).toEqual([]);
  });
});

describe("withGraphicAssetRef", () => {
  it("writes a parameter or an asset back, leaving the rest", () => {
    const moved = withGraphicAssetRef(graphic, "#param:face", "/Volumes/X/Brand.otf") as any;
    expect(moved.params.face).toBe("/Volumes/X/Brand.otf");
    expect(moved.params.photo).toBe("/Users/me/Pictures/sky.jpg");
    const asset = withGraphicAssetRef(graphic, "#asset:logo.png", "/Volumes/X/logo.png") as any;
    expect(asset.program.assets["logo.png"]).toBe("/Volumes/X/logo.png");
    expect(asset.program.hash).toBe("h");
  });
});
