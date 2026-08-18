import { describe, it, expect } from "vitest";
import { getElementType } from "./elementType";

describe("getElementType", () => {
  it("classifies static filetypes", () => {
    for (const t of ["image", "text", "png", "jpg", "jpeg", "gif", "shape"]) {
      expect(getElementType(t)).toBe("static");
    }
  });
  it("classifies dynamic filetypes", () => {
    for (const t of ["video", "audio", "mp4", "mp3", "mov"]) {
      expect(getElementType(t)).toBe("dynamic");
    }
  });
  it("returns undefined for unknown or missing types", () => {
    expect(getElementType("webp")).toBe("undefined");
    expect(getElementType(undefined)).toBe("undefined");
    expect(getElementType("")).toBe("undefined");
  });
});
