import { describe, expect, it } from "vitest";
import { phoneTimecode } from "./phoneTimecode";

describe("phoneTimecode", () => {
  it("shows minutes, seconds and the frame within the second", () => {
    expect(phoneTimecode(0, 60, true)).toBe("00:00.00");
    expect(phoneTimecode(2999, 60, true)).toBe("00:02.59");
    expect(phoneTimecode(3000, 60, true)).toBe("00:03.00");
    expect(phoneTimecode(61_500, 30, true)).toBe("01:01.15");
  });

  it("drops the frame when asked", () => {
    expect(phoneTimecode(9933, 60, false)).toBe("00:09");
  });

  it("runs minutes past an hour rather than adding a field", () => {
    expect(phoneTimecode(3_725_000, 24, false)).toBe("62:05");
  });

  it("never prints garbage for an unusable input", () => {
    expect(phoneTimecode(NaN, 60, true)).toBe("00:00.00");
    expect(phoneTimecode(-5, 60, true)).toBe("00:00.00");
    expect(phoneTimecode(1500, 0, true)).toBe("00:01.00");
  });
});
