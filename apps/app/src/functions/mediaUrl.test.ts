import { describe, expect, it } from "vitest";
import { mediaUrlFor } from "./mediaUrl";

describe("mediaUrlFor", () => {
  it("leaves every path alone outside the self-hosted web build", () => {
    for (const env of ["electron", "demo"] as const) {
      expect(mediaUrlFor("file:///Users/me/a.mp4", env)).toBe("file:///Users/me/a.mp4");
      expect(mediaUrlFor("/sample/a.mp4", env)).toBe("/sample/a.mp4");
      expect(mediaUrlFor("/Users/me/a.png", env)).toBe("/Users/me/a.png");
    }
  });

  it("routes a bare server path through /api/file on the web build", () => {
    expect(mediaUrlFor("/Users/me/a.png", "web")).toBe("/api/file?path=/Users/me/a.png");
  });

  it("never prefixes a path that is already a URL or already the route", () => {
    const blob = "blob:https://example.com/4f1c#clip.mp4";
    expect(mediaUrlFor(blob, "web")).toBe(blob);
    expect(mediaUrlFor("https://cdn.example.com/a.mp4", "web")).toBe(
      "https://cdn.example.com/a.mp4",
    );
    expect(mediaUrlFor("/api/file?path=%2FUsers%2Fme%2Fa.png", "web")).toBe(
      "/api/file?path=%2FUsers%2Fme%2Fa.png",
    );
  });
});
