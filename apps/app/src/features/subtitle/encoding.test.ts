import { describe, expect, it } from "vitest";
import { decodeSubtitleBytes, hasCp949 } from "./encoding";

/**
 * "한글 자막" in CP949, byte for byte.
 *
 * Hand-written rather than produced by an encoder, so the fixture does not
 * depend on the same ICU tables the subject does. Every one of these bytes is
 * >= 0x80 and none of them form a valid UTF-8 sequence, which is exactly what
 * makes the strict decode throw.
 */
const CP949_BYTES = new Uint8Array([
  0xc7, 0xd1, 0xb1, 0xdb, // 한글
  0x20, //                   space
  0xc0, 0xda, 0xb8, 0xb7, // 자막
]);

const KOREAN = "한글 자막";

const utf8 = (text: string) => new TextEncoder().encode(text);

describe("decodeSubtitleBytes", () => {
  it("reads UTF-8 and says so", () => {
    expect(decodeSubtitleBytes(utf8(KOREAN))).toEqual({
      text: KOREAN,
      encoding: "utf-8",
    });
  });

  it("reads plain ASCII as UTF-8", () => {
    expect(decodeSubtitleBytes(utf8("1\n00:00:01,000"))).toEqual({
      text: "1\n00:00:01,000",
      encoding: "utf-8",
    });
  });

  it("strips a UTF-8 BOM", () => {
    // A BOM survives every decode and poisons whatever reads the first line.
    expect(decodeSubtitleBytes(utf8("﻿WEBVTT")).text).toBe("WEBVTT");
  });

  it("never throws, whatever the bytes are", () => {
    expect(() =>
      decodeSubtitleBytes(new Uint8Array([0xff, 0xfe, 0x00, 0x80])),
    ).not.toThrow();
  });
});

// CP949 is absent from a Node built against small ICU. Electron always has it,
// so skipping here means a contributor's toolchain, not a defect.
describe.skipIf(!hasCp949())("decodeSubtitleBytes on a CP949 file", () => {
  it("reads it correctly, and reports which path it took", () => {
    expect(decodeSubtitleBytes(CP949_BYTES)).toEqual({
      text: KOREAN,
      encoding: "cp949",
    });
  });

  // The harness proof. If the strict UTF-8 attempt were not strict, or the
  // fixture were secretly valid UTF-8, the assertion above could pass against a
  // decoder that only ever ran one path.
  it("is bytes UTF-8 genuinely cannot explain", () => {
    expect(() =>
      new TextDecoder("utf-8", { fatal: true }).decode(CP949_BYTES),
    ).toThrow();
  });

  it("reaches the same text by two different routes", () => {
    const viaUtf8 = decodeSubtitleBytes(utf8(KOREAN));
    const viaCp949 = decodeSubtitleBytes(CP949_BYTES);

    expect(viaCp949.text).toBe(viaUtf8.text);
    // Same answer, different path. Requiring them to disagree here is what
    // proves the `encoding` field is reporting rather than hard-coded.
    expect(viaCp949.encoding).not.toBe(viaUtf8.encoding);
  });
});
