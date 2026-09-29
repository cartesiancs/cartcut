import { describe, expect, it } from "vitest";
import {
  AssetMetaWords,
  NO_VALUE,
  assetMetaFor,
  formatAssetDate,
  formatAssetSize,
  kindLabel,
} from "./assetMeta";

const WORDS: AssetMetaWords = {
  today: "Today",
  yesterday: "Yesterday",
  folder: "Folder",
  video: "Video",
  image: "Image",
  audio: "Audio",
  file: "File",
};

const utc = () => 0;
const kst = () => 540;

describe("formatAssetSize", () => {
  it.each([
    [0, "0 B"],
    [999, "999 B"],
    [1000, "1 KB"],
    [1499, "1.5 KB"],
    [1500, "1.5 KB"],
    [12_345, "12.3 KB"],
    [123_456, "123 KB"],
    [999_500, "1 MB"],
    [1_234_567, "1.2 MB"],
    [999_960_000, "1 GB"],
    [2e9, "2 GB"],
    [2.1e9, "2.1 GB"],
    [3.5e12, "3.5 TB"],
  ])("writes %d bytes as %s", (bytes, label) => {
    expect(formatAssetSize(bytes)).toBe(label);
  });

  it("writes -- for a size it does not have", () => {
    for (const bad of [undefined, NaN, -1, Infinity]) {
      expect(formatAssetSize(bad)).toBe(NO_VALUE);
    }
  });
});

describe("formatAssetDate", () => {
  const now = Date.UTC(2026, 8, 29, 12, 0);

  it("writes today and yesterday with a 24-hour clock", () => {
    expect(formatAssetDate(Date.UTC(2026, 8, 29, 14, 3), now, WORDS, utc)).toBe(
      "Today 14:03",
    );
    expect(formatAssetDate(Date.UTC(2026, 8, 28, 9, 12), now, WORDS, utc)).toBe(
      "Yesterday 09:12",
    );
  });

  it("writes anything older as an ISO date", () => {
    expect(formatAssetDate(Date.UTC(2026, 8, 13, 10, 0), now, WORDS, utc)).toBe(
      "2026-09-13",
    );
  });

  it("writes a date in the future as an ISO date", () => {
    expect(formatAssetDate(Date.UTC(2026, 9, 2, 10, 0), now, WORDS, utc)).toBe(
      "2026-10-02",
    );
  });

  it("decides the day in local time, not UTC", () => {
    // 20:30 UTC on the 28th is 05:30 on the 29th in Seoul: today there,
    // yesterday in London.
    const at = Date.UTC(2026, 8, 28, 20, 30);
    expect(formatAssetDate(at, now, WORDS, kst)).toBe("Today 05:30");
    expect(formatAssetDate(at, now, WORDS, utc)).toBe("Yesterday 20:30");
  });

  it("asks for the offset at each instant, across a daylight-saving change", () => {
    // Clocks went back an hour between the file and now. 23:30 UTC on the
    // 27th was 00:30 on the 28th at +60, which is yesterday from the 29th; a
    // single offset read at `now` (0) would put it on the 27th.
    const changedAt = Date.UTC(2026, 8, 28, 12, 0);
    const offset = (ms: number) => (ms < changedAt ? 60 : 0);
    expect(
      formatAssetDate(Date.UTC(2026, 8, 27, 23, 30), now, WORDS, offset),
    ).toBe("Yesterday 00:30");
  });

  it("writes -- for a date it does not have", () => {
    expect(formatAssetDate(undefined, now, WORDS, utc)).toBe(NO_VALUE);
    expect(formatAssetDate(NaN, now, WORDS, utc)).toBe(NO_VALUE);
  });
});

describe("kindLabel", () => {
  it("names the extension and what the panel treats it as", () => {
    expect(kindLabel({ name: "a.mp4", isDirectory: false }, WORDS)).toBe(
      "MP4 Video",
    );
    expect(kindLabel({ name: "a.PNG", isDirectory: false }, WORDS)).toBe(
      "PNG Image",
    );
    expect(kindLabel({ name: "a.gif", isDirectory: false }, WORDS)).toBe(
      "GIF Image",
    );
    expect(kindLabel({ name: "a.wav", isDirectory: false }, WORDS)).toBe(
      "WAV Audio",
    );
    expect(kindLabel({ name: "a.srt", isDirectory: false }, WORDS)).toBe(
      "SRT File",
    );
  });

  it("says Folder for a folder and File for no extension", () => {
    expect(kindLabel({ name: "renders.old", isDirectory: true }, WORDS)).toBe(
      "Folder",
    );
    expect(kindLabel({ name: ".env", isDirectory: false }, WORDS)).toBe("File");
  });
});

describe("assetMetaFor", () => {
  const now = Date.UTC(2026, 8, 29, 12, 0);
  const clip = {
    name: "clip.mp4",
    isDirectory: false,
    size: 2.1e9,
    modifiedMs: Date.UTC(2026, 8, 29, 14, 3),
    createdMs: Date.UTC(2026, 0, 5, 9, 0),
  };

  it("shows the value of the key the panel is sorted by", () => {
    expect(assetMetaFor(clip, "size", now, WORDS, utc)).toBe("2.1 GB");
    expect(assetMetaFor(clip, "modified", now, WORDS, utc)).toBe("Today 14:03");
    expect(assetMetaFor(clip, "created", now, WORDS, utc)).toBe("2026-01-05");
    expect(assetMetaFor(clip, "kind", now, WORDS, utc)).toBe("MP4 Video");
  });

  it("shows nothing for Name, and -- for a folder's size", () => {
    expect(assetMetaFor(clip, "name", now, WORDS, utc)).toBe("");
    expect(
      assetMetaFor({ name: "sub", isDirectory: true }, "size", now, WORDS, utc),
    ).toBe(NO_VALUE);
  });
});
