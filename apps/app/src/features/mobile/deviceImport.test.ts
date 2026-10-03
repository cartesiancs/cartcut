import { describe, expect, it } from "vitest";
import { deviceMediaPath } from "./deviceImport";
import { mediaKindOf } from "../element/mediaElement";

const URL_ = "blob:https://cartcut.cartesiancs.com/4f1c";

describe("deviceMediaPath", () => {
  it("keeps the file's name as the fragment, so its kind is still readable", () => {
    const path = deviceMediaPath(URL_, "IMG_0042.MOV", "video/quicktime");
    expect(path).toBe(`${URL_}#IMG_0042.MOV`);
    expect(mediaKindOf(path)).toBe("video");
    expect(mediaKindOf(deviceMediaPath(URL_, "a.jpg", "image/jpeg"))).toBe("image");
    expect(mediaKindOf(deviceMediaPath(URL_, "v.mp3", "audio/mpeg"))).toBe("audio");
  });

  it("gives a name with no extension the one its type implies", () => {
    expect(deviceMediaPath(URL_, "video", "video/mp4")).toBe(`${URL_}#video.mp4`);
    expect(mediaKindOf(deviceMediaPath(URL_, "image", "image/png"))).toBe("image");
  });

  it("cannot end the fragment early or look like a folder", () => {
    const path = deviceMediaPath(URL_, "a#b?c/d\\e.mp4", "video/mp4");
    expect(path).toBe(`${URL_}#a_b_c_d_e.mp4`);
    expect(path.split("#")).toHaveLength(2);
  });

  it("names an unnamed file", () => {
    expect(deviceMediaPath(URL_, "  ", "image/webp")).toBe(`${URL_}#media.webp`);
    expect(deviceMediaPath(URL_, "", "application/x-unknown")).toBe(`${URL_}#media`);
  });
});
