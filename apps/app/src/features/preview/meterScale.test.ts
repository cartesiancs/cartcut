import { describe, expect, it } from "vitest";
import { METER_SEGMENT_DB, litSegmentsAt } from "./meterScale";
import { METER_FLOOR_DB, amplitudeToDb } from "../timeline/audioLevel";

/** Every block lit, red included. One fewer reaches amber, two fewer is green. */
const ALL = METER_SEGMENT_DB.length;

describe("litSegmentsAt", () => {
  it("lights nothing at the floor or below the first block", () => {
    expect(litSegmentsAt(METER_FLOOR_DB)).toBe(0);
    expect(litSegmentsAt(amplitudeToDb(0))).toBe(0);
    // A microphone's noise floor, which must not hold a block lit.
    expect(litSegmentsAt(-50)).toBe(0);
  });

  it("keeps an ordinary speech peak in the green", () => {
    // -8 dBFS lit the red block under six equal 10 dB steps.
    expect(litSegmentsAt(-8)).toBe(ALL - 2);
    // 0.5 is -6.02 dBFS: just under the amber block, measured independently
    // of the scale rather than read back from it.
    expect(litSegmentsAt(amplitudeToDb(0.5))).toBe(ALL - 2);
  });

  it("lights amber in the last 6 dB and red only at full scale", () => {
    expect(litSegmentsAt(-6)).toBe(ALL - 1);
    expect(litSegmentsAt(-0.5)).toBe(ALL - 1);
    expect(litSegmentsAt(amplitudeToDb(0.999))).toBe(ALL - 1);

    expect(litSegmentsAt(amplitudeToDb(1))).toBe(ALL);
    // A boosted clip past unity reads as the clamp, which is clipping.
    expect(litSegmentsAt(amplitudeToDb(1.4))).toBe(ALL);
  });

  it("lights each block at its own threshold and not a hair under", () => {
    METER_SEGMENT_DB.forEach((threshold, i) => {
      expect(litSegmentsAt(threshold)).toBe(i + 1);
      expect(litSegmentsAt(threshold - 0.01)).toBe(i);
    });
  });

  it("lights nothing for NaN", () => {
    expect(litSegmentsAt(NaN)).toBe(0);
  });
});

describe("METER_SEGMENT_DB", () => {
  it("ascends and ends at clipping", () => {
    for (let i = 1; i < METER_SEGMENT_DB.length; i++) {
      expect(METER_SEGMENT_DB[i]).toBeGreaterThan(METER_SEGMENT_DB[i - 1]);
    }
    expect(METER_SEGMENT_DB[METER_SEGMENT_DB.length - 1]).toBe(0);
    expect(METER_SEGMENT_DB[0]).toBeGreaterThan(METER_FLOOR_DB);
  });
});
