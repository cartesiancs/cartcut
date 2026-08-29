import { describe, it, expect } from "vitest";
import { toFsPath } from "./localpath";

describe("toFsPath", () => {
  it("strips the file:// scheme a clip's localpath carries", () => {
    expect(toFsPath("file:///Users/x/clip.mp4")).toBe("/Users/x/clip.mp4");
  });

  it("decodes percent-encoding, so a name with spaces resolves", () => {
    // The case that broke analyze_audio in the real app.
    expect(toFsPath("file:///Users/x/Duty%20Calls%20-%20Rod%20Kim.mp3")).toBe(
      "/Users/x/Duty Calls - Rod Kim.mp3",
    );
  });

  it("leaves a plain path alone", () => {
    expect(toFsPath("/Users/x/clip.mp4")).toBe("/Users/x/clip.mp4");
  });

  it("leaves a relative path alone", () => {
    expect(toFsPath("clip.mp4")).toBe("clip.mp4");
  });

  it("accepts the scheme in any case", () => {
    expect(toFsPath("FILE:///Users/x/clip.mp4")).toBe("/Users/x/clip.mp4");
  });

  it("hands back a url it cannot convert, rather than throwing", () => {
    // A remote host is not a local file, and `fileURLToPath` rejects it. The
    // caller's own "no such file" then names what it was given, which is more
    // use than an error from in here.
    expect(toFsPath("file://host/x.mp4")).toBe("file://host/x.mp4");
  });

  it("resolves an explicit localhost host", () => {
    expect(toFsPath("file://localhost/Users/x/clip.mp4")).toBe(
      "/Users/x/clip.mp4",
    );
  });
});
